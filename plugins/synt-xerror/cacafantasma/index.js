/**
 * @param {import('@manybot/types/en').PluginContext} ctx
 */

const SETTINGS_KEY = "halloweenPoints";
const WINDOW_MS = 20_000;
const RESET_CONFIRM_MS = 30_000;
const YES_WORDS = new Set(["sim", "s", "yes", "y"]);
const NO_WORDS = new Set(["não", "nao", "n", "no"]);

const GHOSTS = [
  { emoji: "👻", rarity: "common",    pts: 1,  weight: 50  },
  { emoji: "🕷️", rarity: "uncommon",  pts: 2,  weight: 75  },
  { emoji: "🦇", rarity: "rare",      pts: 3,  weight: 90  },
  { emoji: "💀", rarity: "epic",      pts: 5,  weight: 98  },
  { emoji: "🎃", rarity: "legendary", pts: 10, weight: 100 },
];

// At night (0h–6h SP), uncommon+ get a boost: common drops from ~50% to ~30%,
// legendary goes from ~2% to ~7%.
const NIGHT_WEIGHTS = [30, 58, 78, 93, 100];

function isNighttime() {
  const h = new Date().toLocaleString("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(h, 10);
  return hour >= 0 && hour < 6;
}

function rollGhost() {
  const weights = isNighttime() ? NIGHT_WEIGHTS : GHOSTS.map((g) => g.weight);
  const roll = Math.random() * 100;
  return GHOSTS.find((_, i) => roll < weights[i]);
}

function emptyStats() {
  return {
    pts: 0,
    catches: 0,
    rarity: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    last: null,
  };
}

function normalizeStats(raw) {
  if (!raw) return emptyStats();
  if (typeof raw === "number") return { ...emptyStats(), pts: raw };
  return raw;
}

function timeAgo(ts) {
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return null;
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function rankOf(scores, jid) {
  const sorted = Object.entries(scores)
    .map(([j, raw]) => [j, normalizeStats(raw).pts])
    .sort((a, b) => b[1] - a[1]);
  const idx = sorted.findIndex(([j]) => j === jid);
  return idx === -1 ? sorted.length + 1 : idx + 1;
}

// groupJid → { ghost, caughtBy, scope, handle, timeout }
const activeHunts = new Map();
// groupJid → next spawn timestamp
const nextSpawn = new Map();
// "chatId:senderJid" → { scope, timeout }
const pendingReset = new Map();

function scheduleNextSpawn(groupId, log) {
  const minMs = 5 * 60 * 1000;
  const maxMs = 30 * 60 * 1000;
  const at = Date.now() + minMs + Math.random() * (maxMs - minMs);
  nextSpawn.set(groupId, at);
  if (log) log.info(`[cacafantasma] next ghost in ${groupId} at ${new Date(at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
}

export async function setup(ctx) {
  ctx.scheduler.schedule("* * * * *", async () => {
    const { t } = ctx.i18n.createT(import.meta.url);
    let activeGroups = ctx.settings.global.get("activeGroups", []);
    if (!activeGroups.length) return;

    const allChats = ctx.chats.all();
    const validIds = new Set(allChats.map((c) => c.id));
    let dirty = false;

    for (const entry of activeGroups) {
      const groupId = entry.groupId;

      if (!groupId || typeof groupId !== "string" || !groupId.includes("@")) {
        dirty = true;
        continue;
      }

      if (!validIds.has(groupId)) {
        dirty = true;
        continue;
      }

      if (activeHunts.has(groupId)) continue;

      if (!nextSpawn.has(groupId)) {
        scheduleNextSpawn(groupId, ctx.log);
        continue;
      }

      if (Date.now() < nextSpawn.get(groupId)) continue;

      scheduleNextSpawn(groupId, ctx.log);

      const ghost = rollGhost();

      let handle;
      try {
        handle = await ctx.send.to(groupId).text(ghost.emoji);
      } catch (_) {
        continue;
      }

      const hunt = { ghost, caughtBy: null, handle };

      hunt.timeout = setTimeout(async () => {
        activeHunts.delete(groupId);
        if (hunt.caughtBy) return;

        try { await handle.delete(); } catch (_) {}
        try {
          await ctx.send.to(groupId).text(
            t("escaped", { emoji: ghost.emoji, rarity: t(ghost.rarity), pts: ghost.pts })
          );
        } catch (_) {}
      }, WINDOW_MS);

      activeHunts.set(groupId, hunt);
    }

    if (dirty) {
      const cleaned = activeGroups.filter(
        (e) => e.groupId && typeof e.groupId === "string" && e.groupId.includes("@") && validIds.has(e.groupId)
      );
      ctx.settings.global.set("activeGroups", cleaned);
    }
  });
}

export default async function (ctx) {
  if (ctx.msg.fromMe) return;
  if (!ctx.chat.isGroup) return;

  const { t } = ctx.i18n.createT(import.meta.url);
  const prefix = ctx.config.get("CMD_PREFIX", "!");

  // ── pending "reset" confirmation ─────────────────────────────
  const resetKey = `${ctx.chat.id}:${ctx.msg.sender}`;
  if (pendingReset.has(resetKey)) {
    const answer = ctx.msg.body?.trim().toLowerCase();
    if (YES_WORDS.has(answer) || NO_WORDS.has(answer)) {
      const pending = pendingReset.get(resetKey);
      clearTimeout(pending.timeout);
      pendingReset.delete(resetKey);

      if (YES_WORDS.has(answer)) {
        const scopeSettings = ctx.settings.forChat(pending.scope);
        const scores = scopeSettings.get(SETTINGS_KEY, {});
        delete scores[ctx.msg.sender];
        scopeSettings.set(SETTINGS_KEY, scores);
        await ctx.msg.reply.text(t("resetDone"));
      } else {
        await ctx.msg.reply.text(t("resetCancelled"));
      }
      return;
    }
  }

  // ── caçafantasma / ghosthunt ─────────────────────────────────
  if (ctx.msg.is("caçafantasma") || ctx.msg.is("ghosthunt")) {
    const sub = ctx.msg.args[0]?.toLowerCase();

    if (sub === "ativar" || sub === "activate") {
      if (!ctx.chat.isGroup) {
        await ctx.msg.reply.text(t("groupOnly"));
        return;
      }
      if (!await ctx.chat.isSenderAdmin()) {
        await ctx.msg.reply.text(t("adminOnly"));
        return;
      }

      const communityId = ctx.chat.community;
      const activeGroups = ctx.settings.global.get("activeGroups", []);

      // If this group belongs to a community, block if another group in the same community is already active
      if (communityId) {
        const conflict = activeGroups.find((entry) => entry.communityId === communityId && entry.groupId !== ctx.chat.id);
        if (conflict) {
          const conflictChat = ctx.chats.all().find((c) => c.id === conflict.groupId);
          const mention = conflictChat ? { text: conflictChat.name, mentions: [conflict.groupId] } : null;
          if (mention) {
            await ctx.msg.reply.text(t("alreadyActiveMention", { group: mention.text }), mention);
          } else {
            await ctx.msg.reply.text(t("alreadyActive"));
          }
          return;
        }
      }

      if (!activeGroups.find((e) => e.groupId === ctx.chat.id)) {
        activeGroups.push({ groupId: ctx.chat.id, communityId: communityId ?? null });
        ctx.settings.global.set("activeGroups", activeGroups);
      }

      ctx.settings.set("ghostHuntActive", true);
      if (!nextSpawn.has(ctx.chat.id)) scheduleNextSpawn(ctx.chat.id, ctx.log);
      await ctx.msg.reply.text(t("activated"));
      return;
    }

    if (sub === "desativar" || sub === "deactivate") {
      if (!ctx.chat.isGroup) {
        await ctx.msg.reply.text(t("groupOnly"));
        return;
      }
      if (!await ctx.chat.isSenderAdmin()) {
        await ctx.msg.reply.text(t("adminOnly"));
        return;
      }

      const activeGroups = ctx.settings.global.get("activeGroups", []);
      const filtered = activeGroups.filter((e) => e.groupId !== ctx.chat.id);
      ctx.settings.global.set("activeGroups", filtered);

      ctx.settings.set("ghostHuntActive", false);

      const hunt = activeHunts.get(ctx.chat.id);
      if (hunt) {
        clearTimeout(hunt.timeout);
        activeHunts.delete(ctx.chat.id);
      }
      nextSpawn.delete(ctx.chat.id);
      await ctx.msg.reply.text(t("deactivated"));
      return;
    }

    if (sub === "status") {
      let targetJid = null;
      if (ctx.msg.hasMention && ctx.msg.mentionedJid.length) {
        targetJid = ctx.msg.mentionedJid[0];
      } else if (ctx.msg.hasReply) {
        const quoted = await ctx.msg.getReply();
        targetJid = quoted?.sender ?? null;
      }
      if (!targetJid) targetJid = ctx.msg.sender;

      const communityId = ctx.chat.community ?? null;
      const scope = communityId ?? ctx.chat.id;
      const scores = ctx.settings.forChat(scope).get(SETTINGS_KEY, {});
      const stats = normalizeStats(scores[targetJid]);

      const participants = await ctx.chat.getParticipants();
      const participantIds = new Set(participants.map((p) => p.id));
      const contact = await ctx.contacts.get(targetJid, { groupId: ctx.chat.id });
      const fallbackName = contact?.pushname ?? contact?.name ?? targetJid;
      const mention = participantIds.has(targetJid) && contact?.mention ? contact.mention : null;
      const displayName = mention ? mention.text : fallbackName;
      const opts = mention ? { mentions: mention.mentions } : undefined;

      if (stats.catches === 0) {
        await ctx.msg.reply.text(t("statusNone", { name: displayName }), opts);
        return;
      }

      const r = stats.rarity;
      const lastAgo = timeAgo(stats.last.ts);
      const lastArgs = { emoji: stats.last.emoji, rarity: t(stats.last.rarity), pts: stats.last.pts };
      const body = [
        t("statusHeader", { name: displayName }),
        t("statusSummary", { pts: stats.pts, catches: stats.catches }),
        t("statusBreakdown", { common: r.common, uncommon: r.uncommon, rare: r.rare, epic: r.epic, legendary: r.legendary }),
        lastAgo ? t("statusLast", { ...lastArgs, time: lastAgo }) : t("statusLastNow", lastArgs),
      ].join("\n");

      await ctx.msg.reply.text(body, opts);
      return;
    }

    // "reset" is handled above and intentionally only ever targets ctx.msg.sender —
    // there is no path to reset another user's stats.

    if (sub === "reset") {
      const communityId = ctx.chat.community ?? null;
      const scope = communityId ?? ctx.chat.id;

      if (pendingReset.has(resetKey)) clearTimeout(pendingReset.get(resetKey).timeout);
      const timeout = setTimeout(() => pendingReset.delete(resetKey), RESET_CONFIRM_MS);
      pendingReset.set(resetKey, { scope, timeout });

      await ctx.msg.reply.text(t("resetConfirm"));
      return;
    }

    // rules
    const active = ctx.settings.get("ghostHuntActive", false);
    const communityId = ctx.chat.community ?? null;
    const scope = communityId ?? ctx.chat.id;
    const scores = ctx.settings.forChat(scope).get(SETTINGS_KEY, {});

    if (sub === "ranking") {
      let top = t("rankingNotAvailable");
      const mentions = [];
      const entries = Object.entries(scores)
        .map(([jid, raw]) => [jid, normalizeStats(raw).pts])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      if (entries.length > 0) {
        const participants = await ctx.chat.getParticipants();
        const participantIds = new Set(participants.map((p) => p.id));
        const rows = await Promise.all(entries.map(async ([jid, pts], i) => {
          const contact = await ctx.contacts.get(jid, { groupId: ctx.chat.id });
          const label = pts === 1 ? t("point") : t("points");
          if (participantIds.has(jid) && contact?.mention) {
            mentions.push(...contact.mention.mentions);
            return `${i + 1}. ${contact.mention.text} — ${pts} ${label}`;
          }
          const name = contact?.pushname ?? contact?.name ?? jid;
          return `${i + 1}. ${name} — ${pts} ${label}`;
        }));
        top = `🏆 *${t("topLabel")}*\n${rows.join("\n")}`;
      }
      await ctx.msg.reply.text(top, mentions.length ? { mentions } : undefined);
      return;
    }

    await ctx.msg.reply.text(
      t("rules", { prefix, active: active ? t("statusOn") : t("statusOff")}),
    );
    return;
  }

  // ── caçar / catch ────────────────────────────────────────────
  if (ctx.msg.is("caçar") || ctx.msg.is("catch")) {
    const hunt = activeHunts.get(ctx.chat.id);
    if (!hunt || hunt.caughtBy) return;

    clearTimeout(hunt.timeout);
    hunt.caughtBy = ctx.msg.sender;
    activeHunts.delete(ctx.chat.id);

    try { await hunt.handle.delete(); } catch (_) {}

    const communityId = ctx.chat.community ?? null;
    const scope = communityId ?? ctx.chat.id;
    const scopeSettings = ctx.settings.forChat(scope);
    const scores = scopeSettings.get(SETTINGS_KEY, {});
    const prevRank = rankOf(scores, ctx.msg.sender);
    const stats = normalizeStats(scores[ctx.msg.sender]);
    stats.pts += hunt.ghost.pts;
    stats.catches += 1;
    stats.rarity[hunt.ghost.rarity] = (stats.rarity[hunt.ghost.rarity] ?? 0) + 1;
    stats.last = { emoji: hunt.ghost.emoji, rarity: hunt.ghost.rarity, pts: hunt.ghost.pts, ts: Date.now() };
    scores[ctx.msg.sender] = stats;
    scopeSettings.set(SETTINGS_KEY, scores);

    const total = stats.pts;
    const newRank = rankOf(scores, ctx.msg.sender);
    const rankUp = newRank < prevRank;

    const msgKey = rankUp ? "caughtRankUp" : "caught";
    await ctx.msg.reply.text(
      t(msgKey, {
        name: ctx.msg.senderName,
        emoji: hunt.ghost.emoji,
        rarity: t(hunt.ghost.rarity),
        pts: hunt.ghost.pts,
        total,
        rank: newRank,
      })
    );
    return;
  }
}

