/** @typedef {import("@manybot/types/en").PluginContext} PluginContext */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".gif"]);
const PLAYLIST_MAX_ITEMS = 20;
const PLAYLIST_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * @param {PluginContext} ctx
 * @param {string|null} rawQuery
 */
async function resolveQuery(ctx, rawQuery) {
  if (rawQuery) return rawQuery;
  if (!ctx.msg.hasReply) return null;
  const quoted = await ctx.msg.getReply();
  return quoted.body;
}

async function getInfo(query, t) {
  const target = isUrl(query) ? query : `ytsearch10:${query}`;

  let stdout;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", [
      target,
      "--skip-download",
      "--no-warnings",
      "--restrict-filenames",
      "--match-filter", "duration < 720",
      "--ignore-errors",
      "--print", "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration)s",
    ]));
  } catch (err) {
    if (!err.stdout?.trim()) throw err;
    stdout = err.stdout;
  }
  const line = stdout.trim().split("\n")[0];
  if (!line) throw new Error(t("noResults"));

  const [url, title, uploader, duration] = line.split("\t");
  return {
    title,
    url,
    channel: uploader,
    duration: formatTime(Number(duration)),
  };
}

// Sends one gallery item, picking video or image reply based on extension.
function sendGalleryItem(msg, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? msg.reply.video(filePath) : msg.reply.image(filePath);
}

// Fallback for /playv links yt-dlp can't handle (image carousels, galleries).
// Only makes sense for direct URLs, not search queries.
async function tryImageFallback(ctx, mm, query, t) {
  if (!isUrl(query) || !mm.downloadImages) return false;

  const { filePaths, cleanup } = await mm.downloadImages(query, ctx);
  try {
    for (const p of filePaths) await sendGalleryItem(ctx.msg, p);
    await ctx.msg.reply.text(t("imageHint"));
    return true;
  } finally {
    await cleanup?.();
  }
}

/**
 * @param {PluginContext} ctx
 * @param {string|null} rawQuery
 */
async function handlePlay(ctx, t, mm, type, query) {
  const { msg } = ctx;
  const cmdName = type === "mp3" ? "mp3" : "mp4";
  if (!query) {
    return msg.reply.text(
      t("needQueryOrUrl", { cmd: cmdName })
    );
  }
  await msg.reply.text(t("wait"));
  let media;
  try {
    const info = await getInfo(query, t);
    const { filePath, cleanup } = await (type === "mp3"
      ? mm.downloadAudio(info.url, ctx, t)
      : mm.downloadVideo(info.url, ctx, t));
    media = { filePath, cleanup };
    if (type === "mp3") {
      const audioMessage = await msg.reply.audio(filePath, { asVoice: false });
      const caption = `🎵 *${info.title}* - ${info.channel}`;
      if (audioMessage?.reply?.text) {
        await audioMessage.reply.text(caption, { parse_mode: "Markdown" });
      } else {
        await msg.reply.text(caption, { reply_to_message_id: audioMessage.message_id, parse_mode: "Markdown" });
      }
    } else {
      await msg.reply.video(filePath);
    }
  } catch (err) {
    if (type === "mp4") {
      try {
        const handled = await tryImageFallback(ctx, mm, query, t);
        if (handled) return;
      } catch (galleryErr) {
        ctx.log.error(`[playit] Gallery fallback failed: ${galleryErr.message}`);
      }
    }
    ctx.log.error(`[playit] Error: ${err.message}`);
    await msg.reply.text(t("error", { message: err.message }));
  } finally {
    await media?.cleanup?.();
  }
}

// Playlist mode
//
// Per-user (not per-chat) session state, stored in ctx.settings.global since
// SettingsApi is chat-scoped and playlists must follow the user across chats.
// session = { stage: "recording" | "naming", items: string[] }

function sessionKey(sender) {
  return `playlist:session:${sender}`;
}
function savedKey(sender, name) {
  return `playlist:saved:${sender}:${name.toLowerCase()}`;
}

function isPlaylistToggle(msg) {
  return (msg.is("mp3") || msg.is("mp4")) && msg.args.length === 1 && msg.args[0] === "playlist";
}

async function handlePlaylistToggle(ctx, t, sender) {
  const { msg } = ctx;
  const session = ctx.settings.global.get(sessionKey(sender), null);

  if (!session) {
    ctx.settings.global.set(sessionKey(sender), { stage: "recording", items: [] });
    return msg.reply.text(t("playlistStart", { max: PLAYLIST_MAX_ITEMS }));
  }

  if (session.stage === "recording") {
    if (session.items.length === 0) {
      ctx.settings.global.delete(sessionKey(sender));
      return msg.reply.text(t("playlistEmpty"));
    }
    ctx.settings.global.set(sessionKey(sender), { stage: "naming", items: session.items });
    return msg.reply.text(t("playlistAskName", { count: session.items.length }));
  }

  ctx.settings.global.delete(sessionKey(sender));
  return msg.reply.text(t("playlistCancelled"));
}

async function handlePlaylistCapture(ctx, t, sender, session) {
  const { msg } = ctx;
  const text = msg.body?.trim();
  if (!text) return;

  if (session.items.length >= PLAYLIST_MAX_ITEMS) {
    return msg.reply.text(t("playlistLimitReached", { max: PLAYLIST_MAX_ITEMS }));
  }

  session.items.push(text);
  ctx.settings.global.set(sessionKey(sender), session);
  await msg.react("✅");
}

