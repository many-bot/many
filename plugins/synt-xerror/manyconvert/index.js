/**
 * Converts media files between formats via ffmpeg.
 * Handles /video-audio, /video-gif, /gif-video, /foto-pdf and /pdf-foto.
 * Passing "link" as the first argument uploads the result and sends its URL instead of the file.
 */

import { execFile }   from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import fs            from "fs";
import path          from "path";

const execFileAsync = promisify(execFile);

const DOWNLOADS_DIR = path.resolve("downloads");
const UPLOAD_URL    = "https://api.stxerr.dev/upload";

const UPLOAD_RETRIES        = 4;
const UPLOAD_RETRY_DELAY_MS = 3000;
const TOOL_TIMEOUT  = 120_000;
const GIF_MAX_SECONDS = 15;
const GIF_MAX_WIDTH   = 480;
const PDF_DPI         = 110;
const A4              = { w: 595, h: 842 };

const MESSAGES = {
  noMedia:        "Envie o arquivo com o comando na legenda ou responda a ele.",
  converting:     "Convertendo...",
  invalidType:    "Este tipo de arquivo não é aceito por este comando.",
  failed:         "Não foi possível converter o arquivo.",
  noApiKey:       "O upload de links não está configurado.",
  lockedElsewhere: "Tem outra sessão em andamento nesse chat. Espere ela terminar e tente de novo.",
  pdfTruncated: n => `Enviando apenas as primeiras ${n} páginas.`,
};

// Tools

const ffmpeg = args =>
  execFileAsync("ffmpeg", ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", ...args], { timeout: TOOL_TIMEOUT });

async function probeSize(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    filePath,
  ], { timeout: TOOL_TIMEOUT });

  const [width, height] = stdout.trim().split(",").map(Number);
  if (!width || !height) throw new Error("Could not read image size");
  return { width, height };
}

// Upload

