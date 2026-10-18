// src/plugins/many-ai/voice.js
// Turns a WhatsApp voice note / audio message into text via Groq's Whisper
// endpoint (same API key pool + failover as the chat model). Free tier
// covers this comfortably for normal group volume — see README.

import { spawn } from "node:child_process";
import { withKeyFailover } from "./apiKeys.js";

// Groq's hard cap for a direct (multipart) upload — 25MB on every tier, free
// or dev. Larger files need the `url` param + chunking instead, which this
// plugin doesn't implement; past this size we trim with ffmpeg instead.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Trims/re-encodes `buffer` down to at most `maxBytes`, via ffmpeg's `-fs`
 * (stops writing once the limit is hit — works regardless of the source's
 * original bitrate/duration, no probing needed). Re-encodes to opus/mono/
 * 16kHz, the format Whisper downsamples to anyway, keeping output small.
 * Requires the `ffmpeg` binary on the host (no npm dependency).
 */
function trimAudio(buffer, maxBytes) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-fs", String(maxBytes),
      "-f", "ogg",
      "pipe:1",
    ]);
    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => { stderr += d; });
    ff.on("error", reject); // e.g. ENOENT if ffmpeg isn't installed
    ff.on("close", (code) => {
      if (!chunks.length) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      resolve(Buffer.concat(chunks));
    });
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

async function callTranscription(buffer, mimetype, apiKey, model) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype || "audio/ogg" }), "audio.ogg");
  form.append("model", model);
  // verbose_json instead of plain "text" — Whisper's flat text has no line
  // breaks at all (bad for lyrics/poetry/lists), but the segments it
  // detects (one per natural pause) give us a real line break per phrase.
  form.append("response_format", "verbose_json");

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method:  "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (netErr) {
    const e = new Error(`network error: ${netErr.message}`);
    e.isTransient = true;
    throw e;
  }

  if (!res.ok) {
    const errText = await res.text();
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
      const e = new Error(`Groq transcription error ${res.status}`);
      e.isTransient = true;
      throw e;
    }
    throw new Error(`Groq transcription error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const segments = Array.isArray(data.segments) ? data.segments : null;
  if (!segments?.length) return { text: (data.text || "").trim(), confidence: null }; // fallback, shouldn't happen on verbose_json

  const text = segments.map((s) => s.text.trim()).filter(Boolean).join("\n");

  // Rough confidence estimate from Whisper's own avg_logprob per segment
  // (exp(avg_logprob) ≈ the model's average token probability, 0–1),
  // weighted by segment duration so long confident stretches count more
  // than short uncertain ones. null if the API didn't send usable data.
  let weightedLogSum = 0;
  let totalDuration = 0;
  for (const s of segments) {
    const duration = Math.max(0, (s.end ?? 0) - (s.start ?? 0));
    if (duration <= 0 || typeof s.avg_logprob !== "number") continue;
    weightedLogSum += s.avg_logprob * duration;
    totalDuration += duration;
  }
  const confidence = totalDuration > 0 ? Math.exp(weightedLogSum / totalDuration) : null;

  return { text, confidence };
}

/**
 * Transcribes the CURRENT message's audio (the direct, fully-supported
 * path — msg.downloadMedia() is a documented part of the plugin API).
 * Returns { text: "", trimmed: false, confidence: null } on any ordinary failure; callers
 * treat empty text as "couldn't transcribe", never as something to surface
 * as an error to people who didn't ask. isTooLarge is the one exception —
 * it only fires when the audio exceeds maxBytes AND trimming itself failed
 * (e.g. ffmpeg missing), so it's thrown instead of swallowed: it's
 * actionable and the caller should tell the person what happened.
 */
export async function transcribeCurrentMessage(msg, ctx, keys, model, maxBytes = MAX_UPLOAD_BYTES) {
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return { text: "", trimmed: false, confidence: null };
    let buffer = Buffer.from(media.data, "base64");
    let mimetype = media.mimetype;
    let trimmed = false;

    if (buffer.length > maxBytes) {
      try {
        buffer = await trimAudio(buffer, maxBytes);
        mimetype = "audio/ogg";
        trimmed = true;
      } catch (trimErr) {
        ctx.log.error(`[many-ai] audio trim failed: ${trimErr.message}`);
        const e = new Error(`audio too large and couldn't be trimmed (${buffer.length} bytes > ${maxBytes} byte limit)`);
        e.isTooLarge = true;
        e.sizeBytes = buffer.length;
        e.limitBytes = maxBytes;
        throw e;
      }
    }

    const { text, confidence } = await withKeyFailover(keys, (key) => callTranscription(buffer, mimetype, key, model), ctx.log);
    return { text, trimmed, confidence };
  } catch (err) {
    if (err.isTooLarge) throw err;
    ctx.log.error(`[many-ai] transcription error: ${err.message}`);
    return { text: "", trimmed: false, confidence: null };
  }
}

