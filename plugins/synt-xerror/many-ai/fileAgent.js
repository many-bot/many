import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import zlib from "node:zlib";
import child_process from "node:child_process";
import { promisify } from 'node:util';
import { pipeline as streamPipeline } from 'node:stream';
import { describeImageBase64WithGemini } from "./geminiVision.js";

const pipeline = promisify(streamPipeline);

const IMAGE_EXT_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".heic": "image/heic", ".heif": "image/heif",
};



async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Resolves a "write"/"append" payload's raw bytes. "content" (plain UTF-8
 * text) is preferred — it's what the model should use for any text file
 * (html/js/json/csv/md/etc.): no encoding step, and building a file across
 * several "append" calls is just string concatenation, so there's nothing to
 * misalign. "content_base64" still works for binary data the model can't
 * express as text. Callers must already have validated that at least one of
 * the two is present.
 */
/**
 * Best-effort removal of a stray markdown code fence line at the very start
 * and/or end of a text chunk. The model is told never to wrap FILE_WRITE/
 * FILE_APPEND content in ```fences — this is the safety net for when it
 * does anyway, which otherwise writes the fence bytes literally into the
 * file (visible as stray ``` lines mid-file once several chunks concatenate).
 * Only strips a fence line that's alone on its own line at the boundary —
 * never touches ``` appearing naturally inside real content.
 */
function stripStrayCodeFences(text) {
  if (/^```[a-zA-Z0-9_+-]*$/.test(text.trim())) return "";
  let out = text.replace(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n/, "");
  out = out.replace(/\r?\n```[ \t]*$/, "");
  return out;
}

function contentBufferFromPayload(payload) {
  if (payload.content !== undefined) return Buffer.from(stripStrayCodeFences(String(payload.content)), "utf8");
  return Buffer.from(payload.content_base64, "base64");
}

const KNOWN_ACTIONS = [
  "init", "write", "append", "read", "replace", "mv", "cp", "mkdir", "rm",
  "list", "checksum", "zip", "checkpoint", "resume", "deliver", "clear",
];
const MAX_WRITE_BYTES = 20 * 1024 * 1024; // 20MB — guards against pathological base64 payloads
const MAX_INLINE_READ_BYTES = 200 * 1024; // above this, "read" refuses text content and points at checksum/deliver instead

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // matches the 24h retention the skill doc promises
const CLEANUP_THROTTLE_MS = 60 * 60 * 1000; // don't scan SANDBOX_ROOT on every single call
let lastCleanupAt = 0;

/** Best-effort removal of session dirs untouched for longer than SESSION_TTL_MS. Never throws. */
async function cleanupOldSessions(root) {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_THROTTLE_MS) return;
  lastCleanupAt = now;
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    await Promise.all(entries.filter(e => e.isDirectory()).map(async (e) => {
      const dir = path.join(root, e.name);
      try {
        // ops.log is touched on every mutating action, so it tracks real
        // last-activity far better than sessionDir's own mtime (which only
        // changes when a direct child of sessionDir is created, not on
        // writes deeper inside in/out/).
        const opsLog = path.join(dir, "logs", "ops.log");
        const stat = await fs.promises.stat(opsLog).catch(() => fs.promises.stat(dir));
        if (now - stat.mtimeMs > SESSION_TTL_MS) await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (_) { /* ignore this entry, keep going */ }
    }));
  } catch (_) { /* root may not exist yet — nothing to clean */ }
}

function safePath(base, target) {
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(path.resolve(base))) throw new Error("path-traversal");
  return resolved;
}

// session_id becomes a raw path segment below (path.join(SANDBOX_ROOT, sessionId)),
// BEFORE any safePath() check applies to it — an unsanitized "../../etc" here would
// point sessionDir itself outside SANDBOX_ROOT, and every safePath(sessionDir, ...)
// call after that would then be "safe" relative to the wrong root.
function safeSessionId(id) {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  return cleaned || `anon-${Date.now()}`;
}

/** Deterministic, path-safe sandbox session id for a chat — one session per
 * chat, reused across messages. Single source of truth (index.js imports
 * this instead of keeping its own copy) so ingestion and tool-call access
 * always agree on the same id. */
export function sandboxSessionIdFor(chatId) {
  const safe = String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `chat-${safe}`;
}

