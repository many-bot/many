import pkg from "@napi-rs/canvas";
const { createCanvas, loadImage } = pkg;
import { unlink, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID, createHash } from "crypto";
import { existsSync } from "fs";
import { PLUGIN_ROOT } from "../lib/paths.js";
import { FONT_STACKS } from "../lib/fonts.js";
import { makeMeasureCtx, fitFontSize, drawTextLine } from "../lib/text.js";

const measureCtx = makeMeasureCtx();

function truncateAuthor(text, maxWidth, font) {
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && measureCtx.measureText(truncated + "…").width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "…";
}

function authorColor(author) {
  const hex = createHash("md5").update(author).digest("hex");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return [Math.floor(r * 0.28), Math.floor(g * 0.28), Math.floor(b * 0.28)];
}

function getInitial(author) {
  return author.replace(/^[\u2014\u2013\-\s]+/, "").trim()[0]?.toUpperCase() ?? "?";
}

async function drawPhoto(ctx, imgW, height, imagePath) {
  const photo = await loadImage(imagePath);
  const offscreen = createCanvas(imgW, height);
  const offCtx = offscreen.getContext("2d");

  const scale = Math.max(imgW / photo.width, height / photo.height);
  const sw = photo.width * scale;
  const sh = photo.height * scale;
  const sx = (imgW - sw) / 2;
  const sy = (height - sh) / 2;

  offCtx.drawImage(photo, sx, sy, sw, sh);

  const imageData = offCtx.getImageData(0, 0, imgW, height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  offCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(offscreen, 0, 0);
}

function drawPlaceholder(ctx, imgW, height, author) {
  const [r, g, b] = authorColor(author);
  const cx = imgW / 2;
  const cy = height / 2;

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(imgW, height) * 0.75);
  grad.addColorStop(0, `rgb(${r * 3}, ${g * 3}, ${b * 3})`);
  grad.addColorStop(1, `rgb(${r}, ${g}, ${b})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, imgW, height);

  const initial = getInitial(author);
  const fontSize = Math.floor(height * 0.65);
  ctx.font = `bold ${fontSize}px ${FONT_STACKS.serif}`;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(initial, cx, cy + fontSize * 0.05);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

async function render(config) {
  const { width, height, imgPortion, fadeWidth, padding } = config;

  const SCALE = 2;
  const canvas = createCanvas(width * SCALE, height * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  const imgW = Math.floor(width * imgPortion);
  const textX = imgW + padding;
  const textAreaW = width - imgW - padding * 2;

  const AUTHOR_FONT_SIZE = 30;
  const SEP_GAP_TOP = 28;
  const SEP_GAP_BOTTOM = 18;
  const AUTHOR_H = AUTHOR_FONT_SIZE * 1.4;
  const SEP_BLOCK_H = SEP_GAP_TOP + 1 + SEP_GAP_BOTTOM;
  const QUOTE_MAX_H = height - padding * 2 - SEP_BLOCK_H - AUTHOR_H;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  const hasImage = config.imagePath && existsSync(config.imagePath);
  if (hasImage) {
    await drawPhoto(ctx, imgW, height, config.imagePath);
  } else {
    drawPlaceholder(ctx, imgW, height, config.author);
  }

  const fadeX = imgW - fadeWidth;
  const grad = ctx.createLinearGradient(fadeX, 0, imgW, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(fadeX, 0, fadeWidth + 1, height);

  const { size: quoteFontSize, lines, lineH } = fitFontSize(measureCtx, config.quote, textAreaW, QUOTE_MAX_H, {
    minSize: 16,
    maxSize: 72,
    lineSpacing: 1.40,
    fontTemplate: (s) => `italic ${s}px ${FONT_STACKS.serif}`,
  });

  const blockH = lines.length * lineH;
  const totalBlockH = blockH + SEP_BLOCK_H + AUTHOR_H;
  const startY = Math.floor((height - totalBlockH) / 2);

  const QUOTE_TEXT_OFFSET_Y = 40;

  ctx.font = `italic ${quoteFontSize}px ${FONT_STACKS.serif}`;
  ctx.fillStyle = "rgba(230,230,230,0.95)";
  ctx.textBaseline = "top";

  for (const [i, line] of lines.entries()) {
    drawTextLine(ctx, line, textX, startY + QUOTE_TEXT_OFFSET_Y + i * lineH, { fontSize: quoteFontSize });
  }

  const quoteMarkSize = Math.min(quoteFontSize * 8.2, 200);
  ctx.font = `italic ${quoteMarkSize}px ${FONT_STACKS.serif}`;
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.textBaseline = "top";
  ctx.fillText("\u201c", textX - quoteMarkSize * 0.12, startY - quoteMarkSize * 0.30);

  const sepY = startY + blockH + SEP_GAP_TOP;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(textX, sepY);
  ctx.lineTo(textX + 100, sepY);
  ctx.stroke();

  const authorFont = `${AUTHOR_FONT_SIZE}px ${FONT_STACKS.author}`;
  const authorFull = `${config.author}, ${new Date().getFullYear()}`;
  const authorText = truncateAuthor(authorFull, textAreaW, authorFont);

  ctx.font = authorFont;
  ctx.fillStyle = "rgba(160,160,160,0.9)";
  ctx.textBaseline = "top";
  drawTextLine(ctx, authorText, textX, sepY + SEP_GAP_BOTTOM, { fontSize: AUTHOR_FONT_SIZE });

  const buffer = await canvas.encode("png");
  await writeFile(config.output, buffer);
}

export default async function quote(ctx, t) {
  const { msg } = ctx;

  if (!msg.is("quote")) return;

  if (!msg.hasReply) {
    await msg.reply.text(t("quote.needReply"));
    return;
  }

  const reply = await msg.getReply();
  const replyBody = reply?.body?.trim();
  const replySender = reply?.sender;

  if (!replyBody) {
    await msg.reply.text(t("quote.replyNoText"));
    return;
  }

  const replyContact = await ctx.contacts.get(replySender).catch(() => null);
  const replyAuthor = replyContact?.pushname ?? replyContact?.name ?? replySender.split("@")[0] ?? "??";
  const contactId = replySender || null;

  ctx.download.enqueue(
    async () => {
      const id = randomUUID();
      const picPath = ctx.storage.resolve(`pic_${id}.png`);
      const outputPath = ctx.storage.resolve(`output_${id}.png`);
      let hasPic = false;
      let hasOutput = false;

      try {
        if (contactId) {
          hasPic = !!(await ctx.contacts.getPfpPath(contactId, picPath).catch(() => null));
        }

        await render({
          width: 1200,
          height: 600,
          imgPortion: 0.50,
          fadeWidth: 300,
          padding: 60,
          quote: replyBody,
          author: replyAuthor,
          imagePath: hasPic ? picPath : join(PLUGIN_ROOT, "fallback-profile.png"),
          output: outputPath,
        });

        hasOutput = true;
        await msg.reply.image(outputPath);
      } finally {
        if (hasPic) unlink(picPath).catch(() => {});
        if (hasOutput) unlink(outputPath).catch(() => {});
      }
    },
    async (err) => {
      ctx.log.error(`[quote] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}
