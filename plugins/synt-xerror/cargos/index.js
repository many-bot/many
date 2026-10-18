const ROLE_SLUG_RE = /^[a-z0-9_]{1,32}$/;
const MENTION_RE = /(?<![\w@])@([a-z0-9_]{1,32})/gi;

const ACTION_ALIASES = {
  criar: "criar",
  create: "criar",
  apagar: "apagar",
  delete: "apagar",
  deletar: "apagar",
  emoji: "emoji",
  add: "add",
  adicionar: "add",
  remover: "remover",
  remove: "remover",
  status: "status",
  membros: "membros",
  members: "membros",
};

function getStore(ctx) {
  return ctx.settings.forChat(ctx.chat.community ?? ctx.chat.id);
}

function getRoles(ctx) {
  return getStore(ctx).get("roles", {});
}

function saveRoles(ctx, roles) {
  getStore(ctx).set("roles", roles);
}

function isEmoji(str) {
  if (!str || /[a-zA-Z0-9]/.test(str)) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(str);
}

function slugify(name) {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function requireAdmin(ctx, t) {
  if (!ctx.chat.isGroup) {
    await ctx.msg.reply.text(t("only_group"));
    return false;
  }
  if (!(await ctx.chat.isSenderAdmin())) {
    await ctx.msg.reply.text(t("admin_only"));
    return false;
  }
  return true;
}

async function resolveTargets(ctx) {
  if (ctx.msg.hasMention && ctx.msg.mentionedJid.length) return ctx.msg.mentionedJid;
  const quoted = await ctx.msg.getReply();
  return quoted?.sender ? [quoted.sender] : [];
}

async function buildMentionText(ctx, jids) {
  const parts = [];
  const mentions = [];
  for (const jid of jids) {
    const contact = await ctx.contacts.get(jid);
    if (contact?.mention) {
      parts.push(contact.mention.text);
      mentions.push(...contact.mention.mentions);
    } else {
      parts.push(`@${jid.split("@")[0]}`);
      mentions.push(jid);
    }
  }
  return { text: parts.join(" "), mentions };
}

export default async function (ctx) {
  if (ctx.msg.fromMe) return;

  const { t } = ctx.i18n.createT(import.meta.url);
  const prefix = ctx.config.get("CMD_PREFIX") ?? "";
  const cmd = `${prefix}cargo`;

  if (ctx.msg.command === "cargo") {
    const [rawSub, ...rest] = ctx.msg.args;
    const action = ACTION_ALIASES[(rawSub ?? "").toLowerCase()];

    if (!action) {
      return void await ctx.msg.reply.text(t("usage_root", { cmd }));
    }

    if (action === "criar") {
      if (!(await requireAdmin(ctx, t))) return;
      const [nomeRaw, emoji] = rest;
      const slug = slugify(nomeRaw);
      if (rest.length !== 2 || !ROLE_SLUG_RE.test(slug) || !isEmoji(emoji)) {
        return void await ctx.msg.reply.text(t("usage_create", { cmd }));
      }
      const roles = getRoles(ctx);
      if (roles[slug]) return void await ctx.msg.reply.text(t("role_exists"));
      roles[slug] = { name: nomeRaw, emoji, members: [] };
      saveRoles(ctx, roles);
      return void await ctx.msg.reply.text(t("role_created", { emoji, name: nomeRaw, slug }));
    }

    if (action === "apagar") {
      if (!(await requireAdmin(ctx, t))) return;
      if (!rest.length) {
        return void await ctx.msg.reply.text(t("role_name_required", { cmd }));
      }
      const slug = slugify(rest[0]);
      const roles = getRoles(ctx);
      if (!roles[slug]) return void await ctx.msg.reply.text(t("role_not_found"));
      delete roles[slug];
      saveRoles(ctx, roles);
      return void await ctx.msg.reply.text(t("role_deleted"));
    }

    if (action === "emoji") {
      if (!(await requireAdmin(ctx, t))) return;
      const [nomeRaw, emoji] = rest;
      const slug = slugify(nomeRaw);
      if (rest.length !== 2 || !isEmoji(emoji)) {
        return void await ctx.msg.reply.text(t("usage_emoji", { cmd }));
      }
      const roles = getRoles(ctx);
      if (!roles[slug]) return void await ctx.msg.reply.text(t("role_not_found"));
      roles[slug].emoji = emoji;
      saveRoles(ctx, roles);
      return void await ctx.msg.reply.text(t("role_emoji_updated", { name: roles[slug].name, emoji }));
    }

    if (action === "add" || action === "remover") {
      if (!(await requireAdmin(ctx, t))) return;
      const nomeRaw = rest.find((tok) => !/^@\d+$/.test(tok));
      if (!nomeRaw) {
        return void await ctx.msg.reply.text(t("role_name_required", { cmd }));
      }
      const slug = slugify(nomeRaw);
      const roles = getRoles(ctx);
      const role = roles[slug];
      if (!role) return void await ctx.msg.reply.text(t("role_not_found"));
      const targets = await resolveTargets(ctx);
      if (!targets.length) {
        return void await ctx.msg.reply.text(t("no_target"));
      }
      role.members =
        action === "add"
          ? Array.from(new Set([...role.members, ...targets]))
          : role.members.filter((jid) => !targets.includes(jid));
      saveRoles(ctx, roles);
      return void await ctx.msg.reply.text(t("member_count", { emoji: role.emoji, name: role.name, count: role.members.length }));
    }

    if (action === "status") {
      const roles = getRoles(ctx);
      const entries = Object.values(roles);
      if (!entries.length) return void await ctx.msg.reply.text(t("no_roles"));
      const lines = entries.map((r) => t("role_line", { emoji: r.emoji, name: r.name, count: r.members.length }));
      return void await ctx.msg.reply.text(lines.join("\n"));
    }

    if (action === "membros") {
      if (!rest.length) {
        return void await ctx.msg.reply.text(t("role_name_required", { cmd }));
      }
      const slug = slugify(rest[0]);
      const role = getRoles(ctx)[slug];
      if (!role) return void await ctx.msg.reply.text(t("role_not_found"));
      if (!role.members.length) return void await ctx.msg.reply.text(t("role_empty", { emoji: role.emoji, name: role.name }));
      const { text, mentions } = await buildMentionText(ctx, role.members);
      return void await ctx.msg.reply.text(`${role.emoji} *${role.name}*\n${text}`, { mentions });
    }

    return void await ctx.msg.reply.text(t("usage_root", { cmd }));
  }

  if (ctx.msg.hasPrefix || !ctx.chat.isGroup) return;

  const roles = getRoles(ctx);
  if (!Object.keys(roles).length) return;

  const matchedSlugs = new Set();
  for (const match of ctx.msg.body.matchAll(MENTION_RE)) {
    const slug = slugify(match[1]);
    if (roles[slug]) matchedSlugs.add(slug);
  }
  if (!matchedSlugs.size) return;

  for (const slug of matchedSlugs) {
    const role = roles[slug];
    if (!role.members.length) continue;
    const { text, mentions } = await buildMentionText(ctx, role.members);
    await ctx.msg.reply.text(`${role.emoji} *${role.name}*\n${text}`, { mentions });
  }
}

