// user-info - plugin do ManyBot
// Veja a referência da API em: https://manybot.stxerr.dev/docs/api-reference/pt

/** @param {import('@manybot/types/en').PluginContext} ctx */
async function resolveTarget(ctx) {
  let mentioned = ctx.msg.mentionedJid?.[0];
  if (!mentioned) { 
    const reply = await ctx.msg.getReply();
    if (!reply) return null;
    const contact = await reply.getContact();
    return contact;
  }
  return await ctx.contacts.get(mentioned);
}

/** @param {import('@manybot/types/en').PluginContext} ctx */
export default async function (ctx) {
  const { msg, contacts } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const pfpPath = ctx.storage.resolve("pfp.png");

  if (msg.is("get-pfp")) {
    const target = await resolveTarget(ctx);
    if (!target) return msg.reply.text(t("noTarget"));

    const pfp = await contacts.getPfpPath(target.id, pfpPath);
    if (!pfp) return msg.reply.text(t("noPfp"));

    await msg.reply.image(pfp);
    return;
  }
  if (msg.is("get-name")) {
    const target = await resolveTarget(ctx);
    if (!target) return msg.reply.text(t("noTarget"));

    const name = target.pushname || target.numberPretty;
    await msg.reply.text(name);
    return;
  }
}
