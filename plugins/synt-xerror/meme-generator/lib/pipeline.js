import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { getMediaMessage, downloadMedia } from "./media.js";
import {
  compositeClassicoImage,
  renderClassicoOverlayPNG,
  compositeSimplesImage,
  renderSimplesTopBarPNG,
  compositeDesmotImage,
  renderDesmotOverlayPNG,
} from "./canvasOverlay.js";
import { probeMedia, overlayOnMedia, padTopAndOverlay, frameAndOverlay } from "./ffmpeg.js";

function formatFromMime(mime = "") {
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  if (mime.startsWith("video")) return "mp4";
  return "png";
}

async function prepareMedia(ctx, target, style, id, tempFiles) {
  // ffmpeg's webp decoder can't read animated WebP at all — it fails
  // outright on the ANIM container, not just on picking a frame. asMp4
  // asks the driver to convert an animated sticker to mp4 up front (it's a
  // no-op for anything that isn't an animated webp), so the overlay step
  // always gets something ffmpeg can decode, and the template stays a
  // proper video instead of freezing on the first frame.
  const media = await downloadMedia(target, { asMp4: true });
  if (!media) return null;

  const format = formatFromMime(media.mimetype);

  const inPath = ctx.storage.resolve(`${style}_in_${id}.${format}`);
  await writeFile(inPath, media.buffer);
  tempFiles.push(inPath);

  return { inPath, format };
}

async function replyOutput(msg, outPath, format) {
  if (format === "gif" || format === "mp4") await msg.reply.video(outPath);
  else await msg.reply.image(outPath);
}

// Shared shape behind classico/simples/desmot: validate media+text, prepare
// the input (with the animated-webp fix above), then either composite the
// text directly (still images) or render an overlay PNG and hand it to
// ffmpeg (video/gif/sticker). Only the render/overlay functions and their
// text params differ per style — see the wrappers below.
async function runMemeCommand(ctx, { style, params, hasText, compositeImage, renderOverlay, applyOverlay, t }) {
  const { msg } = ctx;

  const target = await getMediaMessage(ctx);
  if (!target) return void await msg.reply.text(t(`${style}.needMedia`));
  if (!hasText) return void await msg.reply.text(t(`${style}.needText`));

  ctx.download.enqueue(
    async () => {
      const id = randomUUID();
      const tempFiles = [];

      try {
        const prepared = await prepareMedia(ctx, target, style, id, tempFiles);
        if (!prepared) return void await msg.reply.text(t("downloadFailed"));
        const { inPath, format } = prepared;

        if (format === "png") {
          const outBuf = await compositeImage(inPath, params);
          const outPath = ctx.storage.resolve(`${style}_out_${id}.png`);
          await writeFile(outPath, outBuf);
          tempFiles.push(outPath);
          await msg.reply.image(outPath);
          return;
        }

        const { width, height } = await probeMedia(inPath);
        const { buffer: overlayBuf, extra = {} } = await renderOverlay(width, height, params);
        const overlayPath = ctx.storage.resolve(`${style}_overlay_${id}.png`);
        await writeFile(overlayPath, overlayBuf);
        tempFiles.push(overlayPath);

        const isSticker = format === "webp";
        const outputFormat = isSticker ? "jpg" : format;
        const outPath = ctx.storage.resolve(`${style}_out_${id}.${outputFormat}`);
        await applyOverlay(inPath, overlayPath, outPath, { format: outputFormat, singleFrame: isSticker, ...extra });
        tempFiles.push(outPath);

        await replyOutput(msg, outPath, outputFormat);
      } finally {
        for (const f of tempFiles) unlink(f).catch(() => {});
      }
    },
    async (err) => {
      ctx.log.error(`[${style}] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}

export async function runClassicoCommand(ctx, { top, bottom, t }) {
  return runMemeCommand(ctx, {
    style: "classico",
    params: { top, bottom },
    hasText: !!(top || bottom),
    compositeImage: compositeClassicoImage,
    renderOverlay: async (width, height, params) => ({
      buffer: await renderClassicoOverlayPNG(width, height, params),
    }),
    applyOverlay: overlayOnMedia,
    t,
  });
}

export async function runSimplesCommand(ctx, { text, t }) {
  return runMemeCommand(ctx, {
    style: "simples",
    params: { text },
    hasText: !!text,
    compositeImage: (inPath, { text }) => compositeSimplesImage(inPath, text),
    renderOverlay: async (width, _height, { text }) => {
      const { buffer, barHeight } = await renderSimplesTopBarPNG(width, text);
      return { buffer, extra: { barHeight } };
    },
    applyOverlay: padTopAndOverlay,
    t,
  });
}

export async function runDesmotCommand(ctx, { title, caption, t }) {
  return runMemeCommand(ctx, {
    style: "desmot",
    params: { title, caption },
    hasText: !!(title || caption),
    compositeImage: compositeDesmotImage,
    renderOverlay: async (width, height, params) => {
      const { buffer, layout } = await renderDesmotOverlayPNG(width, height, params);
      return { buffer, extra: { layout } };
    },
    applyOverlay: frameAndOverlay,
    t,
  });
}
