import { runSimplesCommand } from "../lib/pipeline.js";
import { resolveArgText } from "../lib/media.js";

export default async function simples(ctx, t) {
  const { msg } = ctx;
  if (!msg.is("simples")) return;

  const text = await resolveArgText(ctx);

  await runSimplesCommand(ctx, { text, t });
}
