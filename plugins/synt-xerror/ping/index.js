// ping - ManyBot plugin
// See API reference here: https://manybot.stxerr.dev/docs/api-reference

/** @param {import('@manybot/types').PluginContext} ctx */
export default async function (ctx) {
  const { msg } = ctx;

  if (!msg.is("ping")) return;
  await msg.reply.text("Pong!");
}
