/**
 * Configuração 100% via chat — não usa mais o ~/.manybot/manybot.conf.
 *
 * Um admin do grupo digita "!welcome config" DENTRO do grupo que vai
 * disparar a configuração (esse grupo vira o "canal de controle" da
 * conversa — é nele que se digita "pronto"/"padrão"/"cancelar" e se
 * escrevem as mensagens de texto livre). O bot então guia o admin por
 * um fluxo de perguntas; grupos são "escolhidos" mandando qualquer
 * mensagem DENTRO do grupo desejado.
 *
 * Cada grupo monitorado tem sua própria config, guardada em
 * ctx.settings.global sob a chave SETTINGS_KEY — dá pra rodar
 * "!welcome config" de novo pra reconfigurar (sobrescreve a entrada
 * existente pro mesmo grupo monitorado).
 *
 * i18n: todo texto que o bot ENVIA passa por ctx.i18n (locale/pt.json e
 * locale/en.json). O VOCABULÁRIO de comando — nomes de campo do "!welcome
 * set", palavras-chave como "pular"/"pronto"/"cancelar" e nomes de tema/
 * moldura — continua fixo em português: é sintaxe de comando (o que o
 * usuário precisa digitar), não texto de interface, então localizá-lo
 * mudaria o comportamento do bot, não só o idioma.
 */

/**
 * @typedef {import('@manybot/types').SetupContext} SetupContext
 * @typedef {import('@manybot/types').PluginContext} PluginContext
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Envolve o `t` retornado por ctx.i18n.createT pra injetar automaticamente
 * {{prefix}} (o prefixo de comando configurado, ex. "!") em toda chamada —
 * assim as strings de locale que mostram "!welcome ..." não precisam de um
 * prefixo hardcoded, e cada call site não precisa lembrar de passar a var.
 * @param {PluginContext} ctx
 * @param {(key: string, vars?: object) => string} rawT
 */
function withPrefix(ctx, rawT) {
  return (key, vars) => rawT(key, { prefix: ctx.config.get("CMD_PREFIX"), ...vars });
}

// ── Fontes (fallback em cascata, mesmo padrão do plugin quote) ──────────────
// Cada entrada só é registrada se o arquivo existir — se a pasta fonts/ estiver
// vazia ou incompleta, o plugin continua funcionando normalmente, só cai nas
// fontes genéricas do sistema (sans-serif/serif/monospace) em vez das
// bundladas. Namespaced "Welcome*" pra não colidir com fontes de outros
// plugins (ex. o "Quote*" do plugin quote) registradas no mesmo processo.
//
// Cada família tem Regular E Bold: o card sempre desenha o header, o nome e
// a inicial de fallback em negrito ("bold ...px"), não importa qual preset de
// fonte esteja ativo — sem o arquivo Bold registrado, esse texto sai fino ou
// com negrito sintético de qualidade inferior.
//
// WelcomeMath (STIXTwoMath) cobre símbolos matemáticos que nem DejaVu nem
// Liberation têm. Sem Unifont de propósito: cobertura de Unicode quase total,
// mas é bitmap — pixeliza em qualquer tamanho maior. Pra emoji/símbolos gerais
// sem esse efeito, a cascata usa NotoColorEmoji + STIXTwoMath + a cobertura
// já bem ampla do próprio DejaVu Sans (Latin estendido, Grego, Cirílico,
// setas, boa parte de Símbolos Diversos).
const FONT_DEFS = [
  { path: join(__dirname, "fonts", "DejaVuSans.ttf"), family: "WelcomeSans" },
  { path: join(__dirname, "fonts", "DejaVuSans-Bold.ttf"), family: "WelcomeSans" },
  { path: join(__dirname, "fonts", "LiberationSerif-Regular.ttf"), family: "WelcomeSerif" },
  { path: join(__dirname, "fonts", "LiberationSerif-Bold.ttf"), family: "WelcomeSerif" },
  { path: join(__dirname, "fonts", "DejaVuSansMono.ttf"), family: "WelcomeMono" },
  { path: join(__dirname, "fonts", "DejaVuSansMono-Bold.ttf"), family: "WelcomeMono" },
  { path: join(__dirname, "fonts", "NotoColorEmoji.ttf"), family: "WelcomeEmoji" },
  { path: join(__dirname, "fonts", "NotoSansBamum-Regular.ttf"), family: "WelcomeBamum" },
  { path: join(__dirname, "fonts", "NotoSerifKhitanSmallScript-Regular.ttf"), family: "WelcomeKhitan" },
  { path: join(__dirname, "fonts", "STIXTwoMath-Regular.ttf"), family: "WelcomeMath" },
];
for (const { path, family } of FONT_DEFS) {
  if (fs.existsSync(path)) {
    const ok = GlobalFonts.registerFromPath(path, family);
    if (!ok) console.warn(`[welcome] Falha ao registrar fonte: ${path}`);
  }
}

/** Presets de fonte pro card — cada um cai nas bundladas (se existirem) e depois na genérica do sistema. */
const FONT_STACKS = {
  padrao: `"WelcomeSans", "WelcomeEmoji", "WelcomeBamum", "WelcomeKhitan", "WelcomeMath", sans-serif`,
  serifa: `"WelcomeSerif", "WelcomeEmoji", "WelcomeBamum", "WelcomeKhitan", "WelcomeMath", sans-serif`,
  monoespacada: `"WelcomeMono", "WelcomeEmoji", "WelcomeMath", monospace`,
};
const DEFAULT_FONT = "padrao";

/** Foto de perfil usada quando a pessoa não tem uma (ou não deu pra baixar) e nenhum fallback customizado foi definido. */
const FALLBACK_AVATAR_PATH = join(__dirname, "fallback-profile.png");

const CARD_W = 900;
const CARD_H = 500;
const AVATAR_SIZE = 240;

const SETTINGS_KEY = "welcome:configs";
const COMMAND_NAME = "welcome";

const MIN_NAME_LENGTH = 2;
const FALLBACK_NAME = "novo membro";

/** Sufixo de nome de arquivo derivado do id do grupo monitorado (usado em bg_/avatarfallback_). */
function groupFileSuffix(watchGroupId) {
  return watchGroupId.replace(/[^a-z0-9]/gi, "");
}

const WORDS_DEFAULT = ["padrão", "padrao", "default", "pular"];
const WORDS_DONE = ["pronto"];
const WORDS_CANCEL = ["cancelar", "cancel"];
const WORDS_NONE = ["nenhuma", "nenhum", "desativar", "remover", "não", "nao", "no"];
const WORDS_CONFIRM = ["confirmar", "confirmo", "sim"];

/** Nomes vazios, só espaço, ou com 1 caractere caem no fallback — mesmo tratamento de "sem nome". */
function resolveDisplayName(raw, fallback = FALLBACK_NAME) {
  const trimmed = (raw ?? "").trim();
  return trimmed.length >= MIN_NAME_LENGTH ? trimmed : fallback;
}

