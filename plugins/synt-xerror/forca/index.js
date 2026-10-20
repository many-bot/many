/**
 * Hangman game plugin
 * Game state is persisted to disk (ctx.storage) — survives bot restarts.
 * One JSON file per chat, same pattern as the jogo-da-velha plugin.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readFile }      from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const words     = JSON.parse(await readFile(join(__dirname, "words.json"), "utf8"));

const GAME_TTL_MS = 5 * 60 * 1000;

const generateProgress = word => word.replace(/\p{L}/gu, "_");
const normalize        = l => l.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function safeId(chatId) {
  return chatId.replace(/[^a-zA-Z0-9]/g, "_");
}

function gameFilePath(ctx) {
  return ctx.storage.resolve(`partida-${safeId(ctx.chat.id)}.json`);
}

function lastWordFilePath(ctx) {
  return ctx.storage.resolve(`ultima-palavra-${safeId(ctx.chat.id)}.json`);
}

// TTL checado na leitura (preguiçoso, sem setTimeout) — igual ao jogo-da-velha.
// Trade-off: o bot não avisa mais sozinho quando o tempo esgota; o jogo só
// "some" quando alguém mexe de novo depois do TTL (ou inicia outro).
function loadGame(ctx) {
  const path = gameFilePath(ctx);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Date.now() - (raw.updatedAt ?? 0) > GAME_TTL_MS) {
      unlinkSync(path);
      return null;
    }
    return {
      ...raw,
      guessed: new Set(raw.guessed),
      participants: new Map(Object.entries(raw.participants ?? {})),
    };
  } catch {
    unlinkSync(path);
    return null;
  }
}

function saveGame(ctx, game) {
  const payload = {
    ...game,
    guessed: [...game.guessed],
    participants: Object.fromEntries(game.participants),
    updatedAt: Date.now(),
  };
  writeFileSync(gameFilePath(ctx), JSON.stringify(payload, null, 2));
}

function deleteGame(ctx) {
  const path = gameFilePath(ctx);
  if (existsSync(path)) unlinkSync(path);
}

function loadLastWord(ctx) {
  const path = lastWordFilePath(ctx);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")).word ?? null;
  } catch {
    return null;
  }
}

function saveLastWord(ctx, word) {
  writeFileSync(lastWordFilePath(ctx), JSON.stringify({ word }));
}

const pickWord = (WORDS, ctx) => {
  if (WORDS.length === 1) return WORDS[0];
  const last = loadLastWord(ctx);
  let choice;
  do {
    choice = WORDS[Math.floor(Math.random() * WORDS.length)];
  } while (choice.word === last);
  return choice;
};

export default async function (ctx) {
  const { msg, config, i18n, send } = ctx;
  const prefix = config.get("CMD_PREFIX");
  const { t }  = i18n.createT(import.meta.url);

  // ── Comando !forca ────────────────────────────────────────
  if (msg.command === "forca") {
    const sub   = (msg.args[0] ?? "").toLowerCase();
    const lang  = config.get("LANGUAGE");
    const WORDS = words[lang] ?? words.en;

    if (!sub) {
      await send.text(
        `${t("title")}\n\n` +
        `\`${prefix}forca ${t("startCommand")}\` — ${t("startCommandHelp")}\n` +
        `\`${prefix}forca ${t("stopCommand")}\` — ${t("stopCommandHelp")}`
      );
      return;
    }

    if (sub === t("startCommand") || sub === t("startCommandAlt")) {
      if (loadGame(ctx)) {
        await send.text(t("alreadyRunning"));
        return;
      }

      const random = pickWord(WORDS, ctx);
      const word   = random.word.toLowerCase();
      saveLastWord(ctx, random.word);
      saveGame(ctx, {
        word,
        theme: random.theme,
        lives: 6,
        progress: generateProgress(word),
        guessed: new Set(),
        participants: new Map(),
      });

      await send.text(t("started", { theme: random.theme, word: generateProgress(word), lives: 6 }));
      return;
    }

    if (sub === t("stopCommand")) {
      const game = loadGame(ctx);
      if (!game) {
        await send.text(t("noGame", { cmd: `${prefix}forca ${t("startCommand")}` }));
        return;
      }
      deleteGame(ctx);
      await send.text(t("stopped", { word: game.word }));
      return;
    }

    await send.text(`${t("invalidCommand", { sub })} \`${prefix}forca ${t("startCommand")}\` ${t("or")} \`${prefix}forca ${t("stopCommand")}\`.`);
    return;
  }

  // ── Tentativa de letra ou palavra ─────────────────────────
  const game = loadGame(ctx);
  if (!game) return;

  const attempt = (msg.body ?? "").trim().toLowerCase();
  if (!attempt) return;

  const isLetter = /^\p{L}$/u.test(attempt);
  const isWord   = !isLetter && attempt.length > 1 && /^\p{L}+$/u.test(normalize(attempt));
  if (!isLetter && !isWord) return;

  if (!game.participants.has(msg.sender)) game.participants.set(msg.sender, msg.senderName);

  // ── Palpite de palavra completa ───────────────────────────
  if (isWord) {
    if (normalize(attempt) === normalize(game.word)) {
      const winners = [...game.participants.values()].join(", ") || t("nobody");
      await msg.reply.text(t("won", { word: game.word, participants: winners }));
      deleteGame(ctx);
      return;
    }
    saveGame(ctx, game);
    return;
  }

  // ── Palpite de letra ──────────────────────────────────────
  const normalized = normalize(attempt);
  if (game.guessed.has(normalized)) {
    await msg.reply.text(t("alreadyGuessed", { letter: attempt }));
    return;
  }
  game.guessed.add(normalized);

  const newProgress = [...game.progress];
  let hit = false;
  for (let i = 0; i < game.word.length; i++) {
    if (normalize(game.word[i]) === normalized) {
      newProgress[i] = game.word[i];
      hit = true;
    }
  }
  game.progress = newProgress.join("");
  if (!hit) game.lives--;

  if (game.progress === game.word) {
    const winners = [...game.participants.values()].join(", ") || t("nobody");
    await msg.reply.text(t("won", { word: game.word, participants: winners }));
    deleteGame(ctx);
    return;
  }

  if (game.lives <= 0) {
    await msg.reply.text(t("lost", { word: game.word }));
    deleteGame(ctx);
    return;
  }

  saveGame(ctx, game);

  await msg.reply.text(
    `${t("status", { word: game.progress, lives: game.lives, guessed: [...game.guessed].sort().join(", ") })}\n` +
    (hit ? t("correct") : t("wrong"))
  );
}

