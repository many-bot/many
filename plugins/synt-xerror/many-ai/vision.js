import { withKeyFailover } from "./apiKeys.js";

async function callVisionMistral(messages, apiKey, model, maxTokens) {
  let res;
  try {
    res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens || 300,
      }),
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      let retryIn = null;
      try { const { error } = JSON.parse(body); retryIn = error?.message?.match(/try again in (\S+)\./i)?.[1] ?? null; } catch {}
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
    if (res.status >= 500) {
      const e = new Error(`Mistral API error ${res.status}`);
      e.isTransient = true;
      throw e;
    }
    throw new Error(`Mistral API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return (data.choices[0]?.message?.content || "").trim();
}

export async function analyzeImage(msg, ctx, keys, model, userPrompt) {
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return null;
    const mime = media.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${media.data}`;

    const systemMsg = userPrompt || "Descreva detalhadamente o que você vê nesta imagem.";
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: systemMsg },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ];

    return await withKeyFailover(keys, (key) => callVisionMistral(messages, key, model, 500), ctx.log);
  } catch (err) {
    ctx.log.error(`[many-ai] vision analysis error: ${err.message}`);
    return null;
  }
}