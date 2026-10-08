/** @typedef {import("@manybot/types/en").PluginContext} PluginContext */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".gif"]);
const PLAYLIST_MAX_ITEMS = 10;
const PLAYLIST_MAX_PER_USER = 5;
const PLAYLIST_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const RESERVED_PLAYLIST_NAMES = new Set(["list", "zip", "del", "info", "add"]);
const PLAYLIST_ADD_CONFIRM_WORDS = new Set([
  "sim", "s", "confirma", "confirmar", "confere", "confirmado",
  "yes", "y", "confirm",
  "si", "sí",
]);

function isUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function cookiesArgs(ctx) {
  const cookiesPath = ctx.storage.resolve("cookies.txt");
  return fs.existsSync(cookiesPath) ? ["--cookies", cookiesPath] : [];
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

async function getInfo(ctx, query, t, type) {
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
      ...cookiesArgs(ctx),
      "--print", "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s",
    ]));
  } catch (err) {
    if (!err.stdout?.trim()) throw err;
    stdout = err.stdout;
  }
  const line = stdout.trim().split("\n")[0];
  if (!line) throw new Error(t("noResults"));

  const [url, title, uploader, duration, thumbnail] = line.split("\t");
  return {
    title,
    url,
    channel: uploader,
    duration: formatTime(Number(duration)),
    thumbnail: thumbnail && thumbnail !== "NA" ? thumbnail : null,
  };
}

// Downloads a track's thumbnail as a Buffer to send inline (no temp file
// needed — WAMessageSender.image accepts a raw Buffer directly).
// Best-effort: returns null on any failure, caller falls back to text-only.
async function fetchThumbnail(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Sends the "now playing" card (thumbnail + info) as a reply to `msg`.
// Returns its MessageHandle so the caller can chain the audio/video as a
// reply to *this* card instead of to the original command.
async function sendNowPlayingCard(msg, t, info, cmdName) {
  const caption = t("nowPlaying", {
    title: info.title,
    channel: info.channel,
    duration: info.duration,
    url: info.url,
  }) + t("playlistAddCurrentHint", { cmd: cmdName });
  const thumb = await fetchThumbnail(info.thumbnail);
  const handle = thumb ? msg.reply.image(thumb, caption) : msg.reply.text(caption);
  return { handle };
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

// ── Media cache ───────────────────────────────────────────────────────────
//
// Downloaded songs/videos are keyed by their resolved URL (stable across
// search-query rewordings) and cached under ctx.storage so repeat plays
// (playlists especially) don't re-download every time. Cache hits return
// cleanup: null since there's no temp file to remove — the cached copy
// lives on until the plugin storage dir is cleared.

function cacheDir(ctx, type) {
  return ctx.storage.resolve(`cache/${type}`);
}

function cacheKeyForUrl(url) {
  return crypto.createHash("sha1").update(url).digest("hex");
}

function findCachedFile(ctx, type, url) {
  const dir = cacheDir(ctx, type);
  if (!fs.existsSync(dir)) return null;
  const key = cacheKeyForUrl(url);
  const match = fs.readdirSync(dir).find((f) => f.startsWith(`${key}.`));
  return match ? path.join(dir, match) : null;
}

async function getCachedMedia(ctx, mm, type, url, t) {
  const cached = findCachedFile(ctx, type, url);
  if (cached) return { filePath: cached, cleanup: null };

  const { filePath, cleanup } = await (type === "mp3"
    ? mm.downloadAudio(url, ctx, t)
    : mm.downloadVideo(url, ctx, t));

  try {
    const dir = cacheDir(ctx, type);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(filePath, path.join(dir, `${cacheKeyForUrl(url)}${path.extname(filePath)}`));
  } catch (err) {
    ctx.log.error(`[playit] Cache write failed (${url}): ${err.message}`);
  }

  return { filePath, cleanup };
}

// ── Voice-note transcoding ───────────────────────────────────────────────
//
// WhatsApp only renders a proper "voice note" bubble (with waveform) when
// the audio is OGG/Opus — sending the mp3 straight from yt-dlp with
// asVoice: true either errors or shows up as a flat/broken file, since
// Baileys doesn't transcode for us. Playlist playback (the only place we
// use asVoice) therefore skips the regular mp3 cache entirely: the mp3 is
// downloaded to a temp file only long enough to convert it, and only the
// resulting .ogg is kept in cache/voice, keyed by URL like everything
// else. If ffmpeg isn't available or the conversion fails, we fall back to
// a plain (non-cached) audio download sent as a regular message instead of
// losing the track.

async function getPlaylistVoice(ctx, mm, url, t) {
  const dir = cacheDir(ctx, "voice");
  const key = cacheKeyForUrl(url);
  const outPath = path.join(dir, `${key}.ogg`);
  if (fs.existsSync(outPath)) return outPath;

  const { filePath, cleanup } = await mm.downloadAudio(url, ctx, t);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `${key}.tmp.ogg`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", filePath,
      "-vn",
      "-ac", "1",
      "-ar", "48000",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-application", "voip",
      "-f", "ogg",
      tmpPath,
    ]);
    fs.renameSync(tmpPath, outPath);
    return outPath;
  } finally {
    await cleanup?.();
  }
}