/** Detecta JID cru (ex. "120363...@g.us") — sinal de que o nome do grupo ainda não foi resolvido. */
function looksLikeChatId(str) {
  return /@(g\.us|s\.whatsapp\.net|broadcast|newsletter|lid)$/i.test(str) || /^\d{5,}$/.test(str);
}

/**
 * Nome de grupo válido pra guardar/exibir: rejeita vazio, curto demais, ou
 * um JID cru (quando o driver ainda não tinha resolvido o subject do grupo
 * no momento em que o nome foi capturado).
 */
function sanitizeGroupName(raw) {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length < MIN_NAME_LENGTH) return null;
  if (looksLikeChatId(trimmed)) return null;
  return trimmed;
}

/** Substitui {nome} e {grupo} (e outras chaves passadas) num template de mensagem. */
function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value ?? ""),
    template
  );
}

const SET_FIELDS = ["mensagem", "card", "destino", "nomegrupo", "pv", "fundo", "moldura", "fonte", "avatar", "simples", "simplesgrupo", "grupo"];
const FIELD_ALIASES = { usarcard: "card", alvo: "destino" };
const CARD_ONLY_FIELDS = ["fundo", "moldura", "fonte", "avatar"];

const THEME_PRESETS = {
  roxo: ["#1f1147", "#3a1c71"],
  azul: ["#0f2027", "#2c5364"],
  verde: ["#134e5e", "#71b280"],
  vermelho: ["#8e0e00", "#3a0d0d"],
  dourado: ["#7a5c00", "#2b2100"],
  rosa: ["#780868", "#3a0a4f"],
  escuro: ["#0f0f0f", "#2c2c2c"],
  laranja: ["#7a2e00", "#2b1000"],
  ciano: ["#003b3b", "#001818"],
  cinza: ["#3a3a3a", "#141414"],
};
const DEFAULT_THEME = "roxo";
const FRAME_STYLES = ["circulo", "neon", "quadrado"];
const DEFAULT_FRAME = "circulo";
const HEX_RE = /^#([0-9a-f]{6})$/i;
const DEFAULT_IMAGE_OVERLAY = 0.7;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function shade(hex, percent) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (percent < 0 ? c : 255 - c) * percent)));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/** Resolve a stored `cardBackground` selection into a [colorA, colorB] gradient pair. */
function resolveThemeColors(background) {
  if (background?.type === "solid") return [background.value, background.value];
  if (background?.type === "gradient") return background.value;
  if (background?.type === "color") return [background.value, shade(background.value, -0.45)];
  if (background?.type === "theme") return THEME_PRESETS[background.value] ?? THEME_PRESETS[DEFAULT_THEME];
  return THEME_PRESETS[DEFAULT_THEME];
}

/**
 * Interpreta texto livre de fundo (tema, #hex, "sólido #hex" ou "gradiente #hex #hex").
 * Não lida com imagem — isso é tratado à parte, onde dá pra baixar mídia.
 * @returns O background reconhecido, ou `null` se o texto não bateu com nenhum formato.
 */
