export default async function (ctx) {
  const { msg } = ctx;
  if (!msg.is("ping")) return;
  await msg.reply.text("Pong!");
}
