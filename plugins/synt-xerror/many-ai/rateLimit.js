// src/plugins/many-ai/rateLimit.js
// Daily usage limiter for !transcrever, persisted via ctx.settings.global so
// it survives bot restarts — one counter per sender (global, any chat) and
// one per group chat (shared by everyone in it). Rolling 24h window per
// key, not a fixed midnight reset.

const DAY_MS = 24 * 60 * 60 * 1000;

const senderKey = (id) => `transcrever:sender:${id}`;
const groupKey  = (id) => `transcrever:group:${id}`;

async function readEntry(ctx, key) {
  const entry = await ctx.settings.global.get(key, null);
  if (!entry || entry.resetAt <= Date.now()) return null; // expired — treated as absent
  return entry;
}

async function bump(ctx, key) {
  const current = await readEntry(ctx, key);
  const next = current
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: Date.now() + DAY_MS };
  await ctx.settings.global.set(key, next);
  return next;
}

/**
 * Checks whether sender/chat are already past the daily limit. Call BEFORE
 * doing the expensive work (downloading/transcribing).
 * @returns {Promise<{type: "group"|"sender", resetAt: number}|null>}
 */
export async function checkLimit(ctx, senderId, chatId, isGroup, limit) {
  if (isGroup) {
    const gEntry = await readEntry(ctx, groupKey(chatId));
    if (gEntry && gEntry.count >= limit) return { type: "group", resetAt: gEntry.resetAt };
  }
  const sEntry = await readEntry(ctx, senderKey(senderId));
  if (sEntry && sEntry.count >= limit) return { type: "sender", resetAt: sEntry.resetAt };
  return null;
}

/** "3h42min" / "42min" — rounds up so it never reads "0min" while still blocked. */
export function formatTimeLeft(resetAt) {
  const totalMin = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

/**
 * Records one successful use. Call AFTER the work succeeds — failed
 * attempts shouldn't cost the person their quota.
 *
 * In a group, if this use makes the GROUP counter hit the limit, the
 * sender's own counter is force-bumped to the limit too (even if their
 * personal count was lower) — the group's quota ran out partly because of
 * them, so they're blocked everywhere, not just in this group.
 */
export async function recordUse(ctx, senderId, chatId, isGroup, limit) {
  const sEntry = await bump(ctx, senderKey(senderId));
  if (isGroup) {
    const gEntry = await bump(ctx, groupKey(chatId));
    if (gEntry.count >= limit && sEntry.count < limit) {
      await ctx.settings.global.set(senderKey(senderId), { count: limit, resetAt: gEntry.resetAt });
    }
  }
}