function parseBackgroundText(text) {
  const trimmed = (text ?? "").trim();
  const word = normWord(trimmed);

  if (WORDS_DEFAULT.includes(word)) return { type: "theme", value: DEFAULT_THEME };
  if (THEME_PRESETS[word]) return { type: "theme", value: word };

  const soloMatch = trimmed.match(/^(?:s[oó]lido|solid)\s+(#[0-9a-f]{6})$/i);
  if (soloMatch) return { type: "solid", value: soloMatch[1] };

  const gradMatch = trimmed.match(/^(?:gradiente|gradient)\s+(#[0-9a-f]{6})\s+(#[0-9a-f]{6})$/i);
  if (gradMatch) return { type: "gradient", value: [gradMatch[1], gradMatch[2]] };

  if (HEX_RE.test(trimmed)) return { type: "color", value: trimmed };

  return null;
}

function normWord(s) {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Tenta carregar a imagem de avatar; se falhar (path nulo, arquivo corrompido,
 * etc.), retorna null e quem chama cai no fallback de iniciais.
 */
async function loadAvatarImage(avatarPath) {
  if (!avatarPath) return null;
  try {
    return await loadImage(avatarPath);
  } catch {
    return null;
  }
}

/**
 * Ordem de fallback pra foto do card: avatar real da pessoa → fallback
 * customizado do grupo (definido via "!welcome set avatar") → imagem padrão
 * bundlada com o plugin → (se nem essa existir) null, e o buildCard desenha
 * as iniciais do nome.
 */
function resolveAvatarSource(config, realAvatarPath, gotRealAvatar) {
  if (gotRealAvatar && realAvatarPath && fs.existsSync(realAvatarPath)) return realAvatarPath;
  if (config.avatarFallbackPath && fs.existsSync(config.avatarFallbackPath)) return config.avatarFallbackPath;
  if (fs.existsSync(FALLBACK_AVATAR_PATH)) return FALLBACK_AVATAR_PATH;
  return null;
}

async function buildCard({ welcomeTitle = "Bem-Vindo!", subtitle, avatarPath, outPath, background, frame, headerLabel = "BEM-VINDO", fontFamily = FONT_STACKS[DEFAULT_FONT] }) {
  const canvas = createCanvas(CARD_W, CARD_H);
  const c = canvas.getContext("2d");
  const frameStyle = FRAME_STYLES.includes(frame) ? frame : DEFAULT_FRAME;

  // Fundo: imagem custom (cover-fit + overlay p/ legibilidade) ou gradiente de tema/cor.
  if (background?.type === "image" && fs.existsSync(background.value)) {
    const bg = await loadImage(background.value);
    const scale = Math.max(CARD_W / bg.width, CARD_H / bg.height);
    const w = bg.width * scale;
    const h = bg.height * scale;
    c.drawImage(bg, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
    const overlayStrength = typeof background.overlay === "number" ? background.overlay : DEFAULT_IMAGE_OVERLAY;
    const overlay = c.createLinearGradient(0, 0, 0, CARD_H);
    overlay.addColorStop(0, `rgba(10,8,20,${Math.min(1, overlayStrength * 0.8).toFixed(2)})`);
    overlay.addColorStop(1, `rgba(10,8,20,${Math.min(1, overlayStrength * 1.2).toFixed(2)})`);
    c.fillStyle = overlay;
    c.fillRect(0, 0, CARD_W, CARD_H);
  } else {
    const [colorA, colorB] = resolveThemeColors(background);
    const grad = c.createLinearGradient(0, 0, CARD_W, CARD_H);
    grad.addColorStop(0, colorA);
    grad.addColorStop(1, colorB);
    c.fillStyle = grad;
    c.fillRect(0, 0, CARD_W, CARD_H);
  }
  const accent = background?.type === "image" ? "#ffffff" : resolveThemeColors(background)[1];

  // Faixa decorativa diagonal sutil no topo.
  c.save();
  c.globalAlpha = 0.08;
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(CARD_W, 0);
  c.lineTo(CARD_W, 90);
  c.lineTo(0, 160);
  c.closePath();
  c.fill();
  c.restore();

  c.font = `bold 24px ${fontFamily}`;
  c.fillStyle = "rgba(255,255,255,0.35)";
  c.textAlign = "left";
  c.fillText(headerLabel, 40, 55);

  const ax = CARD_W / 2;
  const ay = CARD_H / 2 - 35;

  c.save();
  if (frameStyle === "neon") {
    c.shadowColor = accent;
    c.shadowBlur = 32;
    c.beginPath();
    c.arc(ax, ay, AVATAR_SIZE / 2 + 10, 0, Math.PI * 2);
    c.strokeStyle = accent;
    c.lineWidth = 7;
    c.stroke();
    c.shadowBlur = 0;
  } else if (frameStyle === "quadrado") {
    const half = AVATAR_SIZE / 2 + 10;
    const r = 32;
    c.beginPath();
    c.moveTo(ax - half + r, ay - half);
    c.arcTo(ax + half, ay - half, ax + half, ay + half, r);
    c.arcTo(ax + half, ay + half, ax - half, ay + half, r);
    c.arcTo(ax - half, ay + half, ax - half, ay - half, r);
    c.arcTo(ax - half, ay - half, ax + half, ay - half, r);
    c.closePath();
    c.fillStyle = "#ffffff";
    c.fill();
  } else {
    c.beginPath();
    c.arc(ax, ay, AVATAR_SIZE / 2 + 8, 0, Math.PI * 2);
    c.fillStyle = "#ffffff";
    c.fill();
  }
  c.restore();

  c.save();
  if (frameStyle === "quadrado") {
    const half = AVATAR_SIZE / 2;
    const r = 26;
    c.beginPath();
    c.moveTo(ax - half + r, ay - half);
    c.arcTo(ax + half, ay - half, ax + half, ay + half, r);
    c.arcTo(ax + half, ay + half, ax - half, ay + half, r);
    c.arcTo(ax - half, ay + half, ax - half, ay - half, r);
    c.arcTo(ax - half, ay - half, ax + half, ay - half, r);
    c.closePath();
  } else {
    c.beginPath();
    c.arc(ax, ay, AVATAR_SIZE / 2, 0, Math.PI * 2);
  }
  c.closePath();
  c.clip();

  const avatarImg = await loadAvatarImage(avatarPath);
  if (avatarImg) {
    c.drawImage(avatarImg, ax - AVATAR_SIZE / 2, ay - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
  } else {
    c.fillStyle = accent;
    c.fillRect(ax - AVATAR_SIZE / 2, ay - AVATAR_SIZE / 2, AVATAR_SIZE, AVATAR_SIZE);
    c.fillStyle = "#ffffff";
    c.font = `bold 80px ${fontFamily}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("👋", ax, ay + 4);
  }
  c.restore();

  c.textAlign = "center";
  c.fillStyle = "#ffffff";
  c.font = `bold 48px ${fontFamily}`;
  c.fillText(welcomeTitle, CARD_W / 2, ay + AVATAR_SIZE / 2 + 65, CARD_W - 80);

  const pillText = subtitle;
  c.font = `22px ${fontFamily}`;
  const pillW = c.measureText(pillText).width + 48;
  const pillX = CARD_W / 2 - pillW / 2;
  const pillY = ay + AVATAR_SIZE / 2 + 88;
  const pillH = 42;
  const pillR = pillH / 2;
  c.beginPath();
  c.moveTo(pillX + pillR, pillY);
  c.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, pillR);
  c.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, pillR);
  c.arcTo(pillX, pillY + pillH, pillX, pillY, pillR);
  c.arcTo(pillX, pillY, pillX + pillW, pillY, pillR);
  c.closePath();
  c.fillStyle = "rgba(255,255,255,0.14)";
  c.fill();
  c.fillStyle = "rgba(255,255,255,0.9)";
  c.textAlign = "center";
  c.fillText(pillText, CARD_W / 2, pillY + 28);

  fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
  return outPath;
}

// ── Config storage (ctx.settings.global) ────────────────────────────────────

/** @param {PluginContext | SetupContext} ctx */
function loadConfigs(ctx) {
  return ctx.settings.global.get(SETTINGS_KEY, []);
}

/**
 * @param {PluginContext | SetupContext} ctx
 * @param {object[]} configs
 */
function saveConfigs(ctx, configs) {
  ctx.settings.global.set(SETTINGS_KEY, configs);
}

/** Usado no evento de entrada: casa só pelo grupo vigiado. */
function findConfig(configs, watchGroupId) {
  return configs.find((c) => c.watchGroupId === watchGroupId) ?? null;
}

/** Usado pelos comandos (status/set/reset): casa pelo grupo vigiado OU pelo grupo onde a config foi iniciada. */
function findConfigForChat(configs, chatId) {
  return configs.find((c) => c.watchGroupId === chatId || c.configChatId === chatId) ?? null;
}

// ── Wizard de configuração (!welcome config) ────────────────────────────────
// Uma sessão em memória por adminId — cada admin configura o seu próprio
// grupo de forma independente e concorrente. Só o admin que iniciou uma
// sessão consegue avançá-la (lookup é sempre por ctx.msg.sender). Sessão
// expira sozinha após SESSION_TIMEOUT_MS sem mensagem válida do admin.
// Fica em memória (não em ctx.storage) de propósito: é estado descartável de
// curta duração (no máx. SESSION_TIMEOUT_MS) — se o bot reiniciar no meio de
// um wizard, o pior caso é o admin ter que rodar "!welcome config" de novo.

const sessions = new Map(); // adminId -> session
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Variáveis dinâmicas que alguns prompts precisam (listas de tema/moldura,
 * mensagem padrão) — o resto do texto vem pronto do locale.
 * @param {(key: string, vars?: object) => string} t
 */
function promptVars(t, step) {
  switch (step) {
    case "cardBackground":
      return { themes: Object.keys(THEME_PRESETS).join(", ") };
    case "cardFrame":
      return { frames: FRAME_STYLES.filter((f) => f !== DEFAULT_FRAME).join(", ") };
    case "cardFont":
      return { fonts: Object.keys(FONT_STACKS).filter((f) => f !== DEFAULT_FONT).join(", ") };
    case "cardMessage":
      return { defaultMessage: t("defaults.cardMessage") };
    case "dmMessage":
      return { defaultMessage: t("defaults.dmMessage") };
    default:
      return {};
  }
}

function startConfirmConfigSession(adminId, watchGroupId) {
  const session = { adminId, anchorChatId: watchGroupId, mode: "confirmConfig", watchGroupId, timeoutHandle: null };
  sessions.set(adminId, session);
  return session;
}

function endSession(adminId) {
  const session = sessions.get(adminId);
  if (session?.timeoutHandle) clearTimeout(session.timeoutHandle);
  sessions.delete(adminId);
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 */
function armTimeout(ctx, session) {
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  session.timeoutHandle = setTimeout(async () => {
    sessions.delete(session.adminId);
    const { t: rawT } = ctx.i18n.createT(import.meta.url);
    const t = withPrefix(ctx, rawT);
    await ctx.send.to(session.anchorChatId).text(t("wizard.timeout"));
  }, SESSION_TIMEOUT_MS);
}

/**
 * Cria a config com tudo no padrão: sem PV, mensagem padrão, enviada no próprio
 * grupo monitorado; card (tema/moldura/fonte default) só se `useCard`.
 * @param {string} watchGroupId
 * @param {string} groupName
 * @param {boolean} useCard
 */
function buildDefaultConfig(watchGroupId, groupName, useCard) {
  return {
    watchGroupId,
    configChatId: watchGroupId,
    useCard,
    cardTargetId: watchGroupId,
    groupName,
    cardBackground: null,
    cardFrame: DEFAULT_FRAME,
    cardMessage: null,
    smallWelcomeGroupIds: [],
    smallWelcomeMessage: null,
    dmMessage: null,
  };
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 */
async function handleConfirmConfigMessage(ctx, session) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  if (ctx.chat.id !== session.anchorChatId) return;

  if (!WORDS_CONFIRM.includes(normWord(ctx.msg.body))) {
    endSession(session.adminId);
    await ctx.msg.reply.text(t("wizard.cancelled"));
    return;
  }

  session.mode = "chooseCard";
  armTimeout(ctx, session);
  await ctx.msg.reply.text(t("wizard.chooseCard"));
}

/**
 * Qualquer resposta que não seja "sim" vale como "não" — o texto do passo já
 * avisa isso, então o admin não precisa pensar em palavras exatas.
 * @param {PluginContext} ctx
 * @param {object} session
 */
async function handleChooseCardMessage(ctx, session) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  if (ctx.chat.id !== session.anchorChatId) return;

  const useCard = WORDS_CONFIRM.includes(normWord(ctx.msg.body));
  endSession(session.adminId);

  const configs = loadConfigs(ctx);
  const groupName = await resolveGroupName(ctx, session.watchGroupId);
  const finalConfig = { ...buildDefaultConfig(session.watchGroupId, groupName, useCard), knownGroupName: groupName };
  if (groupName) knownGroupNames.set(session.watchGroupId, groupName);
  const idx = configs.findIndex((c) => c.watchGroupId === finalConfig.watchGroupId);
  if (idx >= 0) configs[idx] = finalConfig; else configs.push(finalConfig);
  saveConfigs(ctx, configs);

  await ctx.msg.reply.text(t(useCard ? "wizard.savedCard" : "wizard.savedSimple"));
}

// ── Status / set / reset helpers ─────────────────────────────────────────────

/**
 * Dicas anexadas à confirmação de "set": editar "simples" sem nenhum grupo em
 * "simplesgrupo", ou editar um campo visual do card com o card desligado —
 * em ambos os casos a edição não teria efeito visível.
 * @param {(key: string, vars?: object) => string} t
 * @param {string} field
 * @param {object} config
 */
function setHints(t, field, config) {
  if (field === "simples" && config.smallWelcomeGroupIds.length === 0) return `\n\n${t("set.suggestSimplesGrupo")}`;
  if (CARD_ONLY_FIELDS.includes(field) && config.useCard === false) return `\n\n${t("set.cardOffNote")}`;
  return "";
}

/** Nomes de grupo aprendidos pelos eventos do driver — o contexto de setup não tem ctx.chat nem ctx.wa. */
const knownGroupNames = new Map();

/**
 * @param {PluginContext | SetupContext} ctx
 * @param {string} id
 */
function liveGroupName(ctx, id) {
  return knownGroupNames.get(id) ?? sanitizeGroupName(ctx.chats.all().find((c) => c.id === id)?.name);
}

/**
 * @param {PluginContext | SetupContext} ctx
 * @param {string} id
 */
function chatLabel(ctx, id) {
  return liveGroupName(ctx, id) ?? id;
}

/**
 * Guarda o nome do grupo no cache e na config (knownGroupName), pra o evento
 * de entrada — que só roda em setup — nunca cair no JID cru.
 * @param {PluginContext | SetupContext} ctx
 * @param {string} id
 * @param {string | undefined} name
 */
function syncGroupName(ctx, id, name) {
  const clean = sanitizeGroupName(name);
  if (!clean || !id?.endsWith("@g.us")) return;
  knownGroupNames.set(id, clean);
  const configs = loadConfigs(ctx);
  const config = findConfig(configs, id);
  if (config && config.knownGroupName !== clean) {
    config.knownGroupName = clean;
    saveConfigs(ctx, configs);
  }
}

/**
 * Resolve o nome atual de um grupo no contexto de runtime: chat atual →
 * metadata do driver → cache.
 * @param {PluginContext} ctx
 * @param {string} id
 * @returns {Promise<string | null>}
 */
async function resolveGroupName(ctx, id) {
  const fromChat = id === ctx.chat.id ? sanitizeGroupName(ctx.chat.name) : null;
  const fromMeta = fromChat ?? (await ctx.wa?.contract.groupMetadata(id).then((m) => sanitizeGroupName(m.subject)).catch(() => null));
  return fromMeta ?? liveGroupName(ctx, id) ?? null;
}

/**
 * Atualiza o nome guardado do grupo monitorado (runtime).
 * @param {PluginContext} ctx
 * @param {object} config
 */
async function refreshGroupName(ctx, config) {
  const name = await resolveGroupName(ctx, config.watchGroupId);
  if (name) syncGroupName(ctx, config.watchGroupId, name);
}

/**
 * Nome customizado (nomegrupo) → nome atual do grupo → último nome conhecido
 * salvo na config → JID (último recurso).
 * @param {PluginContext | SetupContext} ctx
 * @param {object} config
 */
function getGroupName(ctx, config) {
  return sanitizeGroupName(config.groupName) ?? watchGroupLabel(ctx, config);
}

/**
 * @param {PluginContext | SetupContext} ctx
 * @param {object} config
 */
function watchGroupLabel(ctx, config) {
  return liveGroupName(ctx, config.watchGroupId) ?? config.knownGroupName ?? config.watchGroupId;
}

/**
 * Resumo curto (1-2 linhas) do estado atual — não repete a explicação de
 * cada campo, só diz o que já foi decidido pra esse grupo.
 * @param {PluginContext} ctx
 * @param {object} config
 */
function formatStatus(ctx, config) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  const useCard = config.useCard !== false;

  const summary = t(useCard ? "status.summaryCardOn" : "status.summaryCardOff", { target: chatLabel(ctx, config.cardTargetId) });
  const dm = config.dmMessage ? t("status.enabled") : t("status.disabled");

  return [
    t("status.header", { watchGroup: watchGroupLabel(ctx, config) }),
    t("status.summaryLine", { summary, dm }),
    t("status.fieldsList", { fields: SET_FIELDS.map((f) => `\`${f}\`\n↳ ${t(`status.fieldDesc.${f}`)}`).join("\n") }),
    t("status.example"),
  ].join("\n\n");
}

/** @param {PluginContext} ctx */
async function handleStatusCommand(ctx) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("status.needGroup"));
    return;
  }
  const configs = loadConfigs(ctx);
  const config = findConfigForChat(configs, ctx.chat.id);
  if (!config) {
    await ctx.msg.reply.text(t("status.notConfigured"));
    return;
  }
  await refreshGroupName(ctx, config);
  await ctx.msg.reply.text(formatStatus(ctx, config));
}

/** @param {PluginContext} ctx */
async function handleResetCommand(ctx) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("reset.needGroup"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  const configs = loadConfigs(ctx);
  const config = findConfigForChat(configs, ctx.chat.id);
  if (!config) {
    await ctx.msg.reply.text(t("reset.nothing"));
    return;
  }

  if (!WORDS_CONFIRM.includes(normWord(ctx.msg.args[1] ?? ""))) {
    await ctx.msg.reply.text(t("reset.confirmNeeded"));
    return;
  }

  saveConfigs(ctx, configs.filter((c) => c.watchGroupId !== config.watchGroupId));
  await ctx.msg.reply.text(t("reset.done"));
}

/** Passo do wizard que corresponde a cada campo de "!welcome set", pra reusar o mesmo texto de prompt. */
const FIELD_TO_STEP = {
  grupo: "watchGroup",
  destino: "cardTarget",
  card: "useCard",
  fundo: "cardBackground",
  moldura: "cardFrame",
  fonte: "cardFont",
  avatar: "cardAvatar",
  nomegrupo: "groupName",
  mensagem: "cardMessage",
  simples: "smallWelcomeMessage",
  pv: "dmMessage",
  simplesgrupo: "smallWelcomeGroups",
};

/**
 * @param {(key: string, vars?: object) => string} t
 * @param {string} field
 */
function quickEditPrompt(t, field) {
  const step = FIELD_TO_STEP[field];
  return t("quickEdit.title", { field, prompt: t(`prompts.${step}.body`, promptVars(t, step)) });
}

/**
 * @param {string} adminId
 * @param {string} anchorChatId
 * @param {string} field
 * @param {string} watchGroupId
 */
function startQuickEditSession(adminId, anchorChatId, field, watchGroupId) {
  const session = { adminId, anchorChatId, mode: "quickEdit", field, watchGroupId, timeoutHandle: null };
  sessions.set(adminId, session);
  return session;
}

/**
 * Aplica um valor de texto a um campo de config. Usada tanto por
 * "!welcome set <campo> <valor>" quanto pela resposta do modo guiado.
 * Em caso de valor inválido, chama `reply` com o motivo e retorna false —
 * quem chama não deve salvar nem avançar nesse caso.
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {string} field
 * @param {string} value
 * @param {(text: string) => Promise<unknown>} reply
 * @returns {Promise<boolean>}
 */
async function applySetField(ctx, config, field, value, reply) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  switch (field) {
    case "fundo": {
      if (ctx.msg.hasMedia && ctx.msg.type === "image") {
        const media = await ctx.msg.downloadMedia();
        if (!media) {
          await reply(t("applySet.imageDownloadFail"));
          return false;
        }
        const bgPath = ctx.storage.resolve(`bg_${groupFileSuffix(config.watchGroupId)}.jpg`);
        fs.writeFileSync(bgPath, Buffer.from(media.data, "base64"));
        config.cardBackground = { type: "image", value: bgPath, overlay: DEFAULT_IMAGE_OVERLAY };
        return true;
      }
      const escurecerMatch = value.match(/^(?:escurecer|escuro)\s+(\d{1,3})$/i);
      if (escurecerMatch) {
        if (config.cardBackground?.type !== "image") {
          await reply(t("applySet.darkenOnlyImage"));
          return false;
        }
        const pct = Math.min(100, Math.max(0, parseInt(escurecerMatch[1], 10)));
        config.cardBackground = { ...config.cardBackground, overlay: pct / 100 };
        return true;
      }
      const parsed = parseBackgroundText(value);
      if (!parsed) {
        await reply(t("applySet.backgroundInvalid", { themes: Object.keys(THEME_PRESETS).join(", ") }));
        return false;
      }
      config.cardBackground = parsed;
      return true;
    }
    case "moldura": {
      const chosen = WORDS_DEFAULT.includes(normWord(value)) ? DEFAULT_FRAME : normWord(value);
      if (!FRAME_STYLES.includes(chosen)) {
        await reply(t("applySet.frameInvalid", { frames: FRAME_STYLES.join(", ") }));
        return false;
      }
      config.cardFrame = chosen;
      return true;
    }
    case "fonte": {
      const chosen = WORDS_DEFAULT.includes(normWord(value)) ? DEFAULT_FONT : normWord(value);
      if (!FONT_STACKS[chosen]) {
        await reply(t("applySet.fontInvalid", { fonts: Object.keys(FONT_STACKS).join(", ") }));
        return false;
      }
      config.cardFont = chosen;
      return true;
    }
    case "avatar": {
      const word = normWord(value);
      if (WORDS_DEFAULT.includes(word) || WORDS_NONE.includes(word)) {
        config.avatarFallbackPath = null;
        return true;
      }
      if (!(ctx.msg.hasMedia && ctx.msg.type === "image")) {
        await reply(t("applySet.avatarNeedsImage"));
        return false;
      }
      const media = await ctx.msg.downloadMedia();
      if (!media) {
        await reply(t("applySet.imageDownloadFail"));
        return false;
      }
      const avatarFallbackPath = ctx.storage.resolve(`avatarfallback_${groupFileSuffix(config.watchGroupId)}.jpg`);
      fs.writeFileSync(avatarFallbackPath, Buffer.from(media.data, "base64"));
      config.avatarFallbackPath = avatarFallbackPath;
      return true;
    }
    case "nomegrupo": {
      const trimmed = value.trim();
      config.groupName = WORDS_DEFAULT.includes(normWord(value)) || trimmed.length < MIN_NAME_LENGTH ? null : trimmed;
      return true;
    }
    case "mensagem": {
      config.cardMessage = WORDS_DEFAULT.includes(normWord(value)) ? null : value;
      return true;
    }
    case "pv": {
      const word = normWord(value);
      config.dmMessage = WORDS_NONE.includes(word) ? null : WORDS_DEFAULT.includes(word) ? t("defaults.dmMessage") : value;
      return true;
    }
    case "simples": {
      const word = normWord(value);
      config.smallWelcomeMessage = WORDS_DEFAULT.includes(word) || WORDS_NONE.includes(word) ? null : value;
      return true;
    }
    case "grupo": {
      await reply(t("applySet.groupNeedsGroup"));
      return false;
    }
    case "destino": {
      if (WORDS_DEFAULT.includes(normWord(value))) {
        config.cardTargetId = config.watchGroupId;
        return true;
      }
      await reply(t("applySet.targetNeedsGroup"));
      return false;
    }
    case "simplesgrupo": {
      const word = normWord(value);
      if (WORDS_DONE.includes(word)) return true;
      if (WORDS_NONE.includes(word)) {
        config.smallWelcomeGroupIds = [];
        return true;
      }
      await reply(t("applySet.simplesGroupNeedsGroup"));
      return false;
    }
    case "card": {
      const word = normWord(value);
      if (WORDS_CONFIRM.includes(word)) {
        config.useCard = true;
        return true;
      }
      if (WORDS_NONE.includes(word)) {
        config.useCard = false;
        return true;
      }
      await reply(t("applySet.cardInvalid"));
      return false;
    }
  }
  return false;
}

