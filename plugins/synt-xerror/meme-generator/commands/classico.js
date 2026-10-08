import { runClassicoCommand } from "../lib/pipeline.js";
import { resolveArgText, splitPair } from "../lib/media.js";

export default async function classico(ctx, t) {
  const { msg } = ctx;
  if (!msg.is("classico")) return;

  const [top, bottom] = splitPair(await resolveArgText(ctx));

  await runClassicoCommand(ctx, { top, bottom, t });
}
