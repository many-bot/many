import pkg from "@napi-rs/canvas";
const { createCanvas } = pkg;

export function makeMeasureCtx() {
  return createCanvas(1, 1).getContext("2d");
}

export function wrapText(measureCtx, text, maxWidth, font) {
  measureCtx.font = font;
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (measureCtx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function fitFontSize(measureCtx, text, maxWidth, maxHeight, {
  minSize = 14,
  maxSize = 90,
  lineSpacing = 1.1,
  fontTemplate,
}) {
  for (let size = maxSize; size >= minSize; size -= 1) {
    const font = fontTemplate(size);
    const lines = wrapText(measureCtx, text, maxWidth, font);
    const lineH = size * lineSpacing;
    if (lines.length * lineH <= maxHeight) return { size, lines, lineH };
  }
  const font = fontTemplate(minSize);
  return {
    size: minSize,
    lines: wrapText(measureCtx, text, maxWidth, font),
    lineH: minSize * lineSpacing,
  };
}

export function justifyLine(measureCtx, line, targetWidth, font) {
  measureCtx.font = font;
  const words = line.split(" ").filter(Boolean);
  if (words.length <= 1) return [{ word: line, x: 0 }];

  const wordsWidth = words.reduce((sum, w) => sum + measureCtx.measureText(w).width, 0);
  const gap = (targetWidth - wordsWidth) / (words.length - 1);

  let x = 0;
  const placed = [];
  for (const w of words) {
    placed.push({ word: w, x });
    x += measureCtx.measureText(w).width + gap;
  }
  return placed;
}
