import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyMedia, readMp4Layout, selectPlaybackStreams, verifyRemux, type MediaInspection, type PlaybackSelection } from "@/lib/ingestion/media";
import { newJournalEntry, openJournal, type JournalEntry } from "@/lib/uploader/journal";
import { digestPackets, freeBytes, probeMedia, remux, resolveMediaTools, runProcess, type MediaTools } from "@/lib/uploader/media-tools";
import { normalizeEntry, type NormalizeDeps } from "@/lib/uploader/normalize";
import { fingerprintFile, withReadRange } from "@/lib/uploader/scan";
import type { SourceFingerprint } from "@/types/ingestion";

/**
 * The media pipeline against real FFmpeg and ffprobe (E3.5, E3.6), on tiny
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

/**
 * Moves `udta` (where an MP4 keeps its iTunes `covr` cover) ahead of the
 * tracks inside `moov`, so ffprobe numbers the cover stream 0. Only valid for
 * a non-fast-start file (moov after mdat): no media offset moves. FFmpeg's
 * muxer never writes this order itself; other tools do.
 */
function coverFirst(from: string, to: string) {
  const file = readFileSync(from);
  const children = (start: number, end: number) => {
    const out: Array<{ type: string; start: number; end: number }> = [];
    for (let at = start; at < end; ) {
      const size = file.readUInt32BE(at);
      out.push({ type: file.toString("latin1", at + 4, at + 8), start: at, end: at + size });
      at += size;
    }
    return out;
  };
  const top = children(0, file.length);
  const moov = top[top.length - 1];
  if (moov.type !== "moov" || !top.some((box) => box.type === "mdat")) throw new Error("fixture: expected a non-fast-start MP4");
  const inner = children(moov.start + 8, moov.end);
  const order = [...inner.filter((b) => b.type === "mvhd"), ...inner.filter((b) => b.type === "udta"), ...inner.filter((b) => b.type !== "mvhd" && b.type !== "udta")];
  writeFileSync(to, Buffer.concat([file.subarray(0, moov.start + 8), ...order.map((b) => file.subarray(b.start, b.end))]));
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
  // E3.6 cover art: a still JPEG stored as the container stores cover art.
  const cover = join(work, "cover.jpg");
  const base = join(work, "base.mkv");
  await ffmpeg(["-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", cover]);
  await ffmpeg([...video, ...tone(), ...h264, "-c:a", "libmp3lame", "-ac", "2", base]);
  // A: film 0, audio 1, cover 2 (an iTunes covr image, like the six library MP4s); not fast-start.
  await ffmpeg(["-i", base, "-i", cover, "-map", "0:v", "-map", "0:a", "-map", "1", "-c", "copy", "-disposition:2", "attached_pic", at("Cover Art.VJ Test.2024.mp4")]);
  // Audio 0, film 1, cover 2.
  await ffmpeg(["-i", base, "-i", cover, "-map", "0:a", "-map", "0:v", "-map", "1", "-c", "copy", "-disposition:2", "attached_pic", at("Audio First Cover.VJ Test.2024.mp4")]);
  // B: cover 0, film 1, audio 2.
  coverFirst(fixtures["Cover Art.VJ Test.2024.mp4"], at("Cover First.VJ Test.2024.mp4"));
  // Matroska keeps cover art as an attachment, which FFmpeg exposes as a flagged video stream.
  await ffmpeg(["-i", base, "-map", "0", "-c", "copy", "-attach", cover, "-metadata:s:t", "mimetype=image/jpeg", at("Matroska Cover.VJ Test.2024.mkv")]);
  // The same JPEG muxed as an ordinary track (Matroska drops the flag): a second video stream, not cover art.
  await ffmpeg(["-i", base, "-i", cover, "-map", "1", "-map", "0:a", "-map", "0:v", "-c", "copy", "-disposition:0", "attached_pic", at("Mjpeg Track.VJ Test.2024.mkv")]);
  // D with cover art beside it: two audio streams stay ambiguous.
  await ffmpeg(["-i", base, ...tone(880), "-i", cover, "-map", "0:v", "-map", "0:a", "-map", "1:a", "-map", "2", "-c:v", "copy", "-c:a", "libmp3lame", "-disposition:3", "attached_pic", at("Two Audio Cover.VJ Test.2024.mp4")]);
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
    ["Cover Art.VJ Test.2024.mp4", "remux", ["mp4_not_fast_start", "attached_picture"]],
    ["Audio First Cover.VJ Test.2024.mp4", "remux", ["mp4_not_fast_start", "attached_picture"]],
    ["Cover First.VJ Test.2024.mp4", "remux", ["mp4_not_fast_start", "attached_picture"]],
    ["Matroska Cover.VJ Test.2024.mkv", "remux", ["container_matroska", "attached_picture"]],
    ["Mjpeg Track.VJ Test.2024.mkv", "manual_review", ["multiple_video_streams"]],
    ["Two Audio Cover.VJ Test.2024.mp4", "manual_review", ["multiple_audio_streams"]],
  ])("%s -> %s", async (name, cls, reasons) => {
    const result = classifyMedia(await probe(name));
    expect(result.class).toBe(cls);
    for (const reason of reasons) expect(result.reasons).toContain(reason);
  });

  it("an unreadable file is a probe failure (ffprobe exits non-zero), which the scan records as manual review", async () => {
    expect(await probeMedia(tools!.ffprobe, fixtures["Broken.VJ Test.2024.mkv"])).toEqual({ ok: false, code: "probe_failed" });
    expect(await probeMedia(tools!.ffprobe, join(library, "missing.mkv"))).toEqual({ ok: false, code: "source_unreadable" });
  });

  it("E3.6: real ffprobe flags the covers attached_pic, and selection follows meaning, not position", async () => {
    const expected: Record<string, PlaybackSelection | null> = {
      "Cover Art.VJ Test.2024.mp4": { video: 0, audio: 1, artwork: [2] },
      "Audio First Cover.VJ Test.2024.mp4": { video: 1, audio: 0, artwork: [2] },
      "Cover First.VJ Test.2024.mp4": { video: 1, audio: 2, artwork: [0] },
      "Matroska Cover.VJ Test.2024.mkv": { video: 0, audio: 1, artwork: [2] },
      "Mjpeg Track.VJ Test.2024.mkv": null,
      "Two Audio Cover.VJ Test.2024.mp4": null,
      "Two Video.VJ Test.2024.mkv": null,
      "Two Audio.VJ Test.2024.mkv": null,
    };
    for (const [name, selection] of Object.entries(expected)) expect(selectPlaybackStreams(await probe(name)), name).toEqual(selection);
    // The hazard E3.5 stopped on: in this file FFmpeg's positional 0:v:0 is the cover, not the film.
    const first = await runProcess(tools!.ffprobe.path, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=index,codec_name", "-of", "csv=p=0", fixtures["Cover First.VJ Test.2024.mp4"]], { timeoutMs: 20_000, maxStdoutBytes: 1024 });
    expect(first.stdout.trim()).toBe("0,mjpeg");
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
      digest: (p, selection) => digestPackets(tools!.ffmpeg, p, selection),
      remux: (s, o, selection) => remux(tools!.ffmpeg, s, o, selection),
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

  it.each(["Cover Art.VJ Test.2024.mp4", "Audio First Cover.VJ Test.2024.mp4", "Cover First.VJ Test.2024.mp4", "Matroska Cover.VJ Test.2024.mkv"])("E: %s: the film and audio are copied, the cover is left out, packets identical, source untouched", async (name) => {
    const before = { sha: sha256(fixtures[name]), mtime: statSync(fixtures[name]).mtimeMs };
    const { source, deps } = await run(name);
    const result = await normalizeEntry(source, deps);
    if (result.result !== "normalized") throw new Error(JSON.stringify(result));
    expect(sha256(fixtures[name])).toBe(before.sha);
    expect(statSync(fixtures[name]).mtimeMs).toBe(before.mtime);

    // The rendition is exactly film + audio: canonical, no picture stream, no covr box.
    const output = (await probeMedia(tools!.ffprobe, result.rendition.absolutePath) as { inspection: MediaInspection }).inspection;
    expect(classifyMedia(output)).toMatchObject({ class: "canonical", reasons: [] });
    expect(output.streams.map((s) => [s.type, s.codec, s.attachedPicture])).toEqual([["video", "h264", false], ["audio", "mp3", false]]);
    expect(readFileSync(result.rendition.absolutePath).includes(Buffer.from("covr"))).toBe(false);

    // Identity is proven against the source's selected streams, independently of the pipeline's own digest call.
    const sourceSelection = selectPlaybackStreams(source.media!.inspection!)!;
    const independent = await digestPackets(tools!.ffmpeg, fixtures[name], sourceSelection);
    expect(result.verification.passed).toBe(true);
    expect(result.verification.source).toEqual(independent);
    expect(result.verification.output).toEqual(independent);
    expect(independent!.video.packets).toBeGreaterThan(40);
    // A digest that wrongly took the cover as the video would not match.
    if (sourceSelection.artwork.length) {
      const wrong = await digestPackets(tools!.ffmpeg, fixtures[name], { ...sourceSelection, video: sourceSelection.artwork[0] });
      expect(wrong?.video.packets).toBe(1);
      expect(wrong?.video.sha256).not.toBe(independent!.video.sha256);
    }
  }, 120_000);

  it("the verifier catches a re-encode that keeps the codec, container and duration", async () => {
    const source = fixtures[UNUSUAL];
    const reencoded = join(work, "reencoded.mp4");
    await ffmpeg(["-i", source, "-map", "0:v:0", "-map", "0:a:0", ...h264, "-crf", "40", "-c:a", "copy", "-movflags", "+faststart", reencoded]);
    const selection = { video: 0, audio: 1, artwork: [] };
    const [a, b] = [await digestPackets(tools!.ffmpeg, source, selection), await digestPackets(tools!.ffmpeg, reencoded, selection)];
    const verification = verifyRemux(await probe(UNUSUAL), (await probeMedia(tools!.ffprobe, reencoded) as { inspection: MediaInspection }).inspection, a!, b!);
    expect(verification.passed).toBe(false);
    expect(verification.failures).toContain("video_packets_changed");
    // The copied audio is still identical: the check is per stream.
    expect(verification.failures.some((f) => f.startsWith("audio_packets"))).toBe(false);
  }, 120_000);

  it("FFmpeg failure on unreadable input: a clean failure, no rendition left behind", async () => {
    const broken = fixtures["Broken.VJ Test.2024.mkv"];
    const output = join(work, "never.mp4.partial");
    const result = await remux(tools!.ffmpeg, broken, output, { video: 0, audio: 1, artwork: [] });
    expect(result).toMatchObject({ ok: false, code: "ffmpeg_failed" });
    expect(() => statSync(output)).toThrow();
  });

  it("an existing output is never overwritten, and is reported, not taken for success", async () => {
    // FFmpeg 9.0.2 with -n refuses to overwrite yet exits 0, so remux() checks itself.
    const output = join(work, "exists.mp4.partial");
    writeFileSync(output, "keep me");
    expect(await remux(tools!.ffmpeg, fixtures[UNUSUAL], output, { video: 0, audio: 1, artwork: [] })).toEqual({ ok: false, code: "output_exists", detail: "" });
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
