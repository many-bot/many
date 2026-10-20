import pkg from "@napi-rs/canvas";
const { createCanvas } = pkg;

export function makeMeasureCtx() {
  return createCanvas(1, 1).getContext("2d");
}

const GRAPHEME_SEGMENTER = typeof Intl !== "undefined" && Intl.Segmenter
  ? new Intl.Segmenter("en", { granularity: "grapheme" })
  : null;

// Splits a string into user-perceived characters so multi-codepoint emoji
// (ZWJ sequences, flags, skin-tone modifiers) are never torn in half.
export function toGraphemes(str) {
  if (GRAPHEME_SEGMENTER) return Array.from(GRAPHEME_SEGMENTER.segment(str), (s) => s.segment);
  return Array.from(str); // fallback: code points
}

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

// Splits text into alternating runs of emoji / non-emoji graphemes, without
// ever breaking a grapheme cluster apart.
export function splitEmojiRuns(text) {
  const runs = [];
  let current = "";
  let currentIsEmoji = null;
  for (const g of toGraphemes(text)) {
    const isEmoji = EMOJI_RE.test(g);
    if (currentIsEmoji !== null && isEmoji !== currentIsEmoji) {
      runs.push({ text: current, emoji: currentIsEmoji });
      current = "";
    }
    current += g;
    currentIsEmoji = isEmoji;
  }
  if (current) runs.push({ text: current, emoji: currentIsEmoji });
  return runs;
}

// NotoColorEmoji glyphs are positioned using their OWN font metrics, which
// disagree with the text font's metrics for the same textBaseline setting
// (measured: ~0px off for "bottom"/"alphabetic", but 0.5x+ fontSize off for
// "top", which is what most of this codebase draws with). Rather than guess
// a correction, we render a reference letter and an emoji offscreen once per
// (font, baseline) combo, scan the actual ink, and cache the measured ratio.
const EMOJI_OFFSET_CACHE = new Map();
const CALIBRATION_SIZE = 200;
const CALIBRATION_REF_CHAR = "H";
const CALIBRATION_EMOJI = "\u{1F600}"; // 😀

function scanInkVerticalCenter(font, baseline, ch) {
  const size = CALIBRATION_SIZE;
  const w = size * 3;
  const h = size * 3;
  const c = createCanvas(w, h);
  const cctx = c.getContext("2d");
  cctx.fillStyle = "#000";
  cctx.fillRect(0, 0, w, h);
  cctx.font = font;
  cctx.textBaseline = baseline;
  cctx.textAlign = "left";
  cctx.fillStyle = "#fff";
  const y = Math.floor(h / 2);
  cctx.fillText(ch, size, y);
  const data = cctx.getImageData(0, 0, w, h).data;
  let top = null;
  let bottom = null;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30) {
        if (top === null) top = yy;
        bottom = yy;
        break;
      }
    }
  }
  if (top === null) return 0;
  return (top - y + (bottom - y)) / 2;
}

function getEmojiOffsetRatio(ctx, baseline) {
  const calibrationFont = ctx.font.replace(/[\d.]+px/, `${CALIBRATION_SIZE}px`);
  const key = `${baseline}::${calibrationFont}`;
  if (EMOJI_OFFSET_CACHE.has(key)) return EMOJI_OFFSET_CACHE.get(key);

  let ratio = 0;
  try {
    const textCenter = scanInkVerticalCenter(calibrationFont, baseline, CALIBRATION_REF_CHAR);
    const emojiCenter = scanInkVerticalCenter(calibrationFont, baseline, CALIBRATION_EMOJI);
    ratio = (textCenter - emojiCenter) / CALIBRATION_SIZE;
  } catch {
    ratio = 0;
  }
  EMOJI_OFFSET_CACHE.set(key, ratio);
  return ratio;
}

