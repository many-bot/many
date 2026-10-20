import fs from "node:fs";
import path from "node:path";

// `category` is the nekos.best v2 category — see /api/v2/endpoints.
const ALIASES = {
  abracar: "hug",
  abraçar: "hug",
  beijar: "kiss",
  tapa: "slap",
  cafune: "pat",
  cafuné: "pat",
  cutucar: "poke",
  morder: "bite",
  chutar: "kick",
  socar: "punch",
  cócegas: "tickle",
  cocegas: "tickle",
  acenar: "wave",
  dançar: "dance",
  dancar: "dance",
  matar: "kill",
  cumprimentar: "handshake",
};

// Most commands map 1:1; `kill` maps to "shoot" (no "kill" category exists).
const ACTIONS = {
  hug:       { category: "hug",       emoji: "🤗" },
  kiss:      { category: "kiss",      emoji: "😘" },
  slap:      { category: "slap",      emoji: "✋" },
  pat:       { category: "pat",       emoji: "🤚" },
  poke:      { category: "poke",      emoji: "👉" },
  bite:      { category: "bite",      emoji: "😬" },
  kick:      { category: "kick",      emoji: "🦵" },
  punch:     { category: "punch",     emoji: "👊" },
  tickle:    { category: "tickle",    emoji: "🤣" },
  wave:      { category: "wave",      emoji: "👋" },
  dance:     { category: "dance",     emoji: "💃" },
  kill:      { category: "shoot",     emoji: "💀" },
  handshake: { category: "handshake", emoji: "🤝" },
};

const GIF_API = "https://nekos.best/api/v2";
// nekos.best blocks requests with a missing, generic, or library-default
// User-Agent (node, axios, curl, etc.) — see docs.nekos.best/getting-started/api-reference.
const USER_AGENT = "social-actions-whatsapp-plugin/1.0 (https://manybot.org)";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTS = new Set([".mp4"]);
const DEFAULT_THEME = "anime"; // uses the API, no local folder needed
const THEME_SETTING_KEY = "actionTheme";
const THEME_COMMAND = "actiontheme";

/** Ensures (and returns) `<storage>/<command>/`, creating it via a marker file. */
function ensureActionFolder(ctx, command) {
  const marker = ctx.storage.resolve(path.join(command, ".keep"));
  return path.dirname(marker);
}

/** Picks a random file from `<command>/<theme>/`, or null if there's nothing there. */
function pickLocalFile(ctx, command, theme) {
  const themeDir = path.join(ensureActionFolder(ctx, command), theme);
  if (!fs.existsSync(themeDir)) return null;
  const files = fs.readdirSync(themeDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || ext === ".gif";
  });
  if (files.length === 0) return null;
  return path.join(themeDir, files[Math.floor(Math.random() * files.length)]);
}

function currentTheme(ctx) {
  return ctx.settings.get(THEME_SETTING_KEY, DEFAULT_THEME);
}

/** Any subfolder under any command's storage dir counts as an available theme. */
function listLocalThemes(ctx) {
  const themes = new Set();
  for (const command of Object.keys(ACTIONS)) {
    const commandDir = ensureActionFolder(ctx, command);
    for (const entry of fs.readdirSync(commandDir, { withFileTypes: true })) {
      if (entry.isDirectory()) themes.add(entry.name);
    }
  }
  return ["anime", ...themes];
}

async function handleThemeCommand(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  if (ctx.chat.isGroup && !(await ctx.chat.isAdmin(ctx.msg.sender))) {
    ctx.msg.reply.text(t("groupOrAdmin"));
  }

  const prefix = ctx.config.get("CMD_PREFIX");
  const command = `${prefix}${THEME_COMMAND}`;
  const requested = (ctx.msg.args[0] ?? "").toLowerCase();

  if (!requested) {
    const available = listLocalThemes(ctx);
    return void await ctx.msg.reply.text(
      t("themeStatus", { current: currentTheme(ctx), available: available.length ? available.join(", ") : t("themeNoneLocal") }),
    );
  }

  if (requested !== DEFAULT_THEME && !listLocalThemes(ctx).includes(requested)) {
    return void await ctx.msg.reply.text(t("themeNotFound", { theme: requested, command }));
  }

  ctx.settings.set(THEME_SETTING_KEY, requested);
  await ctx.msg.reply.text(t("themeSet", { theme: requested }));
}

/** Creates each command's storage folder as soon as the plugin loads. */
export async function setup(ctx) {
  for (const command of Object.keys(ACTIONS)) {
    ensureActionFolder(ctx, command);
  }
}

