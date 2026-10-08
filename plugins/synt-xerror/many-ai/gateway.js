// src/plugins/many-ai/gateway.js
// Single decision point for "should the AI even look at this message".
//
// Two stages, cheapest first:
//   1. preFilter()  — pure JS, no API call. Rules out the vast majority of
//      messages for free (wrong prefix, too short, no name/question/help
//      hint, nothing pending). Returns null when there's nothing worth
//      spending even the cheap model on.
//   2. runGateway()  — one call to Mistral Small with structured JSON output,
//      only for the reasons preFilter flagged as ambiguous. Returns a structured
//      verdict: { respond, vision, tools, model, reason }.
//
// The expensive agent model (index.js's resolveReply) is only ever invoked
// after this returns respond:true — it never has to decide for itself whether
// to speak.
//
// A third, unrelated cheap check lives here too: looksHallucinationProne()
// flags messages about bot commands, ManyBot itself, or external
// facts/sources — topics the agent model has no real grounding for and can
// plausibly make up an answer about. index.js uses this to decide whether
// to append a "don't fully trust this" disclaimer after the real reply.
// Pure JS, same "cheapest first" philosophy as preFilter — no API call.

import { getKeyPool, withKeyFailover } from "./apiKeys.js";
import { isTooShortToConsider, looksLikeUnansweredQuestion, looksLikeHelpRequest } from "./intervention.js";

export const VERDICT = Object.freeze({
  ANSWER: "ANSWER",
  MAYBE:  "MAYBE",
  SILENT: "SILENT",
});

// Three cheap, independent categories where the agent model is prone to
// confidently inventing an answer instead of admitting it doesn't know:
// - bot commands (their exact syntax/behavior isn't something it was
//   trained on — it only knows what's in this system prompt)
// - ManyBot itself (its features, internals, roadmap — same problem)
// - anything pointing at an external, checkable fact/source (official
//   links, docs, "latest version", prices, news) that it did not just
//   verify with a tool in this exchange
const HALLUCINATION_RISK_RE = {
  commands: /\b(comando|comandos|command|commands)\b|(^|\s)!\w+/i,
  manybot:  /\bmany[\s-]?bot\b/i,
  external: /\b(fonte|fontes|source|sources|documenta[cç][aã]o|documentation|site oficial|official (site|docs?)|link oficial|onde (baixo|encontro|acho)|changelog|release notes?|vers[aã]o (mais recente|atual)|latest version|not[ií]cia|not[ií]cias)\b/i,
};

/**
 * Cheap heuristic, no API call: does this message ask about something the
 * agent model could easily hallucinate (bot commands, ManyBot itself, or an
 * external/checkable fact) without having actually looked it up? Used only
 * to decide whether to show a disclaimer after the reply — never blocks or
 * changes the reply itself.
 */
export function looksHallucinationProne(body) {
  const text = (body || "").trim();
  if (!text) return false;
  return Object.values(HALLUCINATION_RISK_RE).some(re => re.test(text));
}

const GATE_MAX_TOKENS = 150;

const DETERMINISTIC_REASONS = new Set(["command", "quote"]);

export function isDeterministic(reason) {
  return DETERMINISTIC_REASONS.has(reason);
}

export const DIRECT_TRIGGER_REASONS = new Set(["command", "quote", "continuation", "mention"]);

