import { unlink } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Fonts (mesma cascata do plugin welcome, namespaced "Ship*" pra não ──
// colidir com as fontes "Welcome*" registradas no mesmo processo). Só
// registra o que existir em fonts/ — sem os arquivos, cai no sans-serif
// genérico do sistema e o plugin continua funcionando.
//
// ShipSerif e ShipMono ficam registradas pra uso futuro (presets de estilo),
// mas FONT_STACK abaixo só usa as famílias de cobertura de caractere
// (emoji, Bamum, Khitan, math) como fallback do pushname/score no canvas.
const FONT_DEFS = [
  { path: join(__dirname, "fonts", "DejaVuSans.ttf"), family: "ShipSans" },
  { path: join(__dirname, "fonts", "DejaVuSans-Bold.ttf"), family: "ShipSans" },
  { path: join(__dirname, "fonts", "LiberationSerif-Regular.ttf"), family: "ShipSerif" },
  { path: join(__dirname, "fonts", "LiberationSerif-Bold.ttf"), family: "ShipSerif" },
  { path: join(__dirname, "fonts", "DejaVuSansMono.ttf"), family: "ShipMono" },
  { path: join(__dirname, "fonts", "DejaVuSansMono-Bold.ttf"), family: "ShipMono" },
  { path: join(__dirname, "fonts", "NotoColorEmoji.ttf"), family: "ShipEmoji" },
  { path: join(__dirname, "fonts", "NotoSansBamum-Regular.ttf"), family: "ShipBamum" },
  { path: join(__dirname, "fonts", "NotoSerifKhitanSmallScript-Regular.ttf"), family: "ShipKhitan" },
  { path: join(__dirname, "fonts", "STIXTwoMath-Regular.ttf"), family: "ShipMath" },
  // Display font usada só no número do score (% grande) — Anton (Google
  // Fonts, OFL), condensada/black, legível em qualquer tamanho grande.
  { path: join(__dirname, "fonts", "Anton-Regular.ttf"), family: "ShipScore" },
];
for (const { path, family } of FONT_DEFS) {
  if (existsSync(path)) {
    const ok = GlobalFonts.registerFromPath(path, family);
    if (!ok) console.warn(`[ship] Falha ao registrar fonte: ${path}`);
  }
}
const FONT_STACK = `"ShipSans", "ShipEmoji", "ShipBamum", "ShipKhitan", "ShipMath", sans-serif`;
const SCORE_FONT_STACK = `"ShipScore", ${FONT_STACK}`;

const WIDTH = 900;
const HEIGHT = 560;
const AVATAR_RADIUS = 105;
const AVATAR_Y = 175;
const AVATAR_LEFT_X = 230;
const AVATAR_RIGHT_X = WIDTH - 230;
const NAME_MAX_WIDTH = AVATAR_RADIUS * 2.1;
const NAME_Y = AVATAR_Y + AVATAR_RADIUS + 45;
const SCORE_Y = 420;
const BAR_W = 480;
const BAR_H = 18;
const BAR_Y = HEIGHT - 70;

const COLOR_STOPS = [
  { at: 0, color: [21, 101, 192] },
  { at: 50, color: [142, 36, 170] },
  { at: 80, color: [229, 57, 53] },
  { at: 90, color: [255, 20, 147] },
  { at: 100, color: [255, 20, 147] },
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTION_TIER_MAX = [19, 39, 59, 79, 94, 99, 100];
const CAPTION_VARIANTS = 2;

export default async function (ctx) {
  if (ctx.msg.fromMe) return;
  if (!ctx.msg.is("ship")) return;

  const { t } = ctx.i18n.createT(import.meta.url);

  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("error.groupOnly"));
    return;
  }

  const jids = await resolveShipJids(ctx);
  if (!jids) {
    await ctx.msg.reply.text(t("error.mentions"));
    return;
  }

  let contacts;
  try {
    contacts = await Promise.all(jids.map((jid) => ctx.contacts.get(jid)));
  } catch (err) {
    ctx.log.warn(`ship: contact lookup failed - ${err.message}`);
    await ctx.msg.reply.text(t("error.mentions"));
    return;
  }

  if (contacts.some((c) => !c)) {
    await ctx.msg.reply.text(t("error.mentions"));
    return;
  }

  const names = contacts.map(
    (c) => c.pushname || c.name || c.numberPretty || "?"
  );

  // Sessão só pra evitar que um restart no meio do render/envio deixe
  // trabalho pela metade — fecha assim que a imagem é enviada (ou falha).
  ctx.session.acquire();
  try {
    // Shippar com o próprio bot é sempre 0% — não entra na persistência nem
    // no histórico, é sempre recalculado (ou melhor, nunca calculado).
    const isBotMention = jids.includes(ctx.botId);
    const score = isBotMention
      ? 0
      : resolveScore(ctx, jids[0], jids[1], names[0], names[1]);

    const avatarPaths = await fetchAvatars(ctx, jids);

    let imageBuffer;
    try {
      imageBuffer = await renderShipImage({ names, avatarPaths, score });
    } catch (err) {
      ctx.log.warn(`ship: render failed - ${err.message}`);
      await ctx.msg.reply.text(t("error.render"));
      return;
    } finally {
      await cleanupAvatars(avatarPaths);
    }

    const caption = buildCaption(t, score, contacts[0], contacts[1], isBotMention);
    const mentions = [...contacts[0].mention.mentions, ...contacts[1].mention.mentions];
    await ctx.msg.reply.image(imageBuffer, caption, { mentions });
  } finally {
    ctx.session.release();
  }
}

