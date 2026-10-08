# Bundled skills

Drop one `.txt` file per topic here. Filename (without extension) is the
skill's name; file content is what the model gets back when `SKILL <query>`
matches it. Picked up automatically — no code change, no restart needed
beyond the existing 5-minute cache.

This file (`README.md`) is ignored by the loader — only `.txt` files count.

Suggested starters (not included — write these from the real source, don't
let the model invent them):

- `manybot.txt` — what ManyBot is, how commands/prefixes work in general,
  anything about the FRAMEWORK itself that isn't specific to this AI plugin
  (the AI's own `!ai-settings` docs already live in the core prompt).
- `terms.txt` — this community/project's own glossary — jargon, acronyms,
  internal references that show up in chat and would otherwise make the
  model guess or hallucinate a meaning.

Keep each file focused on one topic — the matcher picks the single
best-scoring file per query, not a blend of several.
