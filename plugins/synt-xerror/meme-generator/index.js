import { registerFonts } from "./lib/fonts.js";
import quote from "./commands/quote.js";
import classico from "./commands/classico.js";
import simples from "./commands/simples.js";
import brat from "./commands/brat.js";
import desmot from "./commands/desmot.js";
import papa from "./commands/papa.js";

export async function setup(ctx) {
  registerFonts(ctx.log);
}

export default async function (ctx) {
  const { t } = ctx.i18n.createT(import.meta.url);

  // Sessão só pra evitar que um restart no meio da geração/envio (ffmpeg,
  // canvas) deixe trabalho pela metade — fecha assim que termina a leva.
  ctx.session.acquire();
  try {
    await quote(ctx, t);
    await classico(ctx, t);
    await simples(ctx, t);
    await brat(ctx, t);
    await desmot(ctx, t);
    await papa(ctx, t);
  } finally {
    ctx.session.release();
  }
}

