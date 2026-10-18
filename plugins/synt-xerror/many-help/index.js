import { DatabaseSync } from "node:sqlite";
import { existsSync }   from "fs";

// ─── utils ───────────────────────────────────────────────────────────────────

const normalize = str =>
  str.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[\s\-_]+/g, "");

const RAW_PREFIX = "raw:";
const TOKEN_RE   = /\{\{(.+?)\}\}/g;

const mono = (pfx, text) => `\`${pfx}${text}\``;

const fmt = (text, pfx) =>
  text.replace(TOKEN_RE, (_, body) =>
    body.startsWith(RAW_PREFIX) ? body.slice(RAW_PREFIX.length) : mono(pfx, body));

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function stripPrefixArgs(args, pfx) {
  return args.map((a) => (a.startsWith(pfx) ? a.slice(pfx.length) : a)).join(" ");
}

const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

const PUNCTUATION_KEYS = {
  ",": "punctuationComma",
  ".": "punctuationPeriod",
  ";": "punctuationSemicolon",
  ":": "punctuationColon",
  "!": "punctuationExclamation",
  "?": "punctuationQuestion",
};

function getKnownCommands(ctx) {
  const raw = ctx.config.get("AUTOCORRECT_COMMANDS", []);
  const list = Array.isArray(raw) ? raw : raw.split(",");
  return list.map((c) => c.trim().toLowerCase()).filter(Boolean);
}

function isAutocorrectEnabled(ctx) {
  const raw = ctx.config.get("AUTOCORRECT_ENABLED", true);
  return !["false", "0", "off", "no"].includes(String(raw).trim().toLowerCase());
}

async function runAutocorrect(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  const pfx   = ctx.config.get("CMD_PREFIX", "!");
  const c     = name => mono(pfx, name);

  const spacedPrefix = !ctx.msg.command && ctx.msg.args.length > 0;
  const cmd = (spacedPrefix ? ctx.msg.args[0] : ctx.msg.command)?.toLowerCase();

  if (!cmd || !/[a-z0-9]/i.test(cmd)) return;

  const commands = getKnownCommands(ctx);
  const normCmd  = normalize(cmd);

  const punctMatch = cmd.match(TRAILING_PUNCT_RE);
  if (punctMatch) {
    const cleanCmd     = cmd.slice(0, cmd.length - punctMatch[0].length);
    const normCleanCmd = normalize(cleanCmd);
    const punctKey     = PUNCTUATION_KEYS[punctMatch[0][0]];
    if (punctKey && commands.some(c => normalize(c) === normCleanCmd)) {
      await ctx.msg.reply.text(t(punctKey, { cmd: cleanCmd }));
      return;
    }
  }

  const exactMatch = commands.find(c => normalize(c) === normCmd);
  if (exactMatch != null) {
    if (spacedPrefix) {
      await ctx.msg.reply.text(t("spaceAfterPrefix", { cmd: exactMatch }));
    }
    return;
  }

  const minLength   = Number(ctx.config.get("AUTOCORRECT_MIN_LENGTH", 1));
  const maxDistance = Number(ctx.config.get("AUTOCORRECT_MAX_DISTANCE", 2));

  let best = null;
  let bestDist = Infinity;

  if (commands.length && normCmd.length >= minLength) {
    for (const known of commands) {
      const dist = levenshtein(normCmd, normalize(known));
      if (dist < bestDist) { bestDist = dist; best = known; }
    }
  }

  if (best && bestDist > 0 && bestDist <= maxDistance) {
    const key = spacedPrefix ? "suggestionSpaced" : "suggestion";
    await ctx.msg.reply.text(t(key, { cmd, best, menuCmd: "many" }));
    return;
  }

  await ctx.msg.reply.text(t("unknownCommand", { cmd, helpCmd: "help", menuCmd: "many" }));
}

// ─── version ─────────────────────────────────────────────────────────────────

const MANYBOT_VERSION    = "v5.13.0";
const MANY_VERSION       = "v5.0";
const MENU_IMAGE_FILENAME = "menu.jpg";

// ─── category meta ───────────────────────────────────────────────────────────

const CATEGORY_ORDER = ["geral", "utilidade", "jogos", "brincadeiras", "comunidades", "adm", "devutils", "config", "halloween"];

const CATEGORY_ALIASES = {
  geral: "geral",
  utilidade: "utilidade", utilidades: "utilidade",
jogo: "jogos", jogos: "jogos",
  brincadeira: "brincadeiras", brincadeiras: "brincadeiras",
  comunidade: "comunidades", comunidades: "comunidades", grupos: "comunidades",
  adm: "adm", admin: "adm", administração: "adm", administracao: "adm",
  devutils: "devutils",
  config: "config", configs: "config", configuracao: "config", configuracoes: "config",
  info: "info", informacao: "info", informacoes: "info", sobre: "info", creditos: "info", crédito: "info",
  halloween: "halloween", fantasma: "halloween", ghost: "halloween",
};

