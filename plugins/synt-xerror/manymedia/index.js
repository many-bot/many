/**
 * Downloads video, audio or photos via yt-dlp/gallery-dl
 * and uploads/sends to server. Handles !baixar-video, !baixar-audio and
 * !baixar-foto (aliases !video/!audio deprecated, !img removed).
 */

import { execFile, spawn } from "child_process";
import { promisify }       from "util";
import fs                  from "fs";
import path                from "path";

const execFileAsync = promisify(execFile);

fs.mkdirSync("logs", { recursive: true });
const logStream = fs.createWriteStream("logs/video-error.log", { flags: "a" });
logStream.on("error", err => console.error("[logStream]", err));

const DOWNLOADS_DIR = path.resolve("downloads");
const UPLOAD_URL    = "https://api.stxerr.dev/upload";

// Public API
// They only download and hand back the file; sending/uploading is the caller's job.

export const api = {
  async downloadVideo(url, ctx, t) {
    return queueDownload(url, "mp4", ctx, t);
  },
  async downloadAudio(url, ctx, t) {
    return queueDownload(url, "mp3", ctx, t);
  },
  async downloadImages(url, ctx) {
    return queueImagesDownload(url, ctx);
  },
};

// Resolve Reddit URL
//
// v.redd.it normalmente serve vídeo e áudio como streams DASH separados.
// yt-dlp --get-url só imprime URLs cruas (sem nenhum marcador "AUDIO"), então
// em vez de tentar adivinhar por texto, pedimos o JSON de formats e filtramos
// por acodec/vcodec.

async function resolveRedditUrl(url, cookiesPath) {
  if (!url.includes("reddit.com") && !url.includes("redd.it")) return { url, audioUrl: null };

  const { stdout } = await execFileAsync("yt-dlp", [
    "-J",
    "--no-playlist",
    "--cookies", cookiesPath,
    url,
  ]);

  const formats = JSON.parse(stdout).formats ?? [];

  const audioFmt = formats
    .filter(f => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
    .sort((a, b) => (a.abr ?? 0) - (b.abr ?? 0))
    .pop();

  // Sem stream de áudio separado (ex: gif silencioso) → deixa o fluxo normal
  // do yt-dlp cuidar, usando a URL original (não uma URL de CDN crua).
  if (!audioFmt) return { url, audioUrl: null };

  const videoFmt = formats
    .filter(f => f.vcodec && f.vcodec !== "none")
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))
    .pop();

  return { url: videoFmt?.url ?? url, audioUrl: audioFmt.url };
}

// Downloaders

function buildYtDlpArgs(url, format, cookiesPath) {
  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isMp3     = format === "mp3";
  const args = [
    "--print",             "after_move:filepath",
    "--cookies",            cookiesPath,
    "--add-header",        "User-Agent:Mozilla/5.0",
    "--retries",           "4",
    "--fragment-retries",  "5",
    "--socket-timeout",    "15",
    "--sleep-interval",    "1",
    "--max-sleep-interval","4",
    "--no-playlist",
  ];

  if (isMp3) {
    args.push(
      "-x",
      "--audio-format",  "mp3",
      "--audio-quality", "0", // VBR ~best (~245kbps)
    );
  } else {
    args.push("-f", "bv+ba/best");
  }

  if (isYouTube) {
    args.push(
      // android alone ignores cookies -> fails on age/login-gated videos
      // ("Only images are available for download"). web is included so
      // yt-dlp still gets a usable format list when cookies are needed.
      "--extractor-args", "youtube:player_client=android,web",
      "--add-header",     "Referer:https://www.youtube.com/",
    );
  }

  return args;
}

async function downloadYtDlp(url, id, format, t, cookiesPath) {
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(DOWNLOADS_DIR, id);
    fs.mkdirSync(tmpDir, { recursive: true });

    const args = [
      ...buildYtDlpArgs(url, format, cookiesPath),
      "--output", path.join(tmpDir, "%(title).80s.%(ext)s"),
      url,
    ];

    const proc = spawn("yt-dlp", args);
    let stdout = "", stderr = "";

    proc.on("error", err => {
      const msg = err.code === "EACCES" ? t("error.noPermission")
        : err.code === "ENOENT"         ? t("error.notFound")
        :                                 `${t("error.startError")} ${err.message}`;
      reject(new Error(msg));
    });

    proc.stdout.on("data", d => { const s = d.toString(); stdout += s; console.log(`[manymedia] ${s.trim()}`); });
    proc.stderr.on("data", d => { const s = d.toString(); stderr += s; logStream.write(s); console.error(`[manymedia] ${s.trim()}`); });

    proc.on("close", async code => {
      console.log(`[manymedia] yt-dlp exited with code ${code}`);
      if (code !== 0) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.error(`[manymedia] Last stderr:\n${stderr.split("\n").slice(-5).join("\n")}`);
        return reject(new Error(`${t("error.downloadFailed")} (exit code ${code})`));
      }

      let filePath = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!filePath || !fs.existsSync(filePath)) {
        const files = fs.readdirSync(tmpDir).filter(f => !f.endsWith(".part"));
        filePath = files.length === 1 ? path.join(tmpDir, files[0]) : null;
      }

      if (!filePath) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return reject(new Error(t("error.fileNotFound")));
      }

      resolve({ filePath, tmpDir });
    });
  });
}

