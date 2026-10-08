/**
 * Hangman game plugin
 * Game state is stored internally per chat.
 */

import { readFile }      from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const words     = JSON.parse(await readFile(join(__dirname, "words.json"), "utf8"));

const GAME_TIMEOUT_MS = 5 * 60 * 1000;

const activeGames        = new Map();
const activeParticipants = new Map();
const lastWords           = new Map();
const gameTimers          = new Map();

const generateProgress = word => word.replace(/\p{L}/gu, "_");
const normalize        = l => l.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const pickWord = (WORDS, chatId) => {
  if (WORDS.length === 1) return WORDS[0];
  let choice;
  do {
    choice = WORDS[Math.floor(Math.random() * WORDS.length)];
  } while (choice.word === lastWords.get(chatId));
  return choice;
};

const clearGameTimer = chatId => {
  const timer = gameTimers.get(chatId);
  if (timer) clearTimeout(timer);
  gameTimers.delete(chatId);
};

const endGame = chatId => {
  activeGames.delete(chatId);
  activeParticipants.delete(chatId);
  clearGameTimer(chatId);
};

const scheduleGameTimer = (chatId, send, t) => {
  clearGameTimer(chatId);
  const timer = setTimeout(async () => {
    const game = activeGames.get(chatId);
    if (!game) return;
    endGame(chatId);
    await send.text(t("timeout", { word: game.word }));
  }, GAME_TIMEOUT_MS);
  gameTimers.set(chatId, timer);
};

export default async function (ctx) {
  const { msg, chat, config, i18n, send } = ctx;
  const chatId = chat.id;
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
      if (activeGames.has(chatId)) {
        await send.text(t("alreadyRunning"));
        return;
      }

      const random = pickWord(WORDS, chatId);
      const word   = random.word.toLowerCase();
      lastWords.set(chatId, random.word);
      activeGames.set(chatId, { word, theme: random.theme, lives: 6, progress: generateProgress(word), guessed: new Set() });
      activeParticipants.set(chatId, new Map());
      scheduleGameTimer(chatId, send, t);

      await send.text(t("started", { theme: random.theme, word: generateProgress(word), lives: 6 }));
      return;
    }

    if (sub === t("stopCommand")) {
      if (!activeGames.has(chatId)) {
        await send.text(t("noGame", { cmd: `${prefix}forca ${t("startCommand")}` }));
        return;
      }
      const game = activeGames.get(chatId);
      endGame(chatId);
      await send.text(t("stopped", { word: game.word }));
      return;
    }

    await send.text(`${t("invalidCommand", { sub })} \`${prefix}forca ${t("startCommand")}\` ${t("or")} \`${prefix}forca ${t("stopCommand")}\`.`);
    return;
  }

  // ── Tentativa de letra ou palavra ─────────────────────────
  const game = activeGames.get(chatId);
  if (!game) return;

  const attempt = (msg.body ?? "").trim().toLowerCase();
  if (!attempt) return;

  const isLetter = /^\p{L}$/u.test(attempt);
  const isWord   = !isLetter && attempt.length > 1 && /^\p{L}+$/u.test(normalize(attempt));
  if (!isLetter && !isWord) return;

  const participants = activeParticipants.get(chatId);
  if (!participants.has(msg.sender)) participants.set(msg.sender, msg.senderName);

  scheduleGameTimer(chatId, send, t);

  // ── Palpite de palavra completa ───────────────────────────
  if (isWord) {
    if (normalize(attempt) === normalize(game.word)) {
      const winners = [...participants.values()].join(", ") || t("nobody");
      await msg.reply.text(t("won", { word: game.word, participants: winners }));
      endGame(chatId);
      return;
    }
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
    const winners = [...participants.values()].join(", ") || t("nobody");
    await msg.reply.text(t("won", { word: game.word, participants: winners }));
    endGame(chatId);
    return;
  }

  if (game.lives <= 0) {
    await msg.reply.text(t("lost", { word: game.word }));
    endGame(chatId);
    return;
  }

  await msg.reply.text(
    `${t("status", { word: game.progress, lives: game.lives, guessed: [...game.guessed].sort().join(", ") })}\n` +
    (hit ? t("correct") : t("wrong"))
  );
}
