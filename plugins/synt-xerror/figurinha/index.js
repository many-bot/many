export const guardOptions = {
  timeout: false,
  cooldown: false,
  jitter:  false,
  typing:  false,
};

import fs           from "fs";
import path         from "path";
import { execFile }  from "child_process";
import { promisify } from "util";

import { createSticker, Exif } from "wa-sticker-formatter";
import WebP                     from "node-webpmux";
import sharp                     from "sharp";

const execFileAsync = promisify(execFile);

const DOWNLOADS_DIR    = path.resolve("downloads");
const FFMPEG           = "ffmpeg";
const MAX_STICKER_SIZE = 900 * 1024;
const SESSION_TIMEOUT  = 2 * 60 * 1000;
const MAX_MEDIA        = 30;
const BURST_WINDOW_MS  = 15 * 1000;
const BURST_THRESHOLD  = 5;

const sessions     = new Map();
const burstTracker = new Map();

function checkBurst(key, ts) {
  const hits = (burstTracker.get(key) || []).filter(t => ts - t < BURST_WINDOW_MS);
  hits.push(ts);

  if (hits.length > BURST_THRESHOLD) {
    burstTracker.delete(key);
    return { blocked: true };
  }

  burstTracker.set(key, hits);
  return { blocked: false };
}

function getSessionEndHint(mediaCount, t, prefix) {
  if (mediaCount === 1) {
    return `\n\n💡 ${t("session.hintDirectMode", { command: prefix + "f" })}`;
  }
  if (mediaCount >= MAX_MEDIA) {
    return `\n\n⚠️ ${t("session.hintMaxReached", { max: MAX_MEDIA })}`;
  }
  return "";
}

function ensureDir() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function cleanup(...files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { }
  }
}

// ffmpeg's own webp decoder cannot read animated WebP at all — it silently
// skips the ANIM/ANMF chunks ("image data not found") and the conversion
// fails, no matter what output you ask for. Workaround: demux the animation
// into individual single-frame WebP files first — those decode fine with
// ffmpeg since only the ANIM *container* trips it up — then hand ffmpeg a
// concat list with each frame's real delay. Detection/demux now come from
// ctx.utils.webp (kernel-side), no local node-webpmux calls needed for that.

