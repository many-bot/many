const MAX_HISTORY_SEND = 6;

export function toApiMessages(history, systemPrompt) {
  const MAX_HISTORY_SEND = 6;
  const messages = history.slice(-MAX_HISTORY_SEND).map(entry => {
    if (entry.kind !== "chat") return { role: entry.role, content: entry.content };
    const tag = entry.current
      ? "[CURRENT MESSAGE — this is the one you should answer]"
      : "[OLD MESSAGE — background context only, don't reply to it unless it's quoted or truly needed]";
    return { role: entry.role, content: `${tag}\n${entry.content}` };
  });
  return [{ role: "system", content: systemPrompt }, ...messages];
}

/**
 * Converts history entries to Mistral API message format.
 * For tool role entries (kind: "tool"), correctly formats them with tool_call_id.
 */
export function toApiMessagesWithTools(history, systemPrompt) {
  const MAX_HISTORY_SEND = 6;
  const messages = history.slice(-MAX_HISTORY_SEND).map(entry => {
    if (entry.kind === "chat") {
      const tag = entry.current
        ? "[CURRENT MESSAGE — this is the one you should answer]"
        : "[OLD MESSAGE — background context only, don't reply to it unless it's quoted or truly needed]";
      return { role: entry.role, content: `${tag}\n${entry.content}` };
    }
    if (entry.kind === "tool_result" && entry.tool_call_id) {
      return {
        role: "tool",
        tool_call_id: entry.tool_call_id,
        content: entry.content,
      };
    }
    if (entry.kind === "tool_call") {
      return {
        role: "assistant",
        content: null,
        tool_calls: entry.tool_calls,
      };
    }
    // legacy text-based tool entries (pre-native function calling)
    return { role: entry.role, content: entry.content };
  });
  return [{ role: "system", content: systemPrompt }, ...messages];
}

function buildRequestBody(history, systemPrompt, MODEL, maxTokens, tools) {
  const body = {
    model: MODEL,
    messages: tools ? toApiMessagesWithTools(history, systemPrompt) : toApiMessages(history, systemPrompt),
    max_tokens: maxTokens,
  };
  if (tools && tools.length) body.tools = tools;
  return body;
}

/** Shared network/HTTP-status error mapping for both the buffered and streaming call paths. */
async function throwForBadResponse(res) {
  const body = await res.text();
  if (res.status === 429) {
    let retryIn = null;
    try {
      const { error } = JSON.parse(body);
      retryIn = error?.message?.match(/try again in (\S+)\./i)?.[1] ?? null;
    } catch {}
    const e = new Error("rate_limit");
    e.isRateLimit = true;
    e.retryIn = retryIn;
    throw e;
  }
  if (res.status === 401 || res.status === 403) {
    const e = new Error(`key rejected (${res.status})`);
    e.isInvalidKey = true;
    throw e;
  }
  if (res.status === 400) {
    throw new Error(`Mistral API error ${res.status}: ${body}`);
  }
  if (res.status >= 500) {
    const e = new Error(`Mistral API error ${res.status}`);
    e.isTransient = true;
    throw e;
  }
  throw new Error(`Mistral API error ${res.status}: ${body}`);
}

async function fetchMistral(history, systemPrompt, apiKey, MODEL, maxTokens, tools, extraBody) {
  try {
    return await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ ...buildRequestBody(history, systemPrompt, MODEL, maxTokens, tools), ...extraBody }),
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }
}

export async function callMistralRaw(history, systemPrompt, apiKey, MODEL, maxTokens, tools) {
  const res = await fetchMistral(history, systemPrompt, apiKey, MODEL, maxTokens, tools);
  if (!res.ok) await throwForBadResponse(res);

  const data = await res.json();
  const choice = data.choices[0];
  const msg = choice.message || {};
  const content = (msg.content || "").trim();
  const toolCalls = msg.tool_calls || null;
  return { content, finishReason: choice.finish_reason || "stop", toolCalls };
}

export async function callMistral(history, systemPrompt, apiKey, MODEL, maxTokens) {
  const { content } = await callMistralRaw(history, systemPrompt, apiKey, MODEL, maxTokens);
  return content;
}