// ── Resolução dos dois alvos ──────────────────────────────────────────────
//
// Formas aceitas:
// - !ship @membro1 @membro2            (duas menções)
// - respondendo msg de membro1 + !ship @membro2   (reply + uma menção)

async function resolveShipJids(ctx) {
  const mentioned = ctx.msg.hasMention ? ctx.msg.mentionedJid : [];

  if (mentioned.length === 2) return mentioned;

  if (mentioned.length === 1) {
    const replied = await ctx.msg.getReply();
    if (replied?.sender && replied.sender !== mentioned[0]) {
      return [replied.sender, mentioned[0]];
    }
  }

  return null;
}

// ── Legenda com @menção e frase divertida por faixa de score ────────────────

function tierForScore(score) {
  for (let i = 0; i < CAPTION_TIER_MAX.length; i++) {
    if (score <= CAPTION_TIER_MAX[i]) return i;
  }
  return CAPTION_TIER_MAX.length - 1;
}

function buildCaption(t, score, contactA, contactB, isBotMention) {
  const variant = Math.floor(Math.random() * CAPTION_VARIANTS);
  const key = isBotMention
    ? `caption.bot.${variant}`
    : `caption.tier${tierForScore(score)}.${variant}`;
  return t(key, {
    name1: contactA.mention.text,
    name2: contactB.mention.text,
    score,
  });
}

// ── Persistência (ctx.settings.global) ───────────────────────────────────
//
// Par (A, B) com qualquer ordem de menção resolve pra mesma chave, guardada
// por até 7 dias — dentro desse prazo o mesmo score é reaproveitado, depois
// é recalculado. Se A ou B já tiver "ship" registrado com outra pessoa, o
// próximo par novo entre eles nasce de propósito com score baixo (< 30).

function pairKey(jidA, jidB) {
  const [a, b] = [jidA, jidB].sort();
  return `ship:pair:${a}|${b}`;
}

function historyKey(jid) {
  return `ship:history:${jid}`;
}

function getHistory(ctx, jid) {
  return ctx.settings.global.get(historyKey(jid), []);
}

function addHistory(ctx, jid, partnerJid) {
  const history = getHistory(ctx, jid);
  if (!history.includes(partnerJid)) {
    ctx.settings.global.set(historyKey(jid), [...history, partnerJid]);
  }
}

function hasOtherPartner(ctx, jid, excludingJid) {
  return getHistory(ctx, jid).some((partner) => partner !== excludingJid);
}

function randomLowScore() {
  return Math.floor(Math.random() * 30); // 0-29, de propósito
}

function resolveScore(ctx, jidA, jidB, nameA, nameB) {
  const key = pairKey(jidA, jidB);
  const stored = ctx.settings.global.get(key, null);
  const now = Date.now();

  if (stored && now - stored.createdAt < SEVEN_DAYS_MS) {
    return stored.score;
  }

  const forcedLow =
    hasOtherPartner(ctx, jidA, jidB) || hasOtherPartner(ctx, jidB, jidA);
  const score = forcedLow ? randomLowScore() : calculateScore(nameA, nameB);

  ctx.settings.global.set(key, { score, createdAt: now });
  addHistory(ctx, jidA, jidB);
  addHistory(ctx, jidB, jidA);

  return score;
}

