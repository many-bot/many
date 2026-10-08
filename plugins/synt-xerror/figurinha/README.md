# Figurinha

Sticker creation plugin for Manybot. Convert images, videos, and GIFs into WhatsApp stickers with automatic optimization.

## Features

- **Direct mode**: Send `!f` with attached media or reply to media to create stickers instantly
- **Batch mode**: Open a batch to collect multiple media files, then generate all stickers at once
- **Automatic optimization**: Resizes images to 512x512, converts videos/GIFs to animated stickers
- **Quality adjustment**: Automatically reduces quality if sticker exceeds 900KB limit
- **Batch processing**: Collect up to 30 media files in a batch before generating

## Usage

### Quick mode (single sticker)

```
!f [attached image/video]
!f [reply to media]
```

Creates one sticker immediately from the attached or replied media. Sending `!f` with no media shows a usage hint.

**Preserve transparency**: Send PNG as document to keep the background transparent:
1. Attach as **Document** (not image)
2. Select your `.png` file
3. Send with `!f` command

### Batch mode (multiple stickers)

```
!f lote                             # Open batch
[send multiple images/videos/GIFs]  # Collect media
!f lote criar                       # Generate all stickers
```

### Cancel batch

```
!f lote parar                       # Cancel active batch
```

## Commands

| Command | Description |
|---------|-------------|
| `!f` | Create sticker from attached/replied media |
| `!f lote` | Open a new batch |
| `!f lote criar` | Generate stickers from collected batch media |
| `!f lote parar` | Stop and clear active batch |

## Requirements

- FFmpeg installed on the system
- Node.js environment with Manybot plugin support

## Dependencies

- `wa-sticker-formatter` - WhatsApp sticker formatting library
- `ffmpeg` - Video/image processing (system dependency)

## Localization

Available in:
- English (`locale/en.json`)
- Portuguese (`locale/pt.json`)
- Spanish (`locale/es.json`)

