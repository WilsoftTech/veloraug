import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyMedia, readMp4Layout, verifyRemux, type MediaInspection } from "@/lib/ingestion/media";
import { newJournalEntry, openJournal, type JournalEntry } from "@/lib/uploader/journal";
import { digestPackets, freeBytes, probeMedia, remux, resolveMediaTools, runProcess, type MediaTools } from "@/lib/uploader/media-tools";
import { normalizeEntry, type NormalizeDeps } from "@/lib/uploader/normalize";
import { fingerprintFile, withReadRange } from "@/lib/uploader/scan";
import type { SourceFingerprint } from "@/types/ingestion";

/**
 * The media pipeline against real FFmpeg and ffprobe (E3.5), on tiny
 * synthetic fixtures made here from FFmpeg's own test sources: no movie, no
 * copyrighted content, nothing committed. The fixtures are encoded; the
 * pipeline under test never encodes. Runs when the tools resolve
 * (VELORA_FFPROBE_PATH / VELORA_FFMPEG_PATH, or PATH), and is skipped
 * otherwise, saying so.
 */

const resolved = await resolveMediaTools(process.env);
const tools: MediaTools | null = resolved.ok ? resolved.tools : null;
if (!tools) console.warn(`media-ffmpeg tests skipped: ${resolved.ok ? "" : resolved.errors.join("; ")}`);

const work = mkdtempSync(join(tmpdir(), "velora-media-"));
const library = join(work, "Movies");
const renditions = join(library, ".velora-renditions");
const UNUSUAL = "Tom Clancy's [Jack_Ryan] (Ghost war) — Ünïcode & spaces.VJ ICE P.2026.mkv";
const fixtures: Record<string, string> = {};

async function ffmpeg(args: string[]) {
  const result = await runProcess(tools!.ffmpeg.path, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { timeoutMs: 120_000, maxStdoutBytes: 1024 });
  if (result.code !== 0) throw new Error(`fixture: ${result.stderrTail}`);
}

const video = ["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=2"];
const tone = (freq = 440) => ["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=44100:duration=2`];
const h264 = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "24"];

