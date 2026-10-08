import { runDesmotCommand } from "../lib/pipeline.js";
import { resolveArgText, splitPair } from "../lib/media.js";

export default async function desmot(ctx, t) {
  const { msg } = ctx;
  if (!msg.is("desmot")) return;

  const [title, caption] = splitPair(await resolveArgText(ctx));

  await runDesmotCommand(ctx, { title, caption, t });
}