async function sha256ForFile(filePath) {
  const h = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    rs.on("error", reject);
    rs.on("end", () => { h.end(); resolve(); });
    rs.pipe(h, { end: false });
  });
  return h.digest("hex");
}

export async function runFileAgent(ctx, arg, opts = {}) {
  // arg can be JSON string or an object
  let payload = arg;
  if (!payload) throw new Error("file-agent-missing-arg");
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      // Looks like JSON was intended — a parse failure here must NOT be
      // swallowed. Silently falling through used to turn a truncated/broken
      // JSON string into the literal "action" value below, which always
      // hit the unknown-action branch with a useless error. Surfacing the
      // real parse error lets the model see exactly what's wrong and retry.
      try { payload = JSON.parse(trimmed); }
      catch (err) { throw new Error(`file-agent-invalid-json: ${err.message}`); }
    } else {
      // simple shorthand: bare action name, e.g. "list"
      payload = { action: trimmed };
    }
  }

  const action = (payload.action || "").toString();
  if (!action) throw new Error("file-agent-no-action");

  const SANDBOX_ROOT = ctx.storage.resolve("sandbox");
  await ensureDir(SANDBOX_ROOT);
  cleanupOldSessions(SANDBOX_ROOT); // throttled internally — fire and forget, never blocks the actual op
  // Security: the sandbox MUST be pinned to the real chat, not to whatever
  // session_id the model puts in the tool payload — a model-supplied value
  // here would let a spoofed/injected session_id read or write another
  // chat's sandbox. opts.chatId (set by the caller from the actual message
  // context) always wins when present; payload.session_id is only a
  // fallback for callers that don't have a chatId to give us.
  const sessionId = opts.chatId != null
    ? sandboxSessionIdFor(opts.chatId)
    : safeSessionId(payload.session_id || payload.session);
  const sessionDir = path.join(SANDBOX_ROOT, sessionId);

  switch (action) {
    case "init": {
      await ensureDir(sessionDir);
      await ensureDir(path.join(sessionDir, "in"));
      await ensureDir(path.join(sessionDir, "out"));
      await ensureDir(path.join(sessionDir, "logs"));
      await ensureDir(path.join(sessionDir, "checkpoints"));
      return { ok: true, workspace: sessionDir };
    }

    case "write": {
      // payload: { path: "in/file.txt", content? | content_base64?, overwrite? }
      // Creates the file (or fully overwrites it) with this content. For
      // content too large to generate in one completion, call "write" once
      // with the first chunk, then "append" for each following chunk.
      // "content" (plain UTF-8 text) is the preferred field for text files —
      // no encoding step, and nothing to misalign across chunks. "content_base64"
      // still exists for binary data. Exactly one of the two must be given.
      if (!payload.path || (payload.content === undefined && !payload.content_base64)) {
        throw new Error("write-missing-params");
      }
      const buf = contentBufferFromPayload(payload);
      if (buf.length > MAX_WRITE_BYTES) throw new Error(`write-too-large:${buf.length}-bytes-max-${MAX_WRITE_BYTES}`);
      const target = safePath(sessionDir, payload.path);
      // Guardrail: a multi-chunk build resumed on a later turn is exactly the
      // scenario where "write" instead of "append" would silently destroy
      // everything already saved. Refuse unless the caller is explicit about
      // wanting to start over.
      const existingStat = await fs.promises.stat(target).catch(() => null);
      if (existingStat?.isFile() && existingStat.size > 0 && payload.overwrite !== true) {
        throw new Error(
          `write-target-exists: "${payload.path}" already has ${existingStat.size} bytes — ` +
          `if you're continuing a build, use "append" instead; if you really mean to start over, ` +
          `retry "write" with "overwrite":true`
        );
      }
      await ensureDir(path.dirname(target));
      // Surface it plainly in the result when overwrite:true actually discarded
      // non-empty prior content — the model needs this in its own tool-result
      // context so it doesn't silently keep treating a truncated overwrite as
      // "continuing the build" (that's what turns a multi-chunk file into a
      // half-finished one when overwrite is used instead of append).
      const discardedBytes = existingStat?.isFile() ? existingStat.size : 0;
      await fs.promises.writeFile(target, buf);
      const sha = await sha256ForFile(target);
      await logOp(sessionDir, "write", target, { sha, bytes: buf.length, discardedBytes });
      return {
        ok: true, path: target, sha, bytes: buf.length,
        ...(discardedBytes > 0 ? {
          warning: `overwrite replaced ${discardedBytes} previous bytes — this file now contains ONLY the ${buf.length} bytes just written, nothing else`,
        } : {}),
      };
    }

    case "append": {
      // payload: { path, content? | content_base64? }
      // Same idea as "write", but adds bytes onto the end of an existing file
      // instead of replacing it. Exists so a single large output (e.g. a
      // generated HTML page) can be built across several tool calls, each
      // one small enough to fit in a normal completion — rather than needing
      // the whole content to be generated in one shot.
      // Prefer "content" (plain UTF-8 text) for text files — chunks just
      // concatenate, nothing to misalign. If using "content_base64" instead,
      // each call's value must be the base64 encoding of ITS OWN raw chunk,
      // never a slice of one big base64 string cut at an arbitrary character
      // offset (that would misalign the 4-char base64 groups and corrupt the
      // decoded bytes) — this is why "content" is the safer default.
      if (!payload.path || (payload.content === undefined && payload.content_base64 === undefined)) {
        throw new Error("append-missing-params");
      }
      const buf = contentBufferFromPayload(payload);
      const target = safePath(sessionDir, payload.path);
      await ensureDir(path.dirname(target));
      const existingStat = await fs.promises.stat(target).catch(() => null);
      if (existingStat?.isDirectory()) throw new Error("append-target-is-directory");
      const existingBytes = existingStat?.size || 0;
      if (existingBytes + buf.length > MAX_WRITE_BYTES) {
        throw new Error(`append-too-large:${existingBytes + buf.length}-bytes-max-${MAX_WRITE_BYTES}`);
      }
      await fs.promises.appendFile(target, buf);
      const stat = await fs.promises.stat(target);
      const sha = await sha256ForFile(target);
      await logOp(sessionDir, "append", target, { bytes_appended: buf.length, total_bytes: stat.size, sha });
      return { ok: true, path: target, bytes_appended: buf.length, total_bytes: stat.size, sha };
    }

    case "read": {
      // payload: { path, encoding? "utf8"|"base64" }
      if (!payload.path) throw new Error("read-missing-params");
      const p = safePath(sessionDir, payload.path);
      const stat = await fs.promises.stat(p);
      if (stat.isDirectory()) throw new Error("read-is-directory");

      // Images are never read as raw bytes/text — that wastes tokens and the
      // model can't make sense of base64 pixel data anyway. Route through
      // Gemini vision instead and hand back a description.
      const imageMime = IMAGE_EXT_MIME[path.extname(p).toLowerCase()];
      if (imageMime) {
        const gv = opts?.geminiVision;
        if (!gv?.enabled || !gv.keys?.length) {
          throw new Error("read-image-vision-disabled: image files can't be read directly — Gemini vision is not configured to interpret them");
        }
        const buf = await fs.promises.readFile(p);
        const base64 = buf.toString("base64");
        const description = await describeImageBase64WithGemini(base64, imageMime, ctx, gv.keys, gv.model, payload.prompt);
        if (!description) throw new Error("read-image-vision-failed: Gemini could not describe this image");
        await logOp(sessionDir, "read-image", p, { mime: imageMime, bytes: stat.size });
        return { ok: true, path: p, size: stat.size, isImage: true, mime: imageMime, description };
      }

      const encoding = payload.encoding === "base64" ? "base64" : "utf8";
      if (stat.size > MAX_INLINE_READ_BYTES) {
        return {
          ok: true, path: p, size: stat.size, truncated: true,
          note: `file is ${stat.size} bytes, over the ${MAX_INLINE_READ_BYTES}-byte inline read limit — ` +
            `use "checksum" to verify it or "deliver"/"zip" to send it directly instead of reading full content`,
        };
      }
      const buf = await fs.promises.readFile(p);
      const content = encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
      return { ok: true, path: p, size: stat.size, encoding, content };
    }

    case "replace": {
      // payload: { path, search, replace, out }
      if (!payload.path || payload.search === undefined || payload.replace === undefined) throw new Error("replace-missing-params");
      const src = safePath(sessionDir, payload.path);
      const text = await fs.promises.readFile(src, "utf8");
      const replaced = text.split(payload.search).join(payload.replace);
      const out = payload.out ? safePath(sessionDir, payload.out) : src;
      await ensureDir(path.dirname(out));
      await fs.promises.writeFile(out, replaced, "utf8");
      const sha = await sha256ForFile(out);
      await logOp(sessionDir, "replace", `${src} -> ${out}`, { sha });
      return { ok: true, out, sha };
    }

    case "mv": {
      if (!payload.src || !payload.dst) throw new Error("mv-missing-params");
      const s = safePath(sessionDir, payload.src);
      const d = safePath(sessionDir, payload.dst);
      await ensureDir(path.dirname(d));
      await fs.promises.rename(s, d);
      await logOp(sessionDir, "mv", `${s} -> ${d}`);
      return { ok: true, from: s, to: d };
    }

    case "cp": {
      if (!payload.src || !payload.dst) throw new Error("cp-missing-params");
      const s = safePath(sessionDir, payload.src);
      const d = safePath(sessionDir, payload.dst);
      await ensureDir(path.dirname(d));
      await fs.promises.copyFile(s, d);
      const sha = await sha256ForFile(d);
      await logOp(sessionDir, "cp", `${s} -> ${d}`, { sha });
      return { ok: true, from: s, to: d, sha };
    }

    case "mkdir": {
      if (!payload.path) throw new Error("mkdir-missing-params");
      const d = safePath(sessionDir, payload.path);
      await ensureDir(d);
      await logOp(sessionDir, "mkdir", d);
      return { ok: true, path: d };
    }

    case "rm": {
      if (!payload.path) throw new Error("rm-missing-params");
      const t = safePath(sessionDir, payload.path);
      // Avoid accidental rm of session root
      if (t === path.resolve(sessionDir)) throw new Error("rm-root-forbidden");
      await fs.promises.rm(t, { recursive: true, force: true });
      await logOp(sessionDir, "rm", t);
      return { ok: true, removed: t };
    }

    case "list": {
      const p = payload.path ? safePath(sessionDir, payload.path) : sessionDir;
      const items = await fs.promises.readdir(p, { withFileTypes: true });
      const result = items.map(d => ({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() }));
      return { ok: true, path: p, items: result };
    }

    case "checksum": {
      if (!payload.path) throw new Error("checksum-missing-params");
      const p = safePath(sessionDir, payload.path);
      const sha = await sha256ForFile(p);
      return { ok: true, path: p, sha };
    }

    case "zip": {
      // payload: { dest, paths: [..], send }
      if (!payload.dest || !payload.paths) throw new Error("zip-missing-params");
      const dest = safePath(sessionDir, payload.dest);
      await ensureDir(path.dirname(dest));
      // Use system zip if available, fallback to node zlib single-file gzip for single file
      try {
        const zipArgs = ["-r", dest, ...payload.paths];
        // Run in sessionDir to keep paths relative
        await runCommand("zip", zipArgs, { cwd: sessionDir });
      } catch (err) {
        // fallback for single path: gzip
        if (payload.paths.length === 1) {
          const src = safePath(sessionDir, payload.paths[0]);
          const gz = zlib.createGzip();
          const rs = fs.createReadStream(src);
          const ws = fs.createWriteStream(dest);
          await pipeline(rs, gz, ws);
        } else throw err;
      }
      await logOp(sessionDir, "zip", dest, { paths: payload.paths });

      // Best-effort manifest.json alongside the archive: path/sha256/size for
      // every plain-file entry that went in. Never lets a manifest problem
      // fail the zip itself, which is the actual deliverable.
      try {
        const files = [];
        for (const rel of payload.paths) {
          const abs = safePath(sessionDir, rel);
          const st = await fs.promises.stat(abs).catch(() => null);
          if (st?.isFile()) files.push({ path: rel, sha256: await sha256ForFile(abs), size: st.size });
        }
        const manifestPath = `${dest}.manifest.json`;
        await fs.promises.writeFile(manifestPath, JSON.stringify({
          session_id: sessionId, delivered_at: new Date().toISOString(), files,
        }, null, 2), "utf8");
      } catch (err) {
        await logOp(sessionDir, "manifest", dest, { error: String(err.message) });
      }

      // Optional: send the resulting archive via ctx.send.file if requested
      if (payload.send && ctx && typeof ctx.send?.file === "function") {
        try {
          const filename = payload.filename || path.basename(dest);
          const handle = await ctx.send.file(dest, filename);
          await logOp(sessionDir, "send", dest, { sent: true, filename });
          return { ok: true, dest, sent: true };
        } catch (err) {
          await logOp(sessionDir, "send", dest, { sent: false, error: String(err.message) });
          return { ok: true, dest, sent: false, error: String(err.message) };
        }
      }

      return { ok: true, dest };
    }

    case "checkpoint": {
      // save a small JSON checkpoint
      const n = payload.data || {};
      n.session_id = sessionId;
      n.timestamp = new Date().toISOString();
      const file = path.join(sessionDir, "checkpoints", `checkpoint-${Date.now()}.json`);
      await ensureDir(path.dirname(file));
      await fs.promises.writeFile(file, JSON.stringify(n, null, 2), "utf8");
      await logOp(sessionDir, "checkpoint", file);
      return { ok: true, file };
    }

    case "resume": {
      // No args needed beyond session_id. Summarizes the sandbox state so a
      // model picking this session back up (new session/conversation, same
      // deterministic session_id) can continue without re-asking the user
      // for everything — the last checkpoint, recent ops, and what's on disk.
      const result = { ok: true, session_id: sessionId, workspace: sessionDir };

      try {
        const cpDir = path.join(sessionDir, "checkpoints");
        const files = (await fs.promises.readdir(cpDir)).filter(f => f.endsWith(".json")).sort();
        result.latest_checkpoint = files.length
          ? JSON.parse(await fs.promises.readFile(path.join(cpDir, files[files.length - 1]), "utf8"))
          : null;
      } catch (_) { result.latest_checkpoint = null; }

      try {
        const raw = await fs.promises.readFile(path.join(sessionDir, "logs", "ops.log"), "utf8");
        const lines = raw.trim().split(os.EOL).filter(Boolean);
        result.recent_ops = lines.slice(-10).map(l => { try { return JSON.parse(l); } catch { return l; } });
      } catch (_) { result.recent_ops = []; }

      result.in_files = await fs.promises.readdir(path.join(sessionDir, "in")).catch(() => []);
      result.out_files = await fs.promises.readdir(path.join(sessionDir, "out")).catch(() => []);
      return result;
    }

    case "clear": {
      // Wipes this chat's own sandbox workspace (in/out/logs/checkpoints)
      // and reinitializes it empty. WhatsApp has no concept of separate
      // sessions per conversation — one chat is always one sandbox — so
      // this is the only way to escape a conflicting/leftover state (e.g.
      // "write-target-exists" from a previous unrelated task). Never
      // touches anything on the user's own device.
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      await ensureDir(sessionDir);
      await ensureDir(path.join(sessionDir, "in"));
      await ensureDir(path.join(sessionDir, "out"));
      await ensureDir(path.join(sessionDir, "logs"));
      await ensureDir(path.join(sessionDir, "checkpoints"));
      await logOp(sessionDir, "clear", sessionDir);
      return { ok: true, workspace: sessionDir, cleared: true };
    }

    case "deliver": {
      // payload: { path, filename }
      if (!payload.path) throw new Error("deliver-missing-params");
      const p = safePath(sessionDir, payload.path);
      if (!fs.existsSync(p)) throw new Error("deliver-not-found");
      if (!ctx || typeof ctx.send?.file !== "function") throw new Error("deliver-send-unavailable");
      const filename = payload.filename || path.basename(p);
      try {
        await ctx.send.file(p, filename);
        await logOp(sessionDir, "deliver", p, { filename });
        return { ok: true, path: p, sent: true };
      } catch (err) {
        await logOp(sessionDir, "deliver", p, { filename, error: String(err.message) });
        return { ok: false, path: p, sent: false, error: String(err.message) };
      }
    }

    default:
      // Listing valid actions in the error itself lets the model self-correct
      // on the next turn without needing another round trip through the prompt.
      throw new Error(`unknown-action:${action}. Known actions: ${KNOWN_ACTIONS.join(", ")}`);
  }
}