function buildVerdictSchema(includeTaskType) {
  const properties = {
    respond: { type: "boolean", description: "Should the AI produce a reply to this message?" },
    vision:  { type: "boolean", description: "Does the AI need image understanding to answer this message?" },
    tools:   { type: "array", items: { type: "string" }, description: "Subset of tools relevant for this request (empty = no tools needed)" },
    model:   { type: "string", enum: ["small", "medium", "large"], description: "Model tier to use (optional, default medium)" },
    reason:  { type: "string", description: "Brief explanation of the verdict" },
  };
  const required = ["respond", "vision", "tools", "model", "reason"];
  if (includeTaskType) {
    properties.task_type = { type: "string", enum: ["SIMPLE", "COMPLEX"], description: "SIMPLE for normal conversation/questions; COMPLEX for anything needing code generation/review, building files (HTML/CSS/JS, scripts, documents), or multi-step technical reasoning" };
    required.push("task_type");
  }
  return {
    type: "json_schema",
    json_schema: {
      name: "gateway_verdict",
      strict: true,
      schema: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

const TASK_TYPE_NOTE_PT = ` Classifique também task_type: "COMPLEX" se resolver isso exigir gerar ou revisar código, montar/editar arquivos (HTML/CSS/JS, scripts, documentos, planilhas), ou raciocínio técnico em várias etapas; "SIMPLE" para conversa normal, perguntas diretas, pesquisa simples.`;
const TASK_TYPE_NOTE_EN = ` Also classify task_type: "COMPLEX" if resolving this needs generating or reviewing code, building/editing files (HTML/CSS/JS, scripts, documents, spreadsheets), or multi-step technical reasoning; "SIMPLE" for normal conversation, direct questions, simple lookups.`;

export function preFilter({
  msg,
  quotedRaw,
  wordRE,
  triggers = [],
  commandName,
  hasPendingContinuation = false,
  isGroup = false,
  lang = "pt",
}) {
  if (commandName && msg.is(commandName)) return { reason: "command", dm: !isGroup };

  // quotedRaw is whatever msg.getReply() resolved to — a normalized message
  // (has .fromMe, .senderName, ...), never raw platform data.
  if (quotedRaw?.fromMe) return { reason: "quote", dm: !isGroup };

  const repliesToSomeoneElse = !!quotedRaw && !quotedRaw.fromMe;

  if (hasPendingContinuation && !repliesToSomeoneElse) return { reason: "continuation", dm: !isGroup };

  if (msg.hasPrefix) return null;

  const body = (msg.body || "").trim();
  const mentioned = (wordRE?.test(body)) || triggers.some(tr => body.toLowerCase().includes(tr.toLowerCase()));
  if (mentioned) return { reason: "mention", dm: !isGroup };

  if (isTooShortToConsider(body)) return null;

  if (isGroup) {
    if (looksLikeUnansweredQuestion(body)) return { reason: "question", dm: false };
    if (looksLikeHelpRequest(body, lang)) return { reason: "help", dm: false };
    return null;
  }

  return { reason: "dm-message", dm: true };
}

function buildGatewayPrompt(reason, lang, aiName, taskTypeEnabled = true) {
  const name = (aiName || "").trim();
  const pt = lang === "pt";
  const taskTypeNote = taskTypeEnabled ? (pt ? TASK_TYPE_NOTE_PT : TASK_TYPE_NOTE_EN) : "";
  const taskTypeField = taskTypeEnabled ? `, task_type ("SIMPLE"|"COMPLEX")` : "";

  const base = pt
    ? `Responda em JSON válido com os campos: respond (boolean), vision (boolean), tools (array de strings), model ("small"|"medium"|"large")${taskTypeField}, reason (string).${taskTypeNote}`
    : `Reply in valid JSON with fields: respond (boolean), vision (boolean), tools (array of strings), model ("small"|"medium"|"large")${taskTypeField}, reason (string).${taskTypeNote}`;

  switch (reason) {
    case "continuation":
      return pt
        ? `A pessoa acabou de falar com a IA (chamada "${name}") há pouco, numa janela de continuidade. Avalie a mensagem marcada [CURRENT MESSAGE]: ela genuinamente continua essa conversa com a IA, ou é outra coisa (mudou de assunto, está falando com outra pessoa, é só um comentário solto)? Se a mensagem atual for apenas uma mídia sem legenda (aparece como algo do tipo "(image message, no caption)", "(sticker message, no caption)", "(video message, no caption)" ou "(document message, no caption)"), sem nenhum texto real, isso raramente é uma continuação genuína — prefira respond:false nesse caso, a menos que a mensagem anterior da IA deixe claro que uma mídia era esperada como resposta (ex: você pediu uma foto, um print, um documento). respond:true se continua a conversa com a IA. respond:false caso contrário. ${base}`
        : `The person just talked to the AI (named "${name}") moments ago, inside a continuation window. Evaluate the message tagged [CURRENT MESSAGE]: does it genuinely continue that conversation with the AI, or is it something else (topic change, talking to someone else, an unrelated remark)? If the current message is just a media placeholder with no caption (shows up as something like "(image message, no caption)", "(sticker message, no caption)", "(video message, no caption)", or "(document message, no caption)"), with no real text, that's rarely a genuine continuation — prefer respond:false unless the AI's previous message made clear that a media reply was expected (e.g. you asked for a photo, a screenshot, a document). respond:true if it continues the conversation with the AI. respond:false otherwise. ${base}`;

    case "mention": {
      return pt
        ? `Avalie SOMENTE a mensagem [CURRENT MESSAGE]. É uma chamada direta à IA, ou só uma menção a ela numa conversa entre outras pessoas? respond:true se for chamada direta. respond:false se for só menção. ${base}`
        : `Evaluate ONLY the message tagged [CURRENT MESSAGE]. Is it a direct call to the AI, or just a mention of it in conversation between other people? respond:true if it's a direct call. respond:false if it's just a mention. ${base}`;
    }

    // The AI's own name literally appears in the text — much stronger
    // signal than a generic trigger phrase, so this gate is intentionally
    // looser (one condition, not several) and defaults to respond:true
    // unless it's clearly third-person talk about the AI.
    case "mention-named": {
      return pt
        ? `Avalie SOMENTE a mensagem [CURRENT MESSAGE]. O nome "${name}" aparece nela — isso já é um forte sinal de chamada direta à IA. respond:false só se for claramente uma menção em terceira pessoa, sem se dirigir a ela (ex: "o ${name} respondeu isso errado ontem", "vocês viram o site do ${name}?"). Em qualquer outro caso, respond:true. ${base}`
        : `Evaluate ONLY the message tagged [CURRENT MESSAGE]. The name "${name}" appears in it — that's already a strong signal of a direct call to the AI. respond:false only if it's clearly third-person talk about the AI, not addressed to it (e.g. "${name} got that wrong yesterday", "did you see ${name}'s site?"). In any other case, respond:true. ${base}`;
    }

    case "question": {
      const effortNote = pt
        ? ` Além disso, respond:true exige que responder precise de mais do que só falar: pesquisa (SEARCH/FETCH/WIKI), uma skill (SKILL), memória (MEM_READ) ou outra ferramenta — preencha "tools" com o que seria necessário. Se a IA já sabe a resposta de cabeça, sem precisar consultar nada, prefira respond:false: não vale a pena interromper a conversa do grupo por algo trivial que qualquer um saberia responder.`
        : ` Also, respond:true requires that answering needs more than just talking: research (SEARCH/FETCH/WIKI), a skill (SKILL), memory (MEM_READ), or another tool — fill "tools" with what would be needed. If the AI already knows the answer off the top of its head, with nothing to look up, prefer respond:false: it's not worth interrupting the group's conversation for something trivial anyone could answer.`;
      return pt
        ? `Analise a mensagem [CURRENT MESSAGE] e as [OLD MESSAGE] recentes do histórico. A pergunta é dirigida a UMA PESSOA ESPECÍFICA do grupo (ex: "pro seu estado?", "você vai?", algo pessoal que só um membro pode responder)? A pergunta é parte de um diálogo entre outros membros onde a IA não está envolvida? A pergunta é casual/pessoal (ex: sobre planos, sentimentos, opinião pessoal de alguém) e não uma dúvida técnica ou de conhecimento geral? Se SIM para qualquer um desses — respond:false. respond:true só se for uma pergunta genuína de conhecimento geral ou técnica, feita ao grupo sem destinatário específico.${effortNote} ${base}`
        : `Analyze [CURRENT MESSAGE] and recent [OLD MESSAGE] entries from history. Is this question directed at A SPECIFIC PERSON in the group (e.g. "what about you?", personal plans, something only a member could answer)? Is it part of a conversation between other people the AI isn't part of? Is it casual/personal rather than a technical or general-knowledge question? If YES to any of these — respond:false. respond:true only if it's a genuine general-knowledge or technical question posed to the whole group with no specific addressee.${effortNote} ${base}`;
    }

    case "help": {
      const effortNote = pt
        ? ` Além disso, respond:true exige que resolver o pedido precise de mais do que só falar: pesquisa (SEARCH/FETCH/WIKI), uma skill (SKILL), memória (MEM_READ) ou outra ferramenta — preencha "tools" com o que seria necessário. Se a IA já sabe a resposta de cabeça, sem precisar consultar nada, prefira respond:false.`
        : ` Also, respond:true requires that resolving this needs more than just talking: research (SEARCH/FETCH/WIKI), a skill (SKILL), memory (MEM_READ), or another tool — fill "tools" with what would be needed. If the AI already knows the answer off the top of its head, with nothing to look up, prefer respond:false.`;
      return pt
        ? `Analise [CURRENT MESSAGE] e as [OLD MESSAGE] recentes. Este pedido de ajuda é parte de um diálogo entre outros membros? A pessoa está pedindo ajuda de ALGUÉM EM ESPECÍFICO (ex: chamou o nome de outra pessoa, respondeu à mensagem de outro)? A "ajuda" é algo pessoal/cotidiano que só outra pessoa do grupo pode dar (ex: pedir carona, perguntar se alguém tem algo)? Se SIM — respond:false. respond:true só se for um pedido de ajuda claro e genuíno que a IA pode resolver (dúvida técnica, explicação, informação factual).${effortNote} ${base}`
        : `Analyze [CURRENT MESSAGE] and recent [OLD MESSAGE] entries. Is this help request part of a conversation between other people? Is the person asking for help from SOMEONE SPECIFIC (e.g. called another person by name, replied to someone else)? Is the "help" personal/daily-life that only another group member can provide? If YES — respond:false. respond:true only if it's a clear, genuine help request the AI can actually resolve (technical question, explanation, factual info).${effortNote} ${base}`;
    }

    case "dm-message":
    default: {
      const effortNote = pt
        ? ` Além disso, prefira respond:true quando resolver o pedido exigir pesquisa (SEARCH/FETCH/WIKI), uma skill (SKILL), memória (MEM_READ) ou outra ferramenta — preencha "tools" de acordo. Se for algo trivial que a IA já sabe de cabeça e só precisaria "falar" (small talk, uma resposta óbvia), prefira respond:false, a menos que a pessoa esteja claramente travada esperando qualquer resposta.`
        : ` Also, prefer respond:true when resolving this needs research (SEARCH/FETCH/WIKI), a skill (SKILL), memory (MEM_READ), or another tool — fill "tools" accordingly. If it's something trivial the AI already knows off the top of its head and would just be "talking" (small talk, an obvious answer), prefer respond:false, unless the person is clearly stuck waiting on any answer at all.`;
      return pt
        ? `Decida se a IA deve responder espontaneamente nesta conversa privada. respond:true se a pessoa está genuinamente travada e precisa de ajuda (pediu algo específico, bateu num erro, está claramente perdida). respond:false para qualquer outro caso (comentário simples, erro de digitação, algo que outro plugin já resolveria).${effortNote} Vision: examine a mensagem — se contiver uma mídia com legenda explícita ("o que é isso?", "como fazer?", "olha este erro") que exija análise visual, marque vision:true. Dica: se a mensagem for texto puro sem mídia, vision:false. ${base}`
        : `Decide whether the AI should respond on its own in this private chat. respond:true if the person is genuinely stuck and needs help (asked for something specific, hit an error, is clearly lost). respond:false for anything else (a simple comment, a typo, something another plugin would already handle).${effortNote} Vision: examine the message — if it contains media with an explicit caption ("what is this?", "how do I fix this?", "look at this error") that demands visual analysis, set vision:true. Hint: if the message is plain text without media, vision:false. ${base}`;
    }
  }
}

function toGatewayApiMessages(history) {
  return history.map(entry => ({ role: entry.role, content: entry.content }));
}

function callGatewayMistral(messages, systemPrompt, apiKey, model, maxTokens, schema) {
  return fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...toGatewayApiMessages(messages)],
      max_tokens: maxTokens,
      response_format: schema,
    }),
  });
}

