import { doSearch }                      from "./search.js";
import { fetchPage }                     from "./webFetch.js";
import { fetchWithTimeout }              from "./httpUtils.js";
import { splitForSending }               from "./waFormat.js";
import { wikiSearchTitles, wikiFetchArticle } from "./wikipedia.js";
import { searchLocalIndex }              from "./localKnowledge.js";
import { searchSkills, listSkillNames, getSkillsContent } from "./skills.js";
import { memRead, memWrite, memRecent, initMemory } from "./memory.js";
import { buildSystemPrompt }             from "./prompt.js";
import { safeCalc, getGroupInfo }        from "./tools.js";
import { getKeyPool, withKeyFailover }   from "./apiKeys.js";
import { callMistralRaw }   from "./mistralClient.js";
import { callGeminiRaw }                 from "./geminiClient.js";
import { TOOL_DEFINITIONS, TOOL_NAME_MAP } from "./toolSchemas.js";
import { initHistory, indexMessage, searchHistory } from "./history.js";
import { isTooShortToConsider, looksLikeUnansweredQuestion, looksLikeHelpRequest } from "./intervention.js";
import { transcribeCurrentMessage } from "./voice.js";
import { analyzeImage } from "./vision.js";
import { describeImageWithGemini } from "./geminiVision.js";
import { listStickers, buildStickerBuffer } from "./stickers.js";
import { runGateway, runGatewayStructured, classifyTaskType, VERDICT, looksHallucinationProne } from "./gateway.js";
import { runFileAgent, runFileAgentCommand, SESSION_TTL_MS, sandboxSessionIdFor } from "./fileAgent.js";
import fs   from "node:fs";
import path from "node:path";

const histories       = new Map();
const lastActivityAt  = new Map(); // chatId -> timestamp of the most recent message, used to detect "did anyone reply while we were waiting"
const chatLocks       = new Map(); // chatId -> promise chain, serializes AI resolution per chat (trigger + passive can otherwise race on the same history array)
const pendingContinuation = new Map(); // chatId -> { senderName, expiresAt } — lets the next message from the SAME sender keep talking to the bot without repeating the trigger, as long as nobody else spoke first
const sleepingChats       = new Map(); // chatId -> { wakeMessage } — set when the AI was explicitly told to leave/go quiet ([STOP], see parseReply); cleared the moment it's explicitly addressed again
const recentlySentByBot   = new Map(); // chatId -> Array<{ body, expiresAt }> — the platform can hand the bot's own outgoing message back as a normal incoming event; used to recognize that and stop it from re-triggering itself (word/literal/continuation all matched on it in testing, causing a self-reply loop)
const loadedSkills        = new Map(); // chatId -> Set<string> of skill names already loaded via SKILL tool this conversation, to avoid re-fetching
// chatId -> { path, expiresAt } — a FILE_WRITE/FILE_APPEND that hasn't been
// delivered yet, tracked ACROSS turns (unlike pendingFileBuild inside
// resolveReplyLoop, which only lives for one reply). Read right before a new
// message is resolved, so the model gets an explicit nudge to call
// FILE_RESUME/FILE_APPEND instead of FILE_WRITE and silently wiping its own
// progress. expiresAt mirrors the sandbox's own retention (SESSION_TTL_MS)
// so this never outlives the files it refers to.
const pendingFileBuilds   = new Map();
const MAX_TRACKED_CHATS       = 500; // caps the number of distinct chats kept in memory
const CONTINUATION_WINDOW_MS  = 3 * 60_000; // how long a "same sender keeps talking to the bot" window stays open
const SELF_ECHO_WINDOW_MS     = 20_000; // how long we watch for the bot's own message to bounce back as an incoming event

/** Updates (or clears) the cross-turn record of an unfinished file build
 * for this chat. Called after every FILE_* result, not just when the
 * tool-call budget runs out — so the reminder is there on the very next
 * message regardless of how that reply ended. */
function syncPendingFileBuild(chatId, pendingFileBuild) {
  if (pendingFileBuild) {
    pendingFileBuilds.set(chatId, { ...pendingFileBuild, expiresAt: Date.now() + SESSION_TTL_MS });
  } else {
    pendingFileBuilds.delete(chatId);
  }
}

/**
 * Runs fn() only after any AI resolution already in flight for this chat has
 * finished — a direct trigger and a passive check landing at the same time
 * would otherwise both mutate the shared history array concurrently.
 */
function withChatLock(chatId, fn) {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(chatId, next.then(() => {}, () => {})); // chain continues regardless of fn's outcome
  return next;
}

/**
 * ctx.settings isn't fully documented — if its real shape ever differs from
 * what we assume here, this must fail back to the default instead of
 * throwing, or every single message in the chat would stop being processed.
 */
async function getSetting(ctx, key, defaultValue) {
  try {
    const value = await ctx.settings?.get(key, defaultValue);
    const resolved = value === undefined || value === null ? defaultValue : value;
    return resolved;
  } catch (err) {
    ctx.log.error(`[many-ai] settings.get(${key}) failed, using default: ${err.message}`);
    return defaultValue;
  }
}

async function setSetting(ctx, key, value) {
  try {
    await ctx.settings?.set(key, value);
    return true;
  } catch (err) {
    ctx.log.error(`[many-ai] settings.set(${key}) failed: ${err.message}`);
    return false;
  }
}

/**
 * Resolves the two sticker-related buildSystemPrompt inputs: whether the
 * feature is on for this chat (ctx.settings, default on) and, only if so,
 * the current manifest (ctx.storage) so the model always sees an up to date
 * list without needing a restart when someone adds a new sticker.
 */
async function getStickerPromptExtras(ctx) {
  const stickersEnabled = await getSetting(ctx, "stickersEnabled", true);
  const stickers = stickersEnabled ? await listStickers(ctx) : [];
  return { stickersEnabled, stickers };
}

/**
 * AI_ALWAYS_SKILLS (config, list of skill names): content injected
 * directly into the prompt on every message, no SKILL tool call involved —
 * so no "lendo skill..." progress message either. Whatever's always-loaded
 * is also dropped from the on-demand `skillNames` list handed to the SKILL
 * tool, so the model isn't invited to re-fetch what it already has.
 */
async function getSkillPromptExtras(config) {
  const alwaysNames = (config.get("AI_ALWAYS_SKILLS", []) || []).map(s => String(s).trim()).filter(Boolean);
  const [alwaysSkills, allNames] = await Promise.all([getSkillsContent(alwaysNames), listSkillNames()]);
  const loaded = new Set(alwaysSkills.map(s => s.name.toLowerCase()));
  // Only hide skills that are actually injected via AI_ALWAYS_SKILLS so the
  // model isn't invited to re-fetch what it already has. Do NOT unconditionally
  // hide other skills here.
  return { alwaysSkills, skillNames: allNames.filter(n => !loaded.has(n.toLowerCase())) };
}

function preview(text, len = 100) {
  const s = String(text ?? "");
  return s.length > len ? s.slice(0, len) + "…" : s;
}

// Rough token approximation (word count) — good enough to keep the [STOP]
// wake-up message from bloating the next system prompt.
function truncateToTokens(text, maxTokens) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) return words.join(" ");
  return words.slice(0, maxTokens).join(" ") + "…";
}

const MAX_HISTORY      = 20;
const DEFAULT_MAX_TOKENS = 200;
const MAX_CONTINUATIONS  = 2; // hard cap on "reply got cut off, continue" round-trips per reply
const MAX_QUOTED_LEN     = 200;

const KNOWN_COMMANDS = [
  "SEARCH", "SEARCH_HISTORY", "MEM_READ", "MEM_WRITE", "CALC", "GROUP_INFO", "SEND_STICKER",
  "FETCH", "WIKI_SEARCH", "WIKI_FETCH", "INDEX_SEARCH", "SKILL",
  "FILE_LIST", "FILE_READ", "FILE_WRITE", "FILE_OVERWRITE", "FILE_APPEND", "FILE_DELETE",
  "FILE_MOVE", "FILE_COPY", "FILE_ZIP", "FILE_SEND", "FILE_CHECKSUM", "FILE_RESUME", "FILE_CLEAR",
  "ANALYZE_IMAGE", "TRANSCRIBE_AUDIO",
];

// FILE_WRITE/FILE_OVERWRITE/FILE_APPEND take their content from everything
// after the command's first line (the path) — see the combine step where
// these commands are dispatched, below.
const FILE_CONTENT_COMMANDS = new Set(["FILE_WRITE", "FILE_OVERWRITE", "FILE_APPEND"]);
const FILE_BUILD_COMMANDS = FILE_CONTENT_COMMANDS;
const FILE_DELIVER_COMMANDS = new Set(["FILE_SEND", "FILE_ZIP"]);

// Bare ALL-CAPS words that are common natural-language replies in pt/en/es and must NEVER be
// treated as a failed tool-call attempt by the unknown-command detector below.
const SAFE_ALLCAPS_WORDS = new Set([
  "OK", "OKAY", "SIM", "NAO", "YES", "NO", "OI", "OLA", "TCHAU", "VALEU", "OPA",
]);

// English verbs a model might plausibly invent as a tool name (e.g. after reading the file-agent
// skill doc's action names and forgetting they're now their own FILE_* commands, not a JSON action
// field). Deliberately narrow — this is not a dictionary, just the realistic "almost right" guesses
// for THIS bot's toolset.
const PLAUSIBLE_TOOL_WORDS = new Set([
  "DOWNLOAD", "VIEW", "READ", "WRITE", "EXEC", "RUN", "EDIT", "DELETE", "DELIVER", "RESUME",
  "ZIP", "UNZIP", "UPLOAD", "RENAME", "MOVE", "COPY", "LIST", "PACKAGE", "SAVE", "OPEN", "CHECKPOINT",
  "TRANSCRIBE",
]);

/** Small edit distance — good enough for short ALL-CAPS command tokens, not built for long strings. */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * True only for tokens that look like a genuine failed tool-call attempt —
 * either a near-miss typo of a real command ("SEACH" ~ "SEARCH") or a
 * plausible invented verb (see PLAUSIBLE_TOOL_WORDS) — NOT for arbitrary
 * ALL-CAPS words a model might use for emphasis in normal prose (e.g. a
 * Portuguese reply opening with "PRECISO ..."). Keeping this narrow is what
 * lets unknown-command detection safely intercept real mistakes without
 * corrupting ordinary replies.
 */
function looksLikeFailedToolCall(token) {
  if (SAFE_ALLCAPS_WORDS.has(token)) return false;
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(token)) return false;
  if (PLAUSIBLE_TOOL_WORDS.has(token)) return true;
  for (const cmd of KNOWN_COMMANDS) {
    if (Math.abs(cmd.length - token.length) <= 2 && levenshtein(cmd, token) <= 2) return true;
  }
  return false;
}

const FILE_INGEST_TYPES = ["image", "video", "document"]; // audio/sticker are handled by other flows already

