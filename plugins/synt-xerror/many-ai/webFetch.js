// src/plugins/many-ai/webFetch.js
// FETCH tool — reads a specific URL (from a SEARCH result or a link the
// user shared) and returns its readable text. No HTML parser dependency:
// a regex strip is good enough for "give the model the page text", and
// keeps this plugin dependency-free like the rest of search.js.

import { fetchWithTimeout } from "./httpUtils.js";

const FETCH_TIMEOUT_MS = 10000; // pages are slower than API endpoints
const MAX_TEXT_LENGTH = 3600; // keep the tool result token-cheap
const MAX_LINKS = 15; // enough to reach real content links past a repeated header/nav block
const MAX_LINK_TEXT = 30;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

/**
 * Pulls <a href> links out of the raw HTML (before tag-stripping destroys
 * them), resolves relative ones against the page URL, and dedupes. Anchor
 * text is kept short so the model can judge relevance ("Docs" vs "#") without
 * spending tokens on long link text. Skips non-navigable hrefs (anchors,
 * mailto/tel/javascript) since FETCH can't do anything useful with those.
 */
function extractLinks(html, baseUrl) {
  const seen = new Set();
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < MAX_LINKS) {
    const href = m[1].trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch (_) { continue; }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    const text = stripHtml(m[2]).replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT);
    links.push(text ? `${text}: ${abs}` : abs);
  }
  return links;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export async function fetchPage(rawUrl) {
  const url = (rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("invalid-url");

  const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } }, FETCH_TIMEOUT_MS);
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) {
    console.error(`[many-ai:fetch] ${url} → HTTP ${res.status}`); // ERROR
    return `Fetch failed with status ${res.status}.`;
  }

  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return `Can't read this content type (${contentType.split(";")[0] || "unknown"}).`;
  }

  const html = await res.text();
  const links = contentType.includes("text/html") ? extractLinks(html, url) : [];
  const text = stripHtml(html);
  if (!text && !links.length) return "Page had no readable text.";

  const body = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "…" : text;
  const linksBlock = links.length ? `\n\nLinks:\n${links.map(l => `- ${l}`).join("\n")}` : "";
  return body + linksBlock;
}
