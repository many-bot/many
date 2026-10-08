// src/plugins/many-ai/textIndex.js
// Shared keyword-scored search over a folder of .txt files. Used by both
// INDEX_SEARCH (admin-curated AI_INDEX_DIR) and SKILL (bundled skills/
// folder shipped with the plugin) — same matching logic, different
// directories, each caller owns its own cache slot.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MIN_TOKEN_LENGTH = 3;

export function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= MIN_TOKEN_LENGTH);
}

const NAME_MATCH_BONUS = 8; // a query token that IS the file's own name is a much stronger signal
                             // of intent than the same word merely appearing N times inside a long
                             // file — without this, longer/denser files (e.g. license.txt mentioning
                             // "ManyBot" almost as often as manybot.txt itself) could outscore the
                             // actually-matching, more specific file.

function scoreEntry(entry, queryTokens) {
  const nameTokens = new Set(tokenize(entry.name));
  const counts = new Map();
  for (const w of tokenize(entry.content)) counts.set(w, (counts.get(w) || 0) + 1);

  let score = 0;
  for (const q of queryTokens) {
    score += counts.get(q) || 0;
    if (nameTokens.has(q)) score += NAME_MATCH_BONUS;
  }
  return score;
}

/**
 * Loads and caches every .txt file in `dir`. `cacheBox` is a `{ current }`
 * object OWNED BY THE CALLER — each distinct directory must pass its own
 * box, or two callers would clobber each other's cached entries.
 */
export async function loadTextEntries(dir, cacheBox, ttlMs, logPrefix) {
  const cached = cacheBox.current;
  if (cached && cached.dir === dir && Date.now() - cached.loadedAt < ttlMs) {
    return cached.entries;
  }

  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    console.error(`${logPrefix} readdir(${dir}) failed: ${err.message}`); // ERROR
    cacheBox.current = { dir, loadedAt: Date.now(), entries: [] };
    return [];
  }

  const entries = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".txt")) continue;
    try {
      const content = (await readFile(path.join(dir, file), "utf8")).trim();
      if (content) entries.push({ name: path.basename(file, ".txt"), content });
    } catch (err) {
      console.error(`${logPrefix} readFile(${file}) failed: ${err.message}`); // ERROR
      continue;
    }
  }

  cacheBox.current = { dir, loadedAt: Date.now(), entries };
  return entries;
}

/** Best-scoring entry for `query`, or null if nothing scored above zero. */
export function bestMatch(entries, query) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return null;

  let best = null;
  let bestScore = 0;
  for (const entry of entries) {
    const score = scoreEntry(entry, queryTokens);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}