function findCategoryFuzzy(query, maxDistance = 2) {
  const norm = normalize(query);
  let best = null, bestDist = Infinity;
  for (const alias of Object.keys(CATEGORY_ALIASES)) {
    const dist = levenshtein(norm, normalize(alias));
    if (dist < bestDist) { bestDist = dist; best = alias; }
  }
  return bestDist > 0 && bestDist <= maxDistance ? CATEGORY_ALIASES[best] : null;
}

// ─── builders ────────────────────────────────────────────────────────────────

function categoryItems(t, key) {
  return key === "config"
    ? t("configCommands")
    : t("plugins").filter(p => p.category === key);
}

function categoryCommandCount(t, key) {
  return categoryItems(t, key).reduce((sum, item) => sum + item.commands.length, 0);
}

function buildCategoryOverview(t, pfx) {
  const lines = [t("overviewHeader", { version: MANY_VERSION })];
  for (const key of CATEGORY_ORDER) {
    const label = t("categoryLabels")[key];
    lines.push(`*${label} (${categoryCommandCount(t, key)}):*\n- {{many ${key}}}\n`);
  }
  lines.push(t("overviewInfo"));
  lines.push(`\n${t("overviewTip")}`);
  return fmt(lines.join("\n"), pfx);
}

async function sendOverview(ctx, t, pfx) {
  const caption = buildCategoryOverview(t, pfx);
  const imgPath = ctx.storage.resolve(MENU_IMAGE_FILENAME);
  if (existsSync(imgPath)) {
    await ctx.msg.reply.image(imgPath, caption);
  } else {
    await ctx.msg.reply.text(caption);
  }
}

function buildCategorySection(t, pfx, key) {
  const label = t("categoryLabels")[key];
  const lines = [`*${label}:*\n`];
  for (const item of categoryItems(t, key)) {
    lines.push(item.name);
    for (const cmd of item.commands) lines.push(`- {{${cmd}}}`);
    lines.push("");
  }
  lines.push(t("categorySectionTip"));
  return fmt(lines.join("\n"), pfx);
}

function buildInfoSection(t, pfx) {
  return fmt([
    t("infoTitle"),
    t("infoManyBotVersion", { version: MANYBOT_VERSION }),
    t("infoManyVersion",    { version: MANY_VERSION }),
    t("infoChangelog"),
    t("infoLicense"),
    t("infoGroup"),
    t("infoSite"),
    t("infoChannel"),
    t("infoCreatorTitle"),
    t("infoCreator"),
  ].join("\n"), pfx);
}

const commandWord = cmd => cmd.split(/\s+/)[0];

function findPlugin(t, pluginName) {
  const query = normalize(pluginName);
  return t("plugins").find(p =>
    normalize(p.id) === query ||
    normalize(p.name) === query ||
    p.aliases?.some(a => normalize(a) === query) ||
    p.commands?.some(c => !c.startsWith(RAW_PREFIX) && normalize(commandWord(c)) === query)
  );
}

function pluginHelpText(t, pluginName, pfx) {
  const p = findPlugin(t, pluginName);
  return p ? fmt(`*${p.name}*\n\n${p.description}`, pfx) : null;
}

function buildPluginHelp(t, pluginName, pfx) {
  return pluginHelpText(t, pluginName, pfx)
    ?? fmt(t("pluginNotFound", { name: pluginName }), pfx);
}

function buildChangelog(t, pfx) {
  return fmt([
    t("changelogTitle",     { version: MANY_VERSION }),
    "",
    t("changelogAdmin"),
    "",
    t("changelogConverter"),
    "",
    t("changelogMusic"),
    "",
    t("changelogMenu"),
    "",
    t("changelogCommunity"),
    "",
    t("changelogSupport"),
    "",
    t("changelogFixes"),
    "",
    t("changelogFooter"),
  ].join("\n"), pfx);
}

function buildLicense(t) {
  return [t("licenseTitle"), "", t("license1"), "", t("license2"), "", t("license3")].join("\n");
}

function inviteErrorMessage(t, err, pfx) {
  const status = err?.cause?.data ?? err?.cause?.output?.statusCode;
  if (status === 401) return t("inviteError401");
  return fmt(t("inviteErrorGeneric"), pfx);
}

// ─── tips ────────────────────────────────────────────────────────────────────

