/**
 * Downloads video, audio or photos via yt-dlp/gallery-dl
 * and uploads/sends to server. Handles !baixar-video, !baixar-audio and
 * !baixar-foto (aliases !video/!audio deprecated, !img removed).
 */

import { execFile, execFileSync, spawn } from "child_process";
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
  async resolveInfo(query, ctx, t) {
    return resolveInfo(query, ctx, t);
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

function buildYtDlpArgs(format, { cookiesPath = null, extractorArgs = null, headers = [], denoPath = null } = {}) {
  const isMp3 = format === "mp3";
  const args = [
    "--print",             "after_move:filepath",
    "--retries",           "4",
    "--fragment-retries",  "5",
    "--socket-timeout",    "15",
    "--sleep-interval",    "1",
    "--max-sleep-interval","4",
    "--no-playlist",
  ];

  if (cookiesPath) args.push("--cookies", cookiesPath);
  for (const header of headers) args.push("--add-header", header);
  if (denoPath) args.push("--js-runtimes", `deno:${denoPath}`);

  if (isMp3) {
    args.push(
      "-x",
      "--audio-format",  "mp3",
      "--audio-quality", "0", // VBR ~best (~245kbps)
    );
  } else {
    // Prefer mp4-native streams (avoids remux); falls back to best+merge.
    // --merge-output-format forces the final container to mp4 even when
    // the chosen streams are webm/mkv-native (e.g. VP9+Opus), since
    // WhatsApp's player rejects those containers as "corrupted".
    args.push(
      "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv+ba/best",
      "--merge-output-format", "mp4",
    );
  }

  if (extractorArgs) args.push("--extractor-args", extractorArgs);

  return args;
}

// Strategies tried in order for YouTube until one succeeds. Rate-limit /
// "content isn't available" errors are often tied to a specific
// cookies+player_client+JS-runtime combo, not actual rate limiting, so we
// vary all of them. Each base combo runs once without deno, once with.
function youTubeStrategies(cookiesPath) {
  const base = [
    { cookiesPath: null,  extractorArgs: null,                           headers: [] },
    { cookiesPath,        extractorArgs: null,                           headers: [] },
    { cookiesPath: null,  extractorArgs: "youtube:player_client=android", headers: ["User-Agent:Mozilla/5.0"] },
    { cookiesPath: null,  extractorArgs: "youtube:player_client=ios",     headers: ["User-Agent:Mozilla/5.0"] },
    { cookiesPath,        extractorArgs: "youtube:player_client=web",     headers: ["User-Agent:Mozilla/5.0", "Referer:https://www.youtube.com/"] },
  ];

  return base.flatMap(cfg => [
    { ...cfg, noDeno: true },
    { ...cfg, noDeno: false },
  ]);
}

// deno is auto-detected by yt-dlp from PATH. To actually test "without deno"
// we strip its directory from the PATH handed to the child process.
let cachedDenoDir;
function denoDir() {
  if (cachedDenoDir !== undefined) return cachedDenoDir;
  try {
    cachedDenoDir = path.dirname(execFileSync("which", ["deno"]).toString().trim());
  } catch {
    cachedDenoDir = null;
  }
  return cachedDenoDir;
}

function envWithoutDeno() {
  const dir = denoDir();
  if (!dir) return process.env;
  const PATH = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(p => p !== dir)
    .join(path.delimiter);
  return { ...process.env, PATH };
}

function runYtDlpAttempt(url, tmpDir, args, env) {
  return new Promise((resolve, reject) => {
    const fullArgs = [...args, "--output", path.join(tmpDir, "%(title).80s.%(ext)s"), url];
    const proc = spawn("yt-dlp", fullArgs, { env });
    let stdout = "", stderr = "";

    proc.on("error", reject);

    proc.stdout.on("data", d => { const s = d.toString(); stdout += s; console.log(`[manymedia] ${s.trim()}`); });
    proc.stderr.on("data", d => { const s = d.toString(); stderr += s; logStream.write(s); console.error(`[manymedia] ${s.trim()}`); });

    proc.on("close", code => {
      console.log(`[manymedia] yt-dlp exited with code ${code}`);
      if (code !== 0) {
        const lastLine = stderr.split("\n").filter(Boolean).at(-1) ?? "";
        console.error(`[manymedia] Last stderr:\n${stderr.split("\n").slice(-5).join("\n")}`);
        return reject(Object.assign(new Error(`exit code ${code}: ${lastLine}`), { exitCode: code }));
      }

      let filePath = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!filePath || !fs.existsSync(filePath)) {
        const files = fs.readdirSync(tmpDir).filter(f => !f.endsWith(".part"));
        filePath = files.length === 1 ? path.join(tmpDir, files[0]) : null;
      }

      if (!filePath) return reject(new Error("file not found after download"));

      resolve(filePath);
    });
  });
}