function parseVerdictObj(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed.respond !== "boolean") return null;
  if (typeof parsed.vision !== "boolean") parsed.vision = false;
  if (!Array.isArray(parsed.tools)) parsed.tools = [];
  if (!["small", "medium", "large"].includes(parsed.model)) parsed.model = "medium";
  if (!["SIMPLE", "COMPLEX"].includes(parsed.task_type)) parsed.task_type = "SIMPLE";
  if (typeof parsed.reason !== "string") parsed.reason = "";
  return {
    respond: parsed.respond,
    vision: parsed.vision,
    tools: parsed.tools,
    model: parsed.model,
    taskType: parsed.task_type,
    reason: parsed.reason,
  };
}

/**
 * Returns the structured verdict object: { respond, vision, tools, model, reason }.
 * Never throws — any failure just means respond:false.
 */
export async function runGatewayStructured({ reason, history, ctx, aiName, lang = "pt", gateModel, taskTypeEnabled = true }) {
  if (isDeterministic(reason)) {
    return { respond: true, vision: false, tools: [], model: "medium", taskType: "SIMPLE", reason: `deterministic: ${reason}` };
  }

  const keys = getKeyPool(ctx, "MISTRAL");
  if (!keys.length) return { respond: false, vision: false, tools: [], model: "medium", reason: "no_api_keys" };

  const prompt = buildGatewayPrompt(reason, lang, aiName, taskTypeEnabled);
  const schema = buildVerdictSchema(taskTypeEnabled);
  try {
    const raw = await withKeyFailover(keys, async (key) => {
      const res = await callGatewayMistral(history, prompt, key, gateModel, GATE_MAX_TOKENS, schema);
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) {
          const e = new Error("rate_limit");
          e.isRateLimit = true;
          throw e;
        }
        if (res.status === 401 || res.status === 403) {
          const e = new Error(`key rejected (${res.status})`);
          e.isInvalidKey = true;
          throw e;
        }
        if (res.status >= 500) {
          const e = new Error(`Mistral API error ${res.status}`);
          e.isTransient = true;
          throw e;
        }
        throw new Error(`Mistral API error ${res.status}: ${body}`);
      }
      const data = await res.json();
      return data.choices[0]?.message?.content || "";
    }, ctx.log);

    const parsed = parseVerdictObj(raw);
    if (parsed) {
      ctx.log?.info?.(`[many-ai:gateway] response: ${JSON.stringify(parsed)}`);
      return parsed;
    }

    ctx.log?.warn?.(`[many-ai:gateway] unparseable verdict: ${raw}`);
    return { respond: false, vision: false, tools: [], model: "medium", taskType: "SIMPLE", reason: "unparseable_verdict" };
  } catch (err) {
    ctx.log?.error?.(`[many-ai:gateway] error: ${err.message}`);
    return { respond: false, vision: false, tools: [], model: "medium", taskType: "SIMPLE", reason: "gateway_error" };
  }
}