/**
 * Troca o grupo monitorado de uma config existente pra `newGroupId`, mantendo
 * o resto das configurações. Move os arquivos de fundo/avatar (nomeados a
 * partir do watchGroupId antigo) e segue o cardTargetId se ele só estava
 * apontando pro padrão (== watchGroupId antigo).
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {object[]} configs
 * @param {string} newGroupId
 * @param {(text: string) => Promise<unknown>} reply
 * @param {(key: string, vars?: object) => string} t
 * @returns {Promise<boolean>}
 */
async function applyGroupChange(ctx, config, configs, newGroupId, reply, t) {
  if (newGroupId === config.watchGroupId) {
    await reply(t("applySet.groupSame"));
    return false;
  }
  if (findConfig(configs, newGroupId)) {
    await reply(t("applySet.groupTaken", { target: chatLabel(ctx, newGroupId) }));
    return false;
  }

  const oldSuffix = groupFileSuffix(config.watchGroupId);
  const newSuffix = groupFileSuffix(newGroupId);

  if (config.cardBackground?.type === "image" && config.cardBackground.value.includes(`bg_${oldSuffix}`)) {
    const newPath = ctx.storage.resolve(`bg_${newSuffix}.jpg`);
    if (fs.existsSync(config.cardBackground.value)) fs.renameSync(config.cardBackground.value, newPath);
    config.cardBackground = { ...config.cardBackground, value: newPath };
  }
  if (config.avatarFallbackPath?.includes(`avatarfallback_${oldSuffix}`)) {
    const newPath = ctx.storage.resolve(`avatarfallback_${newSuffix}.jpg`);
    if (fs.existsSync(config.avatarFallbackPath)) fs.renameSync(config.avatarFallbackPath, newPath);
    config.avatarFallbackPath = newPath;
  }

  if (config.cardTargetId === config.watchGroupId) config.cardTargetId = newGroupId;
  config.watchGroupId = newGroupId;
  return true;
}