/** ctx.send.video/image only accept a file path, not a Buffer — download to a temp file. */
async function fetchGifToTempFile(ctx, category) {
  const res = await fetch(`${GIF_API}/${category}?amount=1`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`nekos.best responded ${res.status}`);
  const { results } = await res.json();
  const url = results?.[0]?.url;
  if (!url) throw new Error(`nekos.best returned no results for "${category}"`);

  const assetRes = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!assetRes.ok) throw new Error(`asset download failed (${assetRes.status})`);
  const buffer = Buffer.from(await assetRes.arrayBuffer());

  const ext = path.extname(new URL(url).pathname) || ".gif";
  const tmpPath = ctx.storage.resolve(`tmp_${category}_${Date.now()}${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

/**
 * @param {import('@manybot/types/en').PluginContext} ctx
 */
async function resolveTarget(ctx) {
  if (ctx.msg.hasReply) {
    const quoted = await ctx.msg.getReply();
    ctx.log.info(JSON.stringify(quoted));
    if (quoted) return { id: quoted.sender };
  }

  const mentionedId = ctx.msg.mentionedJid?.[0];
  if (mentionedId) return { id: mentionedId };

  return null;
}

function tag(jid) {
  return `@${jid.split("@")[0]}`;
}

function userPart(jid) {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

function isSameUser(a, b) {
  return Boolean(a && b) && userPart(a) === userPart(b);
}

async function isBotTarget(ctx, targetId) {
  if (isSameUser(targetId, ctx.botId)) return true;
  const contact = await ctx.contacts.get(targetId).catch(() => null);
  return Boolean(contact?.isMe);
}

function isEveryoneArg(ctx) {
  const arg = (ctx.msg.args[0] ?? "").toLowerCase().replace(/^@/, "");
  return arg === "all";
}

function mediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".gif") return "gif";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "image";
}

/**
 * @param {import('@manybot/types/en').PluginContext} ctx
 */
export default async function (ctx) {
  if (ctx.msg.fromMe) return;
  if (!ctx.msg.hasPrefix) return;

  if (ctx.msg.command === THEME_COMMAND) {
    await handleThemeCommand(ctx);
    return;
  }

  const command = ALIASES[ctx.msg.command] ?? ctx.msg.command;
  const action = ACTIONS[command];
  if (!action) return;

  const { t } = ctx.i18n.createT(import.meta.url);
  const verb = t(`verbs.${command}`);

  if (!ctx.msg.hasReply && isEveryoneArg(ctx)) {
    const caption = t("everyoneLine", {
      sender: tag(ctx.msg.sender),
      action: t(`everyone.${command}`),
      emoji: action.emoji,
    });
    return void await ctx.msg.reply.text(caption, { mentions: [ctx.msg.sender] });
  }

  const target = await resolveTarget(ctx);
  if (!target) {
    const prefix = ctx.config.get("CMD_PREFIX");
    return void await ctx.msg.reply.text(t("noTarget", { command: `${prefix}${ctx.msg.command}` }));
  }

  if (isSameUser(target.id, ctx.msg.sender)) {
    const infinitive = t(`infinitives.${command}`);
    return void await ctx.msg.reply.text(t("selfTarget", { infinitive, emoji: action.emoji }));
  }

  const toBot = await isBotTarget(ctx, target.id);

  // Sessão só pra evitar que um restart no meio do fetch/envio deixe
  // trabalho pela metade — fecha assim que a mídia é enviada (ou falha).
  ctx.session.acquire();
  try {
    const theme = currentTheme(ctx);
    const localFile = theme !== DEFAULT_THEME ? pickLocalFile(ctx, command, theme) : null;
    let media = localFile;
    let isTemp = false;

    if (!media) {
      try {
        media = await fetchGifToTempFile(ctx, action.category);
        isTemp = true;
      } catch (err) {
        ctx.log.error(`social-actions: failed to fetch gif (${action.category}): ${err.message}`);
        return void await ctx.msg.reply.text(t("fetchError"));
      }
    }

    const senderTag = tag(ctx.msg.sender);
    const targetTag = tag(target.id);
    const caption = toBot
      ? t("botLine", { sender: senderTag, action: t(`toBot.${command}`), emoji: action.emoji })
      : t("actionLine", { sender: senderTag, verb, target: targetTag, emoji: action.emoji });
    const mentions = toBot ? [ctx.msg.sender] : [ctx.msg.sender, target.id];

    try {
      const kind = mediaKind(media);
      if (kind === "gif") await ctx.send.gif(media, caption, { mentions });
      else if (kind === "video") await ctx.send.video(media, caption, { mentions });
      else await ctx.send.image(media, caption, { mentions });
    } finally {
      if (isTemp) fs.rmSync(media, { force: true });
    }
  } finally {
    ctx.session.release();
  }
}