const INVITE_LINK_RE = /chat\.whatsapp\.com/i;
const INVITE_URL_RE  = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/;
const AFFIRMATIVE_WORDS = new Set(["sim", "claro", "yes"]);

const SUPPORT_TRIGGER_WORDS = new Set([
  "como", "ajuda", "ajudar", "grupo", "grupos", "duvida", "duvidas", "funciona", "comando", "comandos",
]);

const stripAccents = str =>
  str.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

const QUESTION_PATTERNS = [
  /^(como|onde|qual|quais|quem|quando|quanto|quanta|por ?que|porque|pq|o que|oq)\b/,
  /\b(o ?que|oq) (voce|vc|tu|ce)\b/,
  /\b(voce|vc|tu|ce) (faz|sabe|pode|serve)\b/,
  /\b(voce|vc|tu|ce) (e|eh) (um |uma )?(bot|robo|humano|humana|pessoa|ia|gente)\b/,
  /\bquem (e|eh) (voce|vc|tu|essa|esse)\b/,
  /\b(pra|para) que serve\b|\bserve (pra|para) que\b/,
  /\b(que|quais)( sao)?( os| as)? (comandos?|funcoes|funcionalidades)\b/,
  /\btem (algum |alguma )?(comando|funcao|jeito|como)\b/,
  /\bda (pra|para) \w+/,
  /\bnao (sei (usar|como)|entendi|consigo (usar|fazer))\b/,
  /\b(preciso|quero|queria|gostaria)( de)? (ajuda|saber)\b/,
];

function hasSupportTriggerWord(body) {
  const text  = stripAccents(body);
  const words = text.split(/[^a-z0-9]+/);
  return words.some(w => SUPPORT_TRIGGER_WORDS.has(w));
}

function isQuestionLike(body) {
  const text = stripAccents(body).trim();
  if (text.includes("?") && /[a-z]{2}/.test(text)) return true;
  return QUESTION_PATTERNS.some(re => re.test(text));
}

// ─── chatter detection ───────────────────────────────────────────────────────

const CHATTER_WINDOW_MS   = 10 * 60 * 1000;
const CHATTER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const chatter      = new Map();
const chatterTipAt = new Map();

function isConversational(body) {
  const text = stripAccents(body).trim();
  return /[a-z]{2}/.test(text) && text.split(/\s+/).length >= 2;
}

function trackChatter(sender, threshold) {
  const now = Date.now();
  if (now - (chatterTipAt.get(sender) ?? 0) < CHATTER_COOLDOWN_MS) return false;

  const entry = chatter.get(sender);
  const count = entry && now - entry.last <= CHATTER_WINDOW_MS ? entry.count + 1 : 1;

  if (count < threshold) {
    chatter.set(sender, { count, last: now });
    return false;
  }

  chatter.delete(sender);
  chatterTipAt.set(sender, now);
  return true;
}

function backtickCommandRegex(pfx) {
  const escapedPfx = pfx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^`" + escapedPfx + "\\S+`");
}

// ─── db ──────────────────────────────────────────────────────────────────────