// Draws one line of text, nudging emoji runs so their visual vertical center
// lines up with the surrounding text's, instead of sitting wherever
// NotoColorEmoji's own font metrics happen to place them for the current
// textBaseline. Keeps overall width/alignment identical to a plain
// fillText/strokeText call.
export function drawTextLine(ctx, text, x, y, { stroke = false, fontSize = 0 } = {}) {
  const runs = splitEmojiRuns(text);
  if (runs.length === 0 || (runs.length === 1 && !runs[0].emoji)) {
    if (stroke) ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    return;
  }

  const align = ctx.textAlign;
  const baseline = ctx.textBaseline;
  const offsetRatio = fontSize ? getEmojiOffsetRatio(ctx, baseline) : 0;
  ctx.textAlign = "left";

  const widths = runs.map((r) => ctx.measureText(r.text).width);
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  let cursor = x;
  if (align === "center") cursor = x - totalWidth / 2;
  else if (align === "right") cursor = x - totalWidth;

  runs.forEach((run, i) => {
    const ry = run.emoji ? y + fontSize * offsetRatio : y;
    if (stroke && !run.emoji) ctx.strokeText(run.text, cursor, ry);
    ctx.fillText(run.text, cursor, ry);
    cursor += widths[i];
  });

  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

function breakWordToFit(measureCtx, word, maxWidth) {
  const chunks = [];
  let chunk = "";
  for (const g of toGraphemes(word)) {
    const test = chunk + g;
    if (chunk === "" || measureCtx.measureText(test).width <= maxWidth) {
      chunk = test;
    } else {
      chunks.push(chunk);
      chunk = g;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

// A "word" counts as spam-like (keyboard mash, "AAAAAA", "kakakaka", repeated
// emoji) rather than a real word once it's long enough and its bigrams barely
// vary. Real long words (e.g. "otorrinolaringologista") have diverse bigrams
// and are never flagged, however long they are.
function isSpammyWord(word, { spamMinLength = 8, spamMaxBigramRatio = 0.35 } = {}) {
  const graphemes = toGraphemes(word);
  if (graphemes.length < spamMinLength) return false;
  const bigrams = [];
  for (let i = 0; i < graphemes.length - 1; i++) {
    bigrams.push(graphemes[i].toLowerCase() + graphemes[i + 1].toLowerCase());
  }
  if (bigrams.length === 0) return false;
  return new Set(bigrams).size / bigrams.length <= spamMaxBigramRatio;
}

function wrapParagraph(measureCtx, para, maxWidth, font, state, spamOpts) {
  const words = para.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (measureCtx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      if (measureCtx.measureText(word).width <= maxWidth) {
        line = word;
      } else {
        if (!isSpammyWord(word, spamOpts)) state.cut = true;
        const chunks = breakWordToFit(measureCtx, word, maxWidth);
        for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
        line = chunks[chunks.length - 1] || "";
      }
    }
  }
  lines.push(line); // keep even if empty, so a manual blank line stays a blank line
  return lines;
}

// state (optional, { cut: false }) is set to true if a real (non-spammy) word
// had to be chopped mid-grapheme because it didn't fit maxWidth on its own
// line. Cutting a spammy word never sets it, so fitFontSize won't shrink
// further just to avoid chopping a "kakakaka"/"AAAAAA"-style run.
export function wrapText(measureCtx, text, maxWidth, font, state = {}, spamOpts) {
  measureCtx.font = font;
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const lines = paragraphs.flatMap((para) => wrapParagraph(measureCtx, para, maxWidth, font, state, spamOpts));
  if (lines.length === 1 && lines[0] === "") return []; // whole input was empty: match prior behavior
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // trailing manual newline(s)
  return lines;
}

// Shrinks the font to fit maxHeight, preferring a smaller font over cutting
// a real word mid-grapheme: it first looks for the largest size that fits
// height WITHOUT cutting any real word, and only falls back to a cut (at the
// smallest size that fits, i.e. least-bad cut) if no size avoids it. Spammy
// "words" (long repetitive runs) are cut as soon as they don't fit, without
// forcing this search to keep shrinking.
export function fitFontSize(measureCtx, text, maxWidth, maxHeight, {
  minSize = 14,
  maxSize = 90,
  lineSpacing = 1.1,
  fontTemplate,
  spamMinLength,
  spamMaxBigramRatio,
}) {
  const spamOpts = { spamMinLength, spamMaxBigramRatio };
  let bestCut = null;
  for (let size = maxSize; size >= minSize; size -= 1) {
    const font = fontTemplate(size);
    const state = { cut: false };
    const lines = wrapText(measureCtx, text, maxWidth, font, state, spamOpts);
    const lineH = size * lineSpacing;
    if (lines.length * lineH <= maxHeight) {
      if (!state.cut) return { size, lines, lineH };
      bestCut = { size, lines, lineH };
    }
  }
  if (bestCut) return bestCut;
  const font = fontTemplate(minSize);
  return {
    size: minSize,
    lines: wrapText(measureCtx, text, maxWidth, font, {}, spamOpts),
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

