import pkg from "@napi-rs/canvas";
const { GlobalFonts } = pkg;
import { join } from "path";
import { existsSync } from "fs";
import { PLUGIN_ROOT } from "./paths.js";

const FONT_DEFS = [
  { path: join(PLUGIN_ROOT, "LiberationSerif-Regular.ttf"), family: "QuoteSerif" },
  { path: join(PLUGIN_ROOT, "LiberationSerif-Italic.ttf"), family: "QuoteSerif" },
  { path: join(PLUGIN_ROOT, "LiberationSerif-Bold.ttf"), family: "QuoteSerif" },
  { path: join(PLUGIN_ROOT, "LiberationSerif-BoldItalic.ttf"), family: "QuoteSerif" },
  { path: join(PLUGIN_ROOT, "NotoColorEmoji.ttf"), family: "QuoteEmoji" },
  { path: join(PLUGIN_ROOT, "DejaVuSans.ttf"), family: "QuoteSans" },
  { path: join(PLUGIN_ROOT, "unifont.otf"), family: "QuoteUni" },
  { path: join(PLUGIN_ROOT, "STIXTwoMath-Regular.ttf"), family: "QuoteMath" },
  { path: join(PLUGIN_ROOT, "NotoSansBamum-Regular.ttf"), family: "QuoteBamum" },
  { path: join(PLUGIN_ROOT, "impact.ttf"), family: "MemeImpact" },
  { path: join(PLUGIN_ROOT, "futura-condensed-extrabold.ttf"), family: "MemeFutura" },
  { path: join(PLUGIN_ROOT, "arial-narrow.ttf"), family: "MemeArialNarrow" },
];

export function registerFonts(log) {
  for (const { path, family } of FONT_DEFS) {
    if (existsSync(path)) {
      const ok = GlobalFonts.registerFromPath(path, family);
      if (!ok) log?.warn?.(`[meme] Falha ao registrar fonte: ${path}`);
    } else {
      log?.warn?.(`[meme] Fonte nao encontrada: ${path}`);
    }
  }
}

const UNICODE_FALLBACK = `"QuoteEmoji", "QuoteSans", "QuoteMath", "QuoteBamum", "QuoteUni"`;

export const FONT_STACKS = {
  serif: `"QuoteSerif", ${UNICODE_FALLBACK}`,
  author: `"QuoteSans", "QuoteEmoji", "QuoteSerif", "QuoteMath", "QuoteBamum", "QuoteUni"`,
  classic: `"MemeImpact", ${UNICODE_FALLBACK}`,
  simples: `"MemeFutura", ${UNICODE_FALLBACK}`,
  brat: `"MemeArialNarrow", ${UNICODE_FALLBACK}`,
};
