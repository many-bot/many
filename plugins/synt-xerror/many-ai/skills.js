// src/plugins/many-ai/skills.js
// SKILL tool — searches a small folder of reference material bundled WITH
// the plugin (docs about ManyBot itself, project terms/glossary, and any
// other reference the model shouldn't have to guess about) and returns the
// best match. Kept OUT of the always-on system prompt and pulled in only
// when the model actually decides it's needed. WhatsApp markdown formatting
// is NOT a skill anymore — it's handled deterministically in code, see
// waFormat.js — the model just writes normal markdown and never needs to
// know WhatsApp's formatting rules.
//
// Distinct from INDEX_SEARCH (localKnowledge.js): that one points at an
// admin-configured folder (AI_INDEX_DIR) that's different per bot install;
// this one is the plugin's own bundled folder, the same on every install.
//
// To add a skill: drop a new <name>.txt file in ./skills — no code change,
// no restart needed beyond the existing cache TTL.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTextEntries, bestMatch } from "./textIndex.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR  = path.join(__dirname, "skills");
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRY_LENGTH = 4000;

const cacheBox = { current: null };

export async function searchSkills(query) {
  const q = (query || "").trim();
  if (!q) return null;

  const entries = await loadTextEntries(SKILLS_DIR, cacheBox, CACHE_TTL_MS, "[many-ai:skills]");
  if (!entries.length) return null;

  const best = bestMatch(entries, q);
  if (!best) return null;

  const content = best.content.length > MAX_ENTRY_LENGTH
    ? best.content.slice(0, MAX_ENTRY_LENGTH) + "…"
    : best.content;
  return { name: best.name, content };
}

/**
 * Full content for a fixed list of skill names, meant to be injected
 * directly into the system prompt (AI_ALWAYS_SKILLS) instead of fetched via
 * a SKILL tool call — these are skills the bot should already "know" before
 * answering anything, so there's no per-message tool call and, unlike
 * SKILL/SEARCH/FETCH, no "lendo skill..." progress message either.
 */
export async function getSkillsContent(names) {
  const wanted = (names || []).map(n => n.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return [];

  const entries = await loadTextEntries(SKILLS_DIR, cacheBox, CACHE_TTL_MS, "[many-ai:skills]");
  const wantedSet = new Set(wanted);
  return entries
    .filter(e => wantedSet.has(e.name.toLowerCase()))
    .map(e => ({
      name: e.name,
      content: e.content.length > MAX_ENTRY_LENGTH ? e.content.slice(0, MAX_ENTRY_LENGTH) + "…" : e.content,
    }));
}

/**
 * Names of every bundled skill file, used to list what's actually available
 * right in the core prompt (so the model knows what it CAN ask for, without
 * paying the token cost of each skill's full content on every message).
 */
export async function listSkillNames() {
  const entries = await loadTextEntries(SKILLS_DIR, cacheBox, CACHE_TTL_MS, "[many-ai:skills]");
  return entries.map(e => e.name);
}

