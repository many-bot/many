export async function getMediaMessage(ctx) {
  const { msg } = ctx;
  if (msg.hasMedia) return msg;
  if (msg.hasReply) {
    const quoted = await msg.getReply();
    if (quoted?.hasMedia) return quoted;
  }
  return null;
}

export async function downloadMedia(mediaMsg, opts = {}) {
  const media = await mediaMsg.downloadMedia(opts);
  if (!media) return null;
  return {
    buffer: Buffer.from(media.data, "base64"),
    mimetype: media.mimetype,
    isAnimated: media.isAnimated,
  };
}

export async function getReplyText(ctx) {
  const { msg } = ctx;
  if (!msg.hasReply) return "";
  const reply = await msg.getReply();
  return reply?.body?.trim() ?? "";
}

// Falls back to the quoted message's text when the command itself carries
// no args — the pattern every command in this plugin needs (classico,
// simples, desmot).
export async function resolveArgText(ctx) {
  const { msg } = ctx;
  const raw = msg.args.join(" ").trim();
  return raw || (await getReplyText(ctx));
}

// "top/bottom" or "title/caption" style two-field parsing, shared by
// classico and desmot.
export function splitPair(raw, sep = "/") {
  const [a = "", b = ""] = raw.split(sep).map((s) => s.trim());
  return [a, b];
}