// ── Avatares ──────────────────────────────────────────────────────────────

async function fetchAvatars(ctx, jids) {
  const results = await Promise.allSettled(
    jids.map((jid, index) => {
      const destPath = ctx.storage.resolve(
        `tmp/avatar_${Date.now()}_${index}.jpg`
      );
      return ctx.contacts.getPfpPath(jid, destPath);
    })
  );
  return results.map((r) => (r.status === "fulfilled" ? r.value : null));
}

async function cleanupAvatars(paths) {
  await Promise.all(
    paths.filter(Boolean).map((path) => unlink(path).catch(() => {}))
  );
}

// ── Fórmula do score ──────────────────────────────────────────────────────
//
// Nota: o multiplicador (comuns/2) pode passar de 1 facilmente e distorcer
// a curva antes do clamp final — intencional, não é bug (ver README).

function countCommonChars(a, b) {
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, "");
  const setA = new Set(normalize(a));
  const setB = new Set(normalize(b));
  let common = 0;
  for (const ch of setA) if (setB.has(ch)) common++;
  return common;
}

function calculateScore(nameA, nameB) {
  const base = Math.floor(Math.random() * 101);
  const common = countCommonChars(nameA, nameB);
  const multiplier = common >= 5 ? common / 2 : 1;

  let score = Math.floor(base * multiplier);
  score = clamp(score);

  if (score >= 90 && score <= 100 && Math.round(Math.random()) === 1) {
    score -= 10;
  }

  return clamp(score);
}

function clamp(score) {
  return Math.min(100, Math.max(0, score));
}

// ── Cor / gradiente ───────────────────────────────────────────────────────

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function colorForScore(score) {
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const a = COLOR_STOPS[i];
    const b = COLOR_STOPS[i + 1];
    if (score >= a.at && score <= b.at) {
      const t = (score - a.at) / (b.at - a.at || 1);
      return lerpColor(a.color, b.color, t);
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].color;
}