/**
 * @param {PluginContext} ctx
 */
function extractSetValue(ctx) {
  return (ctx.msg.body ?? "").replace(/^\S+\s+set\s+\S+\s*/i, "").trim();
}

/** @param {PluginContext} ctx */
async function handleSetCommand(ctx) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("set.needGroup"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  const configs = loadConfigs(ctx);
  const idx = configs.findIndex((c) => c.watchGroupId === ctx.chat.id || c.configChatId === ctx.chat.id);
  if (idx < 0) {
    await ctx.msg.reply.text(t("set.notConfigured"));
    return;
  }

  const typedField = normWord(ctx.msg.args[1] ?? "");
  const field = FIELD_ALIASES[typedField] ?? typedField;
  if (!SET_FIELDS.includes(field)) {
    await ctx.msg.reply.text(t("set.invalidField", { fields: SET_FIELDS.join(", ") }));
    return;
  }

  const value = extractSetValue(ctx);
  const hasImage = ctx.msg.hasMedia && ctx.msg.type === "image";
  const config = configs[idx];

  if (!value && !hasImage) {
    const senderId = ctx.msg.sender;
    if (sessions.has(senderId)) {
      await ctx.msg.reply.text(t("wizard.alreadyInProgress"));
      return;
    }
    const session = startQuickEditSession(senderId, ctx.chat.id, field, config.watchGroupId);
    armTimeout(ctx, session);
    await ctx.send.to(session.anchorChatId).text(quickEditPrompt(t, field));
    return;
  }

  const ok = await applySetField(ctx, config, field, value, (text) => ctx.msg.reply.text(text));
  if (!ok) return;

  saveConfigs(ctx, configs);
  await ctx.msg.reply.text(
    t("set.updated", { status: formatStatus(ctx, config) }) + setHints(t, field, config)
  );
}