// Explicit request that the AI actually look at / describe an attached
// image. Deliberately narrower than loose words like "olha"/"vê"/"mostra"/
// "como é" — those are extremely common in everyday PT-BR chat on their own
// and were causing image analysis to run on messages that never actually
// asked for it. Shared by both vision paths (Gemini auto-describe and the
// Mistral caption-triggered one) so "only analyze when asked" means the
// same thing in both places.
const IMAGE_ANALYSIS_REQUEST_RE = /\b(analis[ae]|analyze|descreve|describe|identifica|identify|reconhece|recognize)\b|\bo que (é|tem|significa|diz)|\bwhat(?:'s| is)(?: in)?\b|\b(essa|esta|nessa|nesta) (imagem|foto)\b|\bthis (image|photo|picture)\b/i;

const MIME_EXT_OVERRIDES = { "jpeg": "jpg", "svg+xml": "svg", "quicktime": "mov" };
function extensionForMime(mimetype) {
  const subtype = (mimetype || "").split("/")[1]?.split(";")[0];
  if (!subtype) return "";
  return `.${MIME_EXT_OVERRIDES[subtype] || subtype.replace(/[^a-zA-Z0-9]/g, "")}`;
}

const LAST_IMAGE_POINTER_PATH = "meta/last-image.json";

/**
 * Loads the most recently received image for this chat, if any, provided it
 * was received within SESSION_TTL_MS — the SAME 24h window the sandbox
 * itself is cleaned up on (fileAgent.js's cleanupOldSessions), so this
 * fallback and "the file still physically exists" naturally agree with each
 * other. Returns a msg-like source (only `.type`/`.downloadMedia()`, same
 * contract as a real msg) or null. Never throws — any read/parse failure
 * (no image ever received, pointer stale, file swept already) is just "no
 * cached image available", not an error.
 */
async function loadCachedImageSource(ctx, chatId) {
  try {
    const sandboxRoot = ctx.storage.resolve("sandbox");
    const sessionDir = path.join(sandboxRoot, sandboxSessionIdFor(chatId));
    const ptr = JSON.parse(await fs.promises.readFile(path.join(sessionDir, LAST_IMAGE_POINTER_PATH), "utf8"));
    if (!ptr?.path || !ptr?.ts || Date.now() - ptr.ts > SESSION_TTL_MS) return null;
    const buf = await fs.promises.readFile(path.join(sessionDir, ptr.path));
    const base64 = buf.toString("base64");
    return { type: "image", downloadMedia: async () => ({ data: base64, mimetype: ptr.mimetype }) };
  } catch (_) {
    return null;
  }
}

/**
 * Downloads `source`'s media and writes it to this chat's sandbox `in/`.
 * Shared by the always-on image cache and the fileAgentEnabled file cache
 * below — same storage, same naming, same failure handling either way.
 * Returns { sessionId, filename, media, result } or null (logged) on failure.
 */
async function cacheAttachmentToSandbox(ctx, chatId, source, logLabel) {
  const media = await source.downloadMedia();
  if (!media?.data) {
    ctx.log.error(`[many-ai] ${logLabel} ingest: downloadMedia returned empty (type=${source.type})`);
    return null;
  }
  const filename = `${Date.now()}-${(source.senderName || "user").replace(/[^a-zA-Z0-9_-]/g, "_")}${extensionForMime(media.mimetype)}`;
  const result = await runFileAgent(ctx, { action: "write", path: `in/${filename}`, content_base64: media.data }, { chatId });
  if (!result?.ok) {
    ctx.log.error(`[many-ai] ${logLabel} ingest: write did not return ok for ${filename}`);
    return null;
  }
  return { filename, media, result };
}

/**
 * Downloads any media attached to the current message and drops it into
 * this chat's file-agent sandbox (in/), then records a note in history so
 * the model knows the exact path to use — the model itself never receives
 * or handles the raw bytes. Runs regardless of trigger kind so a file sent
 * ahead of a request is already in place once one comes. Best-effort: any
 * failure is logged and swallowed, never blocks the reply.
 */
async function ingestIncomingFile(ctx, chatId, msg, history, fileAgentEnabled, geminiVision = null, t = null, slot = null, visionAllowed = true) {
  if (msg.fromMe) return;

  let source = msg;
  if (!msg.hasMedia && msg.hasReply && typeof msg.getReply === "function") {
    try {
      const quoted = await msg.getReply();
      if (quoted?.hasMedia) source = quoted;
    } catch (err) {
      ctx.log.error(`[many-ai] getReply error: ${err.message}`);
    }
  }

  if (!source.hasMedia) return;
  if (!FILE_INGEST_TYPES.includes((source.type || "").toLowerCase())) return;

  const isImage = (source.type || "").toLowerCase() === "image";
  const caption = (source.caption || source.body || "").trim();
  const explicitlyRequested = IMAGE_ANALYSIS_REQUEST_RE.test(caption);

  // Gemini vision (AI_GEMINI_VISION_ENABLED): only describes an incoming
  // image when the caption explicitly asks for it (IMAGE_ANALYSIS_REQUEST_RE)
  // AND the message is actually a trigger for the bot (visionAllowed) — a
  // caption matching the regex is common everyday chat between people in a
  // group ("o que é isso?", "essa foto...") who never called the bot at
  // all; without the trigger gate this ran the paid Gemini call AND posted
  // a visible "Analisando imagem..." bubble to the whole group unprompted.
  // The description is just another history note; Mistral (resolveReply) is
  // still the one that reads it and answers. Independent of the sandbox
  // caching below — separate subsystems (a text description vs raw bytes).
  if (isImage && geminiVision?.enabled && geminiVision.keys.length && explicitlyRequested && visionAllowed) {
    // Own persistent bubble, independent from the outer `slot` — if this
    // reused slot.handle, resolveReply's final-answer streaming would edit
    // this very message and silently overwrite "Imagem analisada." the
    // moment the reply started coming in, so the done status was never
    // actually seen.
    const label = t ? t("tools.progress.visionanalyze") : "Analisando imagem";
    const doneLabel = t ? t("tools.progress.visionanalyzeDone") : "Imagem analisada.";
    const failedLabel = t ? t("tools.progress.visionanalyzeFailed") : "Não consegui analisar a imagem.";
    const localSlot = { handle: null };

    await showProgress(ctx, chatId, markSelfEcho, localSlot, `${moonFrame(0)} ${label}...`);

    try {
      const description = await describeImageWithGemini(source, ctx, geminiVision.keys, geminiVision.model);
      if (description) {
        pushEntry(history, {
          role: "user",
          kind: "vision",
          current: source === msg,
          content: `[IMAGE ANALYSIS] ${description}`,
        });
        await showProgress(ctx, chatId, markSelfEcho, localSlot, `✅ ${doneLabel}`);
      } else {
        await showProgress(ctx, chatId, markSelfEcho, localSlot, `⚠️ ${failedLabel}`);
      }
    } catch (err) {
      ctx.log.error(`[many-ai:gemini-vision] ingest error: ${err.message}`);
      await showProgress(ctx, chatId, markSelfEcho, localSlot, `⚠️ ${failedLabel}`);
    }
  }

  if (isImage) {
    // Always cached — independent of fileAgentEnabled — so ANALYZE_IMAGE can
    // look at it again later in this chat without asking the person to
    // resend (see loadCachedImageSource). When fileAgentEnabled is ALSO on,
    // the same file is additionally reachable through the FILE_* commands.
    try {
      const saved = await cacheAttachmentToSandbox(ctx, chatId, source, "image");
      if (saved) {
        const { filename, media, result } = saved;
        await runFileAgent(ctx, {
          action: "write",
          path: LAST_IMAGE_POINTER_PATH,
          content: JSON.stringify({ path: `in/${filename}`, mimetype: media.mimetype || "", ts: Date.now() }),
          overwrite: true,
        }, { chatId });
        const ttlHours = Math.round(SESSION_TTL_MS / 3600000);
        pushEntry(history, {
          role: "user",
          kind: "file",
          current: source === msg,
          content: fileAgentEnabled
            ? `[IMAGE RECEIVED] ${source.senderName} sent an image (${media.mimetype || "unknown type"}), ` +
              `saved to sandbox path "in/${filename}" (sha256: ${result.sha}). Use FILE_READ in/${filename}, ` +
              `FILE_SEND, or FILE_ZIP to inspect or deliver it. Also cached as the chat's most recently ` +
              `received image for ${ttlHours}h — call ANALYZE_IMAGE any time to look at it again, even ` +
              `without it attached to the current/quoted message.`
            : `[IMAGE RECEIVED] ${source.senderName} sent an image (${media.mimetype || "unknown type"}). ` +
              `Cached as the chat's most recently received image for ${ttlHours}h — call ANALYZE_IMAGE any ` +
              `time to look at it, even without it attached to the current/quoted message.`,
        });
      }
    } catch (err) {
      ctx.log.error(`[many-ai] image ingest error: ${err.message}`);
    }
  } else if (fileAgentEnabled) {
    try {
      const saved = await cacheAttachmentToSandbox(ctx, chatId, source, "file");
      if (saved) {
        const { filename, media, result } = saved;
        pushEntry(history, {
          role: "user",
          kind: "file",
          content: `[FILE RECEIVED] ${source.senderName} sent a ${source.type} (${media.mimetype || "unknown type"}), ` +
            `saved to sandbox path "in/${filename}" (sha256: ${result.sha}). Use FILE_READ in/${filename}, ` +
            `FILE_SEND, or FILE_ZIP to inspect or deliver it.`,
        });
      }
    } catch (err) {
      ctx.log.error(`[many-ai] file ingest error: ${err.message}`);
    }
  }
}

function buildWordTriggerRE(words) {
  if (!words?.length) return null;
  return new RegExp(`\\b(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
}

function getHistory(chatId) {
  if (!histories.has(chatId)) {
    if (histories.size >= MAX_TRACKED_CHATS) {
      const evicted = histories.keys().next().value;
      histories.delete(evicted);
      loadedSkills.delete(evicted);
    }
    histories.set(chatId, []);
  }
  return histories.get(chatId);
}

/**
 * Trims down to MAX_HISTORY entries, but never removes the entry currently
 * flagged as "current" — that would let the model silently lose track of
 * the message it's actually answering mid-resolution. Always removes the
 * oldest *non-current* entry first.
 */
function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    const idx = history.findIndex(h => !(h.kind === "chat" && h.current));
    if (idx === -1) break; // everything left is the current message — nothing safe to drop
    history.splice(idx, 1);
  }
}

/**
 * Adds a history entry and, if it's a real chat message, unmarks any
 * previous entry as "current" — only the newest one carries that flag.
 * This is what guarantees the model always knows which message it needs
 * to answer, even after several tool-call iterations.
 */
export function pushEntry(history, entry) {
  if (entry.kind === "chat" && entry.current) {
    for (const h of history) if (h.kind === "chat") h.current = false;
  }
  history.push(entry);
  trimHistory(history);
}

function timeLabel() {
  return new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

function formatChatEntry({ isGroup, chatName, senderName, body, quoted }) {
  const location  = isGroup ? `Group "${chatName}"` : "Private";
  const quotedTag = quoted ? ` [replying to ${quoted.senderLabel}: "${quoted.text}"]` : "";
  return `[${location}] ${senderName} (${timeLabel()}):${quotedTag} ${body}`;
}

function formatCommandEntry({ senderName, body }) {
  return `[Command] ${senderName} (${timeLabel()}): ${body}`;
}

/**
 * Builds the "[replying to X: "..."]" info shown to the model when the
 * current message is a reply/quote. This is what was previously missing —
 * the AI never actually saw what a reply was replying to, only its own new
 * text, which is why it looked like it "didn't understand" replies.
 *
 * `quotedRaw` is whatever `msg.getReply()` resolves to — a normalized
 * WAMessageContext (same shape as `ctx.msg` itself: `.body`, `.type`,
 * `.fromMe`, `.senderName`, `.downloadMedia()`), never raw Baileys data.
 */
async function buildQuotedInfo(quotedRaw) {
  let text = (quotedRaw.body || "").trim();

  // No text on the quoted message but it's a voice note — never transcribed
  // here. Just a placeholder; the model calls TRANSCRIBE_AUDIO itself if it
  // needs the content (audioSource already covers the quoted message).
  if (!text && quotedRaw.type === "audio") text = "(voice note, no caption)";
  if (!text) return null; // genuinely nothing to show (other media, no audio)

  // quotedRaw.senderName is already normalized (real display name if known,
  // bare number fallback otherwise) — no need to resolve the contact again.
  const senderLabel = quotedRaw.fromMe ? "you (the AI)" : quotedRaw.senderName;

  return {
    senderLabel,
    text: text.length > MAX_QUOTED_LEN ? text.slice(0, MAX_QUOTED_LEN) + "…" : text,
  };
}

/**
 * Builds the message list sent to the API, applying the current/old tags on
 * top of the already-stored content (we never bake the tag into the history
 * itself, so it's always correct at send time regardless of how many tool
 * iterations happened since).
 */
/**
 * Parses the model's reply. Much simpler format than earlier versions:
 * - "SILENT" → no reply at all.
 * - "COMMAND(args)" → call the matching tool.
 * - anything else → the final reply text, sent as-is.
 * Command matching is case-insensitive since small models occasionally
 * drift on casing (e.g. "search(...)" instead of "SEARCH(...)").
 */
export function parseReply(reply) {
  let text = (reply || "").trim();
  // Strip an optional private reasoning block (see AI_ENABLE_THINKING /
  // "thinking" setting) FIRST, before any command matching — it can precede
  // a tool call just as easily as the final text, and must never reach the
  // user either way.
  // A max_tokens cutoff can land INSIDE the block, before [/THINKING] was ever
  // emitted — in that case the regex below has nothing to match, and the raw
  // reasoning text used to fall straight through to the user as the "reply".
  // Caught here first: report it as its own type so the caller can ask the
  // model to finish the thought (see resolveReplyLoop's "truncated_thinking"
  // handling) instead of ever displaying it.
  if (/^\[THINKING\]/i.test(text) && !/\[\/THINKING\]/i.test(text)) {
    return { type: "truncated_thinking" };
  }
  text = text.replace(/^\[THINKING\][\s\S]*?\[\/THINKING\][ \t]*\n?/i, "").trim();

  // Optional trailing marker the model appends when it judges THIS exchange
  // is fully resolved and no follow-up is expected (goodbye, task done,
  // simple question answered) — tells resolveReply's caller to block the
  // 3-minute "continuation" window instead of leaving it open. Stripped
  // here so it never leaks to the user and can't be mistaken for a command.
  let concluded = false;
  const endMatch = text.match(/\n?\[END\][ \t]*$/i);
  if (endMatch) {
    text = text.slice(0, endMatch.index).trim();
    concluded = true;
  }

  // Optional trailing marker the model appends when explicitly told to leave/
  // go quiet/sleep (see prompt.js's [STOP] block) — tells resolveReply's
  // caller to go fully silent in this chat until addressed again, not just
  // close the continuation window like [END]. Stripped here for the same
  // reason [END] is. Implies concluded too.
  let stop = false;
  const stopMatch = text.match(/\n?\[STOP\][ \t]*$/i);
  if (stopMatch) {
    text = text.slice(0, stopMatch.index).trim();
    stop = true;
    concluded = true;
  }

  if (!text) return { type: "silent", concluded, stop };
  if (/^SILENT$/i.test(text)) return { type: "silent" };

  // Small models sometimes abbreviate SEND_STICKER as SEND — this is the
  // root cause of literal "SEND" leaking to users. Normalize before
  // matching so it resolves to the real command instead of falling
  // through to plain text.
  text = text.replace(/^SEND(?=\s|$)/i, "SEND_STICKER");
  if (/^SEND_STICKER$/i.test(text)) return { type: "silent" }; // bare "SEND", no target — nothing sane to do with it

  // The model occasionally reverts to the old "CMD(arg)" syntax despite the
  // prompt only teaching "CMD arg" now — normalize any full-line paren call
  // whose command name is real before matching, so a lapse in the model's
  // output doesn't leak the raw "SEND_STICKER(many-blueberry)" text to the
  // user. Only rewrites lines that are actually a known command; ordinary
  // text containing "word(word)" is left untouched.
  text = text.replace(/^([A-Za-z_]+)\(([\s\S]*?)\)[ \t]*$/gm, (whole, cmd, arg) =>
    KNOWN_COMMANDS.includes(cmd.toUpperCase()) ? `${cmd} ${arg}` : whole
  );

  // Simple syntax: COMMAND arg, space-separated, no parentheses — a model
  // that forgets a closing ")" used to leak the raw call as plain text to
  // the user (parseReply had nothing to match), which is exactly what
  // happened with "SEND_STICKER(many-blueberry" in testing. There's no
  // closing delimiter left to forget.
  // The command must be on the message's own first line; anything after
  // that line is a normal reply sent right after the tool call resolves
  // (e.g. sticker + short message). Args are taken from the rest of that
  // first line only — in practice every tool here (search query, sticker
  // name, calc expression, a memory fact) is a one-liner, so this doesn't
  // lose anything real, and it removes the ambiguity the old three-way
  // paren-matching logic had to resolve.
  const newlineIdx = text.indexOf("\n");
  const firstLine  = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trim();
  const call = firstLine.match(/^([A-Za-z_]+)(?:[ \t]+(.*))?$/);

  if (call && KNOWN_COMMANDS.includes(call[1].toUpperCase())) {
    const trailing = newlineIdx === -1 ? null : text.slice(newlineIdx + 1).trim();
    return {
      type: "command",
      command: call[1].toUpperCase(),
      arg: (call[2] || "").trim(),
      trailing: trailing || null,
    };
  }

  // A first line that LOOKS like a tool call (ALL-CAPS token, optionally with
  // underscores, 3+ chars) but isn't a real command name — a typo'd/invented
  // tool (e.g. "DOWNLOAD url", "SEACH foo") that used to leak straight to the
  // user as literal text with zero feedback loop. Genuine reply text almost
  // never opens with a bare all-caps word (the prompt itself asks for normal
  // sentence-case grammar), so this is caught here instead and handed back to
  // resolveReply as a parse error the model can see and self-correct from.
  if (call && looksLikeFailedToolCall(call[1])) {
    return { type: "unknown_command", command: call[1], arg: (call[2] || "").trim() };
  }

  // Reverse order: reply text first, SEND_STICKER call on its own last line
  // — e.g. "Oi!\nSEND_STICKER many-blueberry", the natural order a person
  // would send a message then react with a sticker. Only meaningful for
  // SEND_STICKER: it's the one tool whose result the model never needs
  // back (a side effect, not information to reason about), so the text
  // doesn't have to wait for it. A distinct type from "command" — the
  // caller sends the text FIRST, then fires the sticker, deliberately the
  // opposite send order from the "command"+trailing case above.
  const lines = text.split("\n");
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trim();
    const stickerCall = lastLine.match(/^SEND_STICKER(?:[ \t]+(.*))?$/i);
    const leading = lines.slice(0, -1).join("\n").trim();
    if (stickerCall && leading) {
      return { type: "textThenSticker", value: leading, stickerArg: (stickerCall[1] || "").trim(), concluded, stop };
    }
  }

  // Last resort: never let a raw COMMAND call leak into the chat as text,
  // even if the model embedded it somewhere other than its own first line
  // (that's a prompt-compliance slip, not something the user should see).
  const stripped = text
    .split("\n")
    .filter(line => {
      const m = line.trim().match(/^([A-Za-z_]+)(?:[ \t]+.*)?$/);
      return !(m && KNOWN_COMMANDS.includes(m[1].toUpperCase()));
    })
    .join("\n")
    .trim();

  return { type: "msg", value: stripped || text, concluded, stop };
}

const PROGRESS_TOOLS = {
  SEARCH: "search", FETCH: "fetch", SKILL: "skill", MEM_READ: "memread", MEM_WRITE: "memwrite", CALC: "calc",
  FILE_LIST: "fileagent", FILE_READ: "fileagent", FILE_WRITE: "fileagent", FILE_OVERWRITE: "fileagent",
  FILE_APPEND: "fileagent", FILE_DELETE: "fileagent", FILE_MOVE: "fileagent", FILE_COPY: "fileagent",
  FILE_ZIP: "fileagent", FILE_SEND: "fileagent", FILE_CHECKSUM: "fileagent", FILE_RESUME: "fileagent",
  FILE_CLEAR: "fileagent", FILE_AGENT: "fileagent",
  ANALYZE_IMAGE: "visionanalyze", TRANSCRIBE_AUDIO: "transcribeaudio",
  SEARCH_HISTORY: "searchhistory", GROUP_INFO: "groupinfo", SEND_STICKER: "sticker",
  WIKI_SEARCH: "wikisearch", WIKI_FETCH: "wikifetch", INDEX_SEARCH: "indexsearch",
}; // command -> locale key stem
const PROGRESS_TICK_MS = 350;
const THINKING_SHOW_DELAY_MS = 1200; // don't show the bubble for replies fast enough not to need it

// Single moon-phase spinner used everywhere a progress bubble animates
// (thinking, tool calls, vision analysis) — replaces the old per-tool
// emoji + "..." dots so every status bubble shares one visual identity.
const MOON_FRAMES = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
function moonFrame(tick) {
  return MOON_FRAMES[tick % MOON_FRAMES.length];
}

// FILE_* commands that get their own progress label/icon instead of the
// generic "fileagent" one — the rest (list, checksum, delete, move, copy,
// resume) fall back to the generic label.
const FILE_PROGRESS_STEMS = {
  FILE_WRITE: "filecreate", FILE_OVERWRITE: "filecreate", FILE_APPEND: "filecreate",
  FILE_READ: "fileread", FILE_ZIP: "filepackage", FILE_SEND: "filedeliver",
};

/** Best-effort .edit() — the progress animation is cosmetic, never let it break the actual tool call.
 * Returns true/false so callers that carry the REAL reply (not just a progress bubble) can tell
 * whether the edit actually landed and fall back to sending a fresh message instead of silently
 * losing the content. */
async function safeEdit(handle, text) {
  try {
    if (typeof handle?.edit === "function") {
      await handle.edit(text);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Single entry point for showing/updating the one status bubble a reply
 * uses (thinking / tool progress / vision analysis all share it via `slot`).
 * Creates the message the first time (quoting the original msg when
 * possible), edits it in place on every call after that. Never throws —
 * this is purely cosmetic and must never be the reason a reply fails.
 * Returns the handle (or null if sending failed and there's nothing to
 * edit into).
 */
/**
 * Single entry point for showing/updating the one status bubble a reply
 * uses (thinking / tool progress / vision analysis / live streaming all
 * share it via `slot`). Creates the message on first call (whichever
 * caller gets here first — thinking indicator or streaming, depending on
 * which is faster), edits it in place every call after that.
 *
 * Every call goes through slot._editChain, one shared queue per slot —
 * this is what makes concurrent callers (the thinking ticker and live
 * streaming both want to touch the same message) land in the right order
 * instead of racing. slot.pendingText always holds the LATEST requested
 * text; the create-step reads it at send time (not at call time), so if
 * the desired text moved on while the message was still being sent, the
 * message ends up showing the latest state once the send completes,
 * never a stale snapshot — this is what stops the old "thinking bubble
 * never gets replaced with the real answer" leak.
 *
 * Never throws — this is purely cosmetic and must never be the reason a
 * reply fails. Returns a promise for the handle (or null on failure).
 */
function showProgress(ctx, chatId, markEcho, slot, text, { quoteReply = true } = {}) {
  markEcho(chatId, text);
  slot.pendingText = text;
  slot._editChain = (slot._editChain || Promise.resolve()).then(async () => {
    if (slot.handle) {
      await safeEdit(slot.handle, slot.pendingText);
      return slot.handle;
    }
    try {
      const initial = slot.pendingText;
      const handle = quoteReply && ctx.msg?.reply?.text ? ctx.msg.reply.text(initial) : ctx.send.text(initial);
      await handle;
      slot.handle = handle;
      // Desired text may have moved on again while this send was in
      // flight (nothing else could jump this queue, but the send itself
      // takes real time) — catch up once more so what's on screen always
      // matches the latest call, not the snapshot it was created with.
      if (slot.pendingText !== initial) await safeEdit(handle, slot.pendingText);
      return handle;
    } catch (_) {
      return null;
    }
  });
  return slot._editChain;
}

/**
 * Shows a "🌑 Thinking..." bubble immediately, before the first model call
 * even goes out — same moon-spinner mechanic as withToolProgress, via
 * .edit(). This is its OWN standalone message (never reused by tool
 * progress or the final reply) — a persistent log entry, not a bubble that
 * later gets overwritten. Finalizes to "Thought for Ns." once stopped
 * (either a tool call takes over, or the real reply is ready). Purely
 * cosmetic: any failure here is swallowed, never affects the actual reply.
 */
function startThinkingIndicator(ctx, t, chatId, markEcho, slot) {
  if (slot.thinkingStop) return; // already running/finalized — nothing to do
  const thinkPhase = {}; // dedicated message, independent from `slot` (the real answer's handle)
  const startedAt = Date.now();
  const label = t("tools.progress.thinking");
  let tick = 0;
  let stopped = false;
  let started = false; // becomes true once the bubble has actually been sent
  let timer = null;
  let delayTimer = null;

  const scheduleTick = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      tick++;
      showProgress(ctx, chatId, markEcho, thinkPhase, `${moonFrame(tick)} ${label}...`, { quoteReply: false });
      scheduleTick();
    }, PROGRESS_TICK_MS);
  };

  // Returns a promise the caller can await to guarantee every queued edit
  // (including the final one) has actually landed. `finalText`, when given,
  // overrides the auto-generated "Thought for Ns." text (used sparingly —
  // most callers just call stop() with no args). If the reply finished
  // before THINKING_SHOW_DELAY_MS elapsed, the bubble never appeared —
  // cancel the pending show and skip sending anything at all.
  slot.thinkingStop = (finalText) => {
    if (stopped) return thinkPhase._editChain || Promise.resolve();
    stopped = true;
    clearTimeout(delayTimer);
    clearTimeout(timer);
    if (!started) return Promise.resolve();
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const text = finalText || `💭 ${t("tools.progress.thinkingDone", { seconds })}`;
    return showProgress(ctx, chatId, markEcho, thinkPhase, text, { quoteReply: false });
  };

  delayTimer = setTimeout(() => {
    if (stopped) return;
    started = true;
    showProgress(ctx, chatId, markEcho, thinkPhase, `${moonFrame(0)} ${label}...`, { quoteReply: false });
    scheduleTick();
  }, THINKING_SHOW_DELAY_MS);
}

const TYPE_CHUNK_WORDS = 5; // reveal 5 words per .edit() — enough to feel alive without spamming edits
const TYPE_TICK_MS = 100;

/** Splits into "word + trailing whitespace" tokens so re-joining slices reproduces spacing/newlines exactly. */
function tokenizeForTyping(text) {
  return text.match(/\S+\s*/g) || [text];
}

/**
 * Reveals `fullText` into `handle` a few words at a time via .edit(), like a
 * typing effect. Falls back to a single edit for short replies (not worth
 * animating) or when there's no handle to type into. Best-effort — a failed
 * intermediate edit just gets skipped by safeEdit, never throws.
 */
async function typeOutReply(handle, fullText, markEcho) {
  await typeOutReplyChecked(handle, fullText, markEcho);
}

/**
 * Same as typeOutReply, but returns whether the FINAL edit (the one carrying
 * the complete real text) actually landed — false means the caller must fall
 * back to sending a fresh message, or the reply is silently lost. Earlier,
 * purely cosmetic intermediate edits are still best-effort and their
 * individual success isn't reported.
 */
async function typeOutReplyChecked(handle, fullText, markEcho) {
  if (!handle || typeof handle.edit !== "function") return false;
  const tokens = tokenizeForTyping(fullText);
  if (tokens.length <= TYPE_CHUNK_WORDS) {
    markEcho?.(fullText);
    return safeEdit(handle, fullText);
  }
  let shown = "";
  let lastOk = false;
  for (let i = 0; i < tokens.length; i += TYPE_CHUNK_WORDS) {
    shown += tokens.slice(i, i + TYPE_CHUNK_WORDS).join("");
    // Every intermediate reveal is itself a distinct outgoing edit that can
    // come back as its own incoming event (see the self-echo guard note in
    // sendReplyLines) — each one MUST be registered, not just the final
    // body, or a partial "Oi tudo" bounces back unrecognized and re-triggers
    // the bot on itself mid-typing.
    markEcho?.(shown);
    lastOk = await safeEdit(handle, shown);
    if (i + TYPE_CHUNK_WORDS < tokens.length) await new Promise(r => setTimeout(r, TYPE_TICK_MS));
  }
  return lastOk;
}


/**
 * Wraps a tool call with a small progress message that's edited in place
 * (dots animating, then a ✅/⚠️ summary) while the real call runs in the
 * background. When possible, shows contextual info (hostname for FETCH,
 * engine for SEARCH, chat id for MEM_READ). Any chat that doesn't support
 * .edit() just runs the call directly — this is purely cosmetic and must
 * never be the reason a tool call fails.
 */
async function withToolProgress(command, arg, ctx, t, chatId, markEcho, slot, task) {
  // A tool call means the model is done with its immediate reasoning — stop
  // (and finalize) the thinking indicator if it's still running. It's a
  // fully separate message now, so this is just cleanup, not a handoff.
  if (typeof slot?.thinkingStop === "function") {
    await slot.thinkingStop();
    slot.thinkingStop = null;
  }

  const baseKey = PROGRESS_TOOLS[command];
  const progressEnabled = await getSetting(ctx, "showToolProgress", false);
  if (!baseKey || !progressEnabled) return task();

  let key = baseKey;
  let detail = "";
  let filename = "";
  const queryPreview = preview(arg || "", 60);

  try {
    if (command === "FETCH" && arg) {
      try {
        const u = new URL(arg);
        detail = `: ${u.hostname}`;
      } catch (_) { detail = ""; }
    } else if (command === "SEARCH" && arg) {
      detail = `: ${queryPreview}`;
    } else if (command === "MEM_READ") {
      detail = `: chat ${chatId}`;
    } else if (command === "MEM_WRITE" && arg) {
      detail = `: ${preview(arg, 40)}`;
    } else if (command === "SKILL" && arg) {
      detail = `: ${preview(arg, 40)}`;
    } else if (command.startsWith("FILE_")) {
      if (FILE_PROGRESS_STEMS[command]) key = FILE_PROGRESS_STEMS[command];
      // First whitespace-separated token of arg is always the path/dest for
      // every FILE_* command — good enough for a short progress label.
      filename = (arg || "").trim().split(/\s/)[0]?.split("/").pop() || "";
      detail = filename ? `: ${filename}` : "";
    }
  } catch (_) { detail = ""; }

  // Each tool call gets its OWN persistent message (a real log entry, never
  // reused by the next tool call or by the final reply) — created plain
  // (quoteReply: false), never quoting the user's original message.
  const toolPhase = {};
  const label = t(`tools.progress.${key}`);
  const handle = await showProgress(ctx, chatId, markEcho, toolPhase, `${moonFrame(0)} ${label}${detail}`, { quoteReply: false });
  if (!handle) return task(); // couldn't send — just run the tool directly

  let tick = 0;
  let stopped = false;
  let tickTimer = null;
  const scheduleTick = () => {
    tickTimer = setTimeout(() => {
      if (stopped) return;
      tick++;
      showProgress(ctx, chatId, markEcho, toolPhase, `${moonFrame(tick)} ${label}${detail}`, { quoteReply: false });
      scheduleTick();
    }, PROGRESS_TICK_MS);
  };
  scheduleTick();

  const stop = () => {
    stopped = true;
    clearTimeout(tickTimer);
  };

  // Best-effort "done" text for the success path — falls back to a plain
  // checkmark + the same label if no specific "<key>Done" string exists for
  // this tool, rather than leaving the message stuck on the last tick frame.
  const doneText = () => {
    const doneKey = `tools.progress.${key}Done`;
    const params = key === "search" ? { query: queryPreview }
      : (key === "filecreate" || key === "fileread" || key === "filepackage" || key === "filedeliver") ? { filename }
      : {};
    const text = t(doneKey, params);
    return text && text !== doneKey ? `✅ ${text}` : `✅ ${label}${detail}.`;
  };

  try {
    const result = await task();
    stop();
    await showProgress(ctx, chatId, markEcho, toolPhase, doneText(), { quoteReply: false });
    return result;
  } catch (err) {
    stop();
    await showProgress(ctx, chatId, markEcho, toolPhase, `⚠️ ${t("tools.progress.failed")}`, { quoteReply: false });
    throw err;
  }
}

// One extra attempt for tool failures that look transient (network blip,
// timeout) — keeps a flaky call from costing a whole loop iteration. Not
// retried: anything that isn't clearly transient (bad args, 4xx, etc.) —
// those go straight back to the model as a [TOOL ERROR] to fix instead.
const TOOL_RETRY_DELAY_MS = 500;

function isRetryableToolError(err) {
  const code = String(err?.code || err?.cause?.code || "").toLowerCase();
  const msg = String(err?.message || "").toLowerCase();
  if (["etimedout", "econnreset", "econnrefused", "enotfound", "eai_again"].includes(code)) return true;
  return err?.name === "AbortError" || /timeout|network|fetch failed|socket hang up/.test(msg);
}

async function runToolWithRetry(command, arg, ctx, chatId, t, opts) {
  try {
    return await runTool(command, arg, ctx, chatId, t, opts);
  } catch (err) {
    if (!isRetryableToolError(err)) throw err;
    ctx.log.warn(`[many-ai] ${command} failed transiently (${err.message}) — retrying once`);
    await new Promise(r => setTimeout(r, TOOL_RETRY_DELAY_MS));
    return await runTool(command, arg, ctx, chatId, t, opts);
  }
}

/** Turns a caught tool exception into a message the model can actually act on —
 * real reason included, same "[TOOL ERROR]" shape the prompt already tells it
 * to expect for bad syntax, so it can fix the call and retry instead of giving up. */
function formatToolError(tool, err, lang) {
  const reason = String(err?.message || "unknown error").slice(0, 300);
  return lang === "pt"
    ? `[TOOL ERROR] ${tool} falhou: ${reason} Corrija o argumento/formato e tente de novo (ou use outra ferramenta), ou responda com o que já tem — não repita a mesma chamada quebrada.`
    : `[TOOL ERROR] ${tool} failed: ${reason} Fix the argument/format and retry (or use a different tool), or answer with what you already have — don't repeat the exact same broken call.`;
}

/**
 * Tracks whether a FILE_WRITE/FILE_APPEND job was left mid-flight this
 * reply — started (write/append succeeded) but never actually delivered
 * (FILE_SEND, or FILE_ZIP). Called after every FILE_* tool result in the
 * loop below. Returns the updated state (or null once nothing is left in
 * flight) — used so a maxIterations cutoff can tell the model honestly
 * that the build isn't finished, instead of letting it wrap up as if it
 * were. No session_id to track here — the sandbox is always this chat's
 * own, so "path" alone is enough to resume.
 */
function trackFileBuildState(command, result, current) {
  const ok = result && typeof result === "object" && result.ok;
  if (!ok) return current;
  if (command === "FILE_CLEAR" || result.cleared) return null; // sandbox wiped, nothing left in flight
  if (command === "FILE_AGENT") {
    // Native function-calling path (see TOOL_NAME_MAP): the real action
    // (write/append/deliver/...) isn't in `command`, it's inside the JSON
    // payload — infer it from the result shape instead. write/append
    // results carry `path` with no `sent`; deliver/zip(send) results carry
    // a `sent` boolean.
    if (result.sent) return null; // actually delivered
    if (result.path && result.sent === undefined) return { path: result.path };
    return current;
  }
  if (FILE_BUILD_COMMANDS.has(command)) return { path: result.path };
  if (FILE_DELIVER_COMMANDS.has(command) && result.sent) return null; // actually delivered
  return current;
}

async function runTool(command, arg, ctx, chatId, t, opts) {
  switch (command) {
    case "INDEX_SEARCH":
      return searchLocalIndex(arg, opts.indexDir);

    case "SKILL": {
      const skill = await searchSkills(arg);
      if (!skill) return "No matching skill found.";
      const chatSkills = loadedSkills.get(chatId);
      if (chatSkills?.has(skill.name)) {
        return `Skill '${skill.name}' already loaded earlier in this conversation.`;
      }
      if (!chatSkills) loadedSkills.set(chatId, new Set([skill.name]));
      else chatSkills.add(skill.name);
      return `[${skill.name}] ${skill.content}`;
    }

    case "FILE_LIST": case "FILE_READ": case "FILE_WRITE": case "FILE_OVERWRITE":
    case "FILE_APPEND": case "FILE_DELETE": case "FILE_MOVE": case "FILE_COPY":
    case "FILE_ZIP": case "FILE_SEND": case "FILE_CHECKSUM": case "FILE_RESUME":
    case "FILE_CLEAR":
      // arg is a plain-text positional argument (path, or "path content" for
      // the write-family commands) — see runFileAgentCommand. chatId locks
      // the sandbox to this chat, same guarantee as before.
      try {
        return await runFileAgentCommand(ctx, command, arg, { ...opts, chatId });
      } catch (err) {
        ctx.log.error(`[many-ai] ${command} error: ${err.message}`);
        return `FILE_AGENT_ERROR: ${err.message}`;
      }

    case "FILE_AGENT":
      // Native function-calling path only (see TOOL_NAME_MAP) — arg is the
      // raw JSON payload string from the model's tool call, passed straight
      // through to runFileAgent (which already accepts a JSON string), not
      // the plain-text single-argument form the FILE_* commands above use.
      try {
        return await runFileAgent(ctx, arg, { ...opts, chatId });
      } catch (err) {
        ctx.log.error(`[many-ai] FILE_AGENT error: ${err.message}`);
        return `FILE_AGENT_ERROR: ${err.message}`;
      }

    case "WIKI_SEARCH":
      return wikiSearchTitles(arg, opts.lang);

    case "WIKI_FETCH":
      return wikiFetchArticle(arg, opts.lang);

    case "FETCH":
      return fetchPage(arg);

    case "SEARCH":
      return doSearch(arg, { TAVILY_API_KEY: opts.tavilyKey, SERPER_API_KEY: opts.serperKey, log: ctx.log });

    case "SEARCH_HISTORY":
      return searchHistory(chatId, arg);

    case "MEM_READ":
      return memRead(chatId, arg);

    case "MEM_WRITE":
      await memWrite(chatId, arg);
      return t("memory.saved");

    case "CALC":
      return String(safeCalc(arg));

    case "GROUP_INFO": {
      // Raw data, not a pre-written sentence — the model reads this and
      // composes its own reply, same as it would with a SEARCH result.
      const info = await getGroupInfo(ctx);
      return JSON.stringify(info);
    }

    case "SEND_STICKER": {
      try {
        const buffer = await buildStickerBuffer(ctx, arg, { pack: opts.stickerPack, author: opts.stickerAuthor });
        await ctx.send.sticker(buffer);
        return t("tools.stickerSent");
      } catch (err) {
        if (err.message === "sticker-not-found") return t("tools.stickerNotFound", { name: arg });
        throw err;
      }
    }

    case "ANALYZE_IMAGE": {
      const imageSource = opts.imageSource || await loadCachedImageSource(ctx, chatId);
      if (!imageSource) {
        throw new Error("no image attached to this message (or the one it's replying to), and no recently received image cached for this chat");
      }
      if (opts.geminiVision?.enabled && opts.geminiVision.keys.length) {
        const description = await describeImageWithGemini(imageSource, ctx, opts.geminiVision.keys, opts.geminiVision.model, arg || undefined);
        if (description) return description;
        // fall through to Mistral below on a null (best-effort) result
      }
      if (opts.mistralVisionKeys?.length) {
        const description = await analyzeImage(imageSource, ctx, opts.mistralVisionKeys, opts.mistralVisionModel, arg || undefined);
        if (description) return description;
      }
      throw new Error("vision analysis returned no result (no vision provider configured or both failed)");
    }

    case "TRANSCRIBE_AUDIO": {
      if (!opts.audioSource) {
        throw new Error("no audio attached to this message (or the one it's replying to) to transcribe");
      }
      if (!opts.transcribeKeys?.length) {
        throw new Error("audio transcription is not configured (no API keys)");
      }
      const text = (await transcribeCurrentMessage(opts.audioSource, ctx, opts.transcribeKeys, opts.transcribeModel)).trim();
      if (!text) throw new Error("transcription failed or returned empty");
      return text;
    }

    default:
      // Shouldn't happen (parseReply only lets KNOWN_COMMANDS through), but
      // keeps this from silently returning undefined if the two ever drift.
      return t("errors.toolError", { tool: command });
  }
}

/**
 * `imageSource` (a msg-like object with .downloadMedia(), or null) is
 * per-request state, not config — callers that need ANALYZE_IMAGE to work
 * must set opts.imageSource = <msg|quotedRaw|null> themselves after calling
 * this, same pattern resolveReply uses.
 */
function getToolOpts(ctx) {
  const geminiVisionEnabled = ctx.config.get("AI_GEMINI_VISION_ENABLED", false);
  return {
    tavilyKey: ctx.config.get("TAVILY_API_KEY"),
    serperKey: ctx.config.get("SERPER_API_KEY"),
    stickerPack: ctx.config.get("STICKER_PACK_NAME", "Many AI"),
    stickerAuthor: ctx.config.get("STICKER_AUTHOR_NAME", "ManyBot"),
    lang: ctx.config.get("LANGUAGE", "pt"),
    indexDir: ctx.config.get("AI_INDEX_DIR", ""),
    geminiVision: {
      enabled: geminiVisionEnabled,
      keys: geminiVisionEnabled ? getKeyPool(ctx, "GEMINI") : [],
      model: ctx.config.get("GEMINI_VISION_MODEL", "gemini-flash-latest"),
    },
    mistralVisionKeys: getKeyPool(ctx, "MISTRAL"),
    mistralVisionModel: ctx.config.get("MISTRAL_VISION_MODEL", "mistral-medium-latest"),
    imageSource: null,
    transcribeKeys: getKeyPool(ctx),
    transcribeModel: ctx.config.get("AI_TRANSCRIBE_MODEL", "whisper-large-v3-turbo"),
    audioSource: null,
  };
}

/**
 * Fires a list of SEND_STICKER calls in order, after the text reply has
 * already gone out — the "text first, stickers after" order (see
 * parseReply's "textThenSticker" case). Mirrors the tool-result bookkeeping
 * resolveReply does for every other tool call, so history stays consistent.
 * Never throws — a failed sticker send here shouldn't take down a reply the
 * user already received.
 */
async function sendStickerAfterText(ctx, chatId, t, history, stickerArgs) {
  const args = Array.isArray(stickerArgs) ? stickerArgs : [stickerArgs];
  for (const arg of args.filter(Boolean)) {
    try {
      const result = await runTool("SEND_STICKER", arg, ctx, chatId, t, getToolOpts(ctx));
      pushEntry(history, { role: "user", kind: "tool", content: `[${t("tools.resultLabel")}: SEND_STICKER] ${result}` });
    } catch (err) {
      ctx.log.error(`[many-ai] error in SEND_STICKER (after text): ${err.message}`);
    }
  }
}

/**
 * Pure — no side effects. Sweeps every line of a text block for a
 * SEND_STICKER (or abbreviated SEND) call and pulls it out, in order,
 * returning what's left as the real reply text. Needed because parseReply's
 * "textThenSticker" only detects a sticker call on the very LAST line — a
 * model that stacks several calls with intro text (e.g. listing multiple
 * stickers) used to have every call except the last one ride along as
 * literal text instead of firing. Kept separate from actually firing them
 * so callers can send the text FIRST and only fire stickers afterward —
 * firing here too early is what caused stickers to arrive before the text.
 */
function extractStickerCalls(textBlock) {
  const lines = (textBlock || "").split("\n");
  const kept = [];
  const stickerArgs = [];

  for (const line of lines) {
    const call = line.trim().match(/^SEND(?:_STICKER)?(?:[ \t]+(.*))?$/i);
    const arg = call?.[1]?.trim();
    if (call && arg) stickerArgs.push(arg);
    else kept.push(line);
  }

  return { text: kept.join("\n").trim(), stickerArgs };
}

/**
 * Handles whatever the model wrote after a SEND_STICKER call on its own
 * first line. The model sometimes stacks several SEND_STICKER calls back to
 * back in the same turn (one per sticker it wants to send) instead of one
 * per turn — parseReply only ever treats the FIRST line as "the command",
 * so without this, every SEND_STICKER after the first used to come back as
 * raw trailing text and get sent to the user verbatim (e.g. a literal
 * "SEND_STICKER many-blueberry" line leaking into the chat), and only the
 * first sticker actually got sent. This keeps re-parsing the trailing text,
 * firing every further bare SEND_STICKER it finds immediately — correct
 * while nothing but stickers have appeared yet, since there's no text order
 * to preserve. The moment real text shows up (a "textThenSticker" line),
 * that stops: any stickers from that point on are handed back to the caller
 * as a deferred {text, stickerArg} instead, so they fire only after the
 * text they came with is actually sent.
 */
async function drainStickerTrailing(trailing, ctx, chatId, t, opts, history, slot = null) {
  let text = trailing;
  while (text) {
    const parsed = parseReply(text);

    if (parsed.type === "command" && parsed.command === "SEND_STICKER") {
      let result;
      try {
        result = await runTool("SEND_STICKER", parsed.arg, ctx, chatId, t, opts);
      } catch (err) {
        ctx.log.error(`[many-ai] error in SEND_STICKER (chained): ${err.message}`);
        result = t("errors.toolError", { tool: "SEND_STICKER" });
      }
      pushEntry(history, { role: "user", kind: "tool", content: `[${t("tools.resultLabel")}: SEND_STICKER] ${result}` });
      text = parsed.trailing || "";
      continue;
    }

    if (parsed.type === "textThenSticker") {
      // Real text has shown up in the trail — from here on, any further
      // stickers (embedded in this text, plus the trailing one) must wait
      // until AFTER this text is sent, same as resolveReply's own
      // textThenSticker case. Stop firing immediately and hand back a
      // deferred {text, stickerArg} for the caller to send first, then fire
      // — firing here would put these stickers ahead of text nobody's sent
      // to the user yet.
      if (slot) slot.concluded = !!parsed.concluded;
      if (slot) slot.stop = !!parsed.stop;
      const { text: cleanedLeading, stickerArgs: embedded } = extractStickerCalls(parsed.value);
      return { text: cleanedLeading || null, stickerArg: [...embedded, parsed.stickerArg] };
    }

    if (parsed.type === "silent") return null;

    // Genuine leftover text (or a non-sticker command line, which we don't
    // try to execute here — same as before, it's just returned as text).
    if (slot) slot.concluded = !!parsed.concluded;
    if (slot) slot.stop = !!parsed.stop;
    return parsed.value ?? text;
  }
  return null;
}

/**
 * A reply cut off by max_tokens (finish_reason "length") used to just end
 * there, mid-sentence — this asks the model to keep going, up to
 * MAX_CONTINUATIONS times, and stitches the pieces into one final text.
 * Continuation chunks are appended as raw text, not re-parsed as a command —
 * by this point the model already committed to writing the final answer, a
 * continuation is just more of that same text.
 */
async function continueIfTruncated(text, finishReason, history, systemPrompt, ctx, keys, MODEL, maxTokens, isGemini = false, geminiModel = null) {
  let full = text;
  let reason = finishReason;
  let rounds = 0;

  while (reason === "length" && rounds < MAX_CONTINUATIONS) {
    rounds++;
    const lang = ctx.config.get("LANGUAGE", "pt");
    const nudge = lang === "pt"
      ? "[Sua última resposta foi cortada por limite de tamanho. Continue exatamente de onde parou — não repita o que já foi dito, não recomece do início, não peça desculpa por isso, só continue o texto normalmente.]"
      : "[Your last reply got cut off by a length limit. Continue exactly where you left off — don't repeat what was already said, don't restart from the top, don't apologize for it, just continue the text normally.]";
    pushEntry(history, { role: "user", kind: "tool", content: nudge });

    let cont, contReason;
    try {
      ({ content: cont, finishReason: contReason } = await withKeyFailover(
        keys, (key) => isGemini
          ? callGeminiRaw(history, systemPrompt, key, geminiModel, maxTokens)
          : callMistralRaw(history, systemPrompt, key, MODEL, maxTokens),
        ctx.log
      ));
    } catch (err) {
      ctx.log.error(`[many-ai] continuation error: ${err.message}`);
      break; // best effort — return what we already have rather than lose the whole reply
    }
    if (!cont) break;

    pushEntry(history, { role: "assistant", kind: "tool", content: cont });
    full += (/\s$/.test(full) || /^\s/.test(cont) ? "" : " ") + cont;
    reason = contReason;
  }
  return full;
}

async function resolveReply(history, systemPrompt, ctx, t, MODEL, chatId, maxIterations = 5, triggerKind = null, slot = { handle: null }, imageSource = null, audioSource = null, provider = "mistral", geminiModel = null) {
  const isGemini = provider === "gemini";
  const keys = isGemini ? getKeyPool(ctx, "GEMINI") : getKeyPool(ctx, "MISTRAL");
  if (!keys.length) throw Object.assign(new Error("no_api_keys"), { isMissingKey: true });

  const opts = getToolOpts(ctx);
  opts.imageSource = imageSource;
  opts.audioSource = audioSource;
  const lang = ctx.config.get("LANGUAGE", "pt");
  const maxTokens = Number(ctx.config.get("MANYAI_MAX_TOKENS", DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS;
  // Gemini routing (gateway task_type: COMPLEX) has no native function-calling
  // translation — always plain-text COMMAND-style tools. Doesn't affect the
  // Mistral path at all.
  const useNativeTools = !isGemini && ctx.config.get("AI_NATIVE_TOOLS", false);
  const availableTools = useNativeTools ? TOOL_DEFINITIONS : undefined;
  const callModelRaw = isGemini
    ? (key) => callGeminiRaw(history, systemPrompt, key, geminiModel, maxTokens)
    : (key) => callMistralRaw(history, systemPrompt, key, MODEL, maxTokens, availableTools);

  const thinkingIndicatorEnabled = await getSetting(ctx, "thinking", false);
  if (thinkingIndicatorEnabled) startThinkingIndicator(ctx, t, chatId, markSelfEcho, slot);

  // Belt-and-suspenders: every known exit path already stops the indicator
  // with the right final text, but an unexpected throw anywhere in the loop
  // body must never leave the moon spinner ticking forever on a bubble
  // nobody's watching anymore. Idempotent — a second thinkingStop() call
  // here after one already ran inline is a no-op.
  try {
    return await resolveReplyLoop();
  } finally {
    slot.thinkingStop?.();
  }

  async function resolveReplyLoop() {
  let pendingFileBuild = null; // set while a FILE_WRITE/FILE_APPEND job hasn't been delivered yet

  // Nudges injected into history (as a tool-result-style message) when the
  // model keeps calling tools instead of answering — either hammering the
  // SAME tool repeatedly (e.g. SEARCH x3) or racking up many tool calls
  // overall this reply. Purely a prompt-level nudge, doesn't stop/block
  // anything — the model can ignore it, but usually answers or asks the
  // user for permission to keep trying instead.
  let toolStreak = { command: null, count: 0 };
  let totalToolCalls = 0;
  const REPEAT_EVERY = Number(ctx.config.get("AI_TOOL_REPEAT_WARNING_THRESHOLD", 3)) || 3;
  const TOTAL_EVERY = Number(ctx.config.get("AI_TOOL_TOTAL_WARNING_THRESHOLD", 6)) || 6;

  function maybeNudgeToolOveruse(cmdName) {
    totalToolCalls++;
    toolStreak = toolStreak.command === cmdName
      ? { command: cmdName, count: toolStreak.count + 1 }
      : { command: cmdName, count: 1 };

    let nudge = null;
    if (toolStreak.count > 0 && toolStreak.count % REPEAT_EVERY === 0) {
      nudge = lang === "pt"
        ? `[Você já chamou ${cmdName} ${toolStreak.count} vez(es) seguida(s) nesta resposta. O usuário está esperando uma resposta — se ainda não achou o que precisa, responda com o que já tem ou pergunte ao usuário se deve continuar tentando.]`
        : `[You've called ${cmdName} ${toolStreak.count} time(s) in a row in this reply. The user is waiting for an answer — if you still haven't found what you need, answer with what you have or ask the user whether to keep trying.]`;
    } else if (totalToolCalls > 0 && totalToolCalls % TOTAL_EVERY === 0) {
      nudge = lang === "pt"
        ? `[Você já usou ferramentas ${totalToolCalls} vezes nesta resposta sem responder ao usuário ainda. Considere responder com o que já tem, ou perguntar ao usuário se deve continuar.]`
        : `[You've used tools ${totalToolCalls} times in this reply without answering the user yet. Consider answering with what you have, or asking the user whether to keep going.]`;
    }
    if (nudge) {
      pushEntry(history, { role: "user", kind: "tool", content: nudge });
      ctx.log.info(`[many-ai] tool-overuse nudge: cmd=${cmdName} streak=${toolStreak.count} total=${totalToolCalls}`);
    }
  }

  for (let i = 0; i < maxIterations; i++) {
    let raw, finishReason, toolCalls;
    try {
      const result = await withKeyFailover(keys, (key) => callModelRaw(key), ctx.log);
      raw = result.content;
      finishReason = result.finishReason;
      toolCalls = result.toolCalls;
    } catch (err) {
      await slot.thinkingStop?.(); // don't leave an animated bubble ticking forever on a hard failure
      throw err;
    }

    if (toolCalls && toolCalls.length) {
      pushEntry(history, { role: "assistant", kind: "tool_call", tool_calls: toolCalls, content: raw || "" });
      for (const tc of toolCalls) {
        const cmdName = TOOL_NAME_MAP[tc.function.name];
        if (!cmdName) {
          ctx.log.warn(`[many-ai] unknown native tool: ${tc.function.name}`);
          continue;
        }
        let argStr = "";
        let parsedArgs = null;
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
          // file_agent needs its full JSON payload (action + named fields like
          // path/content/dest/paths) — collapsing it to space-joined values
          // like every other tool loses the field names runFileAgent needs.
          argStr = cmdName === "FILE_AGENT"
            ? (tc.function.arguments || "{}")
            : Object.values(parsedArgs).filter(v => v != null).join(" ");
        } catch {
          argStr = tc.function.arguments || "";
        }

        let result;
        try {
          result = await withToolProgress(cmdName, argStr, ctx, t, chatId, markSelfEcho, slot, () =>
            runToolWithRetry(cmdName, argStr, ctx, chatId, t, opts));
        } catch (err) {
          ctx.log.error(`[many-ai] error in ${cmdName}: ${err.message}`);
          result = formatToolError(cmdName, err, lang);
        }
        pendingFileBuild = trackFileBuildState(cmdName, result, pendingFileBuild);
        syncPendingFileBuild(chatId, pendingFileBuild);

        pushEntry(history, {
          role: "user",
          kind: "tool_result",
          tool_call_id: tc.id,
          content: result,
        });
        maybeNudgeToolOveruse(cmdName);

        if (cmdName === "SEND_STICKER") {
          const trailing = (raw || "").split("\n").slice(1).join("\n").trim();
          if (trailing) return await drainStickerTrailing(trailing, ctx, chatId, t, opts, history, slot);
        }
      }
      continue;
    }

    const parsed = parseReply(raw);

    if (!raw) {
      continue;
    }

    // The model got cut off by the token limit while still inside its own
    // [THINKING] block (never reached [/THINKING]) — nothing here is meant
    // for the user. Keep the "thinking..." bubble ticking (don't stop it —
    // we're not done) and ask the model to close the thought and give its
    // real answer, exactly like a truncated real reply would be continued.
    if (parsed.type === "truncated_thinking") {
      pushEntry(history, { role: "assistant", kind: "tool", content: raw });
      const lang = ctx.config.get("LANGUAGE", "pt");
      const nudge = lang === "pt"
        ? "[Sua resposta foi cortada por limite de tamanho ainda dentro do bloco [THINKING]. Feche com [/THINKING] e escreva sua resposta final de verdade — não repita o raciocínio já escrito.]"
        : "[Your reply got cut off by the length limit while still inside the [THINKING] block. Close it with [/THINKING] and write your actual final reply — don't repeat the reasoning already written.]";
      pushEntry(history, { role: "user", kind: "tool", content: nudge });
      continue;
    }

    // Real text is coming (or we're staying silent) — either way the generic
    // "thinking" message is done; finalize it with the elapsed time. It's
    // its own persistent log entry now, independent from the real reply.
    await slot.thinkingStop?.();

    pushEntry(history, { role: "assistant", kind: "tool", content: raw });

    if (parsed.type === "msg") {
      slot.concluded = !!parsed.concluded;
      slot.stop = !!parsed.stop;
      return await continueIfTruncated(parsed.value, finishReason, history, systemPrompt, ctx, keys, MODEL, maxTokens, isGemini, geminiModel);
    }
    if (parsed.type === "silent") {
      return null;
    }
    if (parsed.type === "unknown_command") {
      const lang = ctx.config.get("LANGUAGE", "pt");
      const errMsg = lang === "pt"
        ? `[ERRO DE FERRAMENTA] Comando desconhecido "${parsed.command}". Comandos válidos: ${KNOWN_COMMANDS.join(", ")}. Corrija o nome/sintaxe e tente de novo, ou responda normalmente em texto.`
        : `[TOOL ERROR] Unknown command "${parsed.command}". Valid commands: ${KNOWN_COMMANDS.join(", ")}. Fix the name/syntax and try again, or just answer in plain text.`;
      pushEntry(history, { role: "user", kind: "tool", content: errMsg });
      continue;
    }
    if (parsed.type === "textThenSticker") {
      slot.concluded = !!parsed.concluded;
      slot.stop = !!parsed.stop;
      const { text: cleanedText, stickerArgs: embedded } = extractStickerCalls(parsed.value);
      return { text: cleanedText || null, stickerArg: [...embedded, parsed.stickerArg] };
    }

    function formatToolResultEntry(command, arg, result) {
      const label = t("tools.resultLabel");
      switch (command) {
        case "SEARCH": {
          const parts = (result || "").split(" | ").filter(Boolean);
          const shown = parts.slice(0, 6);
          const more = Math.max(0, parts.length - shown.length);
          const previewList = shown.map(p => preview(p, 120)).join("; ");
          const suffix = more ? ` …e ${more} mais` : "";
          return `[${label}: ${command}] Pesquisei: ${previewList}${suffix}`;
        }
        case "FETCH": {
          let host = "";
          try { host = new URL(arg).hostname; } catch (_) { host = arg ? preview(arg, 60) : ""; }
          return `[${label}: ${command}] Pesquisei: ${host}`;
        }
        case "SKILL": {
          const m = (result || "").match(/^\[(.+?)\]/);
          const skillName = m ? m[1] : (arg ? preview(arg, 60) : "");
          return `[${label}: ${command}] Skill: ${skillName}`;
        }
        case "MEM_READ": {
          return `[${label}: ${command}] Lendo memória: chat ${chatId}`;
        }
        case "CALC": {
          return `[${label}: ${command}] Calculando`;
        }
        case "ANALYZE_IMAGE": {
          return `[${label}: ${command}] ${preview(result || "", 500)}`;
        }
        default:
          if (command.startsWith("FILE_")) {
            const payload = typeof result === "string" ? result : JSON.stringify(result);
            return `[${label}: ${command}] ${preview(payload, 500)}`;
          }
          return `[${label}: ${command}] ${result}`;
      }
    }

    // FILE_WRITE/FILE_OVERWRITE/FILE_APPEND take their content from
    // whatever follows the path on the command's first line — either later
    // in that same line, or (for anything longer) on the lines after it.
    // parseReply only ever puts the first line in "arg" and the rest in
    // "trailing", so combine them here before dispatch; every other command
    // ignores its own trailing text the same way it always has.
    const toolArg = FILE_CONTENT_COMMANDS.has(parsed.command) && parsed.trailing
      ? `${parsed.arg}\n${parsed.trailing}`
      : parsed.arg;

    let result;
    try {
      result = await withToolProgress(parsed.command, toolArg, ctx, t, chatId, markSelfEcho, slot, () =>
        runToolWithRetry(parsed.command, toolArg, ctx, chatId, t, opts));
    } catch (err) {
      ctx.log.error(`[many-ai] error in ${parsed.command}: ${err.message}`);
      result = formatToolError(parsed.command, err, lang);
    }
    pendingFileBuild = trackFileBuildState(parsed.command, result, pendingFileBuild);
    syncPendingFileBuild(chatId, pendingFileBuild);

    pushEntry(history, { role: "user", kind: "tool", content: formatToolResultEntry(parsed.command, parsed.arg, result) });
    maybeNudgeToolOveruse(parsed.command);

    if (parsed.command === "SEND_STICKER" && parsed.trailing) {
      return await drainStickerTrailing(parsed.trailing, ctx, chatId, t, opts, history, slot);
    }
  }

  if (pendingFileBuild) {
    // Best-effort, no LLM call involved — just records where things stand so
    // a later FILE_RESUME can pick the byte count back up even if this
    // exact conversation doesn't carry the detail forward.
    try {
      await runFileAgent(ctx, {
        action: "checkpoint",
        data: { auto: true, incomplete_file: pendingFileBuild.path, reason: "max_tool_iterations_reached" },
      }, { ...opts, chatId });
    } catch (err) {
      ctx.log.warn(`[many-ai] auto-checkpoint for incomplete file build failed: ${err.message}`);
    }

    const unfinishedNudge = lang === "pt"
      ? `[Você já usou todas as chamadas de ferramenta disponíveis nesta resposta, e o arquivo "${pendingFileBuild.path}" ainda NÃO terminou de ser gerado — não foi entregue (FILE_SEND/FILE_ZIP) ainda. NÃO invente que terminou nem descreva o arquivo como pronto. Responda em texto normal explicando brevemente pra pessoa que ainda falta concluir e que é só mandar outra mensagem (ex: "continua") que você retoma de onde parou.]`
      : `[You've used up every tool call available for this reply, and the file "${pendingFileBuild.path}" is NOT finished yet — it hasn't been delivered (FILE_SEND/FILE_ZIP) yet. Do NOT claim it's done or describe it as ready. Answer in plain text briefly explaining that it's still in progress and that sending another message (e.g. "continue") will let you pick up where you left off.]`;
    pushEntry(history, { role: "user", kind: "tool", content: unfinishedNudge });
  } else {
    const forceNudge = lang === "pt"
      ? "[Você já usou todas as chamadas de ferramenta disponíveis nesta resposta. NÃO chame nenhuma ferramenta agora — responda em texto normal com o que você já descobriu até aqui, mesmo que incompleto. Se não tiver nada útil, diga isso brevemente em vez de ficar em silêncio.]"
      : "[You've used up every tool call available for this reply. Do NOT call any tool now — answer in plain text with whatever you've already found, even if incomplete. If you genuinely have nothing useful, say so briefly instead of staying silent.]";
    pushEntry(history, { role: "user", kind: "tool", content: forceNudge });
  }

  try {
    const { content: raw, finishReason } = await withKeyFailover(
      keys, (key) => isGemini
        ? callGeminiRaw(history, systemPrompt, key, geminiModel, maxTokens)
        : callMistralRaw(history, systemPrompt, key, MODEL, maxTokens),
      ctx.log
    );
    if (raw) {
      const parsed = parseReply(raw);
      pushEntry(history, { role: "assistant", kind: "tool", content: raw });
      if (parsed.type === "msg") {
        slot.concluded = !!parsed.concluded;
        slot.stop = !!parsed.stop;
        return await continueIfTruncated(parsed.value, finishReason, history, systemPrompt, ctx, keys, MODEL, maxTokens, isGemini, geminiModel);
      }
      if (parsed.type === "textThenSticker") {
        slot.concluded = !!parsed.concluded;
        slot.stop = !!parsed.stop;
        const { text: cleanedText, stickerArgs: embedded } = extractStickerCalls(parsed.value);
        return { text: cleanedText || null, stickerArg: [...embedded, parsed.stickerArg] };
      }
    }
  } catch (err) {
    ctx.log.error(`[many-ai] forced final answer error: ${err.message}`);
  }

  // Everything above (forced final call) failed to produce a parseable text
  // reply — the user must never be left with dead silence just because the
  // model didn't follow the forceNudge/unfinishedNudge instructions on its
  // last try. Hardcoded fallback, not dependent on the model behaving.
  ctx.log.warn(t("logs.maxIterationsReached"));
  slot.concluded = false;
  slot.stop = false;
  const fallbackText = pendingFileBuild
    ? (lang === "pt"
        ? `Ainda estou montando o arquivo ("${pendingFileBuild.path}"), mas usei todas as chamadas de ferramenta disponíveis nesta resposta. Manda "continua" que eu retomo de onde parei.`
        : `I'm still building the file ("${pendingFileBuild.path}"), but I've used up every tool call available for this reply. Send "continue" and I'll pick up where I left off.`)
    : (lang === "pt"
        ? "Não consegui terminar de processar isso agora. Tenta de novo ou me manda mais detalhes."
        : "I couldn't finish processing that right now. Try again or send me more details.");
  return fallbackText;
  } // resolveReplyLoop
}

// Returns the trigger kind ("command" | "word" | "literal" | "quote" |
// "continuation") or null. "command" is an explicit, deliberate address
// (the sender @-mentioned the bot's own contact); the other kinds are
// ambient (name mentioned, quoted, or a same-sender follow-up right after
// the bot replied) and stay eligible for SILENT — only "command" disables
// it in the prompt.
function getTriggerKind(msg, quotedRaw, triggers, wordRE, chatId) {
  if (msg.hasBotMention) return "command";

  // Quote and continuation are unambiguous — replying to the bot's own
  // message, or being mid-conversation with it, is a much stronger signal
  // than the name simply appearing in the text. Checked before word/literal
  // so a reply that also happens to mention the name (e.g. "Many vc é muito
  // legal" sent as a reply to the bot) is correctly classified as "quote"
  // (forces a real answer) instead of "word" (still allows SILENT).
  if (quotedRaw?.fromMe) return "quote"; // quoting the AI's own message

  // A message formatted as a command (e.g. "!figurinha") is addressed to
  // whichever plugin actually owns that command — it must never trigger the
  // AI via continuation/word/literal just because it happens to contain the
  // AI's name or arrive during a continuation window. Only this plugin's
  // own command (checked above) or a quote can still reach the AI once "!"
  // is involved.
  if (msg.hasPrefix) return null;

  // Replying to someone else's message (not the AI's) is a strong signal
  // this is a different conversation, even from the same sender inside an
  // otherwise-open window — don't let it count as a continuation.
  const repliesToSomeoneElse = !!quotedRaw && !quotedRaw.fromMe;

  const pending = pendingContinuation.get(chatId);
  if (pending && pending.senderName === msg.senderName && Date.now() < pending.expiresAt && !repliesToSomeoneElse) return "continuation";

  if (wordRE?.test(msg.body)) return "word";
  if (triggers.some(tr => msg.body.trim().toLowerCase().includes(tr.toLowerCase()))) return "literal";

  return null;
}

/** Opens (or refreshes) the continuation window right after the bot actually sends a reply. */
/** Registers self-echo, then replies — use for ANY text this plugin sends via msg.reply.text,
 * not just the AI's final answer. Every send is a potential echo source. */
function guardedReply(chatId, msgObj, text) {
  markSelfEcho(chatId, text);
  return msgObj.reply.text(text);
}

/** Same, for ctx.send.text (unprompted / no message to quote). */
function guardedSend(chatId, ctx, text) {
  markSelfEcho(chatId, text);
  return ctx.send.text(text);
}

function markContinuation(chatId, senderName) {
  pendingContinuation.set(chatId, { senderName, expiresAt: Date.now() + CONTINUATION_WINDOW_MS });
}

/** Records what the bot just sent, so a later incoming echo of that message can be recognized and
 * ignored as a trigger source. */
function markSelfEcho(chatId, bodies) {
  const list = recentlySentByBot.get(chatId) || [];
  const expiresAt = Date.now() + SELF_ECHO_WINDOW_MS;
  for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
    if (body) list.push({ body, expiresAt });
  }
  recentlySentByBot.set(chatId, list);
}

/** Checks whether `body` matches something the bot itself just sent to this chat; if so, consumes
 * that entry (so a later unrelated repeat of the same text isn't wrongly treated as an echo too). */
function consumeSelfEcho(chatId, body) {
  const list = recentlySentByBot.get(chatId);
  if (!list || !list.length) return false;
  const now = Date.now();
  const idx = list.findIndex(e => e.body === body && now < e.expiresAt);
  if (idx === -1) {
    const fresh = list.filter(e => now < e.expiresAt); // opportunistic cleanup of expired entries
    if (fresh.length !== list.length) recentlySentByBot.set(chatId, fresh);
    return false;
  }
  list.splice(idx, 1);
  return true;
}

const MEDIA_FETCH_TIMEOUT_MS = 20000;

/** Downloads a markdown image's URL and sends it as the right media type
 * based on the response content-type. Falls back to a plain text line
 * (alt: url) if the download or send fails — never silently drops it. */
async function sendMediaPart(ctx, sender, part) {
  ctx.log.info(`[many-ai:waFormat] downloading media: ${part.url}`);
  try {
    const res = await fetchWithTimeout(part.url, {}, MEDIA_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (contentType.startsWith("image/")) {
      await sender.image(buf, part.alt || undefined);
    } else if (contentType.startsWith("video/")) {
      await sender.video(buf, part.alt || undefined);
    } else if (contentType.startsWith("audio/")) {
      await sender.audio(buf);
    } else {
      await sender.file(buf, part.alt || undefined);
    }
    ctx.log.info(`[many-ai:waFormat] media sent ok: ${part.url} (contentType=${contentType || "unknown"})`);
  } catch (err) {
    ctx.log.error(`[many-ai:waFormat] media download/send failed for ${part.url}: ${err.message}`);
    const fallback = part.alt ? `${part.alt}: ${part.url}` : part.url;
    await sender.text(fallback);
  }
}

/** Sends every part after the first as its own WhatsApp message, in order:
 * code parts keep bare triple-backtick fences (no language tag), media
 * parts are downloaded and sent as image/video/audio/file, text parts are
 * plain sends. `sender` is a WAMessageSender (msg.reply or ctx.send). */
async function sendFormattedTail(ctx, sender, parts, onBeforeSend) {
  for (const part of parts) {
    if (part.type === "code") {
      const body = "```\n" + part.content + "\n```";
      onBeforeSend?.([body]);
      await sender.text(body);
    } else if (part.type === "media") {
      await sendMediaPart(ctx, sender, part);
    } else if (part.content?.trim()) {
      onBeforeSend?.([part.content]);
      await sender.text(part.content);
    }
  }
}

/**
 * Sends a reply as a single WhatsApp message, quoting the original message.
 * `onBeforeSend` (used to register the self-echo guard) runs BEFORE the
 * await, not after — the platform can hand this same outgoing message back
 * as an incoming event while the send call is still in flight, and if the
 * guard isn't registered yet at that point, the echo slips through as a
 * "new" message and can trigger a self-reply loop (confirmed in testing).
 */
/**
 * The raw text is run through waFormat.splitForSending() first: WhatsApp
 * markdown (bold/italic/headers) is applied to the leading text part, and
 * any code blocks or images are detached into their own messages sent via
 * sendFormattedTail AFTER the main (typed-out or plain) message.
 */
async function sendReplyLines(ctx, msg, reply, onBeforeSend, slotHandle) {
  const raw = (reply || "").trim();
  if (!raw) return { lines: [] };

  const parts = splitForSending(raw);
  ctx.log.info(`[many-ai:waFormat] reply -> ${parts.length} part(s): ${parts.map(p => p.type).join(", ") || "(empty)"}`);

  const first = parts[0];
  let tail = parts;

  if (first && first.type === "text") {
    const body = first.content;
    if (slotHandle) {
      const typed = await typeOutReplyChecked(slotHandle, body, (partial) => onBeforeSend?.([partial]));
      if (!typed) { onBeforeSend?.([body]); await msg.reply.text(body); }
    } else {
      onBeforeSend?.([body]);
      await msg.reply.text(body);
    }
    tail = parts.slice(1);
  } else if (slotHandle) {
    // Reply starts with code/media, not text — drop the bubble and send
    // every part fresh below instead.
    try { await slotHandle.delete(); } catch (_) { /* best-effort */ }
  }

  if (tail.length) await sendFormattedTail(ctx, msg.reply, tail, onBeforeSend);

  return { lines: [raw] };
}

/** Same, but for unprompted sends (passive intervention) — no original message to quote. */
async function sendBroadcastLines(ctx, reply, onBeforeSend, slotHandle) {
  const raw = (reply || "").trim();
  if (!raw) return { lines: [] };

  const parts = splitForSending(raw);
  ctx.log.info(`[many-ai:waFormat] broadcast -> ${parts.length} part(s): ${parts.map(p => p.type).join(", ") || "(empty)"}`);

  const first = parts[0];
  let tail = parts;

  if (first && first.type === "text") {
    const body = first.content;
    if (slotHandle) {
      const typed = await typeOutReplyChecked(slotHandle, body, (partial) => onBeforeSend?.([partial]));
      if (!typed) { onBeforeSend?.([body]); await ctx.send.text(body); }
    } else {
      onBeforeSend?.([body]);
      await ctx.send.text(body);
    }
    tail = parts.slice(1);
  } else if (slotHandle) {
    try { await slotHandle.delete(); } catch (_) { /* best-effort */ }
  }

  if (tail.length) await sendFormattedTail(ctx, ctx.send, tail, onBeforeSend);

  return { lines: [raw] };
}

/**
 * Deterministic, no-AI-call settings command — this must work even if the
 * AI is disabled for the chat (it's the only way to turn it back on), and
 * runs before anything else in the handler. In groups, only admins can
 * change settings (anyone can check status); in DMs, the one user can.
 */
async function handleSettingsCommand(ctx, args, t) {
  const sub = (args[0] || "status").toLowerCase();
  const chatId = ctx.chat.id;
  const reply = (text) => guardedReply(chatId, ctx.msg, text);

  if (ctx.chat.isGroup && sub !== "status") {
    const isAdmin = await ctx.chat.isSenderAdmin();
    if (!isAdmin) {
      await reply(t("settings.adminOnly"));
      return;
    }
  }

  if (sub === "off") {
    const ok = await setSetting(ctx, "enabled", false);
    await reply(ok ? t("settings.disabled") : t("settings.saveError"));
    return;
  }
  if (sub === "on") {
    const ok = await setSetting(ctx, "enabled", true);
    await reply(ok ? t("settings.enabled") : t("settings.saveError"));
    return;
  }
  if (sub === "intervention" || sub === "intervencao" || sub === "intervenção") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "passiveIntervention", true);
      await reply(ok ? t("settings.interventionOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "passiveIntervention", false);
      await reply(ok ? t("settings.interventionOff") : t("settings.saveError"));
    } else {
      await reply(t("settings.interventionUsage"));
    }
    return;
  }
  if (sub === "sticker" || sub === "stickers" || sub === "figurinha" || sub === "figurinhas") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "stickersEnabled", true);
      await reply(ok ? t("settings.stickerOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "stickersEnabled", false);
      await reply(ok ? t("settings.stickerOff") : t("settings.saveError"));
    } else {
      await reply(t("settings.stickerUsage"));
    }
    return;
  }

  if (sub === "thinking") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "thinking", true);
      await reply(ok ? t("settings.thinkingOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "thinking", false);
      await reply(ok ? t("settings.thinkingOff") : t("settings.saveError"));
    } else {
      await reply(t("settings.thinkingUsage"));
    }
    return;
  }

  if (sub === "tools" || sub === "ferramentas" || sub === "toolprogress") {
    const state = (args[1] || "").toLowerCase();
    if (state === "on") {
      const ok = await setSetting(ctx, "showToolProgress", true);
      await reply(ok ? t("settings.toolsOn") : t("settings.saveError"));
    } else if (state === "off") {
      const ok = await setSetting(ctx, "showToolProgress", false);
      await reply(ok ? t("settings.toolsOff") : t("settings.saveError"));
    } else {
      await reply(t("settings.toolsUsage"));
    }
    return;
  }

  const enabled      = await getSetting(ctx, "enabled", true);
  const intervention = await getSetting(ctx, "passiveIntervention", false);
  const stickerOn    = await getSetting(ctx, "stickersEnabled", true);
  const thinkingOn   = await getSetting(ctx, "thinking", false);
  const toolsOn      = await getSetting(ctx, "showToolProgress", false);
  const cmd          = ctx.config.get("MANYAI_SETTINGS_COMMAND", "ai-settings");
  await reply(t("settings.status", {
    cmd,
    enabled:      enabled      ? t("settings.yes") : t("settings.no"),
    intervention: intervention ? t("settings.yes") : t("settings.no"),
    sticker:      stickerOn    ? t("settings.yes") : t("settings.no"),
    thinking:     thinkingOn   ? t("settings.yes") : t("settings.no"),
    tools:        toolsOn      ? t("settings.yes") : t("settings.no"),
  }));
}