beforeAll(async () => {
  if (!tools) return;
  mkdirSync(library, { recursive: true });
  const at = (name: string) => (fixtures[name] = join(library, name));
  await ffmpeg([...video, ...tone(), ...h264, "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", at("Canonical.VJ Test.2024.mp4")]);
  await ffmpeg([...video, ...tone(), ...h264, "-c:a", "libmp3lame", "-ac", "2", at(UNUSUAL)]);
  await ffmpeg([...video, ...tone(), ...h264, "-c:a", "libmp3lame", "-ac", "2", at("Slow Start.VJ Test.2024.mp4")]);
  await ffmpeg([...video, ...tone(), ...h264, "-c:a", "ac3", at("Ac3 Audio.VJ Test.2024.mkv")]);
  await ffmpeg([...video, ...tone(), "-c:v", "mpeg4", "-c:a", "libmp3lame", at("Mpeg4 Video.VJ Test.2024.mkv")]);
  await ffmpeg([...video, ...tone(), ...tone(880), "-map", "0:v", "-map", "1:a", "-map", "2:a", ...h264, "-c:a", "libmp3lame", at("Two Audio.VJ Test.2024.mkv")]);
  await ffmpeg([...video, ...video, ...tone(), "-map", "0:v", "-map", "1:v", "-map", "2:a", ...h264, "-c:a", "libmp3lame", at("Two Video.VJ Test.2024.mkv")]);
  const srt = join(work, "subs.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhello\n");
  await ffmpeg([...video, ...tone(), "-i", srt, "-map", "0:v", "-map", "1:a", "-map", "2:s", ...h264, "-c:a", "libmp3lame", "-c:s", "srt", at("Subtitled.VJ Test.2024.mkv")]);
  writeFileSync(at("Broken.VJ Test.2024.mkv"), createHash("sha256").update("not a movie").digest().toString("hex").repeat(64));
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const probe = async (name: string): Promise<MediaInspection> => {
  const result = await probeMedia(tools!.ffprobe, fixtures[name]);
  if (!result.ok) throw new Error(result.code);
  return result.inspection;
};
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe.skipIf(!tools)("real ffprobe classification of synthetic fixtures", () => {
  it.each([
    ["Canonical.VJ Test.2024.mp4", "canonical", []],
    [UNUSUAL, "remux", ["container_matroska"]],
    ["Slow Start.VJ Test.2024.mp4", "remux", ["mp4_not_fast_start"]],
    ["Ac3 Audio.VJ Test.2024.mkv", "audio_normalization", ["audio_codec_ac3"]],
    ["Mpeg4 Video.VJ Test.2024.mkv", "video_transcode_required", ["video_codec_mpeg4"]],
    ["Two Audio.VJ Test.2024.mkv", "manual_review", ["multiple_audio_streams"]],
    ["Two Video.VJ Test.2024.mkv", "manual_review", ["multiple_video_streams"]],
    ["Subtitled.VJ Test.2024.mkv", "manual_review", ["subtitle_streams"]],
  ])("%s -> %s", async (name, cls, reasons) => {
    const result = classifyMedia(await probe(name));
    expect(result.class).toBe(cls);
    for (const reason of reasons) expect(result.reasons).toContain(reason);
  });

  it("an unreadable file is a probe failure (ffprobe exits non-zero), which the scan records as manual review", async () => {
    expect(await probeMedia(tools!.ffprobe, fixtures["Broken.VJ Test.2024.mkv"])).toEqual({ ok: false, code: "probe_failed" });
    expect(await probeMedia(tools!.ffprobe, join(library, "missing.mkv"))).toEqual({ ok: false, code: "source_unreadable" });
  });

  it("the classification is the same on every run", async () => {
    expect(classifyMedia(await probe(UNUSUAL))).toEqual(classifyMedia(await probe(UNUSUAL)));
  });
});

describe.skipIf(!tools)("real Class 2 normalization", () => {
  const journalDir = join(work, "journal");

  async function run(name: string) {
    const journal = await openJournal(journalDir);
    const path = fixtures[name];
    const facts = statSync(path);
    const fingerprint = await fingerprintFile(path, facts.size);
    const inspection = await probe(name);
    const source: JournalEntry = {
      ...newJournalEntry({ fingerprint, kind: "movie", intendedChannelId: -1001111111111, fileName: name, relativePath: name, absolutePath: path, sizeBytes: facts.size, modifiedAtMs: facts.mtimeMs, discoveryKey: "e".repeat(64) }, new Date()),
      media: { role: "source", inspectedAt: new Date().toISOString(), tools: { ffprobe: tools!.ffprobe.version, ffmpeg: tools!.ffmpeg.version }, inspection, classification: classifyMedia(inspection), rendition: null, derivedFrom: null, normalizationFailure: null },
    };
    await journal.put(source);
    const deps: NormalizeDeps = {
      journal,
      tools: tools!,
      renditionsRoot: renditions,
      probe: (p) => probeMedia(tools!.ffprobe, p),
      digest: (p) => digestPackets(tools!.ffmpeg, p),
      remux: (s, o) => remux(tools!.ffmpeg, s, o),
      freeBytes,
      fingerprint: fingerprintFile,
      fileFacts: async (p) => stat(p).then((f) => (f.isFile() ? { sizeBytes: f.size, modifiedAtMs: f.mtimeMs } : null), () => null),
      mkdir: async (d) => {
        await mkdir(d, { recursive: true });
      },
      rename,
      remove: (p) => unlink(p).catch(() => {}),
      plan: async () => ({ action: "upload_then_review", stopReasons: [] }),
      now: () => new Date(),
    };
    return { journal, source, deps };
  }

  it.each([UNUSUAL, "Slow Start.VJ Test.2024.mp4"])("%s: stream copy, fast start, identical packets, source untouched", async (name) => {
    const before = { sha: sha256(fixtures[name]), mtime: statSync(fixtures[name]).mtimeMs };
    const { journal, source, deps } = await run(name);
    const result = await normalizeEntry(source, deps);
    if (result.result !== "normalized") throw new Error(JSON.stringify(result));

    // The source is byte-for-byte what it was, with the same mtime.
    expect(sha256(fixtures[name])).toBe(before.sha);
    expect(statSync(fixtures[name]).mtimeMs).toBe(before.mtime);

    const output = result.rendition.absolutePath;
    expect(output.startsWith(renditions)).toBe(true);
    expect(result.rendition.fileName).toBe(name.replace(/\.(mkv|mp4)$/, ".mp4"));
    const layout = await withReadRange(output, (read) => readMp4Layout(statSync(output).size, read));
    expect(layout).toMatchObject({ fastStart: true, fragmented: false, complete: true });
    expect(classifyMedia((await probeMedia(tools!.ffprobe, output) as { inspection: MediaInspection }).inspection).class).toBe("canonical");

    const { verification } = result;
    expect(verification.passed).toBe(true);
    expect(verification.source.video.packets).toBeGreaterThan(40);
    expect(verification.source.audio.packets).toBeGreaterThan(50);
    expect(verification.output).toEqual(verification.source);
    expect((await journal.get(result.rendition.fingerprint))?.media?.derivedFrom?.verification.passed).toBe(true);

    // Rerunning on the unchanged source is a no-op.
    const again = await normalizeEntry((await journal.get(source.fingerprint))!, deps);
    expect(again).toMatchObject({ result: "already_normalized", reason: "rendition_intact" });
  }, 120_000);

  it("the verifier catches a re-encode that keeps the codec, container and duration", async () => {
    const source = fixtures[UNUSUAL];
    const reencoded = join(work, "reencoded.mp4");
    await ffmpeg(["-i", source, "-map", "0:v:0", "-map", "0:a:0", ...h264, "-crf", "40", "-c:a", "copy", "-movflags", "+faststart", reencoded]);
    const [a, b] = [await digestPackets(tools!.ffmpeg, source), await digestPackets(tools!.ffmpeg, reencoded)];
    const verification = verifyRemux(await probe(UNUSUAL), (await probeMedia(tools!.ffprobe, reencoded) as { inspection: MediaInspection }).inspection, a!, b!);
    expect(verification.passed).toBe(false);
    expect(verification.failures).toContain("video_packets_changed");
    // The copied audio is still identical: the check is per stream.
    expect(verification.failures.some((f) => f.startsWith("audio_packets"))).toBe(false);
  }, 120_000);

  it("FFmpeg failure on unreadable input: a clean failure, no rendition left behind", async () => {
    const broken = fixtures["Broken.VJ Test.2024.mkv"];
    const output = join(work, "never.mp4.partial");
    const result = await remux(tools!.ffmpeg, broken, output);
    expect(result).toMatchObject({ ok: false, code: "ffmpeg_failed" });
    expect(() => statSync(output)).toThrow();
  });

  it("an existing output is never overwritten, and is reported, not taken for success", async () => {
    // FFmpeg 9.0.2 with -n refuses to overwrite yet exits 0, so remux() checks itself.
    const output = join(work, "exists.mp4.partial");
    writeFileSync(output, "keep me");
    expect(await remux(tools!.ffmpeg, fixtures[UNUSUAL], output)).toEqual({ ok: false, code: "output_exists", detail: "" });
    expect(readFileSync(output, "utf8")).toBe("keep me");
  });

  it("a derivative changed after verification no longer matches its journaled fingerprint", async () => {
    const { source, deps } = await run("Slow Start.VJ Test.2024.mp4");
    const result = await normalizeEntry(source, deps);
    if (result.result !== "normalized" && result.result !== "already_normalized") throw new Error(result.result);
    const path = result.rendition.absolutePath;
    const bytes = readFileSync(path);
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(`${path}.tmp`, bytes);
    renameSync(`${path}.tmp`, path);
    expect(await fingerprintFile(path, bytes.length)).not.toBe(result.rendition.fingerprint as SourceFingerprint);
  }, 120_000);
});

describe("tool discovery (no real tools needed)", () => {
  it("refuses relative paths, wrong binaries and missing files, and never searches anywhere else", async () => {
    const empty = await resolveMediaTools({ PATH: "", VELORA_FFPROBE_PATH: "ffprobe.exe", VELORA_FFMPEG_PATH: join(work, "not-ffmpeg.exe") });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.errors).toContain("VELORA_FFPROBE_PATH must be an absolute path");
    expect(empty.errors.some((e) => e.startsWith("VELORA_FFMPEG_PATH must point to ffmpeg"))).toBe(true);
    const missing = await resolveMediaTools({ PATH: "", VELORA_FFPROBE_PATH: join(work, "nothing", process.platform === "win32" ? "ffprobe.exe" : "ffprobe") });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors).toContain("VELORA_FFPROBE_PATH does not name an existing file");
      expect(missing.errors.some((e) => e.startsWith("ffmpeg not found"))).toBe(true);
    }
  });

  it("a binary that does not report a version is refused", async () => {
    const fake = join(work, "fake-bin");
    mkdirSync(fake, { recursive: true });
    const exe = join(fake, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    writeFileSync(exe, "");
    const result = await resolveMediaTools({ PATH: "", VELORA_FFPROBE_PATH: exe }, async () => ({ code: 0, stdout: "something else", stderrTail: "", timedOut: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("ffprobe at VELORA_FFPROBE_PATH did not report a version");
  });
});