/**
 * Legacy wrapper: calls runGatewayStructured and returns the old VERDICT string
 * for backward compatibility with index.js callers.
 */
export async function runGateway(opts) {
  const verdict = await runGatewayStructured(opts);
  if (verdict.respond) return VERDICT.ANSWER;
  return VERDICT.SILENT;
}

const TASK_TYPE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "task_type_verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        task_type: { type: "string", enum: ["SIMPLE", "COMPLEX"] },
      },
      required: ["task_type"],
      additionalProperties: false,
    },
  },
};

function buildTaskTypeOnlyPrompt(lang) {
  return lang === "pt"
    ? `Classifique a mensagem marcada [CURRENT MESSAGE] (a pessoa já vai receber uma resposta — não avalie se deve responder, só o tipo de tarefa). "COMPLEX" se atendê-la exigir gerar ou revisar código, montar/editar arquivos (HTML/CSS/JS, scripts, documentos, planilhas), ou raciocínio técnico em várias etapas. "SIMPLE" para conversa normal, perguntas diretas, pesquisa simples. Responda em JSON válido: {"task_type": "SIMPLE"|"COMPLEX"}.`
    : `Classify the message tagged [CURRENT MESSAGE] (the person is already getting a reply — don't judge whether to respond, only the task type). "COMPLEX" if fulfilling it needs generating or reviewing code, building/editing files (HTML/CSS/JS, scripts, documents, spreadsheets), or multi-step technical reasoning. "SIMPLE" for normal conversation, direct questions, simple lookups. Reply in valid JSON: {"task_type": "SIMPLE"|"COMPLEX"}.`;
}