/**
 * Runs the actual "should I say something" check. Two stages: gateway.js's
 * cheap gate model returns ANSWER/MAYBE/SILENT for the given `reason`
 * ("question" | "help" | "dm-message" — see gateway.js buildGatewayPrompt),
 * and only when it isn't SILENT does the main model (same one used for
 * direct triggers) run the full resolveReply loop to generate the real
 * reply. Keeps quality consistent with direct triggers while only paying
 * the main model's cost on the rare messages that actually warrant one.
 */
async function runPassiveCheck(ctx, chatId, history, t, senderName, { reason = "help" } = {}) {
  const dm = reason === "dm-message";

  // Automatic/uninvited replies — no mention, no name, no quote, no other
  // trigger — only ever happen if explicitly turned on for this chat, in
  // groups AND in DMs. Off by default: outside this, a reply requires a
  // real trigger. Re-checked here (not just at the call site) since a
  // pending setTimeout could fire after the setting was flipped off.
  const passiveOn = await getSetting(ctx, "passiveIntervention", false);
  if (!passiveOn) return;

  const { config } = ctx;
  const lang      = config.get("LANGUAGE", "pt");
  const gateModel = config.get("AI_PASSIVE_MODEL", "mistral-small-latest");
  const MODEL     = config.get("MISTRAL_MODEL", "mistral-medium-latest");
  const aiName    = config.get("AI_NAME", "");
  const taskTypeEnabled = config.get("AI_TASK_TYPE_ENABLED", true);

  const scratch = history.slice();
  const verdict = await runGateway({ reason, history: scratch, ctx, aiName, lang, gateModel, taskTypeEnabled });
  if (verdict === VERDICT.SILENT) return;

  const { stickersEnabled, stickers } = await getStickerPromptExtras(ctx);
  const { alwaysSkills, skillNames } = await getSkillPromptExtras(config);
  const thinkingEnabled = await getSetting(ctx, "thinking", false);
  const chatMemories = await memRecent(chatId, 10);
  const maxTokens = Number(config.get("MANYAI_MAX_TOKENS", DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS;
  const basePrompt = buildSystemPrompt({
    name: config.get("AI_NAME", ""),
    personality: config.get("AI_PERSONALITY", ""),
    purpose: config.get("AI_PURPOSE", ""),
    extraInstructions: config.get("AI_EXTRA_INSTRUCTIONS", ""),
    language: lang,
    model: MODEL,
    isGroup: !dm,
    settingsCommand: config.get("MANYAI_SETTINGS_COMMAND", "ai-settings"),
    cmdPrefix: config.get("CMD_PREFIX", "!"),
    emojis: config.get("AI_EMOJIS", false),
    replyLength: config.get("AI_REPLY_LENGTH", "short"),
    otherCommands: config.get("AI_OTHER_COMMANDS", []),
    fileAgentEnabled: config.get("AI_FILE_AGENT_ENABLED", false),
    geminiVisionEnabled: config.get("AI_GEMINI_VISION_ENABLED", false),
    stickersEnabled,
    stickers,
    skillNames,
    alwaysSkills,
    thinkingEnabled,
    chatMemories,
    maxTokens,
  });

  const passiveNote = dm
    ? (lang === "pt"
        ? "\n[CONVERSA PRIVADA]\nÉ óbvio que esta mensagem é pra você — é 1:1, não precisa do seu nome. Responda normalmente, como numa conversa direta com a pessoa, incluindo cumprimentos e comentários simples."
        : "\n[PRIVATE CHAT]\nIt's obvious this message is meant for you — it's 1:1, no name needed. Respond normally, like a direct conversation with the person, including greetings and short comments.")
    : (lang === "pt"
        ? "\n[MODO PASSIVO]\nNinguém te chamou diretamente, mas a mensagem foi identificada como uma pergunta sem resposta ou um pedido de ajuda que vale a pena responder. Responda de forma natural e direta."
        : "\n[PASSIVE MODE]\nNobody called you directly, but the message was identified as an unanswered question or a help request worth responding to. Reply naturally and directly.");

  try {
    const slot = { handle: null };
    const reply = await withChatLock(chatId, () => resolveReply(scratch, basePrompt + passiveNote, ctx, t, MODEL, chatId, 3, "passive", slot));
    if (!reply) return;

    const replyText = typeof reply === "object" ? reply.text : reply;

    pushEntry(history, { role: "assistant", kind: "tool", content: replyText });
    const { lines } = await sendBroadcastLines(ctx, replyText, (l) => markSelfEcho(chatId, l), slot.handle);
    if (typeof reply === "object") await sendStickerAfterText(ctx, chatId, t, history, reply.stickerArg);
    if (slot.concluded) {
      pendingContinuation.delete(chatId);
    } else if (senderName) {
      markContinuation(chatId, senderName);
    }
  } catch (err) {
    ctx.log.error(`[many-ai] passive intervention error: ${err.message}`);
    // stay silent on error — never surface an error for something nobody asked for
  }
}

/**
 * DM counterpart to maybeIntervenePassively: only runs the actual gate/reply
 * check if passiveIntervention is on for this chat (see runPassiveCheck) —
 * otherwise a DM behaves exactly like a group, requiring an @mention or a real
 * trigger. When it IS on, this skips the group's unanswered-question wait
 * timer and asks the model directly — the passiveNote (dm: true) is what
 * makes it treat every message as already addressed to it once activated.
 */
async function maybeInterveneInDM(ctx, chatId, history, body, t, senderName) {
  // Unlike the group's noise filter, don't drop short messages here when
  // this IS active — "oi"/"olá" deserve a real check, not a length cutoff.
  if (!body.trim()) return;
  await runPassiveCheck(ctx, chatId, history, t, senderName, { reason: "dm-message" });
}

/**
 * Decides whether a non-triggering group message is worth a passive-mode
 * AI check at all. Cheap heuristics only — they exist purely to avoid
 * spending an API call on every single message in an active group.
 */
async function maybeIntervenePassively(ctx, chatId, history, body, t, senderName) {
  const passiveOn = await getSetting(ctx, "passiveIntervention", false);
  if (!passiveOn || isTooShortToConsider(body)) {
    return;
  }

  const lang = ctx.config.get("LANGUAGE", "pt");

  if (looksLikeUnansweredQuestion(body)) {
    const waitMinutes = Number(ctx.config.get("AI_INTERVENTION_WAIT_MINUTES", 1)) || 1;
    const snapshot = lastActivityAt.get(chatId);
    setTimeout(() => {
      // Someone else spoke in this chat since — the question may already
      // be answered, or the moment has passed. Stay out of it.
      if (lastActivityAt.get(chatId) !== snapshot) return;
      runPassiveCheck(ctx, chatId, history, t, senderName, { reason: "question" }).catch(err => ctx.log.error(`[many-ai] delayed passive check error: ${err.message}`));
    }, waitMinutes * 60_000);
    return;
  }

  if (looksLikeHelpRequest(body, lang)) {
    await runPassiveCheck(ctx, chatId, history, t, senderName, { reason: "help" });
  }
}

export async function setup(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);

  initMemory(ctx);

  const keys = getKeyPool(ctx, "MISTRAL");
  if (!keys.length) {
    ctx.log.warn(t("logs.missingApiKeyWarning"));
  } else {
    ctx.log.success(t("logs.ready", { model: ctx.config.get("MISTRAL_MODEL", "mistral-medium-latest"), count: keys.length }));
  }
}

export const guardOptions = {
  timeout: false, // search + several chained AI calls can take longer than 2min
};

export default async function (ctx) {
  const { msg, chat, config } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const chatId = chat.id;

  lastActivityAt.set(chatId, Date.now());
  const pendingCont = pendingContinuation.get(chatId);
  // The bot's own sent messages come back as normal incoming events with a
  // different senderName than whoever it's talking to (a group JID/number
  // instead of the real name) — without the fromMe guard, the sticker +
  // "Cheguei!" the AI just sent were themselves wiping the continuation
  // window before the human's next message ever arrived.
  if (pendingCont && pendingCont.senderName !== msg.senderName && !msg.fromMe) pendingContinuation.delete(chatId);

  const settingsCommand = config.get("MANYAI_SETTINGS_COMMAND", "ai-settings");
  if (settingsCommand && msg.is(settingsCommand)) {
    await handleSettingsCommand(ctx, msg.args, t);
    return;
  }

  // Kill switch checked before anything else AI-related — indexing included.
  // Not everyone wants a chat listened to at all; "!ai-settings off" (above)
  // is the only thing that still works once this is set.
  const enabled = await getSetting(ctx, "enabled", true);
  if (!enabled) return;

  const lang         = config.get("LANGUAGE", "pt");
  const aiName       = config.get("AI_NAME", "");
  const triggers     = config.get("MANYAI_TRIGGERS", []);
  const MODEL        = config.get("MISTRAL_MODEL", "mistral-medium-latest");
  const fileAgentEnabled = config.get("AI_FILE_AGENT_ENABLED", false);
  const geminiVisionEnabled = config.get("AI_GEMINI_VISION_ENABLED", false);
  // Multi-provider routing: the gateway classifies each reply as SIMPLE or
  // COMPLEX (code, file building, multi-step technical work); COMPLEX turns
  // route to Gemini instead of Mistral, since Mistral is noticeably weaker
  // at exactly that kind of task. Opt-in — off unless a Gemini key AND this
  // flag are both set, so nothing changes for anyone who hasn't configured
  // Gemini. Only applies to the plain-text COMMAND-style tool syntax; if
  // native function calling is on, always stays on Mistral (no schema
  // translation implemented for Gemini's function-calling format).
  const geminiTextEnabled = config.get("AI_GEMINI_TEXT_ENABLED", false)
    && !config.get("AI_NATIVE_TOOLS", false)
    && getKeyPool(ctx, "GEMINI").length > 0;
  const geminiTextModel = config.get("AI_GEMINI_TEXT_MODEL", "gemini-pro-latest");

  // Word trigger defaults to the configured AI name (if any) — never a
  // hardcoded word. Explicitly set MANYAI_WORD_TRIGGERS to override.
  let wordTriggers = config.get("MANYAI_WORD_TRIGGERS", null);
  if (wordTriggers === null) wordTriggers = aiName ? [aiName] : [];
  const wordRE = buildWordTriggerRE(wordTriggers);

  const history = getHistory(chatId);

  // Resolve the quoted message (if any) once — used both to detect the
  // "quoting the AI's own message" trigger and to show the AI what the
  // current message is actually replying to.
  let quotedRaw = null;
  if (msg.hasReply) {
    try {
      quotedRaw = await msg.getReply();
    } catch (err) {
      ctx.log.info(t("logs.shouldRespond.quotedError", { error: err.message }));
    }
  }

  // getMsgType() returns: chat, image, video, audio, sticker, document, poll, unknown.
  const msgType = (msg.type || "").toLowerCase();
  const NON_TEXT_MEDIA = ["image", "video", "sticker", "document", "audio"];

  let body = msg.body || "";
  let isMediaNoCaption = false;

  if (NON_TEXT_MEDIA.includes(msgType)) {
    // No hardcoded "I can't see media" reply anymore — often it's just a
    // reaction/sticker the sender already knows won't be "seen". Label it
    // and fall through to the normal pipeline so the model judges, from
    // context, whether this genuinely needs a reply or should stay SILENT.
    body = `(${msgType} message, no caption)`;
    isMediaNoCaption = true;
  }

  // Self-echo guard: the platform can hand the bot's own outgoing message
  // back through this same handler as a normal incoming event. Confirmed in
  // testing — that echo matched word/continuation triggers and made the bot
  // reply to itself in a loop. Recognize it by matching against what we just
  // sent to this chat; if it matches, it still goes into history as context
  // (so future replies know what was said) but can never itself be a trigger.
  // `msg.fromMe` is checked too, as a hard backstop: whenever the platform
  // DOES mark an echo as fromMe, that alone is enough to disqualify it as a
  // trigger, even if the body-matching above somehow missed it (e.g. a race,
  // or a text variant that was never registered via markSelfEcho).
  const isSelfEcho = Boolean(msg.fromMe) || consumeSelfEcho(chatId, body);

  let triggerKind = isSelfEcho ? null : getTriggerKind(msg, quotedRaw, triggers, wordRE, chatId);
  // Media with no caption (image/video/sticker/document) is never something
  // to force an answer to — the model can't see it anyway. Only an explicit
  // command (an @mention of the bot) counts as actually being asked; ambient
  // triggers (word/literal/continuation/quote) must not fire on it.
  if (isMediaNoCaption && triggerKind !== "command") triggerKind = null;

  // Computed here (before ingestIncomingFile) purely to gate the VISIBLE
  // Gemini-vision analysis: only run it when the bot was actually
  // triggered, or in a DM (where everything is already meant for the bot —
  // see the isGroup comment further below). Prevents the bot from spending
  // an API call and posting an "Analisando imagem..." bubble in a group
  // just because someone's caption happened to match the analysis regex
  // while talking to someone else, not the bot.
  const visionAllowed = !isSelfEcho && (!!triggerKind || !chat.isGroup);

  // Created here (before we even know if this message triggers a reply) so
  // ingestIncomingFile's Gemini-vision progress bubble — if it shows one —
  // is the SAME message resolveReply's thinking/tool-progress indicators
  // continue editing later, instead of a separate one.
  const slot = { handle: null };

  await ingestIncomingFile(ctx, chatId, msg, history, fileAgentEnabled, {
    enabled: geminiVisionEnabled,
    keys: geminiVisionEnabled ? getKeyPool(ctx, "GEMINI") : [],
    model: config.get("GEMINI_VISION_MODEL", "gemini-flash-latest"),
  }, t, slot, visionAllowed);
  const isTriggerCandidate = !!triggerKind;
  // A message is only treated as "another plugin's command" (background
  // context, ignored by the AI) if it ISN'T itself Many's own trigger —
  // otherwise a mention-triggered message would get stored as a command and the user's
  // actual question would end up tagged as something to ignore. These are
  // stored as role "user" (something that happened in the chat), not
  // "system" — a mid-conversation system-role message could be read by the
  // model as an instruction with special authority, which it isn't.
  const isOtherPluginCommand = msg.hasPrefix && !isTriggerCandidate;

  if (isOtherPluginCommand) {
    pushEntry(history, { role: "user", kind: "command", current: false, content: formatCommandEntry({ senderName: msg.senderName, body }) });
  } else if (body.trim() || isTriggerCandidate) {
    // The `isTriggerCandidate` fallback covers the rare case of a genuine
    // trigger with no text of its own (e.g. quoting the AI's last message
    // via a poll) — otherwise an empty body (poll/unrecognized message
    // types that slip past the media checks above) isn't worth archiving.
    const quotedInfo = quotedRaw ? await buildQuotedInfo(quotedRaw) : null;
    pushEntry(history, {
      role: "user",
      kind: "chat",
      current: true,
      content: formatChatEntry({ isGroup: chat.isGroup, chatName: chat.name, senderName: msg.senderName, body, quoted: quotedInfo }),
    });
    indexMessage(chatId, msg.senderName, body); // long-term archive, regardless of whether this triggers a reply

    // A previous reply in this chat left a FILE_WRITE/FILE_APPEND undelivered
    // (either it ran out of tool-call budget, or it paused on its own to ask
    // for "continua"). The model may no longer have that in its own working
    // context by now — this reminder is what actually makes the resume work,
    // rather than relying on it to remember or infer that on its own.
    const pendingBuild = pendingFileBuilds.get(chatId);
    if (pendingBuild && Date.now() < pendingBuild.expiresAt) {
      const reminder = lang === "pt"
        ? `[LEMBRETE DO SISTEMA] Há um arquivo incompleto em "${pendingBuild.path}" de uma resposta anterior — ainda não foi entregue (FILE_SEND/FILE_ZIP). Se esta mensagem for a pessoa pedindo pra continuar, chame FILE_RESUME (ou FILE_CHECKSUM/FILE_READ nesse path) PRIMEIRO pra confirmar exatamente quanto já foi escrito antes de continuar, e use FILE_APPEND pra continuar o conteúdo — NUNCA FILE_WRITE nesse mesmo path, isso falha com erro "write-target-exists" em vez de continuar (use FILE_OVERWRITE só se a intenção for mesmo recomeçar do zero). Se a pessoa pediu algo novo/diferente e esse arquivo antigo está só atrapalhando (ex.: esse mesmo erro "write-target-exists"), explique isso a ela e peça autorização pra limpar o ambiente com FILE_CLEAR antes de prosseguir — isso apaga só o workspace da IA, nunca nada do usuário. Se a pessoa mudou de assunto sem mencionar o arquivo, ignore este lembrete.`
        : `[SYSTEM REMINDER] There's an unfinished file at "${pendingBuild.path}" from an earlier reply — it hasn't been delivered (FILE_SEND/FILE_ZIP) yet. If this message is the person asking to continue, call FILE_RESUME (or FILE_CHECKSUM/FILE_READ on that path) FIRST to confirm exactly how much has been written before continuing, and use FILE_APPEND to continue the content — NEVER FILE_WRITE on that same path, that fails with a "write-target-exists" error instead of continuing it (only use FILE_OVERWRITE if the intent really is to start over). If the person asked for something new/different and this leftover file is just getting in the way (e.g. that same "write-target-exists" error), explain that to them and ask authorization to clear the workspace with FILE_CLEAR before proceeding — this only wipes the AI's own workspace, never anything of the user's. If the person changed topics without mentioning the file, ignore this reminder.`;
      pushEntry(history, { role: "user", kind: "tool", content: reminder });
      // The ordinary "continuation" window (CONTINUATION_WINDOW_MS, a few
      // minutes) closes long before most people actually get back to
      // resuming a paused file build — they read the pause message, do
      // something else, and reply 10+ minutes later. Without this, that
      // reply landed as an ordinary, untriggered message: nothing called
      // the model, the reminder above was never even read, and the person
      // saw the bot go completely silent despite having said it would
      // continue. In a DM everything is already meant for the bot (see the
      // isGroup comment near buildSystemPrompt's caller), so it's safe to
      // just resume here; still routed through the same "continuation" gate
      // below so an unrelated message doesn't wrongly reopen a stale build.
      if (!triggerKind && !chat.isGroup && !isSelfEcho) triggerKind = "continuation";
    } else if (pendingBuild) {
      pendingFileBuilds.delete(chatId); // stale — the sandbox itself will have already expired this session
    }
  }

  // Ambiguous triggers — the name mentioned ("word"/"literal"), or a
  // same-sender follow-up in a GROUP where someone else could still be the
  // intended audience ("continuation") — never used to reach the expensive
  // agent model on their own say-so; they now go through gateway.js's cheap
  // gate first, which sees the message we just pushed to history as
  // [CURRENT MESSAGE]. command/quote/DM-continuation are unambiguous and
  // skip this call entirely (see gateway.isDeterministic / prompt.js's
  // FORCE_ANSWER).
  const MENTION_KINDS = new Set(["word", "literal"]);
  let taskType = "SIMPLE"; // gateway's classification, used below to pick mistral vs gemini
  const taskTypeEnabled = config.get("AI_TASK_TYPE_ENABLED", true);
  if (MENTION_KINDS.has(triggerKind) || triggerKind === "continuation") {
    const gateReason = triggerKind === "word" ? "mention-named"
      : MENTION_KINDS.has(triggerKind) ? "mention"
      : "continuation";
    const gateModel = config.get("AI_PASSIVE_MODEL", "mistral-small-latest");
    const verdict = await runGatewayStructured({ reason: gateReason, history, ctx, aiName, lang, gateModel, taskTypeEnabled });
    if (!verdict.respond) triggerKind = null;
    taskType = verdict.taskType;
  } else if (triggerKind && geminiTextEnabled && taskTypeEnabled) {
    // Deterministic triggers (command/quote) never call the respond-gate at
    // all — the AI is answering regardless — so runGatewayStructured would
    // just short-circuit to a hardcoded "SIMPLE" without ever looking at the
    // message. Classify separately, but only pay for that extra call when
    // routing is actually enabled (nothing changes otherwise).
    const gateModel = config.get("AI_PASSIVE_MODEL", "mistral-small-latest");
    taskType = await classifyTaskType({ history, ctx, lang, gateModel });
  }
  const isTrigger = !!triggerKind;

  // Sleeping ([STOP] — see parseReply/prompt.js): the AI went fully silent
  // in this chat earlier. isTrigger already means an unambiguous trigger
  // (command/quote) or a gateway-confirmed genuine address (word/literal/
  // continuation), so it doubles as "explicit enough to wake up". Waking up
  // consumes the entry — resumeNote is handed to buildSystemPrompt once,
  // then this chat is no longer asleep for anything that follows.
  const sleeping = sleepingChats.get(chatId);
  let resumeNote = null;
  if (sleeping) {
    if (isTrigger) {
      resumeNote = sleeping.wakeMessage;
      sleepingChats.delete(chatId);
    } else {
      return; // still asleep, not explicitly addressed — stay fully silent
    }
  }

  // COMPLEX (code/file work) routes to Gemini when configured; everything
  // else, and any COMPLEX turn without Gemini available, stays on Mistral.
  const provider = (taskType === "COMPLEX" && geminiTextEnabled) ? "gemini" : "mistral";

  if (!isTrigger) {
    if (isSelfEcho) {
    } else if (isMediaNoCaption) {
    } else if (chat.isGroup && !isOtherPluginCommand) {
      maybeIntervenePassively(ctx, chatId, history, body, t, msg.senderName)
        .catch(err => ctx.log.error(`[many-ai] passive intervention error: ${err.message}`));
    } else if (!chat.isGroup && !isOtherPluginCommand) {
      maybeInterveneInDM(ctx, chatId, history, body, t, msg.senderName)
        .catch(err => ctx.log.error(`[many-ai] DM passive engagement error: ${err.message}`));
    }
    return;
  }

  // Vision analysis: if the current message has an image with a caption
  // EXPLICITLY asking about it (IMAGE_ANALYSIS_REQUEST_RE — analisa,
  // descreve, "o que é essa imagem", etc.), analyze it before the main
  // model call. Skipped when Gemini vision is on (AI_GEMINI_VISION_ENABLED)
  // — that already covers the same explicit-request case in
  // ingestIncomingFile, no point paying for two descriptions of the same
  // picture.
  const hasImage = msg.hasMedia || quotedRaw?.hasMedia;
  const shouldAnalyze = !geminiVisionEnabled && hasImage && IMAGE_ANALYSIS_REQUEST_RE.test(body);
  let visionResult = null;
  if (shouldAnalyze) {
    const visionKeys = getKeyPool(ctx, "MISTRAL");
    if (visionKeys.length) {
      const visionModel = config.get("MISTRAL_VISION_MODEL", "mistral-medium-latest");
      const source = msg.hasMedia ? msg : quotedRaw;
      visionResult = await analyzeImage(source, ctx, visionKeys, visionModel, body);
      if (visionResult) {
        pushEntry(history, {
          role: "user",
          kind: "vision",
          current: false,
          content: `[IMAGE ANALYSIS] ${visionResult}`,
        });
      }
    }
  }

  const { stickersEnabled, stickers } = await getStickerPromptExtras(ctx);
  const { alwaysSkills, skillNames } = await getSkillPromptExtras(config);
  const thinkingEnabled = await getSetting(ctx, "thinking", false);
  const chatMemories = await memRecent(chatId, 10);
  const maxTokens = Number(config.get("MANYAI_MAX_TOKENS", DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS;
  const systemPrompt = buildSystemPrompt({
    name: aiName,
    personality: config.get("AI_PERSONALITY", ""),
    purpose: config.get("AI_PURPOSE", ""),
    extraInstructions: config.get("AI_EXTRA_INSTRUCTIONS", ""),
    language: lang,
    model: MODEL,
    triggerKind,
    isGroup: chat.isGroup,
    settingsCommand,
    cmdPrefix: config.get("CMD_PREFIX", "!"),
    emojis: config.get("AI_EMOJIS", false),
    replyLength: config.get("AI_REPLY_LENGTH", "short"),
    otherCommands: config.get("AI_OTHER_COMMANDS", []),
    fileAgentEnabled,
    geminiVisionEnabled,
    stickersEnabled,
    stickers,
    skillNames,
    alwaysSkills,
    thinkingEnabled,
    chatMemories,
    resumeNote,
    maxTokens,
  });

  try {
    // Autonomy knob: how many tool-call rounds the AI gets before being forced
    // to answer with whatever it has — higher means more room to retry a
    // failed tool call or chain several before giving up. Default raised
    // from 5 to 6 (retries now cost an iteration each on top of API-level
    // transient retries in runToolWithRetry).
    const maxToolIterations = Number(config.get("AI_MAX_TOOL_ITERATIONS", 20)) || 20;
    // Same image the inline vision block above would use — passed through so
    // the model can also reach it explicitly via the ANALYZE_IMAGE tool.
    const imageSource = msg.hasMedia ? msg : (quotedRaw?.hasMedia ? quotedRaw : null);
    // Same idea for audio: the model reaches it explicitly via TRANSCRIBE_AUDIO —
    // nothing is transcribed automatically anymore.
    const audioSource = msg.type === "audio" ? msg : (quotedRaw?.type === "audio" ? quotedRaw : null);
    const reply = await withChatLock(chatId, () => resolveReply(history, systemPrompt, ctx, t, MODEL, chatId, maxToolIterations, triggerKind, slot, imageSource, audioSource));
    if (reply) {
      const replyText = typeof reply === "object" ? reply.text : reply;
      const { lines } = await sendReplyLines(ctx, msg, replyText, (l) => markSelfEcho(chatId, l), slot.handle);
      if (typeof reply === "object") await sendStickerAfterText(ctx, chatId, t, history, reply.stickerArg);
      // Simple heads-up, not a reply/quote — just a plain broadcast right
      // after the real answer — for topics the agent model can plausibly
      // hallucinate about (bot commands, ManyBot itself, external sources)
      // per gateway.js's looksHallucinationProne(). Toggle:
      // AI_HALLUCINATION_WARNING_ENABLED (on by default).
      const hallucinationWarningEnabled = config.get("AI_HALLUCINATION_WARNING_ENABLED", true);
      if (hallucinationWarningEnabled && looksHallucinationProne(body)) {
        try { await guardedSend(chatId, ctx, t("warnings.hallucinationRisk")); }
        catch (err) { ctx.log.error(`[many-ai] hallucination warning send error: ${err.message}`); }
      }
      // The model can mark its own reply as [STOP] (see parseReply) when
      // explicitly told to leave/go quiet — full reset, not just closing the
      // continuation window: the chat goes silent (even to being addressed
      // by name) until someone explicitly triggers it again, at which point
      // this exact message is handed back as resumeNote (see isTrigger
      // block above), then forgotten.
      if (slot.stop) {
        pendingContinuation.delete(chatId);
        sleepingChats.set(chatId, { wakeMessage: truncateToTokens(body, 15) });
      } else if (slot.concluded) {
        // [END] — takes priority over opening/extending the continuation
        // window: block it outright, even if one was already open from an
        // earlier reply in this chat.
        pendingContinuation.delete(chatId);
      } else {
        // Every answered turn refreshes the window, including
        // continuation-triggered ones — the gate above (runGateway,
        // reason:"continuation") already re-checks relatedness on each
        // follow-up, so this lets the bot keep talking as long as the
        // conversation stays on topic, and the window only lapses when a
        // follow-up turns out unrelated (verdict respond:false below) or
        // the AI marks [END].
        markContinuation(chatId, msg.senderName);
      }
    } else {
      // The AI was addressed but chose to stay quiet (e.g. a continuation
      // follow-up that turned out not to be for it) — reset immediately
      // instead of leaving the window open until it expires on its own.
      pendingContinuation.delete(chatId);
    }
  } catch (err) {
    ctx.log.error(`[many-ai] error: ${err.message}`);
    // Only surface API failures to the user when they explicitly addressed
    // the bot (command/quote) — an ambient trigger (word/literal/
    // continuation) failing silently beats spamming an alarming error into
    // a conversation nobody actually asked the AI to join.
    const EXPLICIT_TRIGGERS = new Set(["command", "quote"]);
    if (!EXPLICIT_TRIGGERS.has(triggerKind)) return;

    if (err.isMissingKey) {
      await msg.reply.text(t("errors.missingApiKey"));
    } else if (err.isRateLimit) {
      await msg.reply.text(err.retryIn ? t("errors.rateLimitWithRetry", { retryIn: err.retryIn }) : t("errors.rateLimit"));
    } else if (err.isInvalidKey || err.isTransient) {
      await msg.reply.text(t("errors.allKeysRateLimit"));
    } else {
      await msg.reply.text(t("errors.generic"));
    }
  }
}