function rgb([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

function luminance([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ── Corações de fundo (contrastando com a cor atual) ─────────────────────

function drawHeart(c, x, y, size, color, rotation) {
  c.save();
  c.translate(x, y);
  c.rotate(rotation);
  c.beginPath();
  c.moveTo(0, size * 0.3);
  c.bezierCurveTo(-size, -size * 0.5, -size * 1.4, size * 0.6, 0, size * 1.3);
  c.bezierCurveTo(size * 1.4, size * 0.6, size, -size * 0.5, 0, size * 0.3);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.restore();
}

function heartCountForScore(score) {
  return Math.round(lerp(6, 26, score / 100));
}

function drawHeartsBackground(c, bgColor, score) {
  const light = luminance(bgColor) > 150;
  const base = light ? "0,0,0" : "255,255,255";
  const count = heartCountForScore(score);

  for (let i = 0; i < count; i++) {
    const x = Math.random() * WIDTH;
    const y = Math.random() * HEIGHT;
    const size = 14 + Math.random() * 34;
    const alpha = (0.06 + Math.random() * 0.14).toFixed(2);
    const rotation = (Math.random() - 0.5) * 0.6;
    drawHeart(c, x, y, size, `rgba(${base},${alpha})`, rotation);
  }
}

// ── Barra de progresso ────────────────────────────────────────────────────

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawProgressBar(c, score, bgColor) {
  const x = WIDTH / 2 - BAR_W / 2;

  c.fillStyle = "rgba(255,255,255,0.25)";
  roundRect(c, x, BAR_Y, BAR_W, BAR_H, BAR_H / 2);
  c.fill();

  const fillW = Math.max((BAR_W * score) / 100, BAR_H);
  const [r, g, b] = bgColor;
  c.fillStyle = rgb([
    Math.min(r + 40, 255),
    Math.min(g + 40, 255),
    Math.min(b + 40, 255),
  ]);
  roundRect(c, x, BAR_Y, fillW, BAR_H, BAR_H / 2);
  c.fill();
}

// ── Texto / avatares ──────────────────────────────────────────────────────

function truncateText(c, text, maxWidth) {
  if (c.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (
    truncated.length > 1 &&
    c.measureText(truncated + "...").width > maxWidth
  ) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "...";
}

function drawDefaultAvatar(c, cx, cy, radius) {
  c.save();
  c.beginPath();
  c.arc(cx, cy, radius, 0, Math.PI * 2);
  c.closePath();
  c.clip();

  c.fillStyle = "#555";
  c.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  c.fillStyle = "#999";
  c.beginPath();
  c.arc(cx, cy - radius * 0.15, radius * 0.45, 0, Math.PI * 2);
  c.fill();

  c.beginPath();
  c.ellipse(
    cx,
    cy + radius * 0.85,
    radius * 0.75,
    radius * 0.6,
    0,
    Math.PI,
    Math.PI * 2
  );
  c.fill();

  c.restore();
}

async function drawAvatar(c, path, cx, cy, radius) {
  if (path) {
    try {
      const img = await loadImage(path);
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;

      c.save();
      c.beginPath();
      c.arc(cx, cy, radius, 0, Math.PI * 2);
      c.closePath();
      c.clip();
      c.drawImage(
        img,
        sx,
        sy,
        size,
        size,
        cx - radius,
        cy - radius,
        radius * 2,
        radius * 2
      );
      c.restore();
      return;
    } catch {
      // falls through to the default avatar
    }
  }
  drawDefaultAvatar(c, cx, cy, radius);
}

async function renderShipImage({ names, avatarPaths, score }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const c = canvas.getContext("2d");
  const bgColor = colorForScore(score);
  const [r, g, b] = bgColor;

  const gradient = c.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(
    0,
    rgb([Math.max(r - 40, 0), Math.max(g - 40, 0), Math.max(b - 40, 0)])
  );
  gradient.addColorStop(
    1,
    rgb([Math.min(r + 25, 255), Math.min(g + 25, 255), Math.min(b + 25, 255)])
  );
  c.fillStyle = gradient;
  c.fillRect(0, 0, WIDTH, HEIGHT);

  drawHeartsBackground(c, bgColor, score);

  await drawAvatar(c, avatarPaths[0], AVATAR_LEFT_X, AVATAR_Y, AVATAR_RADIUS);
  await drawAvatar(c, avatarPaths[1], AVATAR_RIGHT_X, AVATAR_Y, AVATAR_RADIUS);

  c.lineWidth = 6;
  c.strokeStyle = "rgba(255,255,255,0.85)";
  for (const x of [AVATAR_LEFT_X, AVATAR_RIGHT_X]) {
    c.beginPath();
    c.arc(x, AVATAR_Y, AVATAR_RADIUS, 0, Math.PI * 2);
    c.stroke();
  }

  // Texto sempre com contorno + cor escolhida pela luminância do fundo —
  // nunca interpolar a cor do texto a partir da cor do fundo (score alto
  // = fundo vermelho/rosa, texto também tendendo a vermelho = some).
  const textIsLight = luminance(bgColor) <= 140;
  const nameFill = textIsLight ? "#fff" : "#111";
  const nameStroke = textIsLight ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.75)";

  c.font = `32px ${FONT_STACK}`;
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  c.lineJoin = "round";
  c.lineWidth = 4;
  c.strokeStyle = nameStroke;
  c.fillStyle = nameFill;
  for (const [name, x] of [[names[0], AVATAR_LEFT_X], [names[1], AVATAR_RIGHT_X]]) {
    const text = truncateText(c, name, NAME_MAX_WIDTH);
    c.strokeText(text, x, NAME_Y);
    c.fillText(text, x, NAME_Y);
  }

  const fontSize = Math.round(lerp(70, 120, score / 100));
  c.font = `${fontSize}px ${SCORE_FONT_STACK}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";

  const label = `${score}%`;
  const scoreFill = score === 100 ? "#ff1493" : textIsLight ? "#fff" : "#111";
  const scoreStroke = textIsLight ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.8)";

  c.lineWidth = Math.round(fontSize * 0.09);
  c.strokeStyle = scoreStroke;
  c.strokeText(label, WIDTH / 2, SCORE_Y);
  c.fillStyle = scoreFill;
  c.fillText(label, WIDTH / 2, SCORE_Y);

  drawProgressBar(c, score, bgColor);

  return canvas.encode("png");
}

