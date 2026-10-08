import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

export async function probeMedia(path) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_frames",
    "-of", "json",
    path,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] ?? {};
  return { width: stream.width, height: stream.height };
}

function outputArgsFor(format) {
  if (format === "gif") return ["-f", "gif"];
  return ["-c:a", "copy"];
}

export async function overlayOnMedia(inputPath, overlayPath, outputPath, { format, singleFrame }) {
  const args = [
    "-y", "-i", inputPath, "-i", overlayPath,
    "-filter_complex", "overlay=0:0",
    ...(singleFrame ? ["-frames:v", "1"] : []),
    ...outputArgsFor(format),
    outputPath,
  ];
  await run("ffmpeg", args);
}

export async function padTopAndOverlay(inputPath, overlayPath, outputPath, { format, barHeight, singleFrame }) {
  const padFilter = `[0:v]pad=iw:ih+${barHeight}:0:${barHeight}:color=white[padded];[padded][1:v]overlay=0:0`;
  const args = [
    "-y", "-i", inputPath, "-i", overlayPath,
    "-filter_complex", padFilter,
    ...(singleFrame ? ["-frames:v", "1"] : []),
    ...outputArgsFor(format),
    outputPath,
  ];
  await run("ffmpeg", args);
}

export async function frameAndOverlay(inputPath, overlayPath, outputPath, { format, singleFrame, layout }) {
  const { border, whiteW, whiteH, outerMargin, canvasW, canvasH } = layout;
  const filter =
    `[0:v]pad=${whiteW}:${whiteH}:${border}:${border}:color=white[bordered];` +
    `[bordered]pad=${canvasW}:${canvasH}:${outerMargin}:${outerMargin}:color=black[framed];` +
    `[framed][1:v]overlay=0:0`;
  const args = [
    "-y", "-i", inputPath, "-i", overlayPath,
    "-filter_complex", filter,
    ...(singleFrame ? ["-frames:v", "1"] : []),
    ...outputArgsFor(format),
    outputPath,
  ];
  await run("ffmpeg", args);
}