async function logOp(sessionDir, action, target, extra = {}) {
  try {
    const logdir = path.join(sessionDir, "logs");
    await ensureDir(logdir);
    const entry = {
      ts: new Date().toISOString(),
      action,
      target: String(target || ""),
      extra,
    };
    const file = path.join(logdir, "ops.log");
    await fs.promises.appendFile(file, JSON.stringify(entry) + os.EOL);
  } catch (err) {
    // best-effort logging
    try { console.error("logOp error", err.message); } catch (_) {}
  }
}

const COMMAND_ACTION_MAP = {
  FILE_LIST: "list", FILE_READ: "read", FILE_WRITE: "write", FILE_OVERWRITE: "write",
  FILE_APPEND: "append", FILE_DELETE: "rm", FILE_MOVE: "mv", FILE_COPY: "cp",
  FILE_ZIP: "zip", FILE_SEND: "deliver", FILE_CHECKSUM: "checksum", FILE_RESUME: "resume",
  FILE_CLEAR: "clear",
};

/** Splits on the first whitespace char (space OR newline) — "path rest..." -> [path, rest]. */
function firstToken(s) {
  const str = (s || "").trim();
  const i = str.search(/\s/);
  return i === -1 ? [str, ""] : [str.slice(0, i), str.slice(i + 1).trim()];
}