const INACTIVE_MS = 3 * 24 * 60 * 60 * 1000;

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_users (
      sender     TEXT    PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL DEFAULT 0
    )
  `);
  try { db.exec("ALTER TABLE seen_users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0"); } catch {}
  return db;
}

function purgeInactive(db) {
  db.prepare("DELETE FROM seen_users WHERE last_seen > 0 AND last_seen < ?").run(Date.now() - INACTIVE_MS);
}

function touchUser(db, sender) {
  db.prepare("UPDATE seen_users SET last_seen = ? WHERE sender = ?").run(Date.now(), sender);
}

function isFirstTime(db, sender) {
  const { changes } = db
    .prepare("INSERT OR IGNORE INTO seen_users (sender, first_seen, last_seen) VALUES (?, ?, ?)")
    .run(sender, Date.now(), Date.now());
  return changes === 1;
}

// ─── plugin ──────────────────────────────────────────────────────────────────

let db;
const recentlyGreeted = new Set();
const pendingAdd      = new Map();

export function setup(ctx) {
  const dbPath = ctx.storage.resolve("users.db");
  db = openDb(dbPath);
  const { t } = ctx.i18n.createT(import.meta.url);
  ctx.log.info(t("setupLoaded"));
}

/**
 * @param {import('@manybot/types/en').PluginContext} ctx
 */
export default async function (ctx) {
  const { msg, chat, config } = ctx;
  if (msg.fromMe) return;

  const { t } = ctx.i18n.createT(import.meta.url);
  const pfx    = config.get("CMD_PREFIX", "!");
  const sender = msg.sender;
  const addKey = chat.id + ":" + sender;

  const say = (text, opts) => msg.reply.text(fmt(text, pfx), opts);

  if (msg.hasPrefix) chatter.delete(sender);

  if (pendingAdd.has(addKey)) {
    const invite = pendingAdd.get(addKey);
    pendingAdd.delete(addKey);

    const firstWord = stripAccents(msg.body).trim().split(/\s+/)[0];
    if (!AFFIRMATIVE_WORDS.has(firstWord)) return;

    try {
      const result = await chat.acceptInvite(invite);
      await msg.reply.text(result.status === "joined" ? t("inviteJoined") : t("inviteJoinedPending"));
    } catch (err) {
      ctx.log.error("acceptInvite failed:", err);
      await msg.reply.text(inviteErrorMessage(t, err, pfx));
    }
    return;
  }

  if (msg.is("add")) {
    await msg.reply.text(t("addRemoved"));
    return;
  }

  const HELP_TRIGGERS    = ["many", "help", "hello", "ajuda", "ola", "olá"];
  const LICENSE_TRIGGERS = ["licenca", "licença", "license"];

  const isDetailCmd    = msg.is("help") && msg.args.length > 0;
  const isNavCmd       = HELP_TRIGGERS.includes(msg.command) && msg.command !== "help" && msg.args.length > 0;
  const isHelpCmd      = HELP_TRIGGERS.includes(msg.command);
  const isLicenseCmd   = LICENSE_TRIGGERS.includes(msg.command);
  const isChangelogCmd = msg.is("changelog");

  if (isDetailCmd) {
    const query = stripPrefixArgs(msg.args, pfx);
    const key   = CATEGORY_ALIASES[normalize(query)] ?? findCategoryFuzzy(query);
    if (key === "info") await msg.reply.text(buildInfoSection(t, pfx));
    else if (key)       await msg.reply.text(buildCategorySection(t, pfx, key));
    else                await msg.reply.text(buildPluginHelp(t, query, pfx));
    return;
  }

  if (isNavCmd) {
    const query = stripPrefixArgs(msg.args, pfx);
    const key   = CATEGORY_ALIASES[normalize(query)] ?? findCategoryFuzzy(query);
    if (key === "info") {
      await msg.reply.text(buildInfoSection(t, pfx));
    } else if (key) {
      await msg.reply.text(buildCategorySection(t, pfx, key));
    } else {
      const help = pluginHelpText(t, query, pfx);
      if (help) await msg.reply.text(help);
      else       await sendOverview(ctx, t, pfx);
    }
    return;
  }

  if (isHelpCmd) {
    await sendOverview(ctx, t, pfx);
    return;
  }

  if (isLicenseCmd) {
    await msg.reply.text(buildLicense(t));
    return;
  }

  if (isChangelogCmd) {
    await msg.reply.text(buildChangelog(t, pfx), { linkPreview: false });
    return;
  }

  if (msg.hasPrefix) {
    if (isAutocorrectEnabled(ctx)) await runAutocorrect(ctx);
    return;
  }

  const hasBacktickCmd = backtickCommandRegex(pfx).test(msg.body);
  const hasInviteLink  = !chat.isGroup && (INVITE_LINK_RE.test(msg.body) || msg.type === "invite");
  const hasSupportWord = !chat.isGroup && !msg.hasPrefix && (hasSupportTriggerWord(msg.body) || isQuestionLike(msg.body));

  if (hasBacktickCmd || hasInviteLink || hasSupportWord) chatter.delete(sender);

  if (hasBacktickCmd) {
    await msg.reply.text(t("backtickTip"));
    return;
  }

  if (hasInviteLink) {
    const invite = msg.type === "invite" ? msg : msg.body.match(INVITE_URL_RE)?.[0];
    pendingAdd.set(addKey, invite);
    await say(t("inviteConfirmPrompt"));
    return;
  }

  if (hasSupportWord) {
    await msg.reply.text(t("supportTip"), { linkPreview: false });
    return;
  }

  if (!db) return;

  purgeInactive(db);

  if (!chat.isGroup && isFirstTime(db, sender)) {
    if (recentlyGreeted.has(sender)) return;
    recentlyGreeted.add(sender);
    setTimeout(() => recentlyGreeted.delete(sender), 5000);

    const licenseShort = fmt(t("licenseShort"), pfx);
    await say(t("greetingText", { licenseShort }), { linkPreview: false });
    return;
  }

  if (chat.isGroup) return;

  touchUser(db, sender);

  const threshold = Number(config.get("CHATTER_THRESHOLD", 3));
  if (isConversational(msg.body) && trackChatter(sender, threshold)) {
    await say(t("chatterTip"));
  }
}

