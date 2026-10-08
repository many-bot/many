import { createCanvas, loadImage } from "@napi-rs/canvas";
import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { join } from "path";
import { existsSync } from "fs";
import { PLUGIN_ROOT } from "../lib/paths.js";
import { getMediaMessage, downloadMedia } from "../lib/media.js";

// --- CONFIG ---
const custom = {
  x: 245,       // position
  y: 60,
  width: 130,   // size (set null to use original)
  height: 130, // null = auto from width keeping aspect ratio
};
// --- END CONFIG ---

async function compose(customImagePath, outputPath) {
  const [bottom, top, img] = await Promise.all([
    loadImage(join(PLUGIN_ROOT, "pope-bottom.png")),
    loadImage(join(PLUGIN_ROOT, "pope-top.png")),
    loadImage(customImagePath),
  ]);

  const canvas = createCanvas(bottom.width, bottom.height);
  const ctx = canvas.getContext("2d");

  // Layer 1: bottom
  ctx.drawImage(bottom, 0, 0);

  // Layer 2: custom image
  const w = custom.width ?? img.width;
  const h = custom.height ?? (custom.width ? img.height * (custom.width / img.width) : img.height);
  ctx.drawImage(img, custom.x, custom.y, w, h);

  // Layer 3: top (resized to match bottom's size)
  ctx.drawImage(top, 0, 0, bottom.width, bottom.height);

  const buffer = canvas.toBuffer("image/png");
  await writeFile(outputPath, buffer);
}

export default async function papa(ctx, t) {
  const { msg } = ctx;
  if (!msg.is("papa")) return;

  if (!existsSync(join(PLUGIN_ROOT, "pope-bottom.png")) || !existsSync(join(PLUGIN_ROOT, "pope-top.png"))) {
    return void await msg.reply.text(t("papa.noTemplate"));
  }

  const mediaTarget = await getMediaMessage(ctx);
  const replyTarget = !mediaTarget && msg.hasReply ? await msg.getReply() : null;
  const pfpSender = replyTarget?.sender ?? null;

  if (!mediaTarget && !pfpSender) return void await msg.reply.text(t("papa.needTarget"));

  ctx.download.enqueue(
    async () => {
      const id = randomUUID();
      const customPath = ctx.storage.resolve(`papa_in_${id}.png`);
      const outputPath = ctx.storage.resolve(`papa_out_${id}.png`);

      try {
        if (mediaTarget) {
          const media = await downloadMedia(mediaTarget);
          if (!media) return void await msg.reply.text(t("downloadFailed"));
          await writeFile(customPath, media.buffer);
        } else {
          const pfp = await ctx.contacts.getPfpPath(pfpSender, customPath).catch(() => null);
          if (!pfp) return void await msg.reply.text(t("papa.needTarget"));
        }

        await compose(customPath, outputPath);
        await msg.reply.image(outputPath);
      } finally {
        unlink(customPath).catch(() => {});
        unlink(outputPath).catch(() => {});
      }
    },
    async (err) => {
      ctx.log.error(`[papa] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}