async function downloadRedditWithAudio(videoUrl, audioUrl, id, format) {
  const tmpDir   = path.join(DOWNLOADS_DIR, id);
  fs.mkdirSync(tmpDir, { recursive: true });

  const isMp3    = format === "mp3";
  const filePath = isMp3
    ? path.join(tmpDir, "audio.mp3")
    : path.join(tmpDir, "video.mp4");

  const args = isMp3
    ? [
        "-i", audioUrl,
        "-vn", "-sn", "-dn",
        "-map_metadata", "-1",
        "-c:a", "libmp3lame",
        "-q:a", "0", // VBR ~best
        "-shortest", filePath,
      ]
    : ["-i", videoUrl, "-i", audioUrl, "-c:v", "copy", "-c:a", "aac", "-shortest", filePath];

  await new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    proc.stderr.on("data", d => logStream.write(d));
    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
      resolve();
    });
  });

  return { filePath, tmpDir };
}

async function downloadMedia(url, id, format, t, cookiesPath) {
  const { url: resolvedUrl, audioUrl } = await resolveRedditUrl(url, cookiesPath);

  if (audioUrl) {
    return downloadRedditWithAudio(resolvedUrl, audioUrl, id, format);
  }

  return downloadYtDlp(resolvedUrl, id, format, t, cookiesPath);
}

// gallery-dl fallback — used when yt-dlp can't handle the link (e.g. image
// carousels). Downloads every item and returns their file paths.

async function downloadImagesGalleryDl(url, id, cookiesPath) {
  const tmpDir = path.join(DOWNLOADS_DIR, id);
  fs.mkdirSync(tmpDir, { recursive: true });

  const args = ["--cookies", cookiesPath, url];

  return new Promise((resolve, reject) => {
    const proc = spawn("gallery-dl", args, { cwd: tmpDir });
    let stdout = "", stderr = "";

    proc.on("error", err => {
      const msg = err.code === "EACCES" ? "gallery-dl: permission denied"
        : err.code === "ENOENT"         ? "gallery-dl: not found"
        :                                 `gallery-dl failed to start: ${err.message}`;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      reject(new Error(msg));
    });

    proc.stdout.on("data", d => { const s = d.toString(); stdout += s; console.log(`[manymedia] ${s.trim()}`); });
    proc.stderr.on("data", d => { const s = d.toString(); stderr += s; logStream.write(s); console.error(`[manymedia] ${s.trim()}`); });

    proc.on("close", code => {
      console.log(`[manymedia] gallery-dl exited with code ${code}`);

      const filePaths = stdout
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map(p => path.resolve(tmpDir, p))
        .filter(p => fs.existsSync(p));

      if (code !== 0 || filePaths.length === 0) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.error(`[manymedia] Last stderr:\n${stderr.split("\n").slice(-5).join("\n")}`);
        return reject(new Error(`gallery-dl failed (exit code ${code})`));
      }

      resolve({ filePaths, tmpDir });
    });
  });
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".gif"]);

function sendGalleryItem(ctx, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? ctx.send.video(filePath) : ctx.send.image(filePath);
}

function queueImagesDownload(url, ctx) {
  const cookiesPath = ctx.storage.resolve("cookies.txt");
  const id = `img-${Date.now()}`;

  return new Promise((resolve, reject) => {
    ctx.download.enqueue(
      async () => {
        try {
          const { filePaths, tmpDir } = await downloadImagesGalleryDl(url, id, cookiesPath);
          resolve({
            filePaths,
            cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
          });
        } catch (err) {
          reject(err);
        }
      },
      async () => reject(new Error("gallery-dl queue error"))
    );
  });
}

