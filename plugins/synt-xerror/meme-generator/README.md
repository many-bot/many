# meme-generator

Meme plugin for ManyBot: stylized quotes + classic, simple, and brat meme generators.

## Commands

### `!quote`
Reply to a text message — no arguments, don't type text after the command.
Generates a quote image using the sender's profile photo (or a fallback avatar
if no photo/contact is available). The replied message must have text.

### `!classico top text / bottom text`
Reply to media (image, video, GIF, or sticker) or send the command along with it.
Classic meme: Impact font, uppercase, black outline. Use `/` to separate the two lines of text —
you can omit one side.

```
!classico when the code works | on the first try
```

### `!simples text`
Same concept as the classic meme, but with text only at the top. Futura Condensed ExtraBold font,
without forcing uppercase.

### `!brat text`
Does not use media — text only. White square background, Arial Narrow font, justified text.
Automatically shrinks the font size if the text is long.

```
!brat this is brat
```

### `!brat2 text`
Same as `!brat`, but with a `#89cc00` background instead of white.

### `!desmot title / caption`
Reply to media (image, video, GIF, or sticker) or send the command along with it.
Demotivational-poster style: black frame, thin white matting around the image, bold serif
title in caps below, smaller serif caption underneath. Use `/` to separate title and caption —
you can omit one side. Uses the same serif font as `!quote`.

```
!desmot I MUST GO / My bronies need me
```

### `!papa`
Reply to media (or send the command with it) to use that image, or reply to a text message to use
that person's profile picture. Composites it between the pope's fingers using `pope-bottom.png` /
`pope-top.png` as templates.

## Requirements

- `ffmpeg` installed and available in the `PATH` (required to apply `classico`/`simples` to
videos, GIFs, or animated stickers).

