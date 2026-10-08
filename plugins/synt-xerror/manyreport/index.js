import { readFileSync, writeFileSync, existsSync } from "fs";

// Histórico manual de mensagens por chat — o ManyBot ainda não expõe isso
// nativamente, então guardamos aqui em memória (só texto, sem mídia e sem
// nome/número de quem mandou).
const HISTORICO_MAX = 10;
const historicoPorChat = new Map();

// Tickets ficam em disco (ctx.storage) pra sobreviver a restart. O bloco de
// 200 msgs/chat do ManyBot ainda pode evictar a mensagem original — ver
// buscarMensagemOriginal().
const TICKETS_MAX = 500;

/**
 * @param {string} chatId
 * @param {string} texto
 */
function registrarMensagem(chatId, texto) {
  const lista = historicoPorChat.get(chatId) ?? [];
  const hora = new Date().toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
  lista.push({ texto: texto.slice(0, 300), hora });
  if (lista.length > HISTORICO_MAX) lista.shift();
  historicoPorChat.set(chatId, lista);
}

/**
 * @param {string} chatId
 * @param {(...args: unknown[]) => string} t
 */
function formatarHistorico(chatId, t) {
  const lista = historicoPorChat.get(chatId) ?? [];
  if (lista.length === 0) return t("semHistorico");
  return lista.map((m) => `[${m.hora}] ${m.texto}`).join("\n");
}

/**
 * @param {import('@manybot/types').PluginContext} ctx
 */
function lerTickets(ctx) {
  const caminho = ctx.storage.resolve("tickets.json");
  if (!existsSync(caminho)) return { nextId: 1, tickets: {} };
  return JSON.parse(readFileSync(caminho, "utf-8"));
}

/**
 * @param {import('@manybot/types').PluginContext} ctx
 */
function salvarTickets(ctx, dados) {
  const ids = Object.keys(dados.tickets);
  if (ids.length > TICKETS_MAX) {
    for (const id of ids.slice(0, ids.length - TICKETS_MAX)) delete dados.tickets[id];
  }
  writeFileSync(ctx.storage.resolve("tickets.json"), JSON.stringify(dados, null, 2));
}

/**
 * Cria um ticket ligado à mensagem original (msgId) e devolve o número gerado.
 * @param {import('@manybot/types').PluginContext} ctx
 * @param {string} msgId
 * @param {string} chatId
 */
function criarTicket(ctx, msgId, chatId) {
  const dados = lerTickets(ctx);
  const id = String(dados.nextId);
  dados.tickets[id] = { msgId, chatId, criadoEm: Date.now() };
  dados.nextId += 1;
  salvarTickets(ctx, dados);
  return id;
}

/**
 * @param {import('@manybot/types').PluginContext} ctx
 * @param {string} id
 */
function buscarTicket(ctx, id) {
  return lerTickets(ctx).tickets[id] ?? null;
}

/**
 * @param {import('@manybot/types').SetupContext} ctx
 */
export async function setup(ctx) {
  const numero = ctx.config.get("REPORT_NUMBER");

  if (!numero) {
    ctx.log.warn(
      "manyreport: REPORT_NUMBER não configurado no manybot.toml — os reports não serão enviados a lugar nenhum."
    );
    return;
  }

  ctx.log.success(`manyreport carregado. Reports serão enviados para ${numero}.`);
}

/**
 * Garante que o número configurado vire um JID válido do WhatsApp.
 * Aceita tanto "5511999999999" quanto "5511999999999@s.whatsapp.net".
 * @param {string} numero
 */
function paraJid(numero) {
  const limpo = String(numero).trim();
  return limpo.includes("@") ? limpo : `${limpo.replace(/\D/g, "")}@s.whatsapp.net`;
}

/**
 * @param {string | null | undefined} valor
 */
function apenasDigitos(valor) {
  return valor ? String(valor).replace(/\D/g, "") : "";
}

/**
 * Confere se quem mandou o comando é o admin configurado em REPORT_NUMBER.
 * Prioriza o chat.id (PV do bot é sempre @c.us baseado em número, não passa
 * pela resolução de LID) e só recorre ao contato do remetente como reforço —
 * senderPn sozinho é resolução passiva e pode nunca resolver.
 * @param {import('@manybot/types').PluginContext} ctx
 * @param {string} numeroConfigurado
 */
async function ehAdminConfigurado(ctx, numeroConfigurado) {
  if (!numeroConfigurado) return false;
  const numeroAlvo = apenasDigitos(numeroConfigurado);

  if (!ctx.chat.isGroup && apenasDigitos(ctx.chat.id) === numeroAlvo) return true;

  const contato = await ctx.msg.getContact();
  return apenasDigitos(contato?.numberRaw) === numeroAlvo;
}

