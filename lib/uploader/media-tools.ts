import "server-only";
import { spawn } from "node:child_process";
import { stat, statfs } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { createPacketDigest, inspectionFromProbe, packetListArguments, readMp4Layout, remuxArguments, type MediaInspection, type PacketDigest } from "@/lib/ingestion/media";
import { withReadRange } from "@/lib/uploader/scan";

/**
 * The FFmpeg/ffprobe side of media normalization (E3.5). Every tool runs as a
 * direct child process with an argument array: never a shell, so a file name
 * with spaces, quotes, brackets or any Unicode is one argument and nothing
 * else. Output is bounded: probes are capped, packet listings are folded line
 * by line, and no movie is ever read into memory.
 *
 * Tools are found deterministically and never downloaded:
 * 1. VELORA_FFPROBE_PATH / VELORA_FFMPEG_PATH: absolute paths to the binaries
 *    (the documented, verified build, kept outside Git);
 * 2. otherwise the first ffprobe/ffmpeg on PATH.
 * Each must run `-version`; its version is recorded with every result.
 */

export const FFPROBE_ENV = "VELORA_FFPROBE_PATH";
export const FFMPEG_ENV = "VELORA_FFMPEG_PATH";

export interface MediaTool {
  path: string;
  version: string;
  source: "env" | "path";
}

export interface MediaTools {
  ffprobe: MediaTool;
  ffmpeg: MediaTool;
}

export type ToolResolution = { ok: true; tools: MediaTools } | { ok: false; errors: string[] };

export interface RunResult {
  code: number | null;
  stdout: string;
  /** The last few kilobytes of stderr, for a failure message. */
  stderrTail: string;
  timedOut: boolean;
}

export type Runner = (file: string, args: readonly string[], options: { timeoutMs: number; maxStdoutBytes: number; onLine?: (line: string) => void }) => Promise<RunResult>;

const STDERR_TAIL_BYTES = 4096;

/** Spawns `file` directly (shell: false). With onLine, stdout is streamed line by line and not kept. */
export const runProcess: Runner = (file, args, { timeoutMs, maxStdoutBytes, onLine }) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let pending = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (onLine) {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          onLine(pending.slice(0, newline).replace(/\r$/, ""));
          pending = pending.slice(newline + 1);
        }
        return;
      }
      if (stdout.length + chunk.length > maxStdoutBytes) {
        overflow = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderrTail: error.message.slice(0, 300), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (onLine && pending.length > 0) onLine(pending.replace(/\r$/, ""));
      resolve({ code: overflow ? null : code, stdout, stderrTail: overflow ? "output over limit" : stderr, timedOut });
    });
  });

const EXECUTABLE = (name: "ffprobe" | "ffmpeg") => (process.platform === "win32" ? [`${name}.exe`, name] : [name]);

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function locate(name: "ffprobe" | "ffmpeg", env: Readonly<Record<string, string | undefined>>, variable: string): Promise<{ path: string; source: MediaTool["source"] } | string> {
  const configured = env[variable];
  if (configured) {
    // An operator setting, still checked: an absolute path to a binary of that name.
    if (!isAbsolute(configured)) return `${variable} must be an absolute path`;
    if (!EXECUTABLE(name).includes(basename(configured).toLowerCase())) return `${variable} must point to ${name}${process.platform === "win32" ? ".exe" : ""}`;
    if (!(await isFile(configured))) return `${variable} does not name an existing file`;
    return { path: configured, source: "env" };
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => isAbsolute(d))) {
    for (const file of EXECUTABLE(name)) {
      const candidate = join(dir, file);
      if (await isFile(candidate)) return { path: candidate, source: "path" };
    }
  }
  return `${name} not found: set ${variable} to the verified build, or put ${name} on PATH`;
}

