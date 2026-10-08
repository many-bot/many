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

```
!mp3 playlist                    # start/stop recording
!mp3 playlist nome-da-playlist   # load and play a saved playlist
!mp3 playlist nome-da-playlist zip  # download everything as a .zip
!mp3 playlist nome-da-playlist del  # delete the playlist
```

1. Run `!mp3 playlist` (or `!mp4 playlist`) to enter recording mode.
2. Send song names or links, one per message — each gets a ✅ reaction.
3. Run `!mp3 playlist` again to stop. You'll be asked for a playlist name.
4. The name can't have spaces or special characters (letters, numbers, `_`, `-` only), and can't repeat one you already have.

Playlists are saved per user (not per chat), so they follow you across conversations. Max 20 songs per playlist.

Loading a playlist with `!mp3 playlist <name>` sends each song as audio; `!mp4 playlist <name>` sends each as video. Adding `zip` at the end downloads every item into a folder and sends it back as a single `.zip` file — requires `zip` installed on the system.

## Dependencies

- [`synt-xerror/manymedia`](https://manybot.stxerr.dev/docs/plugins/manymedia)
- `yt-dlp` installed on the system
- `zip` installed on the system (optional, only for `!mp3/!mp4 playlist <name> zip`)
