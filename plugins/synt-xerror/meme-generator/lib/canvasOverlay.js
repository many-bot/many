import pkg from "@napi-rs/canvas";
const { createCanvas, loadImage } = pkg;
import { FONT_STACKS } from "./fonts.js";
import { makeMeasureCtx, fitFontSize, drawTextLine } from "./text.js";

const CLASSICO_CFG = { fontFamily: FONT_STACKS.classic, uppercase: true, strokeRatio: 0.06 };

function drawClassicoBar(ctx, text, width, height, y, align) {
  if (!text) return;
  const display = text.toUpperCase();

  const strokeMargin = height * 0.18 * CLASSICO_CFG.strokeRatio;
  const maxWidth = width * 0.92 - strokeMargin * 2;
  const maxHeight = height * 0.28;

  const measureCtx = makeMeasureCtx();
  const { size, lines, lineH } = fitFontSize(measureCtx, display, maxWidth, maxHeight, {
    minSize: Math.floor(height * 0.025),
    maxSize: Math.floor(height * 0.15),
    lineSpacing: 1.05,
    fontTemplate: (s) => `${s}px ${CLASSICO_CFG.fontFamily}`,
  });

  ctx.font = `${size}px ${CLASSICO_CFG.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = align === "top" ? "top" : "bottom";
  ctx.lineWidth = size * CLASSICO_CFG.strokeRatio;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  ctx.lineJoin = "round";

  lines.forEach((line, i) => {
    const offset = align === "top" ? i * lineH : -(lines.length - 1 - i) * lineH;
    const ly = y + offset;
    drawTextLine(ctx, line, width / 2, ly, { stroke: true, fontSize: size });
  });
}

function drawClassicoBars(ctx, width, height, { top, bottom }) {
  const margin = height * 0.02;
  if (top) drawClassicoBar(ctx, top, width, height, margin, "top");
  if (bottom) drawClassicoBar(ctx, bottom, width, height, height - margin, "bottom");
}

export async function compositeClassicoImage(imagePath, { top, bottom }) {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, img.width, img.height);
  drawClassicoBars(ctx, img.width, img.height, { top, bottom });
  return canvas.encode("png");
}

export async function renderClassicoOverlayPNG(width, height, { top, bottom }) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  drawClassicoBars(ctx, width, height, { top, bottom });
  return canvas.encode("png");
}

function computeSimplesBar(width, text) {
  const measureCtx = makeMeasureCtx();
  const vPadding = width * 0.06;
  const maxWidth = width * 0.9;
  const maxHeight = width * 1.2; // generous cap — real height comes from line count below

  const { size, lines, lineH } = fitFontSize(measureCtx, text, maxWidth, maxHeight, {
    minSize: Math.floor(width * 0.03),
    maxSize: Math.floor(width * 0.09),
    lineSpacing: 1.15,
    fontTemplate: (s) => `bold ${s}px ${FONT_STACKS.simples}`,
  });

  const barHeight = Math.round(vPadding * 2 + lines.length * lineH);
  return { size, lines, lineH, barHeight };
}

function drawSimplesBar(ctx, width, barHeight, size, lines, lineH) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, barHeight);

  ctx.font = `bold ${size}px ${FONT_STACKS.simples}`;
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const blockH = lines.length * lineH;
  const startY = (barHeight - blockH) / 2;

  lines.forEach((line, i) => {
    drawTextLine(ctx, line, width / 2, startY + i * lineH, { fontSize: size });
  });
}

export async function compositeSimplesImage(imagePath, text) {
  const img = await loadImage(imagePath);
  const { size, lines, lineH, barHeight } = computeSimplesBar(img.width, text);

  const canvas = createCanvas(img.width, img.height + barHeight);
  const ctx = canvas.getContext("2d");

  drawSimplesBar(ctx, img.width, barHeight, size, lines, lineH);
  ctx.drawImage(img, 0, barHeight);

  return canvas.encode("png");
}

export async function renderSimplesTopBarPNG(width, text) {
  const { size, lines, lineH, barHeight } = computeSimplesBar(width, text);
  const canvas = createCanvas(width, barHeight);
  const ctx = canvas.getContext("2d");

  drawSimplesBar(ctx, width, barHeight, size, lines, lineH);

  return { buffer: await canvas.encode("png"), barHeight };
}

const DESMOT_CFG = {
  outerMarginRatio: 0.05,
  minOuterMargin: 24,
  borderRatio: 0.012,
  minBorder: 4,
  titleMaxRatio: 0.11,
  titleMinRatio: 0.02,
  captionMaxRatio: 0.04,
  captionMinRatio: 0.015,
};

function computeDesmotLayout(imgW, imgH, title, caption) {
  const outerMargin = Math.max(Math.round(imgW * DESMOT_CFG.outerMarginRatio), DESMOT_CFG.minOuterMargin);
  const border = Math.max(Math.round(imgW * DESMOT_CFG.borderRatio), DESMOT_CFG.minBorder);

  const whiteW = imgW + border * 2;
  const whiteH = imgH + border * 2;
  const canvasW = whiteW + outerMargin * 2;
  const textAreaW = canvasW - outerMargin * 2;

  const measureCtx = makeMeasureCtx();

  let titleLines = [], titleSize = 0, titleLineH = 0;
  if (title) {
    const r = fitFontSize(measureCtx, title.toUpperCase(), textAreaW, imgW * 0.4, {
      minSize: Math.floor(imgW * DESMOT_CFG.titleMinRatio),
      maxSize: Math.floor(imgW * DESMOT_CFG.titleMaxRatio),
      lineSpacing: 1.15,
      fontTemplate: (s) => `bold ${s}px ${FONT_STACKS.serif}`,
    });
    titleLines = r.lines; titleSize = r.size; titleLineH = r.lineH;
  }

  let captionLines = [], captionSize = 0, captionLineH = 0;
  if (caption) {
    const r = fitFontSize(measureCtx, caption, textAreaW, imgW * 0.25, {
      minSize: Math.floor(imgW * DESMOT_CFG.captionMinRatio),
      maxSize: Math.floor(imgW * DESMOT_CFG.captionMaxRatio),
      lineSpacing: 1.25,
      fontTemplate: (s) => `${s}px ${FONT_STACKS.serif}`,
    });
    captionLines = r.lines; captionSize = r.size; captionLineH = r.lineH;
  }

  const titleBlockH = titleLines.length * titleLineH;
  const captionBlockH = captionLines.length * captionLineH;
  const hasText = titleLines.length > 0 || captionLines.length > 0;
  const gapTop = outerMargin * 0.9;
  const gapMid = titleLines.length && captionLines.length ? captionSize * 0.6 : 0;
  const textBlockH = hasText ? gapTop + titleBlockH + gapMid + captionBlockH + outerMargin : 0;

  const canvasH = whiteH + outerMargin * 2 + textBlockH;

  return {
    outerMargin, border, whiteW, whiteH, canvasW, canvasH,
    imageX: outerMargin + border, imageY: outerMargin + border,
    whiteX: outerMargin, whiteY: outerMargin,
    textStartY: whiteH + outerMargin * 2 + gapTop,
    gapMid,
    title: { lines: titleLines, size: titleSize, lineH: titleLineH },
    caption: { lines: captionLines, size: captionSize, lineH: captionLineH },
  };
}

function drawDesmotText(ctx, layout) {
  const { canvasW, textStartY, title, caption, gapMid } = layout;
  let y = textStartY;

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  if (title.lines.length) {
    ctx.font = `bold ${title.size}px ${FONT_STACKS.serif}`;
    ctx.fillStyle = "#fff";
    title.lines.forEach((line, i) => drawTextLine(ctx, line, canvasW / 2, y + i * title.lineH, { fontSize: title.size }));
    y += title.lines.length * title.lineH + gapMid;
  }

  if (caption.lines.length) {
    ctx.font = `${caption.size}px ${FONT_STACKS.serif}`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    caption.lines.forEach((line, i) => drawTextLine(ctx, line, canvasW / 2, y + i * caption.lineH, { fontSize: caption.size }));
  }
}

export async function compositeDesmotImage(imagePath, { title, caption }) {
  const img = await loadImage(imagePath);
  const layout = computeDesmotLayout(img.width, img.height, title, caption);

  const canvas = createCanvas(layout.canvasW, layout.canvasH);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, layout.canvasW, layout.canvasH);

  ctx.fillStyle = "#fff";
  ctx.fillRect(layout.whiteX, layout.whiteY, layout.whiteW, layout.whiteH);

  ctx.drawImage(img, layout.imageX, layout.imageY, img.width, img.height);

  drawDesmotText(ctx, layout);

  return canvas.encode("png");
}

export async function renderDesmotOverlayPNG(imgW, imgH, { title, caption }) {
  const layout = computeDesmotLayout(imgW, imgH, title, caption);
  const canvas = createCanvas(layout.canvasW, layout.canvasH);
  const ctx = canvas.getContext("2d");

  drawDesmotText(ctx, layout);

  return { buffer: await canvas.encode("png"), layout };
}
