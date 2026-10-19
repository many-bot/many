// manydev - ManyBot plugin
// See API reference here: https://manybot.stxerr.dev/docs/api-reference

/** @param {import('@manybot/types').PluginContext} ctx */
export default async function (ctx) {
  const { msg, chat, contacts } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);

  if (msg.is("lid")) {
    const reply = await msg.getReply();
    const mentionedId = msg.mentionedJid?.[0];

    let cont = null;
    if (reply) {
      cont = await reply.getContact();
    } else if (mentionedId) {
      cont = await contacts.get(mentionedId).catch(() => null);
    }

    if (!cont) {
      await msg.reply.text(t("lidMissingTarget"));
      return;
    }

    await msg.reply.text(
      t("lidResult", { name: cont.mention.text, id: cont.id }),
      cont.mention
    );
  }

  if (msg.is("jid")) {
    if (!chat.isGroup) {
      await msg.reply.text(t("jidGroupOnly"));
      return;
    }

    await msg.reply.text(t("jidResult", { id: chat.id }));
  }
}

