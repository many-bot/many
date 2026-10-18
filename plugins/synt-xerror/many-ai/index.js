// src/plugins/many-ai/index.js
// !transcrever — transcribes the audio quoted by the command. Reply-only:
// WhatsApp voice notes can't carry a caption, so there's no "send audio +
// command" path, only "reply to an audio with !transcrever". Uses Groq
// Whisper under the hood, see voice.js.

import { transcribeCurrentMessage } from "./voice.js";
import { getKeyPool } from "./apiKeys.js";
import { checkLimit, recordUse, formatTimeLeft } from "./rateLimit.js";

export default async function (ctx) {
  if (!ctx.msg.is("transcrever")) return;

  const { t } = ctx.i18n.createT(import.meta.url);

  const dailyLimit = Number(ctx.config.get("AI_TRANSCRIBE_DAILY_LIMIT", 5)) || 5;
  const senderId = ctx.msg.sender || ctx.msg.senderPn;
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.isGroup;

  if (senderId) {
    const blocked = await checkLimit(ctx, senderId, chatId, isGroup, dailyLimit);
    if (blocked) {
      const key = blocked.type === "group" ? "groupLimited" : "senderLimited";
      await ctx.msg.reply.text(t(key, { limit: dailyLimit, timeLeft: formatTimeLeft(blocked.resetAt) }));
      return;
    }
  }

  const quoted = ctx.msg.hasReply ? await ctx.msg.getReply() : null;
  if (!quoted || quoted.type !== "audio") {
    await ctx.msg.reply.text(t("noReply"));
    return;
  }

  const keys = getKeyPool(ctx);
  if (!keys.length) {
    await ctx.msg.reply.text(t("missingKey"));
    return;
  }

  const model = ctx.config.get("AI_TRANSCRIBE_MODEL", "whisper-large-v3-turbo");
  const maxMb = Number(ctx.config.get("AI_TRANSCRIBE_MAX_MB", 25)) || 25;
  const minConfidence = Number(ctx.config.get("AI_TRANSCRIBE_MIN_CONFIDENCE", 0.8)) || 0.8;

  let result;
  try {
    result = await transcribeCurrentMessage(quoted, ctx, keys, model, maxMb * 1024 * 1024);
  } catch (err) {
    if (err.isTooLarge) {
      await ctx.msg.reply.text(t("trimFailed", {
        sizeMb: (err.sizeBytes / 1024 / 1024).toFixed(1),
        limitMb: maxMb,
      }));
      return;
    }
    throw err;
  }

  const text = result.text.trim();
  if (!text) {
    await ctx.msg.reply.text(t("failed"));
    return;
  }

  if (senderId) await recordUse(ctx, senderId, chatId, isGroup, dailyLimit);

  let headerLine = t("header");
  if (result.confidence !== null && result.confidence < minConfidence) {
    headerLine += ` ${t("lowConfidenceNote")}`;
  }

  let message = `${headerLine}\n\n${text}`;
  if (result.trimmed) message += `\n\n${t("trimmedNote", { limitMb: maxMb })}`;
  await ctx.msg.reply.text(message);
}