async function downloadYtDlp(url, id, format, t, cookiesPath, denoPath) {
  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const tmpDir = path.join(DOWNLOADS_DIR, id);
  fs.mkdirSync(tmpDir, { recursive: true });

  const strategies = isYouTube
    ? youTubeStrategies(cookiesPath)
    : [{ cookiesPath, extractorArgs: null, headers: ["User-Agent:Mozilla/5.0"], noDeno: false }];

  let lastErr;
  for (const [i, strategy] of strategies.entries()) {
    const { noDeno, ...cfg } = strategy;
    const args = buildYtDlpArgs(format, { ...cfg, denoPath: noDeno ? null : denoPath });
    const env  = noDeno ? envWithoutDeno() : process.env;
    try {
      const filePath = await runYtDlpAttempt(url, tmpDir, args, env);
      return { filePath, tmpDir };
    } catch (err) {
      lastErr = err;
      console.error(`[manymedia] yt-dlp strategy ${i + 1}/${strategies.length} (${noDeno ? "no-deno" : "deno"}) failed: ${err.message}`);
      for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  const msg = lastErr?.code === "EACCES" ? t("error.noPermission")
    : lastErr?.code === "ENOENT"         ? t("error.notFound")
    : lastErr?.exitCode !== undefined    ? `${t("error.downloadFailed")} (exit code ${lastErr.exitCode})`
    :                                      `${t("error.startError")} ${lastErr?.message ?? "unknown"}`;
  throw new Error(msg);
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

async function downloadMedia(url, id, format, t, cookiesPath, denoPath) {
  const { url: resolvedUrl, audioUrl } = await resolveRedditUrl(url, cookiesPath);

  if (audioUrl) {
    return downloadRedditWithAudio(resolvedUrl, audioUrl, id, format);
  }

  return downloadYtDlp(resolvedUrl, id, format, t, cookiesPath, denoPath);
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
  const denoPath     = ctx.config.get("DENO_PATH");
  const id = `${format}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    ctx.download.enqueue(
      async () => {
        try {
          const { filePath, tmpDir } = await downloadMedia(url, id, format, t, cookiesPath, denoPath);
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

// Info/search resolution (no download) — used by dependents like playit to
// resolve a query/URL into { title, url, channel, duration, thumbnail }
// before deciding whether/what to download. Shares the same multi-strategy
// retry approach as the downloader.

function isUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildYtDlpInfoArgs({ cookiesPath = null, extractorArgs = null, headers = [], denoPath = null } = {}) {
  const args = [
    "--skip-download",
    "--no-warnings",
    "--restrict-filenames",
    "--match-filter", "duration < 720",
    "--ignore-errors",
  ];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  for (const header of headers) args.push("--add-header", header);
  if (denoPath) args.push("--js-runtimes", `deno:${denoPath}`);
  if (extractorArgs) args.push("--extractor-args", extractorArgs);
  args.push("--print", "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s");
  return args;
}

async function runYtDlpInfoAttempt(target, args, env) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", [target, ...args], { env }));
  } catch (err) {
    if (!err.stdout?.trim()) throw err;
    stdout = err.stdout;
  }
  return stdout.trim().split("\n")[0];
}

async function resolveInfo(query, ctx, t) {
  const target      = isUrl(query) ? query : `ytsearch10:${query}`;
  const cookiesPath = ctx.storage.resolve("cookies.txt");
  const denoPath    = ctx.config.get("DENO_PATH");
  const isYouTube   = target.includes("youtube.com") || target.includes("youtu.be") || target.startsWith("ytsearch");

  const strategies = isYouTube
    ? youTubeStrategies(cookiesPath)
    : [{ cookiesPath, extractorArgs: null, headers: ["User-Agent:Mozilla/5.0"], noDeno: false }];

  let lastErr;
  for (const [i, strategy] of strategies.entries()) {
    const { noDeno, ...cfg } = strategy;
    const args = buildYtDlpInfoArgs({ ...cfg, denoPath: noDeno ? null : denoPath });
    const env  = noDeno ? envWithoutDeno() : process.env;
    try {
      const line = await runYtDlpInfoAttempt(target, args, env);
      if (!line) throw new Error("empty result");

      const [url, title, uploader, duration, thumbnail] = line.split("\t");
      return {
        title,
        url,
        channel: uploader,
        duration: formatTime(Number(duration)),
        thumbnail: thumbnail && thumbnail !== "NA" ? thumbnail : null,
      };
    } catch (err) {
      lastErr = err;
      console.error(`[manymedia] yt-dlp info strategy ${i + 1}/${strategies.length} (${noDeno ? "no-deno" : "deno"}) failed: ${err.message}`);
    }
  }

  throw new Error(t("noResults"));
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

    if (!ctx.session.acquire()) {
      await msg.reply.text(t("error.lockedElsewhere"));
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
      })
      .finally(() => ctx.session.release());

    return;
  }
}