async function extractVideoFrames(input, fps) {
  ensureDir();
  const framesDir = path.join(DOWNLOADS_DIR, `frames-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(framesDir, { recursive: true });
  await execFileAsync(FFMPEG, [
    "-i", input,
    "-vf", `fps=${fps},scale=512:512:flags=lanczos`,
    "-vsync", "0",
    "-y", path.join(framesDir, "frame-%04d.png"),
  ]);
  const files = fs.readdirSync(framesDir).sort().map(f => path.join(framesDir, f));
  return { framesDir, files };
}

async function resizeImage(input, output) {
  await execFileAsync(FFMPEG, ["-i", input, "-vf", "scale=512:512:flags=lanczos", "-y", output]);
}

function classifyError(err, t) {
  const m = err.message ?? "";
  if (m === t("error.tooLarge") || /900\s*KB/i.test(m)) return t("error.tooLarge");
  if (/invalid|corrupt|moov|codec|decode|unsupported/i.test(m))  return t("error.invalidFormat");
  return t("error.conversionFailed");
}

async function buildStaticSticker(inputPath, t, senderName, stickerAuthor) {
  for (const quality of [80, 60, 40, 20]) {
    const buf = await createSticker(fs.readFileSync(inputPath), {
      pack:       senderName,
      author:      stickerAuthor,
      type:       "STATIC",
      categories: ["🤖"],
      quality,
    });
    if (buf.length <= MAX_STICKER_SIZE) return buf;
  }
  throw new Error(t("error.tooLarge"));
}

// wa-sticker-formatter's createSticker(), for animated media, always pipes
// the image through sharp's own animated-WebP writer (resize + re-encode
// the whole multi-frame image in one sharp .webp() call) — that's a second
// full recompression pass on top of whatever we hand it, and it's where
// the progressive artifacts actually came from: sharp/libvips' animated
// WebP writer does the same kind of inter-frame optimization regardless of
// how clean the frames we feed it are. So for animated stickers we skip
// createSticker()/convert() entirely: build the WebP ourselves frame by
// frame (each frame encoded independently, no dependency on prior frames)
// and use wa-sticker-formatter's own Exif class — which only writes the
// pack/author/emoji metadata via node-webpmux, no pixel re-encode — to
// stamp the result. Our own quality loop replaces createSticker()'s.
async function muxAnimatedFrames(frameSources, delays, quality) {
  const frames = [];
  for (let i = 0; i < frameSources.length; i++) {
    const buf = await sharp(frameSources[i])
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality, lossless: false })
      .toBuffer();
    frames.push(await WebP.Image.generateFrame({ buffer: buf, delay: delays[i] }));
  }
  return WebP.Image.save(null, { frames, width: 512, height: 512, loops: 0 });
}

async function buildAnimatedSticker(frameSources, delays, t, senderName, stickerAuthor) {
  for (const quality of [80, 60, 40, 20]) {
    const muxed = await muxAnimatedFrames(frameSources, delays, quality);
    const buf   = await new Exif({ pack: senderName, author: stickerAuthor, categories: ["🤖"] }).add(muxed);
    if (buf.length <= MAX_STICKER_SIZE) return buf;
  }
  throw new Error(t("error.tooLarge"));
}

function isGifMedia(media, isGif) {
  return (
    media.mimetype === "image/gif" ||
    (media.mimetype === "video/mp4" && isGif)
  );
}

function isSupported(media, gif) {
  return (
    media.mimetype?.startsWith("image/") ||
    media.mimetype?.startsWith("video/") ||
    gif
  );
}

// Baixa e valida a mídia de uma entry (msg, quoted ou item do histórico),
// unificando a checagem que antes era repetida (com pequenas divergências,
// ex. `quoted.isGif ?? false` vs `entry.isGif` sem fallback) em 3 lugares.
async function fetchValidMedia(entry) {
  if (!entry?.hasMedia) return null;

  const media = await entry.downloadMedia();
  if (!media) return null;

  const gif = isGifMedia(media, entry.isGif ?? false);
  if (!isSupported(media, gif)) return null;

  return { media, isGif: gif };
}

// Enfileira um job pesado na fila do kernel garantindo que DOWNLOADS_DIR
// seja limpo mesmo se `work` lançar exceção — antes a limpeza só rodava
// no caminho de sucesso, e uma falha no meio do processamento deixava
// arquivos temporários acumulando em disco.
function runQueued(ctx, t, errLabel, work, onSettled) {
  ctx.download.enqueue(
    async () => {
      try {
        await work();
      } finally {
        ctx.utils.emptyFolder(DOWNLOADS_DIR);
        onSettled?.();
      }
    },
    async (err) => {
      ctx.log.error(`${errLabel}: ${err.message}`);
      await ctx.send.text(t("error.conversionFailed"));
      onSettled?.();
    }
  );
}

const STICKER_FPS = 15;

async function processarUmaMedia(media, gif, ctx, t, stickerName, stickerAuthor) {
  ensureDir();

  const ext        = media.mimetype.split("/")[1];
  let   isAnimated = media.mimetype.startsWith("video/") || gif;

  const id          = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath   = path.join(DOWNLOADS_DIR, `${id}.${ext}`);
  const resizedPath = path.join(DOWNLOADS_DIR, `${id}-scaled.${ext}`);
  let   framesDir; // only used for video/gif input, cleaned up below

  try {
    fs.writeFileSync(inputPath, Buffer.from(media.data, "base64"));

    // Stickers are always reported as "image/webp" whether animated or
    // not — media.isAnimated already resolves that for us (framework-side),
    // no need to re-read the file we just wrote.
    if (!isAnimated && ext === "webp") {
      isAnimated = media.isAnimated;
    }

    let buf;
    if (isAnimated) {
      let frameSources, delays;
      if (ext === "webp") {
        const frames = await ctx.utils.webp.demuxFrames(inputPath);
        frameSources = frames.map(f => f.data);
        delays       = frames.map(f => f.delayMs);
      } else {
        const extracted = await extractVideoFrames(inputPath, STICKER_FPS);
        framesDir    = extracted.framesDir;
        frameSources = extracted.files;
        delays       = frameSources.map(() => Math.round(1000 / STICKER_FPS));
      }
      buf = await buildAnimatedSticker(frameSources, delays, t, stickerName, stickerAuthor);
    } else {
      await resizeImage(inputPath, resizedPath);
      buf = await buildStaticSticker(resizedPath, t, stickerName, stickerAuthor);
    }

    await ctx.send.sticker(buf);
    return { ok: true };
  } catch (err) {
    ctx.log.error(`Sticker error: ${err.message}`);
    return { ok: false, reason: classifyError(err, t) };
  } finally {
    cleanup(inputPath, resizedPath);
    if (framesDir) fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

// Uses ctx.utils.webp.demuxFrames (see the note above for why we can't
// just point ffmpeg at the animated webp directly) to get each frame +
// its real delay, writes them as PNGs, and feeds ffmpeg a concat list
// with per-frame duration so playback speed matches the original sticker.
async function animatedWebpToVideo(ctx, inputPath, outputPath) {
  const frames       = await ctx.utils.webp.demuxFrames(inputPath);
  const frameSources = frames.map(f => f.data);
  const delays       = frames.map(f => f.delayMs);

  const framesDir = path.join(DOWNLOADS_DIR, `extract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    const listLines = [];
    let lastFrame;
    for (let i = 0; i < frameSources.length; i++) {
      const framePath = path.join(framesDir, `frame-${String(i).padStart(4, "0")}.png`);
      await sharp(frameSources[i]).png().toFile(framePath);
      listLines.push(`file '${framePath}'`, `duration ${(delays[i] / 1000).toFixed(3)}`);
      lastFrame = framePath;
    }
    // ffmpeg's concat demuxer ignores the very last "duration" line, so the
    // final frame has to be listed once more with no duration after it.
    listLines.push(`file '${lastFrame}'`);

    const listPath = path.join(framesDir, "list.txt");
    fs.writeFileSync(listPath, listLines.join("\n"));

    await execFileAsync(FFMPEG, [
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", "scale=512:512:flags=lanczos,format=yuv420p",
      "-c:v", "libx264",
      "-movflags", "+faststart",
      "-y", outputPath,
    ]);
  } finally {
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

// ctx.send.video()/ctx.send.image() take a file path, not a Buffer — unlike
// ctx.send.sticker(). Passing a Buffer made it get treated as a path
// internally, which is what threw "argument 'path' must be a string...".
async function extrairMedia(media, ctx, t) {
  ensureDir();
  const id        = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(DOWNLOADS_DIR, `${id}.webp`);
  let   outputPath;

  try {
    fs.writeFileSync(inputPath, Buffer.from(media.data, "base64"));

    if (media.isAnimated) {
      outputPath = path.join(DOWNLOADS_DIR, `${id}-extracted.mp4`);
      await animatedWebpToVideo(ctx, inputPath, outputPath);
      await ctx.send.video(outputPath);
    } else {
      outputPath = path.join(DOWNLOADS_DIR, `${id}-extracted.png`);
      await sharp(inputPath).png().toFile(outputPath);
      await ctx.send.image(outputPath);
    }

    return { ok: true };
  } catch (err) {
    ctx.log.error(`Extract error: ${err.message}`);
    return { ok: false, reason: classifyError(err, t) };
  } finally {
    cleanup(inputPath, outputPath);
  }
}

export default async function (ctx) {
  // Evita auto-gatilho e loops infinitos no processamento de texto/mídia
  if (ctx.msg.fromMe) return;

  const { msg, chat } = ctx;
  const { t }         = ctx.i18n.createT(import.meta.url);
  const prefix        = ctx.config.get("CMD_PREFIX");
  const chatId        = chat.id;
  const fName = ctx.settings.global.get(`FIG_PACK:${msg.sender}`, null)
    || ctx.config.get("FIG_NAME", null)
    || `${msg.senderName}\n`;
  const fAuthor = ctx.settings.global.get(`FIG_AUTHOR:${msg.sender}`, null)
    || ctx.config.get("FIG_AUTHOR", null)
    || `\nManyBot\nwww.manybot.org`;

  if (msg.is("figurinha"))
    msg.reply.text(t("error.cmdDeprecated", { old: prefix + "figurinha", new: prefix + "f" }));

  const isCmd = msg.is("f");

  if (!isCmd) return;

  const sub        = msg.args[0];
  const loteCmd    = `${prefix}f lote`;
  const loteAction = sub === "lote" ? msg.args[1] : null;

  // ── figurinha lote parar ─────────────────────────────────
  if (sub === "parar" || loteAction === "parar") {
    const session = sessions.get(chatId);
    if (!session) {
      await ctx.msg.reply.text(t("session.noneActive", { command: loteCmd }));
      return;
    }
    clearTimeout(session.timeout);
    sessions.delete(chatId);
    ctx.session.release();
    await ctx.msg.reply.text(t("session.stopped"));
    return;
  }

  // ── figurinha editar metadados ───────────────────────────
  if (sub === "edit") {
    const field = msg.args[1];

    if (field === "reset") {
      ctx.settings.global.delete(`FIG_PACK:${msg.sender}`);
      ctx.settings.global.delete(`FIG_AUTHOR:${msg.sender}`);
      await ctx.msg.reply.text(t("edit.resetDone"));
      return;
    }

    // args.join() colapsa quebras de linha reais em espaço (args é
    // dividido por whitespace, incluindo \n) — extrai do body cru
    // pra permitir pack/autor com múltiplas linhas.
    const marker = `edit ${field} `;
    const idx    = msg.body.indexOf(marker);
    const value  = idx === -1 ? "" : msg.body.slice(idx + marker.length).trim().replace(/\\{1,2}n/g, "\n");

    if (field !== "pack" && field !== "autor") {
      await ctx.msg.reply.text(t("edit.usage", { command: prefix + "f" }));
      return;
    }
    if (!value) {
      await ctx.msg.reply.text(t("edit.missingValue", { field }));
      return;
    }

    const key = field === "pack" ? `FIG_PACK:${msg.sender}` : `FIG_AUTHOR:${msg.sender}`;
    ctx.settings.global.set(key, value);
    await ctx.msg.reply.text(t("edit.saved", { field, value }));
    return;
  }

  // ── figurinha lote criar ─────────────────────────────────
  if (loteAction === "criar") {
    const session = sessions.get(chatId);
    if (!session) {
      await ctx.msg.reply.text(t("session.noneActive", { command: loteCmd }));
      return;
    }

    const medias = [];
    for (const entry of chat.history) {
      if (entry.timestamp < session.startTs) continue;
      if (entry.sender !== session.author) continue;

      const result = await fetchValidMedia(entry);
      if (!result) continue;

      medias.push(result);
      if (medias.length >= MAX_MEDIA) break;
    }

    if (!medias.length) {
      await ctx.msg.reply.text(t("session.noMedia"));
      return;
    }

    clearTimeout(session.timeout);
    sessions.delete(chatId);

    await ctx.msg.reply.text(t("session.generating"));

    // Processamento pesado do lote enviado para a fila gerenciada pelo kernel
    runQueued(ctx, t, "Erro ao processar lote", async () => {
      const results = [];
      for (const { media, isGif } of medias) {
        results.push(await processarUmaMedia(media, isGif, ctx, t, fName, fAuthor));
      }

      const ok   = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok).length;
      const summary = `✅ ${ok} ${t("session.created")}, ❌ ${fail} ${t("session.failed")}`;
      const hint = getSessionEndHint(medias.length, t, prefix);

      if (fail > 0) {
        const lines = results
          .map((r, i) => !r.ok ? `• ${i + 1}. ${r.reason}` : null)
          .filter(Boolean)
          .join("\n");
        await ctx.send.text(`${summary}\n\n${t("session.failDetail")}\n${lines}${hint}`);
      } else {
        await ctx.send.text(`${summary}${hint}`);
      }
    }, () => ctx.session.release());
    return;
  }

  // ── figurinha lote → abre lote ───────────────────────────
  if (sub === "lote") {
    if (sessions.has(chatId)) {
      await ctx.msg.reply.text(t("session.alreadyOpen", { command: `${loteCmd} criar` }));
      return;
    }

    if (!ctx.session.acquire()) {
      await ctx.msg.reply.text(t("session.lockedElsewhere"));
      return;
    }

    const timeout = setTimeout(async () => {
      sessions.delete(chatId);
      ctx.session.release();
      try {
        await ctx.send.text(`${t("session.expired")} \`${loteCmd}\` ${t("session.expiredEnd")}`);
      } catch {}
    }, SESSION_TIMEOUT);

    sessions.set(chatId, {
      author: msg.sender,
      startTs: msg.timestamp,
      timeout,
    });

    await ctx.msg.reply.text(t("session.started", { command: `${loteCmd} criar`, cancel: `${loteCmd} parar` }));
    return;
  }

  // ── figurinha extrair ────────────────────────────────────
  if (sub === "extrair") {
    let media = null;

    if (msg.hasReply) {
      const quoted = await msg.getReply();
      if (quoted?.hasMedia) media = await quoted.downloadMedia();
    }
    if (!media && msg.hasMedia) {
      media = await msg.downloadMedia();
    }

    if (!media || media.mimetype !== "image/webp") {
      await ctx.msg.reply.text(t("extract.noSticker"));
      return;
    }

    runQueued(ctx, t, "Erro ao extrair mídia", async () => {
      const result = await extrairMedia(media, ctx, t);
      if (!result.ok) await ctx.msg.reply.text(`❌ ${result.reason}`);
    });
    return;
  }

  // ── figurinha com mídia direta ───────────────────────────
  const mediasParaCriar = [];

  if (msg.hasMedia) {
    const result = await fetchValidMedia(msg);
    if (result) mediasParaCriar.push(result);
  }

  if (msg.hasReply) {
    const quoted = await msg.getReply();
    const result = await fetchValidMedia(quoted);
    if (result) mediasParaCriar.push(result);
  }

  if (mediasParaCriar.length > 0) {
    if (msg.hasMedia) {
      const burstKey = `${chatId}:${msg.sender}`;

      if (checkBurst(burstKey, msg.timestamp).blocked) {
        await ctx.msg.reply.text(t("session.burstDetected", { command: prefix + "f", lote: loteCmd, batch: `${loteCmd} criar` }));
        return;
      }
    }

    if (!ctx.session.acquire()) {
      await ctx.msg.reply.text(t("session.lockedElsewhere"));
      return;
    }

    await ctx.msg.reply.text(t("session.generatingOne"));

    // Mídias imediatas também passam pela fila para não bloquear o Event Loop
    runQueued(ctx, t, "Erro ao criar figurinha direta", async () => {
      for (const { media, isGif } of mediasParaCriar) {
        const result = await processarUmaMedia(media, isGif, ctx, t, fName, fAuthor);
        if (!result.ok) await ctx.msg.reply.text(`❌ ${result.reason}`);
      }
    }, () => ctx.session.release());
    return;
  }

  await ctx.msg.reply.text(t("error.sendMedia", { lote: loteCmd, batch: `${loteCmd} criar` }));
}

