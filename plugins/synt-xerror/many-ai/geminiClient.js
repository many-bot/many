// src/plugins/many-ai/geminiClient.js
// Text-generation client for Gemini — used as the "complex task" provider
// (code, file building) picked by gateway.js's task_type classification.
// Same return contract as mistralClient.js's callMistralRaw so resolveReply
// (index.js) can call either one interchangeably: { content, finishReason,
// toolCalls }. toolCalls is always null here — native function calling isn't
// implemented for this provider; the plain-text COMMAND-style tool syntax
// (the default when AI_NATIVE_TOOLS is off) works identically regardless of
// which provider generated the text, so no schema translation is needed.
// Callers must not route to this client while AI_NATIVE_TOOLS is on.

const MAX_HISTORY_SEND = 6;

/**
 * Maps this plugin's internal history entries (role: "user"|"assistant",
 * same convention as mistralClient.js) to Gemini's "contents" shape:
 * role "user"|"model", each turn a { parts: [{ text }] } object. Gemini
 * has no separate system-role message — the system prompt is passed via
 * the top-level systemInstruction field instead (see callGeminiRaw).
 */
function toGeminiContents(history) {
  return history.slice(-MAX_HISTORY_SEND).map(entry => {
    const role = entry.role === "assistant" ? "model" : "user";
    const tag = entry.kind === "chat"
      ? (entry.current
          ? "[CURRENT MESSAGE — this is the one you should answer]\n"
          : "[OLD MESSAGE — background context only, don't reply to it unless it's quoted or truly needed]\n")
      : "";
    return { role, parts: [{ text: `${tag}${entry.content ?? ""}` }] };
  });
}

async function fetchGemini(history, systemPrompt, apiKey, MODEL, maxTokens) {
  const body = {
    contents: toGeminiContents(history),
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: maxTokens },
  };
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }
}

async function throwForBadResponse(res) {
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
    const e = new Error(`Gemini API error ${res.status}`);
    e.isTransient = true;
    throw e;
  }
  throw new Error(`Gemini API error ${res.status}: ${body}`);
}

// Gemini finishReason values ("STOP", "MAX_TOKENS", ...) mapped to the
// same "stop"/"length" strings mistralClient.js returns, so callers
// (continueIfTruncated, the [THINKING] cutoff check) don't need to know
// which provider produced the response.
function mapFinishReason(reason) {
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

export async function callGeminiRaw(history, systemPrompt, apiKey, MODEL, maxTokens) {
  const res = await fetchGemini(history, systemPrompt, apiKey, MODEL, maxTokens);
  if (!res.ok) await throwForBadResponse(res);

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content = parts.map(p => p.text || "").join("").trim();
  const finishReason = mapFinishReason(candidate?.finishReason);
  return { content, finishReason, toolCalls: null };
}

export async function callGemini(history, systemPrompt, apiKey, MODEL, maxTokens) {
  const { content } = await callGeminiRaw(history, systemPrompt, apiKey, MODEL, maxTokens);
  return content;
}

