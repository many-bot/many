// plugins/release-notifier/index.js
//
// Avisa num chat do WhatsApp sempre que sair uma release nova, checando
// periodicamente o endpoint do release-server (o servidor HTTP que o
// post-receive/release.sh alimenta a cada tag processada).
//
// Comandos:
//   !release aqui   -> define o chat atual como destino dos avisos
//   !release check  -> força uma checagem imediata
//   !release        -> mostra o chat configurado e o menu de comandos
//
// Config (manybot.toml, todas opcionais):
//   RELEASE_ENDPOINT   - default "http://localhost:3006/release"
//   RELEASE_POLL_CRON  - default "*/2 * * * *" (a cada 2 minutos)
//   RELEASE_CHAT_ID    - chat padrão, usado se "!release aqui" nunca foi rodado
//                         (formato "5511999999999@c.us" ou "xxxxx@g.us")

import { readFileSync, writeFileSync, existsSync } from "fs";

const ENDPOINT_KEY = "RELEASE_ENDPOINT";
const DEFAULT_ENDPOINT = "http://localhost:3006/release";
const CRON_KEY = "RELEASE_POLL_CRON";
const DEFAULT_CRON = "*/2 * * * *";
const CHAT_SETTING_KEY = "releaseChatId";
const LAST_TAG_FILE = "last-tag.json";

function statusLabel(status) {
  switch (status) {
    case "staged":
      return "🕓 aguardando aprovação (`npm stage approve`)";
    case "published":
      return "✅ publicada no npm";
    case "rc-built":
      return "🧪 release candidate (não publicada)";
    case "built":
      return "🔧 build concluído (sem publish)";
    default:
      return status ?? "desconhecido";
  }
}

function formatMessage(release) {
  const shortCommit = (release.commit ?? "").slice(0, 7);
  const notes = (release.notes ?? "").trim();

  const lines = [
    `🚀 *Nova versão do ManyBot: ${release.name}*`,
    `Tag: \`${release.tag}\``,
    `Status: ${statusLabel(release.status)}`,
  ];
  if (shortCommit) lines.push(`Commit: \`${shortCommit}\``);
  if (notes) lines.push("", notes);
  lines.push(`Git diff:\nhttps://git.stxerr.dev/manybot.git/commit/?id=${shortCommit}`)

  return lines.join("\n");
}

function getTargetChatId(ctx) {
  const fromSettings = ctx.settings.global.get(CHAT_SETTING_KEY, null);
  if (fromSettings) return fromSettings;
  return ctx.config.get("RELEASE_CHAT_ID", null);
}

async function checkForRelease(ctx) {
  const endpoint = ctx.config.get(ENDPOINT_KEY, DEFAULT_ENDPOINT);

  let release;
  try {
    const res = await fetch(endpoint);
    if (res.status === 404) return; // nenhuma release publicada ainda, nada a fazer
    if (!res.ok) {
      ctx.log.warn(`release-notifier: endpoint respondeu ${res.status}`);
      return;
    }
    release = await res.json();
  } catch (err) {
    ctx.log.error(`release-notifier: falha ao consultar ${endpoint} — ${err.message}`);
    return;
  }

  if (!release?.tag) return;

  const lastTagPath = ctx.storage.resolve(LAST_TAG_FILE);
  const last = existsSync(lastTagPath)
    ? JSON.parse(readFileSync(lastTagPath, "utf-8"))
    : { tag: null };

  if (last.tag === release.tag) return; // já avisamos dessa tag, nada de novo

  const chatId = getTargetChatId(ctx);
  if (!chatId) {
    ctx.log.warn(
      'release-notifier: nenhum chat configurado — mande "!release aqui" no chat desejado, ou defina RELEASE_CHAT_ID no manybot.toml'
    );
    return;
  }

  await ctx.send.to(chatId).text(formatMessage(release));

  writeFileSync(lastTagPath, JSON.stringify({ tag: release.tag }, null, 2));
  ctx.log.success(`release-notifier: avisou sobre ${release.tag}`);
}

export async function setup(ctx) {
  const cron = ctx.config.get(CRON_KEY, DEFAULT_CRON);
  const endpoint = ctx.config.get(ENDPOINT_KEY, DEFAULT_ENDPOINT);

  ctx.scheduler.schedule(cron, async () => {
    await checkForRelease(ctx);
  });

  // checagem imediata ao subir o bot, sem esperar o primeiro tick do cron
  await checkForRelease(ctx);

  ctx.log.info(`release-notifier ativo — checando ${endpoint} (${cron})`);
}

export default async function (ctx) {
  if (ctx.msg.fromMe) return;
  if (!ctx.msg.is("release")) return;

  const sub = ctx.msg.args[0]?.toLowerCase();

  if (sub === "aqui") {
    ctx.settings.global.set(CHAT_SETTING_KEY, ctx.chat.id);
    await ctx.msg.reply.text(`Ok! Vou avisar releases novas aqui (${ctx.chat.name}).`);
    return;
  }

  if (sub === "check") {
    await ctx.msg.reply.text("Checando...");
    await checkForRelease(ctx);
    return;
  }

  const chatId = getTargetChatId(ctx);
  await ctx.msg.reply.text(
    chatId
      ? `Chat configurado pra avisos: ${chatId}\n\nComandos:\n!release aqui — muda o destino pra este chat\n!release check — força uma checagem agora`
      : 'Nenhum chat configurado ainda.\n\nMande "!release aqui" neste chat, ou defina RELEASE_CHAT_ID no manybot.toml.\n\nComandos:\n!release aqui — define este chat como destino\n!release check — força uma checagem agora'
  );
}