// Sends a playlist mp3 as a voice note, transcoding to ogg/opus first (or
// reusing the cached ogg). Falls back to a normal, uncached audio message
// if the transcode fails, instead of dropping the track.
async function sendPlaylistAudio(ctx, mm, url, t) {
  try {
    const oggPath = await getPlaylistVoice(ctx, mm, url, t);
    await ctx.send.audio(oggPath, { asVoice: true });
  } catch (err) {
    ctx.log.error(`[playit] Voice transcode failed (${url}): ${err.message}`);
    const { filePath, cleanup } = await mm.downloadAudio(url, ctx, t);
    try {
      await ctx.send.audio(filePath, { asVoice: false });
    } finally {
      await cleanup?.();
    }
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
  let info;
  try {
    info = await getInfo(ctx, query, t, type);
    media = await getCachedMedia(ctx, mm, type, info.url, t);
    ctx.settings.global.set(lastPlayedKey(msg.sender), { type, query, info });

    if (type === "mp3") {
      const card = await sendNowPlayingCard(msg, t, info, cmdName);
      await card.handle.reply.audio(media.filePath, { asVoice: false });
    } else {
      await msg.reply.video(media.filePath);
    }
  } catch (err) {
    if (type === "mp4") {
      try {
        const handled = await tryImageFallback(ctx, mm, info?.url ?? query, t);
        if (handled) return;
      } catch (galleryErr) {
        ctx.log.error(`[playit] Gallery fallback failed: ${galleryErr.message}`);
      }
    }
    ctx.log.error(`[playit] Error: ${err.message}`);
    await msg.reply.text(t("error"));
  } finally {
    await media?.cleanup?.();
  }
}

// Downloads (or reuses from cache) and sends one playlist item, resolving
// the query fresh via yt-dlp. Used as a fallback when a playlist has no
// pre-resolved tracks yet (e.g. created before caching existed, or a track
// that failed to prefetch). No per-song text — playlist mode only sends
// media as it goes, then lists titles at the end. Playlists are mp3-only.
async function sendPlaylistItem(ctx, t, mm, query) {
  try {
    const info = await getInfo(ctx, query, t, "mp3");
    await sendPlaylistAudio(ctx, mm, info.url, t);
    return `${info.title} - ${info.channel}`;
  } catch (err) {
    ctx.log.error(`[playit] Playlist item failed (${query}): ${err.message}`);
    return null;
  }
}

// Same as sendPlaylistItem but for a track that was already resolved during
// prefetch (has a stable url) — skips the yt-dlp lookup entirely. mp3-only.
async function sendResolvedTrack(ctx, t, mm, track) {
  if (track.failed || !track.url) return null;

  try {
    await sendPlaylistAudio(ctx, mm, track.url, t);
    return `${track.title} - ${track.channel}`;
  } catch (err) {
    ctx.log.error(`[playit] Playlist item failed (${track.query}): ${err.message}`);
    return null;
  }
}

// Playlist mode — mp3 only.
//
// Per-user (not per-chat) session state, stored in ctx.settings.global since
// SettingsApi is chat-scoped and playlists must follow the user across chats.
// session = { stage: "naming" } — set while waiting for the playlist name.
//
// A playlist is created empty and immediately ready; songs are added one at
// a time afterwards via `... add`. Saved shape:
// { name, items: string[], createdAt, ready: boolean, tracks: Track[] }
// where Track = { query, title, channel, url } or { query, failed: true }.

function sessionKey(sender) {
  return `playlist:session:${sender}`;
}
function savedKey(sender, name) {
  return `playlist:saved:${sender}:${name.toLowerCase()}`;
}
function lastPlayedKey(sender) {
  return `playlist:lastplayed:${sender}`;
}
function addCurrentPendingKey(sender) {
  return `playlist:addcurrentpending:${sender}`;
}

function isPlaylistToggle(msg) {
  return msg.is("mp3") && msg.args.length === 1 && msg.args[0] === "playlist";
}

async function handlePlaylistToggle(ctx, t, sender) {
  const { msg } = ctx;
  const session = ctx.settings.global.get(sessionKey(sender), null);

  if (session) {
    ctx.settings.global.delete(sessionKey(sender));
    return msg.reply.text(t("playlistCancelled"));
  }

  ctx.settings.global.set(sessionKey(sender), { stage: "naming" });
  return msg.reply.text(t("playlistAskName"));
}

async function handlePlaylistNaming(ctx, t, sender, session) {
  const { msg } = ctx;
  const name = msg.body?.trim();
  if (!name) return;

  if (name.toLowerCase() === "cancelar") {
    ctx.settings.global.delete(sessionKey(sender));
    return msg.reply.text(t("playlistCancelled"));
  }

  if (!PLAYLIST_NAME_RE.test(name) || RESERVED_PLAYLIST_NAMES.has(name.toLowerCase())) {
    return msg.reply.text(t("playlistInvalidName"));
  }
  if (ctx.settings.global.get(savedKey(sender, name), null)) {
    return msg.reply.text(t("playlistNameTaken", { name }));
  }
  if (listOwnPlaylists(ctx, sender).length >= PLAYLIST_MAX_PER_USER) {
    ctx.settings.global.delete(sessionKey(sender));
    return msg.reply.text(t("playlistMaxPerUserReached", { max: PLAYLIST_MAX_PER_USER }));
  }

  ctx.settings.global.set(savedKey(sender, name), {
    name,
    items: [],
    createdAt: Date.now(),
    ready: true,
    tracks: [],
  });
  ctx.settings.global.delete(sessionKey(sender));
  return msg.reply.text(t("playlistCreated", { name }));
}

function listOwnPlaylists(ctx, sender) {
  const prefix = `playlist:saved:${sender}:`;
  const all = ctx.settings.global.getAll();
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => all[k])
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function handlePlaylistList(ctx, t, sender) {
  const { msg } = ctx;
  const playlists = listOwnPlaylists(ctx, sender);
  if (playlists.length === 0) {
    return msg.reply.text(t("playlistListEmpty"));
  }

  const lines = playlists.map((p) => {
    const count = t("playlistSongCount", { count: p.items.length });
    const status = p.ready ? "" : ` ${t("playlistNotReadySuffix")}`;
    return `• *${p.name}* — ${count}${status}`;
  });
  return msg.reply.text(`${t("playlistListHeader")}\n${lines.join("\n")}`);
}

async function handlePlaylistInfo(ctx, t, playlist) {
  const { msg } = ctx;
  const lines = playlist.ready && playlist.tracks
    ? playlist.tracks.map((tr, i) => tr.failed || !tr.title
      ? `${i + 1}. ⚠️ ${tr.query}`
      : `${i + 1}. ${tr.title} - ${tr.channel}`)
    : playlist.items.map((q, i) => `${i + 1}. ${q}`);

  return msg.reply.text(`${t("playlistInfoHeader", { name: playlist.name, count: playlist.items.length })}\n${lines.join("\n")}`);
}

// Playlists are mp3-only — always zips the audio, regardless of which
// command (!mp3/!mp4) was used to reach `... zip`.
async function handlePlaylistZip(ctx, t, mm, playlist) {
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
        const info = await getInfo(ctx, query, t, "mp3");
        const media = await getCachedMedia(ctx, mm, "mp3", info.url, t);
        cleanups.push(media.cleanup);
        fs.copyFileSync(media.filePath, path.join(dir, path.basename(media.filePath)));
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

async function handlePlaylistLoad(ctx, t, mm, args) {
  const { msg } = ctx;
  const sender = msg.sender;
  const [name, flag, indexArg, ...rest] = args;

  if (name?.toLowerCase() === "list") {
    return handlePlaylistList(ctx, t, sender);
  }

  if (name?.toLowerCase() === "add") {
    return handlePlaylistAddCurrentStart(ctx, t, sender, flag);
  }

  if (!PLAYLIST_NAME_RE.test(name)) {
    return msg.reply.text(t("playlistInvalidName"));
  }

  const playlist = ctx.settings.global.get(savedKey(sender, name), null);
  if (!playlist) {
    return msg.reply.text(t("playlistNotFound", { name }));
  }

  const normalizedFlag = flag?.toLowerCase();
  if (normalizedFlag === "zip") {
    if (!playlist.ready) {
      return msg.reply.text(t("playlistNotReadyYet", { name: playlist.name }));
    }
    return handlePlaylistZip(ctx, t, mm, playlist);
  }
  if (normalizedFlag === "del") {
    // `del <index>` removes a single song (index from `... info`);
    // `del` alone still deletes the whole playlist.
    if (indexArg) {
      return handlePlaylistRemove(ctx, t, sender, playlist, indexArg);
    }
    return handlePlaylistDelete(ctx, t, sender, playlist);
  }
  if (normalizedFlag === "info") {
    return handlePlaylistInfo(ctx, t, playlist);
  }
  if (normalizedFlag === "add") {
    const query = await resolveQuery(ctx, [indexArg, ...rest].filter(Boolean).join(" ") || null);
    return handlePlaylistAddStart(ctx, t, sender, playlist, query);
  }

  if (!playlist.ready) {
    return msg.reply.text(t("playlistNotReadyYet", { name: playlist.name }));
  }
  if (playlist.items.length === 0) {
    return msg.reply.text(t("playlistLoadEmpty", { name: playlist.name }));
  }

  await ctx.send.text(t("playlistLoading", { name: playlist.name }));

  const titles = [];
  if (playlist.ready && playlist.tracks) {
    for (const track of playlist.tracks) {
      const title = await sendResolvedTrack(ctx, t, mm, track);
      titles.push(title ?? t("playlistItemFailed", { query: track.query }));
    }
  } else {
    for (const query of playlist.items) {
      const title = await sendPlaylistItem(ctx, t, mm, query);
      titles.push(title ?? t("playlistItemFailed", { query }));
    }
  }

  const list = titles.map((title, i) => `${i + 1}. ${title}`).join("\n");
  await msg.reply.text(`${t("playlistFinished", { name: playlist.name })}\n${list}`);
}

// Removes a single song by its 1-based index (as shown by `... info`),
// keeping items/tracks in sync so positions still line up afterwards.
async function handlePlaylistRemove(ctx, t, sender, playlist, indexArg) {
  const { msg } = ctx;
  const index = Number.parseInt(indexArg, 10);
  if (!Number.isInteger(index) || index < 1 || index > playlist.items.length) {
    return msg.reply.text(t("playlistRemoveInvalidIndex", { count: playlist.items.length }));
  }

  const pos = index - 1;
  const removedTrack = playlist.tracks?.[pos];
  const label = removedTrack && !removedTrack.failed && removedTrack.title
    ? `${removedTrack.title} - ${removedTrack.channel}`
    : playlist.items[pos];

  const items = playlist.items.filter((_, i) => i !== pos);
  const tracks = playlist.tracks ? playlist.tracks.filter((_, i) => i !== pos) : playlist.tracks;
  ctx.settings.global.set(savedKey(sender, playlist.name), { ...playlist, items, tracks });

  return msg.reply.text(t("playlistRemoveDone", { label, name: playlist.name, count: items.length }));
}

function addPendingKey(sender) {
  return `playlist:addpending:${sender}`;
}

// Resolves the query via yt-dlp and shows a confirmation prompt ("Confere:")
// before actually adding anything to the playlist.
async function handlePlaylistAddStart(ctx, t, sender, playlist, query) {
  const { msg } = ctx;
  if (!query) {
    return msg.reply.text(t("playlistAddNeedQuery"));
  }
  if (playlist.items.length >= PLAYLIST_MAX_ITEMS) {
    return msg.reply.text(t("playlistLimitReached", { max: PLAYLIST_MAX_ITEMS }));
  }

  let info;
  try {
    info = await getInfo(ctx, query, t, "mp3");
  } catch (err) {
    ctx.log.error(`[playit] Playlist add failed (${query}): ${err.message}`);
    return msg.reply.text(t("error"));
  }

  ctx.settings.global.set(addPendingKey(sender), { name: playlist.name, query, info });

  return msg.reply.text(t("playlistAddConfirm", {
    title: info.title,
    channel: info.channel,
    duration: info.duration,
    name: playlist.name,
  }));
}

// Adds one resolved track to a saved playlist: appends it, re-warms the
// cache and flips the playlist back to ready when it was already playable.
// Shared by the "Confere:" confirm flow and the "add tocando" shortcut.
async function addTrackToPlaylist(ctx, t, key, playlist, query, info) {
  const { msg } = ctx;
  if (playlist.items.length >= PLAYLIST_MAX_ITEMS) {
    return msg.reply.text(t("playlistLimitReached", { max: PLAYLIST_MAX_ITEMS }));
  }

  const wasReady = playlist.ready && !!playlist.tracks;
  const newTrack = { query, title: info.title, channel: info.channel, url: info.url };
  const items = [...playlist.items, query];
  const tracks = wasReady ? [...playlist.tracks, newTrack] : playlist.tracks;
  // If the playlist was already playable, adding a song makes it
  // not-ready again — playback stays blocked until this one song is
  // actually fetched, same guarantee as a freshly recorded playlist.
  ctx.settings.global.set(key, { ...playlist, items, tracks, ready: wasReady ? false : playlist.ready });

  await msg.reply.text(t("playlistAddDone", {
    title: info.title,
    channel: info.channel,
    name: playlist.name,
    count: items.length,
  }));

  if (!wasReady) return; // still-prefetching playlist will pick this song up on its own

  const mm = ctx.plugins.require("synt-xerror/manymedia");
  if (!mm) return;

  // Fetch (and cache) the new song's voice .ogg, then flip the playlist
  // back to ready — playlists are mp3-only, the raw mp3 itself isn't kept.
  try {
    await getPlaylistVoice(ctx, mm, info.url, t);
  } catch (err) {
    ctx.log.error(`[playit] Add cache warm failed (${query}): ${err.message}`);
  }

  const current = ctx.settings.global.get(key, null);
  if (!current) return; // playlist was deleted while fetching the new song
  ctx.settings.global.set(key, { ...current, ready: true });
  await ctx.msg.reply.text(t("playlistReady", { name: playlist.name }));
}

// Handles the reply to the "Confere:" prompt above (a plain, non-prefixed
// message) — adds the track on a confirm word, cancels on anything else.
async function handlePlaylistAddConfirm(ctx, t, sender, pending) {
  const { msg } = ctx;
  const text = msg.body?.trim().toLowerCase();
  ctx.settings.global.delete(addPendingKey(sender));

  if (!text || !PLAYLIST_ADD_CONFIRM_WORDS.has(text)) {
    return msg.reply.text(t("playlistAddCancelled"));
  }

  const key = savedKey(sender, pending.name);
  const playlist = ctx.settings.global.get(key, null);
  if (!playlist) {
    return msg.reply.text(t("playlistNotFound", { name: pending.name }));
  }

  return addTrackToPlaylist(ctx, t, key, playlist, pending.query, pending.info);
}

// "!mp3 playlist add tocando" — shortcut to add the last song played via a
// direct !mp3/!mp4 command (not from a playlist) without re-searching it.
// Asks which saved playlist to add it to, then reuses addTrackToPlaylist.
async function handlePlaylistAddCurrentStart(ctx, t, sender, keyword) {
  const { msg } = ctx;
  if (keyword?.toLowerCase() !== "tocando") {
    return msg.reply.text(t("playlistAddCurrentUsage"));
  }

  const lastPlayed = ctx.settings.global.get(lastPlayedKey(sender), null);
  if (!lastPlayed) {
    return msg.reply.text(t("playlistAddCurrentNone"));
  }

  const playlists = listOwnPlaylists(ctx, sender);
  if (playlists.length === 0) {
    return msg.reply.text(t("playlistListEmpty"));
  }

  ctx.settings.global.set(addCurrentPendingKey(sender), lastPlayed);
  const names = playlists.map((p) => `• ${p.name}`).join("\n");
  return msg.reply.text(t("playlistAddCurrentAskName", {
    title: lastPlayed.info.title,
    channel: lastPlayed.info.channel,
    list: names,
  }));
}

// Handles the reply to the "which playlist?" prompt above.
async function handlePlaylistAddCurrentConfirm(ctx, t, sender, pending) {
  const { msg } = ctx;
  const name = msg.body?.trim();
  ctx.settings.global.delete(addCurrentPendingKey(sender));
  if (!name) return;

  if (!PLAYLIST_NAME_RE.test(name)) {
    return msg.reply.text(t("playlistInvalidName"));
  }

  const key = savedKey(sender, name);
  const playlist = ctx.settings.global.get(key, null);
  if (!playlist) {
    return msg.reply.text(t("playlistNotFound", { name }));
  }

  return addTrackToPlaylist(ctx, t, key, playlist, pending.query, pending.info);
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

  if (msg.fromMe) return;

  const pendingAdd = ctx.settings.global.get(addPendingKey(sender), null);
  if (pendingAdd && !msg.hasPrefix) {
    return handlePlaylistAddConfirm(ctx, t, sender, pendingAdd);
  }

  const pendingAddCurrent = ctx.settings.global.get(addCurrentPendingKey(sender), null);
  if (pendingAddCurrent && !msg.hasPrefix) {
    return handlePlaylistAddCurrentConfirm(ctx, t, sender, pendingAddCurrent);
  }

  const session = ctx.settings.global.get(sessionKey(sender), null);
  if (session && !msg.hasPrefix && !isPlaylistToggle(msg)) {
    return handlePlaylistNaming(ctx, t, sender, session);
  }

  for (const [oldCmd, newCmd] of Object.entries(RENAMED)) {
    if (msg.is(oldCmd)) return msg.reply.text(t("commandRemoved", { old: oldCmd, new: newCmd }));
  }

  if (isPlaylistToggle(msg)) {
    return handlePlaylistToggle(ctx, t, sender);
  }

  if (msg.is("mp3") || msg.is("mp4")) {
    const type = msg.is("mp3") ? "mp3" : "mp4";

    if (msg.args.length === 0 && !msg.hasReply) {
      return msg.reply.text(t(type === "mp3" ? "usage" : "usageVideo", { cmd: type }));
    }

    // Playlists are mp3-only.
    if (msg.args[0] === "playlist") {
      if (type === "mp4") {
        return msg.reply.text(t("playlistMp3Only"));
      }
      const mm = ctx.plugins.require("synt-xerror/manymedia");
      if (!mm) {
        ctx.log.error("[Playit] Dependency not found: synt-xerror/manymedia");
        return;
      }
      return handlePlaylistLoad(ctx, t, mm, msg.args.slice(1));
    }

    const mm = ctx.plugins.require("synt-xerror/manymedia");
    if (!mm) {
      ctx.log.error("[Playit] Dependency not found: synt-xerror/manymedia");
      return;
    }

    const query = await resolveQuery(ctx, msg.args.join(" "));
    await handlePlay(ctx, t, mm, type, query);
  }
}

