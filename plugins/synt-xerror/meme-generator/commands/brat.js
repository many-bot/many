import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import pkg from "@napi-rs/canvas";
const { createCanvas } = pkg;
import { FONT_STACKS } from "../lib/fonts.js";
import { makeMeasureCtx, fitFontSize, justifyLine } from "../lib/text.js";
import { getReplyText } from "../lib/media.js";

const SIZE = 1080;
const RENDER_SCALE = 0.40;
const BLUR_PX = 1;
const JPEG_QUALITY = 68;

function drawBrat(text, bg) {
  const renderSize = Math.floor(SIZE * RENDER_SCALE);
  const canvas = createCanvas(renderSize, renderSize);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, renderSize, renderSize);

  const padding = renderSize * 0.1;
  const maxWidth = renderSize - padding * 2;
  const maxHeight = renderSize - padding * 2;

  const measureCtx = makeMeasureCtx();
  const { size, lines, lineH } = fitFontSize(measureCtx, text, maxWidth, maxHeight, {
    minSize: Math.floor(renderSize * 0.03),
    maxSize: Math.floor(renderSize * 0.22),
    lineSpacing: 1.05,
    fontTemplate: (s) => `${s}px ${FONT_STACKS.brat}`,
  });

  const font = `${size}px ${FONT_STACKS.brat}`;
  ctx.font = font;
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const blockH = lines.length * lineH;
  const startY = (renderSize - blockH) / 2;

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    const isLastLine = i === lines.length - 1 || lines.length === 1;

    if (isLastLine) {
      ctx.fillText(line, padding, y);
      return;
    }

    for (const { word, x } of justifyLine(measureCtx, line, maxWidth, font)) {
      ctx.fillText(word, padding + x, y);
    }
  });

  return canvas;
}

const VARIANTS = {
  brat: { bg: "#fff", needTextKey: "brat.needText" },
  brat2: { bg: "#89cc00", needTextKey: "brat2.needText" },
};

export default async function brat(ctx, t) {
  const { msg } = ctx;
  const style = msg.is("brat") ? "brat" : msg.is("brat2") ? "brat2" : null;
  if (!style) return;
  const { bg, needTextKey } = VARIANTS[style];

  let text = msg.args.join(" ").trim();
  if (!text) text = await getReplyText(ctx);
  if (!text) return void await msg.reply.text(t(needTextKey));

  ctx.download.enqueue(
    async () => {
      const outputPath = ctx.storage.resolve(`${style}_${randomUUID()}.jpg`);

      try {
        const small = drawBrat(text, bg);
        const upscaled = createCanvas(SIZE, SIZE);
        const upCtx = upscaled.getContext("2d");
        upCtx.imageSmoothingEnabled = true;
        upCtx.filter = `blur(${BLUR_PX}px)`;
        upCtx.drawImage(small, 0, 0, SIZE, SIZE);

        const buffer = await upscaled.encode("jpeg", JPEG_QUALITY);
        await writeFile(outputPath, buffer);
        await msg.reply.image(outputPath);
      } finally {
        unlink(outputPath).catch(() => {});
      }
    },
    async (err) => {
      ctx.log.error(`[${style}] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}