async function handlePlaylistNaming(ctx, t, sender, session) {
  const { msg } = ctx;
  const name = msg.body?.trim();
  if (!name) return;

  if (!PLAYLIST_NAME_RE.test(name)) {
    return msg.reply.text(t("playlistInvalidName"));
  }
  if (ctx.settings.global.get(savedKey(sender, name), null)) {
    return msg.reply.text(t("playlistNameTaken", { name }));
  }

  ctx.settings.global.set(savedKey(sender, name), {
    name,
    items: session.items,
    createdAt: Date.now(),
  });
  ctx.settings.global.delete(sessionKey(sender));
  return msg.reply.text(t("playlistSaved", { name, count: session.items.length }));
}

async function handlePlaylistZip(ctx, t, mm, type, playlist) {
  const { msg } = ctx;
  await msg.reply.text(t("playlistZipping", { name: playlist.name, count: playlist.items.length }));

  const folder = `${msg.sender.replace(/[^a-zA-Z0-9_-]/g, "_")}/${playlist.name.toLowerCase()}`;
  const dir = ctx.storage.resolve(`playlists/${folder}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const cleanups = [];
  try {
    for (const query of playlist.items) {
      try {
        const info = await getInfo(query, t);
        const { filePath, cleanup } = await (type === "mp3"
          ? mm.downloadAudio(info.url, ctx, t)
          : mm.downloadVideo(info.url, ctx, t));
        cleanups.push(cleanup);
        fs.copyFileSync(filePath, path.join(dir, path.basename(filePath)));
      } catch (err) {
        ctx.log.error(`[playit] Playlist zip item failed (${query}): ${err.message}`);
      }
    }

    if (fs.readdirSync(dir).length === 0) {
      return msg.reply.text(t("playlistZipEmpty"));
    }

    const zipPath = ctx.storage.resolve(`playlists/${folder}.zip`);
    fs.rmSync(zipPath, { force: true });
    await execFileAsync("zip", ["-r", zipPath, "."], { cwd: dir });
    await msg.reply.file(zipPath, `${playlist.name}.zip`);
    fs.rmSync(zipPath, { force: true });
  } finally {
    for (const cleanup of cleanups) await cleanup?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function handlePlaylistDelete(ctx, t, sender, playlist) {
  const { msg } = ctx;
  ctx.settings.global.delete(savedKey(sender, playlist.name));

  const folder = `${sender.replace(/[^a-zA-Z0-9_-]/g, "_")}/${playlist.name.toLowerCase()}`;
  fs.rmSync(ctx.storage.resolve(`playlists/${folder}`), { recursive: true, force: true });
  fs.rmSync(ctx.storage.resolve(`playlists/${folder}.zip`), { force: true });

  return msg.reply.text(t("playlistDeleted", { name: playlist.name }));
}

async function handlePlaylistLoad(ctx, t, mm, type, args) {
  const { msg } = ctx;
  const sender = msg.sender;
  const [name, flag] = args;

  if (!PLAYLIST_NAME_RE.test(name)) {
    return msg.reply.text(t("playlistInvalidName"));
  }

  const playlist = ctx.settings.global.get(savedKey(sender, name), null);
  if (!playlist) {
    return msg.reply.text(t("playlistNotFound", { name }));
  }

  if (flag?.toLowerCase() === "zip") {
    return handlePlaylistZip(ctx, t, mm, type, playlist);
  }
  if (flag?.toLowerCase() === "del") {
    return handlePlaylistDelete(ctx, t, sender, playlist);
  }

  await msg.reply.text(t("playlistLoading", { name: playlist.name, count: playlist.items.length }));
  for (const query of playlist.items) {
    await handlePlay(ctx, t, mm, type, query);
  }
}

const RENAMED = { play: "mp3", playv: "mp4" };

/**
 * @param {PluginContext} ctx
 * @param {string|null} rawQuery
 */
export default async function (ctx) {
  const { msg } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const sender = msg.sender;

  const session = ctx.settings.global.get(sessionKey(sender), null);
  if (session && !msg.hasPrefix && !isPlaylistToggle(msg)) {
    if (session.stage === "recording") return handlePlaylistCapture(ctx, t, sender, session);
    if (session.stage === "naming") return handlePlaylistNaming(ctx, t, sender, session);
  }

  for (const [oldCmd, newCmd] of Object.entries(RENAMED)) {
    if (msg.is(oldCmd)) return msg.reply.text(t("commandRemoved", { old: oldCmd, new: newCmd }));
  }

  if (isPlaylistToggle(msg)) {
    return handlePlaylistToggle(ctx, t, sender);
  }

  if (msg.is("mp3") || msg.is("mp4")) {
    const type = msg.is("mp3") ? "mp3" : "mp4";
    const mm = ctx.plugins.require("synt-xerror/manymedia");
    if (!mm) {
      ctx.log.error("[Playit] Dependency not found: synt-xerror/manymedia");
      return;
    }

    if (msg.args[0] === "playlist") {
      return handlePlaylistLoad(ctx, t, mm, type, msg.args.slice(1));
    }

    const query = await resolveQuery(ctx, msg.args.join(" "));
    await handlePlay(ctx, t, mm, type, query);
  }
}
