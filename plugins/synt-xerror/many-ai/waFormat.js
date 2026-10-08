// src/plugins/many-ai/waFormat.js
//
// Converts standard/GitHub-flavored markdown (what the model naturally
// writes) into WhatsApp's own formatting, in code — the model no longer
// needs to know WhatsApp's rules (see prompt.js, formatting skill removed).
//
// splitForSending() is the main entry point: it returns an ordered list of
// parts to send as separate WhatsApp messages. Everything else here is a
// pure text transform with no I/O.

const BOLD_PLACEHOLDER_OPEN = "\uE000";
const BOLD_PLACEHOLDER_CLOSE = "\uE001";

const CODE_FENCE_RE = /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADER_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm;
const BOLD_RE = /\*\*(?!\s)(.+?)(?<!\s)\*\*/g;
const ITALIC_RE = /\*(?!\s)(.+?)(?<!\s)\*/g;

function isTableRow(line) {
  return line.includes("|") && line.trim().length > 0;
}

function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function renderTableAsBlocks(headers, rows) {
  const blocks = rows.map((row) =>
    headers
      .map((h, i) => `*${h || `Col ${i + 1}`}:* ${row[i] ?? ""}`)
      .join("\n")
  );
  return blocks.join("\n\n");
}

function convertTables(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (
      isTableRow(lines[i]) &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      const headers = splitRow(lines[i]);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && isTableRow(lines[j]) && !isSeparatorRow(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out.push(renderTableAsBlocks(headers, rows));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

function convertLinks(text) {
  return text.replace(LINK_RE, (_, label, url) => `${label}: ${url}`);
}

function convertEmphasis(text) {
  let out = text.replace(BOLD_RE, (_, inner) => `${BOLD_PLACEHOLDER_OPEN}${inner}${BOLD_PLACEHOLDER_CLOSE}`);
  out = out.replace(ITALIC_RE, (_, inner) => `_${inner}_`);
  out = out
    .split(BOLD_PLACEHOLDER_OPEN)
    .join("*")
    .split(BOLD_PLACEHOLDER_CLOSE)
    .join("*");
  return out;
}

function convertHeaders(text) {
  return text.replace(HEADER_RE, (_, inner) => {
    const trimmed = inner.trim();
    if (trimmed.startsWith("*") && trimmed.endsWith("*")) return trimmed;
    return `*${trimmed}*`;
  });
}

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Runs every text-only transform (tables, links, headers, bold/italic) on a single segment. */
function formatTextSegment(text) {
  let out = text;
  out = convertLinks(out);
  out = convertEmphasis(out);
  out = convertTables(out);
  out = convertHeaders(out);
  return collapseBlankLines(out);
}

/** Splits a text segment on markdown images, keeping the surrounding text in order. */
function extractImages(text) {
  const parts = [];
  let lastIndex = 0;
  let match;
  IMAGE_RE.lastIndex = 0;
  while ((match = IMAGE_RE.exec(text))) {
    const before = text.slice(lastIndex, match.index);
    if (before) parts.push({ type: "text", content: before });
    parts.push({ type: "media", alt: match[1] || "", url: match[2] });
    lastIndex = match.index + match[0].length;
  }
  const rest = text.slice(lastIndex);
  if (rest) parts.push({ type: "text", content: rest });
  return parts;
}

/**
 * Splits raw markdown (as written by the model) into an ordered list of
 * parts ready to send as separate WhatsApp messages:
 *   { type: "text", content }
 *   { type: "code", content }
 *   { type: "media", url, alt }
 * Code blocks are always detached (own part, language tag stripped).
 * Images are always detached (own part) — the caller decides how to fetch
 * and send them based on content-type.
 */
export function splitForSending(raw) {
  const input = raw || "";
  const parts = [];
  let lastIndex = 0;
  let match;
  CODE_FENCE_RE.lastIndex = 0;
  while ((match = CODE_FENCE_RE.exec(input))) {
    const before = input.slice(lastIndex, match.index);
    if (before.trim()) {
      for (const p of extractImages(before)) {
        parts.push(p.type === "text" ? { type: "text", content: formatTextSegment(p.content) } : p);
      }
    }
    const code = match[1].replace(/\n$/, "");
    if (code.trim()) parts.push({ type: "code", content: code });
    lastIndex = match.index + match[0].length;
  }
  const rest = input.slice(lastIndex);
  if (rest.trim()) {
    for (const p of extractImages(rest)) {
      parts.push(p.type === "text" ? { type: "text", content: formatTextSegment(p.content) } : p);
    }
  }
  return parts.filter((p) => p.type !== "text" || p.content.trim().length > 0);
}

/** Convenience: formats a whole string as a single WhatsApp-ready text body,
 * with no detaching (code blocks keep triple-backtick fences inline, no
 * language tag; images are dropped). Useful for contexts that only ever
 * send one text message (progress bubbles, short confirmations). */
export function formatInline(raw) {
  const input = (raw || "").replace(IMAGE_RE, "");
  return formatTextSegment(input.replace(CODE_FENCE_RE, (_, code) => "```" + code.replace(/\n$/, "") + "```"));
}

