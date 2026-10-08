# playit

ManyBot plugin to play audio or video in WhatsApp from a search term or URL.

## Commands

| Command        | Description                          |
|----------------|---------------------------------------|
| `!mp3 <query or url>`  | Downloads and sends audio (mp3) |
| `!mp4 <query or url>`  | Downloads and sends video (mp4) |

If the argument isn't a valid URL, it searches YouTube and uses the first result.

```
!mp3 rap do minecraft
!mp4 https://youtu.be/dQw4w9WgXcQ
```

If `!mp4` is used on a link yt-dlp can't handle (e.g. an image gallery/carousel), it falls back to downloading the images via `manymedia` and suggests using `!img <url>` directly next time.

> Renamed from `!play`/`!playv` in v3.0.0.

## Playlist mode

> Playlists only exist on `!mp3` — `!mp4` never has playlists.

```
!mp3 playlist                          # create a new playlist (asks for a name)
!mp3 playlist list                     # show your saved playlists
!mp3 playlist nome-da-playlist         # load and play a saved playlist
!mp3 playlist nome-da-playlist info    # show the songs in the playlist, numbered
!mp3 playlist nome-da-playlist add <nome ou link>  # add one song (asks to confirm)
!mp3 playlist nome-da-playlist del <índice>        # remove one song, by its info index
!mp3 playlist nome-da-playlist zip     # download everything as a .zip
!mp3 playlist nome-da-playlist del     # delete the whole playlist
```

1. Run `!mp3 playlist`. It asks for a name in your next message (reply *cancelar* to back out).
2. Send just the name. The name can't have spaces or special characters (letters, numbers, `_`, `-` only), can't repeat one you already have, and can't be `list`, `info`, `zip`, `del`, or `add` (those are reserved subcommands).
3. The playlist is created empty and ready right away — no songs are added upfront. Add them whenever with `!mp3 playlist <name> add <name/link>` or `!mp3 playlist add tocando` (adds the last song you played).

Playlists are saved per user (not per chat), so they follow you across conversations. Max 20 songs per playlist.

Loading a playlist first sends a "loading playlist" notice, then streams each song as its own message (not a reply to your command), each as a voice note (`asVoice`, transcoded to OGG/Opus via `ffmpeg` so WhatsApp actually renders it as PTT instead of erroring/showing a flat file; if `ffmpeg` isn't available or the conversion fails, it falls back to a regular audio message). An empty playlist just replies with a hint to add songs instead of "playing" nothing. Adding `zip` at the end downloads everything into a folder and sends it back as a single `.zip` file (always as mp3) — requires `zip` installed on the system. Adding `info` instead shows the numbered song list without downloading anything.

**Adding a song** — `!mp3 playlist <name> add <name or link>` (or reply to a message with just `!mp3 playlist <name> add`) resolves it via yt-dlp and shows a confirmation: `🔎 Confere: <title> - <channel> (<duration>)`. Reply with something like *sim*/*yes*/*confere* to add it, or anything else to cancel. Adding a song to a playlist that's already playable briefly flips it back to "not ready" while the new song is fetched and cached.

**Removing a song** — `!mp3 playlist <name> del <índice>`, using the number shown by `... info`. `del` with no number still deletes the entire playlist.

## Caching

Every downloaded song/video is cached under the plugin's storage directory, keyed by its resolved URL. A repeat request for the same song/video — whether a single `!mp3`/`!mp4`, a playlist `zip`, or video playback — is served from disk instead of being re-downloaded. Playlist **audio** playback is the one exception: the mp3 itself is never kept, only the transcoded voice `.ogg` (see below) is cached — the raw mp3 is downloaded to a temp file, converted, and deleted right after. The cache has no automatic eviction/size limit yet.

## Dependencies

- [`synt-xerror/manymedia`](https://manybot.stxerr.dev/docs/plugins/manymedia)
- `yt-dlp` installed on the system
- `ffmpeg` installed on the system (used to transcode playlist audio to OGG/Opus for voice notes; without it, playlist songs still send, just as regular audio instead of PTT)
- `zip` installed on the system (optional, only for `!mp3 playlist <name> zip`)
