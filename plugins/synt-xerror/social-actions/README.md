# acoes-sociais (social-actions)

Discord-style action commands (`/hug`, `/kiss`, etc.) using gifs from the
public [otakugifs.xyz](https://otakugifs.xyz/api) API — no API key, no npm
dependency.

## Usage

Reply to the person's message, or mention them in the text:

```
/hug @carlos
```

Result: a message with a real mention + a gif of the action.

## Available commands

`hug`, `kiss`, `slap`, `pat`, `poke`, `bite`, `kick`, `punch`, `tickle`, `wave`, `dance`

## Themes

By default every command uses the `anime` theme, which calls the
otakugifs API. You can add your own local themes: any subfolder inside a
command's folder becomes a theme.

```
data/plugin/hug/
  mlp/
    1.gif
    2.gif
  games/
    1.gif
    2.gif
```

Switch themes per chat with `!actiontheme <name>` (group admins only in
groups; anyone in DM). `!actiontheme` with no argument shows the current
theme and every local theme found across all commands. Setting
`!actiontheme anime` goes back to the API.

If the current theme has no files for a given command, that command falls
back to the API automatically.

## Local images/gifs (optional)

The plugin automatically creates a folder for each command inside its
storage (`hug/`, `kiss/`, `slap/`, etc). Files must live inside a theme
subfolder (`hug/mlp/`, `hug/games/`, ...) — see [Themes](#themes) above.
Accepted extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.mp4`.

## Locale

`en`, `pt`, `es` — command names stay fixed in English regardless of
language (e.g. `hug`, `kiss`); only the bot's replies are translated.

## Requirements

- Node 22+ (uses native `fetch`)
- No npm or external dependencies
