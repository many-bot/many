// manydev - ManyBot plugin
// See API reference here: https://manybot.stxerr.dev/docs/api-reference

/** @param {import('@manybot/types').PluginContext} ctx */
export default async function (ctx) {
  const { msg, chat } = ctx;

  if (msg.is("lid")) {
    const reply = await msg.getReply();

    if (!reply) {
      await msg.reply.text("Você precisa responder a uma mensagem.");
      return;
    }

    const cont = await reply.getContact();

    await msg.reply.text(
      `O LID do usuário ${cont.mention.text} é:\n${cont.id}`,
      cont.mention
    );
  }
  
  if (msg.is("jid")) {
    if (!chat.isGroup) {
      await msg.reply.text("Esse comando só funciona em grupos.");
      return;
    }

    await msg.reply.text(`O JID desse chat é:\n${chat.id}`);
  }
}