/**
 * @param {PluginContext} ctx
 * @param {object} session
 */
async function handleQuickEditMessage(ctx, session) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  const word = normWord(ctx.msg.body);
  const inAnchor = ctx.chat.id === session.anchorChatId;

  if (WORDS_CANCEL.includes(word) && inAnchor) {
    endSession(session.adminId);
    await ctx.send.to(ctx.chat.id).text(t("wizard.editCancelled"));
    return;
  }

  armTimeout(ctx, session);

  const configs = loadConfigs(ctx);
  const config = configs.find((c) => c.watchGroupId === session.watchGroupId);
  if (!config) {
    endSession(session.adminId);
    await ctx.send.to(session.anchorChatId).text(t("quickEdit.configGone"));
    return;
  }

  const reply = (text) => ctx.send.to(session.anchorChatId).text(text);

  if (session.field === "grupo") {
    if (!(ctx.chat.isGroup && !inAnchor)) return;
    const ok = await applyGroupChange(ctx, config, configs, ctx.chat.id, reply, t);
    if (!ok) return;
  } else if (session.field === "destino") {
    if (ctx.chat.isGroup && !inAnchor) {
      config.cardTargetId = ctx.chat.id;
    } else if (inAnchor) {
      const ok = await applySetField(ctx, config, "destino", ctx.msg.body ?? "", reply);
      if (!ok) return;
    } else {
      return;
    }
  } else if (session.field === "simplesgrupo") {
    if (ctx.chat.isGroup && !inAnchor) {
      if (config.smallWelcomeGroupIds.includes(ctx.chat.id)) {
        config.smallWelcomeGroupIds = config.smallWelcomeGroupIds.filter((id) => id !== ctx.chat.id);
        await reply(t("wizard.smallWelcomeRemoved", { name: ctx.chat.name }));
      } else {
        config.smallWelcomeGroupIds.push(ctx.chat.id);
        await reply(t("wizard.smallWelcomeAdded", { name: ctx.chat.name }));
      }
      saveConfigs(ctx, configs);
      return;
    }
    if (!inAnchor) return;
    const ok = await applySetField(ctx, config, "simplesgrupo", ctx.msg.body ?? "", reply);
    if (!ok) return;
  } else {
    if (!inAnchor) return;
    const ok = await applySetField(ctx, config, session.field, ctx.msg.body ?? "", reply);
    if (!ok) return;
  }

  saveConfigs(ctx, configs);
  endSession(session.adminId);
  await reply(
    t("set.updated", { status: formatStatus(ctx, config) }) + setHints(t, session.field, config)
  );
}