/**
 * @param {import('@manybot/types').PluginContext} ctx
 */
export default async function (ctx) {
  const { msg, chat } = ctx;
  const { t } = ctx.i18n.createT(import.meta.url);
  const prefixo = ctx.config.get("CMD_PREFIX", "!");
  const numeroConfigurado = ctx.config.get("REPORT_NUMBER");

  if (msg.fromMe) return;

  if (!msg.hasPrefix && msg.type === "chat" && msg.body.trim()) {
    registrarMensagem(chat.id, msg.body.trim());
  }

  if (msg.is("fechar")) {
    if (!numeroConfigurado || !(await ehAdminConfigurado(ctx, numeroConfigurado))) return;

    const ticketId = msg.args[0];
    if (!ticketId) {
      await msg.reply.text(t("usoFechar", { prefixo }));
      return;
    }

    const dados = lerTickets(ctx);
    const ticket = dados.tickets[ticketId];
    if (!ticket) {
      await msg.reply.text(t("ticketNaoEncontrado", { ticket: ticketId }));
      return;
    }
    if (ticket.fechado) {
      await msg.reply.text(t("ticketJaFechado", { ticket: ticketId }));
      return;
    }

    ticket.fechado = Date.now();
    salvarTickets(ctx, dados);
    await msg.reply.text(t("ticketFechado", { ticket: ticketId }));
    return;
  }

  if (msg.is("responder")) {
    if (!numeroConfigurado || !(await ehAdminConfigurado(ctx, numeroConfigurado))) return;

    const ticketId = msg.args[0];
    const resposta = msg.args.slice(1).join(" ").trim();

    if (!ticketId || !resposta) {
      await msg.reply.text(t("usoResponder", { prefixo }));
      return;
    }

    const ticket = buscarTicket(ctx, ticketId);
    if (!ticket) {
      await msg.reply.text(t("ticketNaoEncontrado", { ticket: ticketId }));
      return;
    }
    if (ticket.fechado) {
      await msg.reply.text(t("ticketJaFechadoResponder", { ticket: ticketId }));
      return;
    }

    const mensagemOriginal = await chat.getMsg(ticket.msgId);

    try {
      if (mensagemOriginal) {
        await mensagemOriginal.reply.text(t("templateResposta", { texto: resposta }));
        await msg.reply.text(t("respostaEnviada", { ticket: ticketId }));
      } else {
        await ctx.send
          .to(ticket.chatId)
          .text(t("templateRespostaFallback", { ticket: ticketId, texto: resposta }));
        await msg.reply.text(t("respostaEnviadaSemCitar", { ticket: ticketId }));
      }
    } catch (err) {
      ctx.log.error(`manyreport: falha ao enviar resposta do ticket #${ticketId} — ${err.message}`);
      await msg.reply.text(t("falhaEnvioResposta"));
    }
    return;
  }

  const ehBug = msg.is("bug");
  const ehSugestao = msg.is("sugestao") || msg.is("sugerir");

  if (!ehBug && !ehSugestao) return;

  const conteudo = msg.args.join(" ").trim();

  if (!conteudo) {
    await msg.reply.text(ehBug ? t("usoBug", { prefixo }) : t("usoSugestao", { prefixo }));
    return;
  }

  if (!numeroConfigurado) {
    ctx.log.error("manyreport: REPORT_NUMBER não configurado no manybot.toml.");
    await msg.reply.text(t("naoConfigurado"));
    return;
  }

  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const tipoLabel = ehBug ? t("tipoBug") : t("tipoSugestao");
  const origemChat = chat.isGroup ? t("grupo") : t("privado");
  const historico = formatarHistorico(chat.id, t);
  const ticketId = criarTicket(ctx, msg.id, chat.id);

  const relatorio = t("templateRelatorio", {
    tipo: tipoLabel,
    conteudo,
    origem: origemChat,
    data: agora,
    historico,
    ticket: ticketId,
  });

  try {
    const destino = paraJid(numeroConfigurado);
    await ctx.send.to(destino).text(relatorio);
    await msg.reply.text(ehBug ? t("confirmadoBug") : t("confirmadoSugestao"));
    ctx.log.info(`manyreport: ${tipoLabel} enviado (ticket #${ticketId}).`);
  } catch (err) {
    ctx.log.error(`manyreport: falha ao enviar report — ${err.message}`);
    await msg.reply.text(t("falhaEnvio"));
  }
}

