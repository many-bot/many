import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, existsSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  x: 320,
  y: 110,
  width: 240,
  height: 240,
};

/**
 * @param {string} customImagePath
 * @param {string} outputPath
 * @param {typeof DEFAULTS} [options]
 * @returns {Promise<string>} outputPath
 */
export async function composePope(customImagePath, outputPath, options = {}, circular = false) {
  const config = { ...DEFAULTS, ...options };

  const [bottom, top, img] = await Promise.all([
    loadImage(readFileSync(path.join(__dirname, "../pope-bottom.png"))),
    loadImage(readFileSync(path.join(__dirname, "../pope-top.png"))),
    loadImage(readFileSync(customImagePath)),
  ]);

  const canvas = createCanvas(bottom.width, bottom.height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(bottom, 0, 0);

  const w = config.width;
  const h = config.height;

  if (circular) {
    const cx = config.x + w / 2;
    const cy = config.y + h / 2;
    const r = Math.min(w, h) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, config.x, config.y, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(img, config.x, config.y, w, h);
  }

  ctx.drawImage(top, 0, 0);

  await writeFile(outputPath, canvas.toBuffer("image/png"));
  return outputPath;
}

function hasTemplates() {
  return (
    existsSync(path.join(__dirname, "../pope-bottom.png")) &&
    existsSync(path.join(__dirname, "../pope-top.png"))
  );
}

/**
 * @param {import('@manybot/types/en').PluginContext} ctx
 */
export default async function papa(ctx, t) {
  const { msg } = ctx;
  if (!msg.is("papa")) return;

  if (!hasTemplates()) {
    return void (await msg.reply.text(t("papa.noTemplate")));
  }

  let imagePath = null;
  let isTemp = false;

  let circular = false;

  if (msg.hasMedia) {
    const media = await msg.downloadMedia();
    if (!media) return void (await msg.reply.text(t("downloadFailed")));
    imagePath = ctx.storage.resolve(`papa_input_${randomUUID()}.png`);
    await writeFile(imagePath, Buffer.from(media.data, "base64"));
    isTemp = true;
  } else if (msg.hasReply) {
    const reply = await msg.getReply();
    if (reply?.hasMedia) {
      const media = await reply.downloadMedia();
      if (!media) return void (await msg.reply.text(t("downloadFailed")));
      imagePath = ctx.storage.resolve(`papa_input_${randomUUID()}.png`);
      await writeFile(imagePath, Buffer.from(media.data, "base64"));
      isTemp = true;
    } else {
      const contact = await reply.getContact();
      const pfpPath = ctx.storage.resolve(`papa_pfp_${randomUUID()}.png`);
      imagePath = await ctx.contacts.getPfpPath(contact.id, pfpPath);
      if (!imagePath) return void (await msg.reply.text(t("papa.noPfp")));
      circular = true;
    }
  } else if (msg.hasMention) {
    const mentionId = msg.mentionedJid?.[0];
    const pfpPath = ctx.storage.resolve(`papa_pfp_${randomUUID()}.png`);
    imagePath = await ctx.contacts.getPfpPath(mentionId, pfpPath);
    if (!imagePath) return void (await msg.reply.text(t("papa.noPfp")));
    circular = true;
  }

  if (!imagePath) {
    return void (await msg.reply.text(t("papa.needTarget")));
  }

  ctx.download.enqueue(
    async () => {
      const outputPath = ctx.storage.resolve(`papa_out_${randomUUID()}.png`);
      try {
        await composePope(imagePath, outputPath, {}, circular);
        await msg.reply.image(outputPath);
      } finally {
        unlink(outputPath).catch(() => {});
        if (isTemp) unlink(imagePath).catch(() => {});
      }
    },
    async (err) => {
      ctx.log.error(`[papa] ${err.message}`);
      await msg.reply.text(t("error"));
    }
  );
}