/** Finds and checks both tools. Never downloads anything. */
export async function resolveMediaTools(env: Readonly<Record<string, string | undefined>> = process.env, run: Runner = runProcess): Promise<ToolResolution> {
  const errors: string[] = [];
  const found: Partial<MediaTools> = {};
  for (const [name, variable] of [["ffprobe", FFPROBE_ENV], ["ffmpeg", FFMPEG_ENV]] as const) {
    const location = await locate(name, env, variable);
    if (typeof location === "string") {
      errors.push(location);
      continue;
    }
    const result = await run(location.path, ["-hide_banner", "-version"], { timeoutMs: 20_000, maxStdoutBytes: 64 * 1024 });
    const version = new RegExp(`^${name} version (\\S+)`).exec(result.stdout)?.[1];
    if (result.code !== 0 || !version) errors.push(`${name} at ${location.source === "env" ? variable : "PATH"} did not report a version`);
    else found[name] = { path: location.path, version, source: location.source };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, tools: found as MediaTools };
}

export type ProbeResult = { ok: true; inspection: MediaInspection } | { ok: false; code: "probe_failed" | "probe_timeout" | "probe_output_invalid" | "source_unreadable" };

/** ffprobe of one file (headers only) plus its MP4 box layout. */
export async function probeMedia(ffprobe: MediaTool, path: string, run: Runner = runProcess): Promise<ProbeResult> {
  let sizeBytes: number;
  try {
    const facts = await stat(path);
    if (!facts.isFile()) return { ok: false, code: "source_unreadable" };
    sizeBytes = facts.size;
  } catch {
    return { ok: false, code: "source_unreadable" };
  }
  const result = await run(ffprobe.path, ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", path], { timeoutMs: 120_000, maxStdoutBytes: 4 * 1024 * 1024 });
  if (result.timedOut) return { ok: false, code: "probe_timeout" };
  if (result.code !== 0) return { ok: false, code: "probe_failed" };
  try {
    const layout = await withReadRange(path, (read) => readMp4Layout(sizeBytes, read));
    return { ok: true, inspection: inspectionFromProbe(JSON.parse(result.stdout), sizeBytes, layout) };
  } catch {
    return { ok: false, code: "probe_output_invalid" };
  }
}

/** Packet digests of the first video and audio stream, read by stream copy (no decoding). */
export async function digestPackets(ffmpeg: MediaTool, path: string, run: Runner = runProcess): Promise<PacketDigest | null> {
  const digest = createPacketDigest();
  const result = await run(ffmpeg.path, packetListArguments(path), { timeoutMs: 60 * 60 * 1000, maxStdoutBytes: 0, onLine: (line) => digest.push(line) });
  return result.code === 0 ? digest.result() : null;
}

/**
 * The Class 2 repackage: stream copy into a new file. The output must not
 * exist: FFmpeg's `-n` refuses to overwrite but still exits 0 (FFmpeg 9.0.2),
 * so the precondition is checked here, and success also requires the output
 * to exist afterwards.
 */
export async function remux(ffmpeg: MediaTool, sourcePath: string, outputPath: string, run: Runner = runProcess): Promise<{ ok: true } | { ok: false; code: "output_exists" | "ffmpeg_failed" | "ffmpeg_timeout"; detail: string }> {
  const outputSize = () => stat(outputPath).then((facts) => (facts.isFile() ? facts.size : -1), () => null);
  if ((await outputSize()) !== null) return { ok: false, code: "output_exists", detail: "" };
  const result = await run(ffmpeg.path, remuxArguments(sourcePath, outputPath), { timeoutMs: 2 * 60 * 60 * 1000, maxStdoutBytes: 64 * 1024 });
  if (result.timedOut) return { ok: false, code: "ffmpeg_timeout", detail: "" };
  const detail = result.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
  if (result.code !== 0) return { ok: false, code: "ffmpeg_failed", detail };
  return ((await outputSize()) ?? 0) > 0 ? { ok: true } : { ok: false, code: "ffmpeg_failed", detail: detail || "no output written" };
}

/** Free bytes for an unprivileged writer on the volume holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const facts = await statfs(dir);
  return Number(facts.bavail) * Number(facts.bsize);
}

/** Space a stream-copy repackage needs: the source size plus 2% (container overhead) and 256 MiB of margin. */
export function remuxSpaceNeeded(sourceBytes: number): number {
  return Math.ceil(sourceBytes * 1.02) + 256 * 1024 * 1024;
}
