// --- Settings helpers ---

function getScopeId(ctx) {
  return ctx.chat.community ?? ctx.chat.id;
}

function getRulesFromSettings(ctx, chatId) {
  const store = ctx.settings.forChat(chatId ?? getScopeId(ctx));
  return store.get("rules", []);
}

function saveRules(ctx, rules, chatId) {
  const store = ctx.settings.forChat(chatId ?? getScopeId(ctx));
  store.set("rules", rules);
}

// --- Public API (other plugins can use this) ---

export function getRules(ctx, chatId) {
  return getRulesFromSettings(ctx, chatId);
}

export function getRule(ctx, index, chatId) {
  const rules = getRules(ctx, chatId);
  return rules[index - 1] ?? null;
}

// --- Pending "add penalty?" flow state (chatId -> { ruleIndex, sender }) ---

const pendingPenalty = new Map();

// --- Plugin handler ---

export default async function (ctx) {
  if (ctx.msg.fromMe) return;
  const { t } = ctx.i18n.createT(import.meta.url);
  const prefix = ctx.config.get("CMD_PREFIX") ?? "";
  const rulesCmd = `${prefix}rules`;
  const warnCmd = `${prefix}warn`;

  // Continuation of "!rules add" waiting for a penalty answer
  if (pendingPenalty.has(ctx.chat.id)) {
    const pending = pendingPenalty.get(ctx.chat.id);
    const raw = (ctx.msg.body ?? "").trim();

    if (prefix && raw.startsWith(prefix)) return;
    if (ctx.msg.sender !== pending.sender) return;

    pendingPenalty.delete(ctx.chat.id);

    const rules = getRulesFromSettings(ctx);
    const rule = rules[pending.ruleIndex];
    const num = pending.ruleIndex + 1;

    const skip = !raw || ["não", "nao", "no", "n", "-"].includes(raw.toLowerCase());
    if (!skip && rule) {
      rule.penalty = raw;
      saveRules(ctx, rules);
    }

    await ctx.msg.reply.text(
      skip
        ? t("penaltySkipped", { num, text: rule?.text ?? "" })
        : t("penaltyAdded", { num, text: rule?.text ?? "", penalty: raw })
    );
    return;
  }

  const command = ctx.msg.command;
  const args = ctx.msg.args;

  // !rules [add|rm|mv]
  if (command === "rules") {
    const sub = args[0]?.toLowerCase();

    // !rules
    if (!sub) {
      const rules = getRulesFromSettings(ctx);
      if (rules.length === 0) {
        return void await ctx.msg.reply.text(t("empty", { cmd: rulesCmd }));
      }
      const list = rules
        .map((r, i) => `*${i + 1}.* ${r.text}${r.penalty ? `\n   ${t("penalty")}: ${r.penalty}` : ""}`)
        .join("\n\n");
      await ctx.msg.reply.text(t("list", { list, cmd: rulesCmd }));
      return;
    }

    // !rules add <text>
    if (sub === "add") {
      if (!ctx.chat.isGroup && !ctx.chat.isCommunity) {
        return void await ctx.msg.reply.text(t("groupOnly"));
      }
      if (!await ctx.chat.isSenderAdmin()) {
        return void await ctx.msg.reply.text(t("adminOnly"));
      }

      const text = args.slice(1).join(" ").trim();
      if (!text) {
        return void await ctx.msg.reply.text(t("addUsage", { cmd: rulesCmd }));
      }

      const rules = getRulesFromSettings(ctx);
      rules.push({ text, penalty: null });
      saveRules(ctx, rules);

      pendingPenalty.set(ctx.chat.id, { ruleIndex: rules.length - 1, sender: ctx.msg.sender });

      await ctx.msg.reply.text(t("added", { num: rules.length, text }));
      await ctx.msg.reply.text(t("askPenalty"));
      return;
    }

    // !rules rm <id>
    if (sub === "rm") {
      if (!await ctx.chat.isSenderAdmin()) {
        return void await ctx.msg.reply.text(t("adminOnly"));
      }

      const id = parseInt(args[1], 10);
      const rules = getRulesFromSettings(ctx);

      if (!args[1] || isNaN(id) || id < 1 || id > rules.length) {
        return void await ctx.msg.reply.text(t("rmUsage", { cmd: rulesCmd, max: rules.length || 1 }));
      }

      const [removed] = rules.splice(id - 1, 1);
      saveRules(ctx, rules);

      await ctx.msg.reply.text(t("removed", { text: removed.text }));
      return;
    }

    // !rules mv <id> up/down
    if (sub === "mv") {
      if (!await ctx.chat.isSenderAdmin()) {
        return void await ctx.msg.reply.text(t("adminOnly"));
      }

      const id = parseInt(args[1], 10);
      const dir = args[2]?.toLowerCase();
      const rules = getRulesFromSettings(ctx);

      const isUp = ["up", "cima"].includes(dir);
      const isDown = ["down", "baixo"].includes(dir);

      if (!args[1] || isNaN(id) || id < 1 || id > rules.length || (!isUp && !isDown)) {
        return void await ctx.msg.reply.text(t("mvUsage", { cmd: rulesCmd }));
      }

      if (isUp && id === 1) return void await ctx.msg.reply.text(t("alreadyFirst"));
      if (isDown && id === rules.length) return void await ctx.msg.reply.text(t("alreadyLast"));

      const swapIdx = isUp ? id - 2 : id;
      [rules[id - 1], rules[swapIdx]] = [rules[swapIdx], rules[id - 1]];
      saveRules(ctx, rules);

      await ctx.msg.reply.text(t("moved", { text: rules[isUp ? id - 2 : id].text }));
      return;
    }
  }

  // !warn @mention <id>
  if (command === "warn") {
    if (!ctx.chat.isGroup && !ctx.chat.isCommunity) {
      return void await ctx.msg.reply.text(t("groupOnly"));
    }
    if (!await ctx.chat.isSenderAdmin()) {
      return void await ctx.msg.reply.text(t("adminOnly"));
    }

    ctx.log.info(`warn: mentionedJid=${JSON.stringify(ctx.msg.mentionedJid)} args=${JSON.stringify(args)}`);

    let mentioned = ctx.msg.mentionedJid?.[0];
    if (!mentioned) {
      const replied = await ctx.msg.getReply();
      mentioned = replied?.sender;
    }
    ctx.log.info(`warn: mentioned=${mentioned}`);
    if (!mentioned) {
      return void await ctx.msg.reply.text(t("warnUsage", { cmd: warnCmd, rulesCmd }));
    }

    const ruleId = parseInt(args[args.length - 1], 10);
    const rules = getRulesFromSettings(ctx);
    ctx.log.info(`warn: ruleId=${ruleId} totalRules=${rules.length}`);

    if (isNaN(ruleId) || ruleId < 1 || ruleId > rules.length) {
      return void await ctx.msg.reply.text(t("warnUsage", { cmd: warnCmd, rulesCmd }));
    }

    const rule = rules[ruleId - 1];
    const penalty = rule.penalty ? `\n\n*${t("penalty")}:* ${rule.penalty}` : "";

    let dmText;
    if (ctx.chat.community) {
      let communityName = ctx.chat.name;
      if (!ctx.chat.isCommunity) {
        const communityChat = await ctx.chat.getChat(ctx.chat.community);
        if (communityChat) communityName = communityChat.name;
      }
      dmText = t("warnDmCommunity", { communityName, ruleNum: ruleId, ruleText: rule.text, penalty });
    } else {
      dmText = t("warnDm", { groupName: ctx.chat.name, ruleNum: ruleId, ruleText: rule.text, penalty });
    }

    try {
      await ctx.send.to(mentioned).text(dmText);
    } catch (err) {
      ctx.log.error(`warn: falha ao enviar DM para ${mentioned}`, err);
      return void await ctx.msg.reply.text(t("warnFailed"));
    }

    await ctx.msg.reply.text(t("warnSent"));
    return;
  }
}

