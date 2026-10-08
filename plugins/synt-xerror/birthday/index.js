const NIVER_DATA_KEY = "niverBirthdays";
const DATE_REGEX = /^(\d{2})\/(\d{2})$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_HORARIO = "00:00";
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TZ_OFFSET_MINUTES = -180; // UTC-3 fixo (sem DST)

function isValidDate(dd, mm) {
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

function nowInTz() {
  return new Date(Date.now() + TZ_OFFSET_MINUTES * 60000);
}

function todayDDMM() {
  const d = nowInTz();
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nowHHMM() {
  const d = nowInTz();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function loadData(ctx) {
  return (await ctx.settings.global.get(NIVER_DATA_KEY)) ?? {};
}

async function saveData(ctx, data) {
  await ctx.settings.global.set(NIVER_DATA_KEY, data);
}

function chatConfig(data, chatId) {
  return data[chatId] ?? { horario: DEFAULT_HORARIO, birthdays: [] };
}

async function resolveTarget(msg) {
  let targetId = msg.mentionedJid?.[0];
  if (!targetId) {
    const replied = await msg.getReply();
    targetId = replied?.sender;
  }
  if (!targetId) targetId = msg.sender;
  return targetId;
}

const USAGE_ADD =
  "Uso: *!niver add DD/MM @membro*\n\n" +
  "DD/MM é o dia e o mês do aniversário, separados por barra.\n" +
  "Exemplo: se o aniversário é 25 de dezembro, mande:\n" +
  "`!niver add 25/12 @membro`\n\n" +
  "Marque (@) a pessoa na mensagem, ou responda a uma mensagem dela.\n" +
  "Se não marcar ninguém, cadastro o aniversário de quem mandou o comando.";

const USAGE_RM =
  "Uso: *!niver rm @membro*\n\n" +
  "Marque (@) a pessoa cujo aniversário quer remover, ou responda a uma mensagem dela.\n" +
  "Se não marcar ninguém, removo o aniversário de quem mandou o comando.";

const USAGE_HORARIO =
  "Uso: *!niver horario HH:MM*\n\n" +
  "HH:MM é a hora e o minuto em que o aviso será enviado (horário de Brasília).\n" +
  "Exemplo, pra avisar às 9 da manhã:\n" +
  "`!niver horario 09:00`\n\n" +
  "Se não configurar, o padrão é 00:00 (meia-noite).";

let adminCtx = null;

export default async function (ctx) {
  const { msg, chat } = ctx;

  if (msg.fromMe) return;
  if (!msg.command || !msg.is("niver")) return;

  if (!chat.isGroup) {
    await msg.reply.text("Esse comando só funciona em grupos.");
    return;
  }

  const sub = (msg.args[0] ?? "").toLowerCase();
  const data = await loadData(ctx);
  const config = chatConfig(data, chat.id);

  if (sub === "add") {
    if (!(await chat.isSenderAdmin())) {
      await msg.reply.text("Só administradores podem configurar aniversários.");
      return;
    }

    const match = DATE_REGEX.exec(msg.args[1] ?? "");
    const targetId = await resolveTarget(msg);

    if (!match || !isValidDate(match[1], match[2]) || !targetId) {
      await msg.reply.text(USAGE_ADD);
      return;
    }

    const date = `${match[1]}/${match[2]}`;
    config.birthdays = config.birthdays.filter((b) => b.id !== targetId);
    config.birthdays.push({ id: targetId, date });
    data[chat.id] = config;
    await saveData(ctx, data);

    await msg.reply.text(`Aniversário registrado para ${date}.`);
    return;
  }

  if (sub === "rm" || sub === "remove") {
    if (!(await chat.isSenderAdmin())) {
      await msg.reply.text("Só administradores podem configurar aniversários.");
      return;
    }

    const targetId = await resolveTarget(msg);
    if (!targetId) {
      await msg.reply.text(USAGE_RM);
      return;
    }

    const before = config.birthdays.length;
    config.birthdays = config.birthdays.filter((b) => b.id !== targetId);
    data[chat.id] = config;
    await saveData(ctx, data);

    await msg.reply.text(
      before !== config.birthdays.length ? "Aniversário removido." : "Esse membro não tinha aniversário registrado."
    );
    return;
  }

  if (sub === "horario") {
    if (!(await chat.isSenderAdmin())) {
      await msg.reply.text("Só administradores podem configurar aniversários.");
      return;
    }

    const time = msg.args[1] ?? "";
    if (!TIME_REGEX.test(time)) {
      await msg.reply.text(USAGE_HORARIO);
      return;
    }

    config.horario = time;
    data[chat.id] = config;
    await saveData(ctx, data);

    await msg.reply.text(`Horário de aviso definido para ${time}.`);
    return;
  }

  if (sub === "list" || sub === "listar") {
    if (!config.birthdays.length) {
      await msg.reply.text("Nenhum aniversário cadastrado neste grupo.\n\nPra cadastrar, use:\n" + USAGE_ADD);
      return;
    }

    const lines = [];
    for (const b of config.birthdays) {
      const contact = await ctx.contacts.get(b.id, { groupId: chat.id }).catch(() => null);
      lines.push(`${b.date} — ${contact?.name ?? contact?.pushname ?? b.id}`);
    }
    await msg.reply.text(`Horário: ${config.horario}\n\n${lines.join("\n")}`);
    return;
  }

  await msg.reply.text(
    "🎂 *Aniversários do grupo*\n\n" +
    "*!niver add DD/MM @membro* -> cadastra o aniversário de alguém\n" +
    "_Exemplo: !niver add 25/12 @membro_\n" +
    "_Se não marcar ninguém, cadastra o de quem mandou_\n\n" +
    "*!niver rm @membro* -> remove um aniversário cadastrado\n\n" +
    "*!niver horario HH:MM* -> define a hora do aviso (padrão 00:00)\n" +
    "_Exemplo: !niver horario 09:00_\n\n" +
    "*!niver list* -> lista os aniversários cadastrados"
  );
}

export async function setup(ctx) {
  adminCtx = ctx;

  ctx.scheduler.schedule("* * * * *", async () => {
    const time = nowHHMM();
    const date = todayDDMM();
    const data = await loadData(adminCtx);

    for (const [chatId, config] of Object.entries(data)) {
      if ((config.horario ?? DEFAULT_HORARIO) !== time) continue;

      const todays = (config.birthdays ?? []).filter((b) => b.date === date);
      if (!todays.length) continue;

      const parts = [];
      const mentions = [];
      for (const b of todays) {
        const contact = await adminCtx.contacts.get(b.id, { groupId: chatId }).catch(() => null);
        if (!contact) continue;
        parts.push(contact.mention.text);
        mentions.push(...contact.mention.mentions);
      }
      if (!parts.length) continue;

      try {
        await adminCtx.send.to(chatId).text(`🎉 Hoje tem aniversário! Parabéns, ${parts.join(", ")}! 🎂`, { mentions });
      } catch (err) {
        adminCtx.log.error(`niver: falha ao enviar aviso em ${chatId}`, err);
      }
    }
  });
}

