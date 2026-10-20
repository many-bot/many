# manyconvert

Convert videos, GIFs, photos and PDFs between formats, right from the chat. Companion to [manymedia](https://github.com/synt-xerror/manymedia.many).

## Commands

| Command | Alias | Input | Output |
|---|---|---|---|
| `!video-audio` | `!v2a` | Video | MP3 audio |
| `!video-gif` | `!v2g` | Video | WhatsApp GIF |
| `!gif-video` | `!g2v` | GIF or video | MP4 video |
| `!foto-pdf` | `!f2p` | Image | PDF (one A4 page) |
| `!pdf-foto` | `!p2f` | PDF | One image per page, in order |

## Usage

Send the file with the command as its caption, or reply to a file with the command.

```
!v2a
!g2v link
```

### `link` argument

Add `link` after any command to upload the result and receive a download URL instead of the file itself.

```
!p2f link
```

The upload goes to the same endpoint as manymedia and uses the same `MEDIA_SRV_API_KEY`. Without that key configured, `link` is refused.

## Requirements

| Tool | Required | Used by |
|---|---|---|
| `ffmpeg` (includes `ffprobe`) | Yes | All commands |
| `pdftoppm` (poppler-utils) | Only for `pdf-foto` | `!pdf-foto` |

```bash
sudo apt install ffmpeg poppler-utils
```

## Configuration

| Key | Default | Description |
|---|---|---|
| `MEDIA_SRV_API_KEY` | — | API key for the upload server (`link` argument) |
| `CONVERT_MAX_PDF_PAGES` | `20` | Maximum pages sent by `pdf-foto` |

## Notes

- `video-gif` produces a muted video of up to 15 seconds and 480 px wide, sent as a WhatsApp GIF (not a `.gif` file).
- `foto-pdf` fits the image on an A4 page, landscape or portrait depending on the image.
- `pdf-foto` renders pages as JPEG at 110 DPI. PDFs longer than the page limit are truncated, and the bot says so.
- Uploaded files get a random prefix in their name to avoid collisions on the server.

## License

MIT