/**
 * Cheap, dedicated task-type-only classification — used for triggers that
 * skip the full respond-gate entirely (command/quote: the AI is always
 * going to reply, so runGatewayStructured short-circuits to a hardcoded
 * "SIMPLE" instead of spending a call on it). Callers should only invoke
 * this when multi-provider routing is actually enabled, since it's an
 * extra API call this codepath didn't make before. Never throws — any
 * failure just means "SIMPLE" (stays on the default provider).
 */
export async function classifyTaskType({ history, ctx, lang = "pt", gateModel }) {
  const keys = getKeyPool(ctx, "MISTRAL");
  if (!keys.length) return "SIMPLE";

  const prompt = buildTaskTypeOnlyPrompt(lang);
  try {
    const raw = await withKeyFailover(keys, async (key) => {
      const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          model: gateModel,
          messages: [{ role: "system", content: prompt }, ...toGatewayApiMessages(history)],
          max_tokens: 50,
          response_format: TASK_TYPE_SCHEMA,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) { const e = new Error("rate_limit"); e.isRateLimit = true; throw e; }
        if (res.status === 401 || res.status === 403) { const e = new Error(`key rejected (${res.status})`); e.isInvalidKey = true; throw e; }
        if (res.status >= 500) { const e = new Error(`Mistral API error ${res.status}`); e.isTransient = true; throw e; }
        throw new Error(`Mistral API error ${res.status}: ${body}`);
      }
      const data = await res.json();
      return data.choices[0]?.message?.content || "";
    }, ctx.log);

    const parsed = JSON.parse(raw);
    return parsed.task_type === "COMPLEX" ? "COMPLEX" : "SIMPLE";
  } catch (err) {
    ctx.log?.error?.(`[many-ai:gateway] classifyTaskType error: ${err.message}`);
    return "SIMPLE";
  }
}

