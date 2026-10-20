/**
 * plugins/adivinhacao/index.js
 *
 * Game state persisted to disk (ctx.storage) — survives bot restarts.
 * One JSON file per chat, same pattern as the jogo-da-velha plugin.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const RANGE   = { min: 1, max: 100 };
const sorteio = () =>
  Math.floor(Math.random() * (RANGE.max - RANGE.min + 1)) + RANGE.min;

function gameFilePath(ctx) {
  const safeId = ctx.chat.id.replace(/[^a-zA-Z0-9]/g, "_");
  return ctx.storage.resolve(`partida-${safeId}.json`);
}

function loadNumber(ctx) {
  const path = gameFilePath(ctx);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")).numero ?? null;
  } catch {
    unlinkSync(path);
    return null;
  }
}

function saveNumber(ctx, numero) {
  writeFileSync(gameFilePath(ctx), JSON.stringify({ numero }));
}

function deleteNumber(ctx) {
  const path = gameFilePath(ctx);
  if (existsSync(path)) unlinkSync(path);
}

export default async function (ctx) {
  const { msg }  = ctx;
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
      saveNumber(ctx, sorteio());
      await ctx.send.text(t("started"));
      ctx.log.info(t("gameLog.started"));
      return;
    }

    if (sub === "parar") {
      deleteNumber(ctx);
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
  const numero = loadNumber(ctx);
  if (numero === null) return;

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
    deleteNumber(ctx);
  } else {
    await ctx.send.text(num > numero ? t("lower") : t("higher"));
  }
}

