/** @param {import('@manybot/types').PluginContext} ctx */
export default async function (ctx) {
  if (ctx.msg.fromMe) return;
  if (!ctx.msg.is("roll")) return;

  const { t } = ctx.i18n.createT(import.meta.url);
  const input = (ctx.msg.args[0] ?? "").trim();

  const diceMatch = input.match(/^(\d+)?d(\d+)$/i);
  const plainMatch = !diceMatch && input.match(/^(\d+)$/);

  if (!diceMatch && !plainMatch) {
    await ctx.msg.reply.text(t("invalid_usage"));
    return;
  }

  const randomInt = (max) => {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return (arr[0] % max) + 1;
  };

  if (plainMatch) {
    const faces = parseInt(plainMatch[1]);
    if (faces < 2 || faces > 10000) {
      await ctx.msg.reply.text(t("invalid_faces"));
      return;
    }
    await ctx.msg.reply.text(t("result_single", { result: randomInt(faces) }));
    return;
  }

  const count = Math.min(parseInt(diceMatch[1] || "1") || 1, 20);
  const faces = parseInt(diceMatch[2]);

  if (faces < 2 || faces > 10000) {
    await ctx.msg.reply.text(t("invalid_faces"));
    return;
  }

  const rolls = Array.from({ length: count }, () => randomInt(faces));
  const total = rolls.reduce((a, b) => a + b, 0);

  if (count === 1) {
    await ctx.msg.reply.text(t("result_one", { faces, total }));
  } else {
    await ctx.msg.reply.text(t("result_multi", {
      count,
      faces,
      breakdown: rolls.join("+"),
      total,
    }));
  }
}

