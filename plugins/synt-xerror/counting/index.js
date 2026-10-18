import fs from "node:fs";

// ── Helpers ───────────────────────────────────────────────

const INACTIVITY_LIMIT_MS = 24 * 60 * 60 * 1000;

function loadState(storage) {
  try {
    const entries = JSON.parse(fs.readFileSync(storage, "utf8"));
    const now = Date.now();
    return new Map(
      entries.filter(([, s]) => !s.updatedAt || now - s.updatedAt < INACTIVITY_LIMIT_MS)
    );
  } catch {
    return new Map();
  }
}

function saveState(storage, map) {
  try {
    fs.writeFileSync(storage, JSON.stringify([...map]));
  } catch {}
}

function getState(map, chatId) {
  if (!map.has(chatId)) {
    map.set(chatId, {
      number: 0,
      lastMention: null,
      lastContactId: null,
      updatedAt: null,
    });
  }
  return map.get(chatId);
}

function resetState(state) {
  state.number        = 0;
  state.lastMention   = null;
  state.lastContactId = null;
}

function touch(state) {
  state.updatedAt = Date.now();
}

// ── Setup (scheduler de inatividade) ────────────────────────

/**
 * @param {import('@manybot/types/en').SetupContext} ctx
 */
export async function setup(ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);
  const storage = ctx.storage.resolve("chat_state.json");

  ctx.scheduler.schedule("0 * * * *", async () => {
    const map = loadState(storage);
    const now = Date.now();
    let changed = false;

    for (const [chatId, state] of map) {
      if (!state.updatedAt) continue;
      if (now - state.updatedAt < INACTIVITY_LIMIT_MS) continue;

      const settings = ctx.settings.forChat(chatId);
      if (!settings.get("enabled", false)) continue;

      settings.set("enabled", false);
      map.delete(chatId);
      changed = true;

      try {
        await ctx.send.to(chatId).text(t("disabledByInactivity"));
      } catch {}
    }

    if (changed) saveState(storage, map);
  });
}

// ── Plugin ────────────────────────────────────────────────

/**
 * @param {import('@manybot/types/en').PluginContext} ctx
 */
export default async function (ctx) {
  const { msg, chat } = ctx;
  const { t }         = ctx.i18n.createT(import.meta.url);

  const storage = ctx.storage.resolve("chat_state.json");
  const map     = loadState(storage);

  // ── Comando !counting ───────────────────────────────────
  if (msg.is("counting")) {
    const [sub] = msg.args.map((a) => a.toLowerCase());

    if (sub === "on" || sub === "off") {
      if (!chat.isGroup) {
        await msg.reply.text(t("onlyGroups"));
        return;
      }

      const isAdmin = await chat.isSenderAdmin();
      if (!isAdmin) {
        await msg.reply.text(t("onlyAdmins"));
        return;
      }

      ctx.settings.set("enabled", sub === "on");
      if (sub === "on") {
        touch(getState(map, chat.id));
        saveState(storage, map);
      }
      await msg.reply.text(sub === "on" ? t("enabled") : t("disabled"));
      return;
    }

    if (!ctx.settings.get("enabled", false)) {
      await ctx.send.text(t("notEnabled"));
      return;
    }

    const state = getState(map, chat.id);
    touch(state);
    saveState(storage, map);

    const infoText =
      `*${t("title")}*\n\n` +
      `${t("rulesLine1")}\n` +
      `${t("rulesLine2")}\n` +
      `${t("rulesLine3")}\n\n` +
      t("current", { number: state.number }) +
      (state.lastMention?.text
        ? "\n" + t("lastCounter") + state.lastMention.text
        : "");

    await ctx.send.text(infoText, state.lastMention || undefined);
    return;
  }

  // ── Filtro: só roda se ativado neste chat ───────────────
  if (!ctx.settings.get("enabled", false)) return;

  // ── Game logic ───────────────────────────────────────────
  const n = Number(msg.body.trim());
  if (!Number.isInteger(n) || n <= 0) return;

  const state   = getState(map, chat.id);
  const contact = await msg.getContact();
  if (!contact) return;

  touch(state);

  if (contact.id === state.lastContactId && n !== 1) {
    resetState(state);
    saveState(storage, map);
    await msg.react("❌").catch(() => {});
    return;
  }

  if (n === state.number + 1) {
    state.number        = n;
    state.lastMention   = contact.mention;
    state.lastContactId = contact.id;
    saveState(storage, map);
    await msg.react("✅").catch(() => {});
  } else {
    resetState(state);
    saveState(storage, map);
    await msg.react("❌").catch(() => {});
  }
}