// Queue wrapper — used by both the public API and the command handler.
// Resolves with { filePath, cleanup }. Caller decides what to do with the
// file and is responsible for calling cleanup() once it's done with it.

function queueDownload(url, format, ctx, t) {
  const cookiesPath = ctx.storage.resolve("cookies.txt");
  const id = `${format}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    ctx.download.enqueue(
      async () => {
        try {
          const { filePath, tmpDir } = await downloadMedia(url, id, format, t, cookiesPath);
          resolve({
            filePath,
            cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
          });
        } catch (err) {
          reject(err);
        }
      },
      async () => reject(new Error(t("error.generic")))
    );
  });
}

// Upload

const UPLOAD_RETRIES        = 4;
const UPLOAD_RETRY_DELAY_MS = 3000;

async function uploadToServer(filePath, apiKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = path.basename(filePath);

  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    if (attempt > 1) {
      console.log(`[manymedia] Retrying upload (attempt ${attempt}/${UPLOAD_RETRIES})...`);
      await new Promise(res => setTimeout(res, UPLOAD_RETRY_DELAY_MS));
    }
    try {
      const body = new FormData();
      body.append("file", new Blob([fileBuffer]), fileName);

      const res    = await fetch(UPLOAD_URL, { method: "POST", headers: { "x-api-key": apiKey }, body });
      const text   = await res.text();
      console.log(`[manymedia] Upload response: ${res.status} ${res.statusText}`);

      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);

      const result = JSON.parse(text);
      if (!result.url) throw new Error("Server response missing url");

      const finalUrl = result.url.startsWith("https")
        ? result.url
        : `https://api.stxerr.dev${result.url}`;
      return finalUrl;

    } catch (err) {
      lastError = err;
      console.error(`[manymedia] Upload attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw new Error(`Upload failed after ${UPLOAD_RETRIES} attempts: ${lastError.message}`);
}

// Command Entry Point — owns sending/uploading + cleanup

export default async function (ctx) {
  const { msg }  = ctx;
  const { t }    = ctx.i18n.createT(import.meta.url);

  const DEPRECATED = { video: "baixar-video", audio: "baixar-audio" };
  let cmdUsed = null;
  for (const [oldCmd, newCmd] of Object.entries(DEPRECATED)) {
    if (msg.is(oldCmd)) {
      await msg.reply.text(t("deprecated", { old: oldCmd, new: newCmd }));
      cmdUsed = newCmd;
      break;
    }
  }

  const commands = {
    ["baixar-video"]: "mp4",
    ["baixar-foto"]: "mp4",
    ["baixar-audio"]: "mp3",
  };

  for (const [cmd, format] of Object.entries(commands)) {
    if (!cmdUsed && !msg.is(cmd)) continue;
    if (cmdUsed && cmdUsed !== cmd) continue;

    const url = msg.args[0];
    if (!url) {
      await msg.reply.text(`${t("noUrl")} \`${cmdUsed ?? cmd} https://example.com/...\``);
      return;
    }

    await msg.reply.text(t("downloading"));

    const uplToSrv  = ctx.config.get("UPL_MEDIA_TO_SRV", "no");
    const srvApiKey = ctx.config.get("MEDIA_SRV_API_KEY");
    const sendFile  = (p) => format === "mp3"
      ? ctx.send.audio(p)
      : ctx.send.video(p);

    queueDownload(url, format, ctx, t)
      .then(async ({ filePath, cleanup }) => {
        try {
          if (uplToSrv === "yes") {
            const link = await uploadToServer(filePath, srvApiKey);
            await msg.reply.text(`*Download:*\n${link}`);
          } else {
            await sendFile(filePath);
          }
          ctx.log.info(`${cmd} completed → ${url}`);
        } finally {
          cleanup();
        }
      })
      .catch(async () => {
        if (format !== "mp4") {
          await msg.reply.text(t("error.generic"));
          return;
        }

        try {
          const { filePaths, cleanup } = await queueImagesDownload(url, ctx);
          try {
            if (uplToSrv === "yes") {
              const links = [];
              for (const p of filePaths) links.push(await uploadToServer(p, srvApiKey));
              await msg.reply.text(`*Download:*\n${links.join("\n")}`);
            } else {
              for (const p of filePaths) await sendGalleryItem(ctx, p);
            }
            ctx.log.info(`${cmd} (gallery-dl) completed → ${url}`);
          } finally {
            cleanup();
          }
        } catch {
          await msg.reply.text(t("error.generic"));
        }
      });

    return;
  }
}