/**
 * Plain-text, one-verb-per-command interface for FILE_AGENT — same style as
 * SEARCH/FETCH/etc, for models (especially small/local ones) that can't
 * reliably produce well-formed JSON. `arg` is a single string: for
 * path-only commands it's just the path; for FILE_WRITE/FILE_OVERWRITE/
 * FILE_APPEND it's "path" followed by the raw file content (real
 * newlines, nothing to escape) — index.js already joins the command's
 * first line with any following lines before calling this. Maps onto the
 * same underlying actions as runFileAgent's JSON-payload form (still used
 * internally, e.g. the automatic mid-build checkpoint), so session
 * isolation and every safety check there (write-target-exists, path
 * traversal, size limits) applies unchanged.
 */
export async function runFileAgentCommand(ctx, command, arg, opts = {}) {
  const action = COMMAND_ACTION_MAP[command];
  if (!action) throw new Error(`file-agent-unknown-command:${command}`);
  const payload = { action };

  switch (command) {
    case "FILE_LIST":
      payload.path = (arg || "").trim() || "in";
      break;
    case "FILE_READ":
    case "FILE_CHECKSUM":
    case "FILE_DELETE":
      payload.path = (arg || "").trim();
      if (!payload.path) throw new Error(`${command.toLowerCase()}-missing-path`);
      break;
    case "FILE_RESUME":
    case "FILE_CLEAR":
      break;
    case "FILE_WRITE":
    case "FILE_OVERWRITE":
    case "FILE_APPEND": {
      const [p, content] = firstToken(arg);
      if (!p) throw new Error(`${command.toLowerCase()}-missing-path`);
      payload.path = p;
      payload.content = content;
      if (command === "FILE_OVERWRITE") payload.overwrite = true;
      break;
    }
    case "FILE_MOVE":
    case "FILE_COPY": {
      const [src, rest] = firstToken(arg);
      const [dst] = firstToken(rest);
      if (!src || !dst) throw new Error(`${command.toLowerCase()}-missing-src-dst: expected "${command} src dst"`);
      payload.src = src;
      payload.dst = dst;
      break;
    }
    case "FILE_SEND": {
      const [p, rest] = firstToken(arg);
      if (!p) throw new Error("file_send-missing-path");
      payload.path = p;
      if (rest) payload.filename = rest.split(/\s+/)[0];
      break;
    }
    case "FILE_ZIP": {
      const [dest, rest] = firstToken(arg);
      const paths = rest ? rest.split(/\s+/).filter(Boolean) : [];
      if (!dest || !paths.length) throw new Error('file_zip-missing-dest-or-paths: expected "FILE_ZIP dest.zip path1 path2 ..."');
      payload.dest = dest;
      payload.paths = paths;
      payload.send = true; // no separate deliver step in the simple command interface
      break;
    }
  }

  return runFileAgent(ctx, payload, opts);
}

async function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = child_process.spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)));
  });
}

export default { runFileAgent, runFileAgentCommand };