/** @param {SetupContext} ctx */
/**
 * Monta o card + textos de boas-vindas pra um "membro" (real, num evento de
 * entrada, ou simulado, no "!welcome test"). Não envia nada — só gera os
 * artefatos; quem chama decide os destinos. Sempre retorna `cleanup()` pra
 * apagar os arquivos temporários depois de enviar.
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {string} userId
 * @param {object|null} contact
 * @param {(key: string, vars?: object) => string} t
 * @param {string} [idSuffix] sufixo pro nome dos arquivos temporários — evita colidir com um evento real rodando em paralelo
 */
async function renderMemberCard(ctx, config, userId, contact, t, idSuffix = "") {
  const userMention = `@${userId.replace(/(:\d+)?@.*$/, "")}`;
  const name = resolveDisplayName(contact?.pushname ?? contact?.name, t("defaults.fallbackName"));
  const groupName = getGroupName(ctx, config);
  const templateVars = { nome: userMention, grupo: groupName, pushname: name };

  const defaultCardMessage = t("defaults.cardMessage");
  const caption = fillTemplate(config.cardMessage ?? defaultCardMessage, templateVars);
  const smallCaption = fillTemplate(config.smallWelcomeMessage ?? config.cardMessage ?? defaultCardMessage, templateVars);

  const safeId = userId.replace(/[^a-z0-9]/gi, "") + idSuffix;
  const useCard = config.useCard !== false;

  let realAvatarPath = null;
  let gotRealAvatar = false;
  let cardPath = null;
  let cardOk = false;

  if (useCard) {
    realAvatarPath = ctx.storage.resolve(`tmp_avatar_${safeId}.jpg`);
    gotRealAvatar = await ctx.contacts.getPfpPath(userId, realAvatarPath).catch((err) => {
      ctx.log.warn(`welcome: getPfpPath falhou — ${err.message}`);
      return null;
    });

    cardPath = ctx.storage.resolve(`tmp_card_${safeId}.png`);
    try {
      await buildCard({
        welcomeTitle: t("defaults.cardWelcomeTitle"),
        subtitle: t("defaults.cardSubtitle", { group: groupName }),
        avatarPath: resolveAvatarSource(config, realAvatarPath, gotRealAvatar),
        outPath: cardPath,
        background: config.cardBackground ?? { type: "theme", value: DEFAULT_THEME },
        frame: config.cardFrame ?? DEFAULT_FRAME,
        fontFamily: FONT_STACKS[config.cardFont] ?? FONT_STACKS[DEFAULT_FONT],
        headerLabel: t("defaults.cardHeader"),
      });
      cardOk = true;
    } catch (err) {
      ctx.log.warn(`welcome: falha ao gerar card — ${err.message}`);
    }
  }

  const cleanup = () => {
    if (cardPath) fs.rmSync(cardPath, { force: true });
    if (gotRealAvatar && realAvatarPath) fs.rmSync(realAvatarPath, { force: true });
  };

  return { name, groupName, templateVars, caption, smallCaption, cardPath: cardOk ? cardPath : null, cleanup };
}

export async function setup(ctx) {
  ctx.events.on("groups.upsert", ({ groups }) => groups.forEach((g) => syncGroupName(ctx, g.id, g.subject)));
  ctx.events.on("chats.upsert", ({ chats }) => chats.forEach((c) => syncGroupName(ctx, c.id, c.name)));
  ctx.events.on("chats.update", ({ updates }) => updates.forEach((u) => syncGroupName(ctx, u.id, u.name)));

  ctx.events.on("group-participants.update", async (update) => {
    ctx.log.info(`welcome: evento recebido — ${JSON.stringify(update)}`);

    if (update.action !== "add") {
      ctx.log.info(`welcome: ignorado, action="${update.action}" (esperado "add")`);
      return;
    }

    const groupId = update.id;
    const configs = loadConfigs(ctx);
    const config = findConfig(configs, groupId);
    if (!config) {
      const prefix = ctx.config.get("CMD_PREFIX");
      ctx.log.info(`welcome: grupo "${groupId}" não configurado, ignorando (rode "${prefix}welcome config" nesse grupo pra ativar)`);
      return;
    }

    const { t: rawT } = ctx.i18n.createT(import.meta.url);
    const t = withPrefix(ctx, rawT);
    const target = config.cardTargetId ?? groupId;
    const participants = update.participants ?? [];
    if (participants.length === 0) {
      ctx.log.info("welcome: participants vazio, abortando");
      return;
    }

    for (const userId of participants) {
      ctx.log.info(`welcome: processando userId="${userId}"`);

      const contact = await ctx.contacts.get(userId).catch((err) => {
        ctx.log.warn(`welcome: ctx.contacts.get falhou para "${userId}" — ${err.message}`);
        return null;
      });

      const adminApi = ctx.plugins.require("synt-xerror/admin");
      if (await adminApi.isAutobanTarget(groupId, contact)) {
        ctx.log.info(`welcome: userId="${userId}" bate com autoban do admin, pulando boas-vindas`);
        continue;
      }

      const assets = await renderMemberCard(ctx, config, userId, contact, t);

      try {
        if (assets.cardPath) {
          await ctx.send.to(target).image(assets.cardPath, assets.caption, { mentions: [userId] });
          ctx.log.info("welcome: card enviado com sucesso");
        } else {
          await ctx.send.to(target).text(assets.caption, { mentions: [userId] });
        }
      } finally {
        assets.cleanup();
      }

      if (config.dmMessage) {
        try {
          await ctx.send.to(userId).text(fillTemplate(config.dmMessage, assets.templateVars), { mentions: [userId] });
        } catch (err) {
          ctx.log.warn(`welcome: falha ao mandar PV de boas-vindas para "${userId}" — ${err.message}`);
        }
      }

      for (const smallTarget of config.smallWelcomeGroupIds) {
        if (smallTarget === target) continue;
        try {
          await ctx.send.to(smallTarget).text(assets.smallCaption, { mentions: [userId] });
        } catch (err) {
          ctx.log.warn(`welcome: falha ao mandar boas-vindas simples em "${smallTarget}" — ${err.message}`);
        }
      }
    }
  });
}

/**
 * Prévia SEM efeitos colaterais: tudo é enviado só no chat atual, nada vai
 * pros grupos configurados de verdade, ninguém é adicionado em lugar nenhum.
 * Usa os próprios dados de contato de quem rodou o comando como "novo membro".
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {object} assets retorno de renderMemberCard
 * @param {(key: string, vars?: object) => string} t
 * @param {string} userId
 */
