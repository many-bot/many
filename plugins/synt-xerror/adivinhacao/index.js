/**
 * plugins/adivinhacao/index.js
 *
 * Game state lives here — isolated in the plugin.
 * Multiple groups can play simultaneously without conflict.
 */

const RANGE       = { min: 1, max: 100 };
const jogosAtivos = new Map();
const sorteio     = () =>
  Math.floor(Math.random() * (RANGE.max - RANGE.min + 1)) + RANGE.min;

export default async function (ctx) {
  const { msg }  = ctx;
  const chatId   = ctx.chat.id;
  const prefix   = ctx.config.get("CMD_PREFIX");
  const { t }    = ctx.i18n.createT(import.meta.url);

  // ── !adivinhação ─────────────────────────────────────────
  if (msg.is("adivinhação")) {
    const sub = msg.args[0];

    if (!sub) {
      await ctx.send.text(
        `${t("title")}\n\n` +
        `\`${prefix}adivinhação começar\` — ${t("startCommand")}\n` +
        `\`${prefix}adivinhação parar\` — ${t("stopCommand")}`
      );
      return;
    }

    if (sub === "começar") {
      jogosAtivos.set(chatId, sorteio());
      await ctx.send.text(t("started"));
      ctx.log.info(t("gameLog.started"));
      return;
    }

    if (sub === "parar") {
      jogosAtivos.delete(chatId);
      await ctx.send.text(t("stopped"));
      ctx.log.info(t("gameLog.stopped"));
      return;
    }

    await ctx.send.text(
      `${t("invalidCommand", { sub })} \`${prefix}adivinhação começar\` ${t("or")} \`${prefix}adivinhação parar\`.`
    );
    return;
  }

  // ── Guesses during active game ────────────────────────────
  const numero = jogosAtivos.get(chatId);
  if (numero === undefined) return;

  const tentativa = msg.body.trim();
  if (!/^\d+$/.test(tentativa)) return;

  const num = parseInt(tentativa, 10);
  if (num < RANGE.min || num > RANGE.max) {
    await msg.reply.text(t("range", { min: RANGE.min, max: RANGE.max }));
    return;
  }

  if (num === numero) {
    await msg.reply.text(
      `${t("correct", { number: numero })} \`${prefix}adivinhação começar\` ${t("playAgain")}`
    );
    jogosAtivos.delete(chatId);
  } else {
    await ctx.send.text(num > numero ? t("lower") : t("higher"));
  }
}