async function uploadToServer(filePath, apiKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = `${randomUUID().slice(0, 8)}-${path.basename(filePath)}`;

  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    if (attempt > 1) await new Promise(res => setTimeout(res, UPLOAD_RETRY_DELAY_MS));

    try {
      const body = new FormData();
      body.append("file", new Blob([fileBuffer]), fileName);

      const res = await fetch(UPLOAD_URL, { method: "POST", headers: { "x-api-key": apiKey }, body });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);

      const result = JSON.parse(await res.text());
      if (!result.url) throw new Error("Server response missing url");

      return result.url.startsWith("https") ? result.url : `https://api.stxerr.dev${result.url}`;
    } catch (err) {
      lastError = err;
      console.error(`[manyconvert] Upload attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw new Error(`Upload failed after ${UPLOAD_RETRIES} attempts: ${lastError.message}`);
}

// Minimal single-page PDF wrapping a JPEG (DCTDecode), so ffmpeg is the only dependency.

function jpegToPdf(jpegPath, { width, height }, outPath) {
  const jpeg      = fs.readFileSync(jpegPath);
  const landscape = width > height;
  const page      = landscape ? { w: A4.h, h: A4.w } : A4;
  const scale     = Math.min(page.w / width, page.h / height);
  const drawW     = width * scale;
  const drawH     = height * scale;
  const x         = (page.w - drawW) / 2;
  const y         = (page.h - drawH) / 2;
  const content   = `q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;

  const chunks  = [];
  const offsets = [];
  let size = 0;

  const push = data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
    chunks.push(buf);
    size += buf.length;
  };

  const object = (n, ...parts) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    parts.forEach(push);
    push("\nendobj\n");
  };

  push("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.w} ${page.h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  object(4,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  );
  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefPos = size;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let n = 1; n <= 5; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

// Converters — each converts `input` inside `dir` and returns { files, send, notice? }.

async function videoToAudio(ctx, input, dir) {
  const out = path.join(dir, "audio.mp3");
  await ffmpeg(["-i", input, "-vn", "-sn", "-dn", "-map_metadata", "-1", "-c:a", "libmp3lame", "-q:a", "2", out]);
  return { files: [out], send: p => ctx.send.audio(p, { asVoice: false }) };
}

async function videoToGif(ctx, input, dir) {
  const out = path.join(dir, "gif.mp4");
  await ffmpeg([
    "-i", input,
    "-an", "-sn", "-dn",
    "-t", String(GIF_MAX_SECONDS),
    "-vf", `fps=15,scale='min(${GIF_MAX_WIDTH},iw)':-2`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "26",
    "-movflags", "+faststart",
    out,
  ]);
  return { files: [out], send: p => ctx.send.gif(p) };
}

async function gifToVideo(ctx, input, dir) {
  const out = path.join(dir, "video.mp4");
  await ffmpeg([
    "-i", input,
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
    "-movflags", "+faststart",
    out,
  ]);
  return { files: [out], send: p => ctx.send.video(p) };
}

async function photoToPdf(ctx, input, dir) {
  const jpeg = path.join(dir, "photo.jpg");
  const out  = path.join(dir, "photo.pdf");
  await ffmpeg(["-i", input, "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "2", jpeg]);
  jpegToPdf(jpeg, await probeSize(jpeg), out);
  return { files: [out], send: p => ctx.send.file(p, "photo.pdf") };
}

async function pdfToPhotos(ctx, input, dir) {
  const maxPages = Number(ctx.config.get("CONVERT_MAX_PDF_PAGES", "20")) || 20;

  await execFileAsync("pdftoppm", [
    "-jpeg",
    "-r", String(PDF_DPI),
    "-l", String(maxPages + 1),
    input,
    path.join(dir, "page"),
  ], { timeout: TOOL_TIMEOUT });

  const pages = fs.readdirSync(dir)
    .filter(f => f.startsWith("page-") && f.endsWith(".jpg"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (pages.length === 0) throw new Error("pdftoppm produced no pages");

  return {
    files:  pages.slice(0, maxPages).map(page => path.join(dir, page)),
    send:   p => ctx.send.image(p),
    notice: pages.length > maxPages ? MESSAGES.pdfTruncated(maxPages) : null,
  };
}

const isVideo = mime => mime.startsWith("video/");
const isImage = mime => mime.startsWith("image/");
const isPdf   = mime => mime === "application/pdf";

const CONVERSIONS = [
  { names: ["video-audio", "v2a"], accepts: isVideo,                          convert: videoToAudio },
  { names: ["video-gif",   "v2g"], accepts: isVideo,                          convert: videoToGif   },
  { names: ["gif-video",   "g2v"], accepts: m => isVideo(m) || m === "image/gif", convert: gifToVideo },
  { names: ["foto-pdf",    "f2p"], accepts: isImage,                          convert: photoToPdf   },
  { names: ["pdf-foto",    "p2f"], accepts: isPdf,                            convert: pdfToPhotos  },
];

// Job

async function resolveSource(msg) {
  if (msg.hasMedia) return msg;
  if (!msg.hasReply) return null;
  const quoted = await msg.getReply();
  return quoted?.hasMedia ? quoted : null;
}

async function deliver(ctx, { files, send, notice }, linkMode) {
  if (linkMode) {
    const apiKey = ctx.config.get("MEDIA_SRV_API_KEY");
    const links  = [];
    for (const file of files) links.push(await uploadToServer(file, apiKey));
    await ctx.msg.reply.text(`*Download:*\n${links.join("\n")}`);
  } else {
    for (const file of files) await send(file);
  }
  if (notice) await ctx.send.text(notice);
}

async function runConversion(ctx, conversion, source, linkMode) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DOWNLOADS_DIR, "convert-"));

  try {
    const media = await source.downloadMedia();
    if (!media?.data || !conversion.accepts(media.mimetype ?? "")) {
      await ctx.msg.reply.text(MESSAGES.invalidType);
      return;
    }

    const input = path.join(dir, "input");
    fs.writeFileSync(input, Buffer.from(media.data, "base64"));

    await deliver(ctx, await conversion.convert(ctx, input, dir), linkMode);
    ctx.log.info(`${conversion.names[0]} completed`);
  } catch (err) {
    ctx.log.error(`[manyconvert] ${conversion.names[0]} failed: ${err.message}`);
    await ctx.msg.reply.text(MESSAGES.failed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export default async function (ctx) {
  const { msg } = ctx;

  const conversion = CONVERSIONS.find(c => c.names.some(name => msg.is(name)));
  if (!conversion) return;

  const source = await resolveSource(msg);
  if (!source) {
    await msg.reply.text(MESSAGES.noMedia);
    return;
  }

  const linkMode = msg.args[0]?.toLowerCase() === "link";
  if (linkMode && !ctx.config.get("MEDIA_SRV_API_KEY")) {
    await msg.reply.text(MESSAGES.noApiKey);
    return;
  }

  if (!ctx.session.acquire()) {
    await msg.reply.text(MESSAGES.lockedElsewhere);
    return;
  }

  await msg.reply.text(MESSAGES.converting);

  ctx.download.enqueue(
    async () => {
      try {
        await runConversion(ctx, conversion, source, linkMode);
      } finally {
        ctx.session.release();
      }
    },
    async err => {
      ctx.log.error(`[manyconvert] queue error: ${err.message}`);
      ctx.session.release();
    },
  );
}