async function runPreviewTest(ctx, config, assets, t, userId) {
  const target = config.cardTargetId ?? config.watchGroupId;

  await ctx.msg.reply.text(t("test.previewHeader"));

  const cardLabel = t(assets.cardPath ? "test.previewCardLabel" : "test.previewMessageLabel", { target: chatLabel(ctx, target) });
  const cardCaption = `${cardLabel}\n\n${assets.caption}\n\n${t("test.fieldHint", { field: "mensagem" })}`;
  if (assets.cardPath) {
    await ctx.send.to(ctx.chat.id).image(assets.cardPath, cardCaption, { mentions: [userId] });
  } else {
    await ctx.send.to(ctx.chat.id).text(cardCaption, { mentions: [userId] });
  }

  if (config.smallWelcomeGroupIds.length) {
    const names = config.smallWelcomeGroupIds.map((id) => chatLabel(ctx, id)).join(", ");
    await ctx.send.to(ctx.chat.id).text(`${t("test.previewSmallLabel", { target: names })}\n\n${assets.smallCaption}\n\n${t("test.fieldHint", { field: "simples" })}`, { mentions: [userId] });
  } else {
    await ctx.send.to(ctx.chat.id).text(t("test.previewNoSmall"));
  }

  if (config.dmMessage) {
    await ctx.send.to(ctx.chat.id).text(`${t("test.previewDmLabel")}\n\n${fillTemplate(config.dmMessage, assets.templateVars)}\n\n${t("test.fieldHint", { field: "pv" })}`, { mentions: [userId] });
  } else {
    await ctx.send.to(ctx.chat.id).text(t("test.previewNoDm"));
  }

  await ctx.send.to(ctx.chat.id).text(t("test.previewFooter"));
}

/**
 * Teste REAL: roda o mesmo pipeline do evento de entrada de verdade — envia
 * pros grupos configurados e manda PV — mas usando os dados de quem rodou
 * o comando como "novo membro", e com cada mensagem marcada como teste
 * (pra quem estiver no grupo não achar que alguém entrou de fato).
 *
 * @param {PluginContext} ctx
 * @param {object} config
 * @param {string} userId
 * @param {object|null} contact
 * @param {object} assets retorno de renderMemberCard
 * @param {(key: string, vars?: object) => string} t
 */
async function runRealTest(ctx, config, userId, contact, assets, t) {
  const target = config.cardTargetId ?? config.watchGroupId;
  const prefix = t("test.realCaptionPrefix");

  await ctx.msg.reply.text(t("test.realHeader"));

  try {
    if (assets.cardPath) {
      await ctx.send.to(target).image(assets.cardPath, prefix + assets.caption, { mentions: [userId] });
    } else {
      await ctx.send.to(target).text(prefix + assets.caption, { mentions: [userId] });
    }
  } catch (err) {
    ctx.log.warn(`welcome: teste real falhou ao enviar card — ${err.message}`);
  }

  if (config.dmMessage) {
    try {
      await ctx.send.to(userId).text(prefix + fillTemplate(config.dmMessage, assets.templateVars), { mentions: [userId] });
    } catch (err) {
      ctx.log.warn(`welcome: teste real falhou ao enviar PV — ${err.message}`);
    }
  }

  for (const smallTarget of config.smallWelcomeGroupIds) {
    if (smallTarget === target) continue;
    try {
      await ctx.send.to(smallTarget).text(prefix + assets.smallCaption, { mentions: [userId] });
    } catch (err) {
      ctx.log.warn(`welcome: teste real falhou ao enviar boas-vindas simples — ${err.message}`);
    }
  }

  await ctx.msg.reply.text(t("test.realDone"));
}

/**
 * "!welcome test" (prévia, só no chat atual) ou "!welcome test grupo"
 * (roda de verdade nos grupos configurados, marcado como teste).
 *
 * @param {PluginContext} ctx
 * @param {"preview" | "real"} mode
 */
async function handleTestCommand(ctx, mode) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  const configs = loadConfigs(ctx);
  const config = findConfigForChat(configs, ctx.chat.id);
  if (!config) {
    await ctx.msg.reply.text(t("test.notConfigured"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  await refreshGroupName(ctx, config);
  const userId = ctx.msg.sender;
  const contact = await ctx.contacts.get(userId).catch(() => null);
  const assets = await renderMemberCard(ctx, config, userId, contact, t, `_test${Date.now()}`);

  try {
    if (mode === "real") {
      await runRealTest(ctx, config, userId, contact, assets, t);
    } else {
      await runPreviewTest(ctx, config, assets, t, userId);
    }
  } finally {
    assets.cleanup();
  }
}

/**
 * @param {PluginContext} ctx
 * @param {string} senderId
 * @param {object|undefined} existing
 */
async function handleConfigCommand(ctx, senderId, existing) {
  const { t: rawT } = ctx.i18n.createT(import.meta.url);
  const t = withPrefix(ctx, rawT);
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("wizard.startConfigNeedGroup"));
    return;
  }
  if (!(await ctx.chat.isSenderAdmin())) return;

  if (existing) {
    await ctx.send.to(existing.anchorChatId).text(t("wizard.alreadyInProgress"));
    return;
  }

  const configs = loadConfigs(ctx);
  if (findConfigForChat(configs, ctx.chat.id)) {
    await ctx.msg.reply.text(t("wizard.alreadyConfigured"));
    return;
  }

  const session = startConfirmConfigSession(senderId, ctx.chat.id);
  armTimeout(ctx, session);
  await ctx.msg.reply.text(t("wizard.confirmConfig"));
}

/** @param {PluginContext} ctx */
export default async function (ctx) {
  if (ctx.msg.fromMe) return;

  const senderId = ctx.msg.sender;
  const existing = sessions.get(senderId);

  if (ctx.msg.is(COMMAND_NAME)) {
    const sub = (ctx.msg.args[0] ?? "").toLowerCase();
    switch (sub) {
      case "config":
        await handleConfigCommand(ctx, senderId, existing);
        return;
      case "status":
        await handleStatusCommand(ctx);
        return;
      case "reset":
        await handleResetCommand(ctx);
        return;
      case "set":
        await handleSetCommand(ctx);
        return;
      case "test": {
        const mode = (ctx.msg.args[1] ?? "").toLowerCase() === "grupo" ? "real" : "preview";
        await handleTestCommand(ctx, mode);
        return;
      }
      default: {
        const { t: rawT } = ctx.i18n.createT(import.meta.url);
        const t = withPrefix(ctx, rawT);
        if (!ctx.chat.isGroup) {
          await ctx.msg.reply.text(t("help.needGroup"));
          return;
        }
        await ctx.msg.reply.text(t("help.text"));
        return;
      }
    }
  }

  if (!existing) return;
  if (existing.mode === "quickEdit") {
    await handleQuickEditMessage(ctx, existing);
  } else if (existing.mode === "confirmConfig") {
    await handleConfirmConfigMessage(ctx, existing);
  } else if (existing.mode === "chooseCard") {
    await handleChooseCardMessage(ctx, existing);
  }
}

