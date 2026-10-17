import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyMedia, readMp4Layout, selectPlaybackStreams, verifyRemux, type MediaInspection, type PlaybackSelection } from "@/lib/ingestion/media";
import { assessOriginalMedia } from "@/lib/ingestion/original-media";
import { decodeFailureReason, verifiedAssessment, verifyOriginal } from "@/lib/discovery/original-verification";
import { newJournalEntry, openJournal, type JournalEntry } from "@/lib/uploader/journal";
import { decodeStreams, digestPackets, freeBytes, probeMedia, remux, resolveMediaTools, runProcess, spoolDocument, type MediaTools } from "@/lib/uploader/media-tools";
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

// Checkpoint 10: the two helpers of the Policy 3 verification contract, on the committed synthetic browser fixtures.
describe.skipIf(!tools)("real whole-file decode and seek (verification contract)", () => {
  const fixture = (name: string) => join("tests/browser/fixtures", name);
  it("decodes a whole fixture to its end, and after a seek, reporting how far it got", async () => {
    for (const [name, audio] of [["mp4-h264-aac-moov-at-end.mp4", [1]], ["mkv-h264-aac-two-audio.mkv", [1, 2]]] as const) {
      const whole = await decodeStreams(tools!.ffmpeg, fixture(name), { video: 0, audio });
      expect(whole.outcome, name).toBe("decoded"); expect(whole.frames, name).toBeGreaterThan(100); expect(whole.seconds, name).toBeGreaterThan(11.5);
      const seek = await decodeStreams(tools!.ffmpeg, fixture(name), { video: 0, audio: [1] }, { start: 9, seconds: 2 });
      expect(seek, name).toMatchObject({ outcome: "decoded" }); expect(seek.frames, name).toBeGreaterThan(0); expect(seek.seconds, name).toBeLessThanOrEqual(2.2);
    }
  });
  it("a truncated file, a damaged one and one that is not media are failures, never a shorter success", async () => {
    const source = readFileSync(fixture("mkv-h264-aac.mkv"));
    const truncated = join(work, "truncated.mkv"), damaged = join(work, "damaged.mkv"), noise = join(work, "noise.mkv");
    writeFileSync(truncated, source.subarray(0, 150_000));
    const broken = Buffer.from(source); broken.fill(0, 120_000, 140_000); writeFileSync(damaged, broken);
    writeFileSync(noise, Buffer.alloc(50_000, 7));
    const cut = await decodeStreams(tools!.ffmpeg, truncated, { video: 0, audio: [1] });
    // FFmpeg exits 0 for a file that ends early; its message and the short decode are what give it away.
    expect(cut.outcome).toBe("decode_failed"); expect(cut.seconds).toBeLessThan(10);
    expect((await decodeStreams(tools!.ffmpeg, damaged, { video: 0, audio: [1] })).outcome).toBe("decode_failed");
    expect((await decodeStreams(tools!.ffmpeg, noise, { video: 0, audio: [1] })).outcome).toBe("decode_failed");
    expect((await decodeStreams(tools!.ffmpeg, fixture("mkv-h264-aac.mkv"), { video: 0, audio: [1] }, null, runProcess, 1)).outcome).toBe("decode_timeout");
    // The source fixture was only read.
    expect(createHash("sha256").update(readFileSync(fixture("mkv-h264-aac.mkv"))).digest("hex")).toBe(createHash("sha256").update(source).digest("hex"));
  });
});

describe("spooling a document for verification (no real tools needed)", () => {
  const spool = join(work, "spool");
  const document = Buffer.from(Array.from({ length: 2_500_000 }, (_, index) => (index * 31 + 7) & 0xff));
  const reader = (bytes: Buffer, calls: number[] = []) => async (offset: number, length: number) => { calls.push(length); return bytes.subarray(offset, offset + length); };
  const leftovers = () => { try { return statSync(spool).isDirectory() ? readFileSync : null; } catch { return null; } };
  it("reads the document once, in order, in bounded pieces, hashes every byte and removes its copy", async () => {
    const calls: number[] = [];
    let seen = "";
    const result = await spoolDocument(spool, reader(document, calls), document.length, async (file) => {
      seen = file.path;
      expect(createHash("sha256").update(readFileSync(file.path)).digest("hex")).toBe(file.sha256);
      return { sha256: file.sha256, bytes: file.bytes };
    });
    expect(result).toEqual({ sha256: createHash("sha256").update(document).digest("hex"), bytes: document.length });
    expect(calls).toEqual([1_048_576, 1_048_576, 402_848]);
    expect(() => statSync(seen)).toThrow(); expect(leftovers()).not.toBeNull();
  });
  it("reports a reader that stops short as fewer bytes, and removes the copy when the caller or the reader fails", async () => {
    const short = await spoolDocument(spool, reader(document.subarray(0, 1_500_000)), document.length, async (file) => file.bytes);
    expect(short).toBe(1_500_000);
    let path = "";
    await expect(spoolDocument(spool, reader(document), document.length, async (file) => { path = file.path; throw new Error("verification_failed_midway"); })).rejects.toThrow("verification_failed_midway");
    expect(() => statSync(path)).toThrow();
    await expect(spoolDocument(spool, async () => { throw new Error("media_read_failed"); }, document.length, async () => "unreached")).rejects.toThrow("media_read_failed");
  });
  it("refuses, before reading anything, a place it cannot use or a document the volume cannot hold", async () => {
    const calls: number[] = [];
    for (const [dir, size] of [["relative/spool", 1000], [spool, 0], [spool, Number.MAX_SAFE_INTEGER]] as const)
      await expect(spoolDocument(dir, reader(document, calls), size, async () => "unreached")).rejects.toThrow("verification_storage_unavailable");
    expect(calls).toEqual([]);
  });
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

// Legacy media check fix (2026-10-17): the whole Policy 3 verifier on real files with the real tools. An MP4 is not
// refused for its index at the end, an MKV is accepted, and a decode that fails is named for what it found.
describe.skipIf(!tools)("Policy 3 verification of originals, by format and by failure (real tools)", () => {
  const fixture = (name: string) => join("tests/browser/fixtures", name);
  async function verifyFile(path: string, fileName: string, bytesHashed?: number) {
    const probe = await probeMedia(tools!.ffprobe, path);
    if (!probe.ok) return { probe: probe.code } as const;
    const assessment = assessOriginalMedia(probe.inspection, fileName);
    const size = statSync(path).size;
    const verification = await verifyOriginal({ inspection: probe.inspection, assessment, sizeBytes: size, sha256: "b".repeat(64), bytesHashed: bytesHashed ?? size, fileName,
      tools: { ffmpeg: tools!.ffmpeg.version, ffprobe: tools!.ffprobe.version }, now: () => new Date() }, { decode: (streams, window) => decodeStreams(tools!.ffmpeg, path, streams, window) });
    return { assessment, verification, recorded: verifiedAssessment(assessment, verification) } as const;
  }
  const copy = (name: string, bytes: Buffer) => { const path = join(work, name); writeFileSync(path, bytes); return path; };

  it("verifies a fast-start MP4, an MP4 with its index at the end, an MKV, and an MKV whose audio browsers cannot play", async () => {
    const cases = [
      ["mp4-h264-aac-faststart.mp4", "mp4_head_index", []],
      ["mp4-h264-aac-moov-at-end.mp4", "mp4_tail_index", ["mp4_startup_tail_required"]],
      ["mkv-h264-aac.mkv", "matroska", ["firefox_mkv_streaming_unreliable"]],
      ["mkv-h264-ac3.mkv", "matroska", ["ac3_audio_silent_in_tested_browsers"]],
    ] as const;
    for (const [name, layout, warnings] of cases) {
      const result = await verifyFile(fixture(name), name);
      if ("probe" in result) throw new Error(`${name}: ${result.probe}`);
      expect(result.verification.integrity, name).toMatchObject({ status: "verified", reasons: [] });
      expect(result.verification.streaming, name).toMatchObject({ status: "verified", layout });
      expect(result.recorded, name).toMatchObject({ accepted: true, integrity: "verified", streaming: "verified", download: "original_servable" });
      // Browser compatibility is recorded beside integrity and streaming, never in place of them.
      for (const warning of warnings) expect(result.recorded.warnings, name).toContain(warning);
    }
    const ac3 = await verifyFile(fixture("mkv-h264-ac3.mkv"), "mkv-h264-ac3.mkv");
    if ("probe" in ac3) throw new Error(ac3.probe);
    expect(ac3.recorded.compatibility).toMatchObject({ chromium: "tested_video_only_silent_audio" });
  });

  it("names each failure, and none of them verifies", async () => {
    const aac = readFileSync(fixture("mkv-h264-aac.mkv")), mp3 = readFileSync(fixture("mkv-h264-mp3.mkv")), mp4 = readFileSync(fixture("mp4-h264-aac-faststart.mp4"));
    const flipped = Buffer.from(aac); for (let at = 100_000; at < 100_400; at += 1) flipped[at] ^= 0x5a;
    const finalBlock = Buffer.from(mp3); finalBlock.fill(0, finalBlock.length - 1500, finalBlock.length - 900);
    const cases = [
      ["corrupt.mkv", flipped, "decode_corrupt_data"],
      ["final-block.mkv", finalBlock, "decode_error_at_end"],
      ["truncated.mkv", aac.subarray(0, 150_000), "content_truncated"],
    ] as const;
    for (const [name, bytes, reason] of cases) {
      const result = await verifyFile(copy(name, bytes), name);
      if ("probe" in result) throw new Error(`${name}: ${result.probe}`);
      expect(result.verification.integrity, name).toMatchObject({ status: "failed", reasons: [reason] });
      expect(result.recorded, name).toMatchObject({ accepted: false, integrity: "incomplete", streaming: "unverified" });
    }
    // A truncated MP4: its boxes no longer cover the file, so it is refused before any decode is asked for.
    const cutMp4 = await verifyFile(copy("truncated.mp4", mp4.subarray(0, 170_000)), "truncated.mp4");
    if ("probe" in cutMp4) throw new Error(cutMp4.probe);
    expect(cutMp4.verification.integrity).toMatchObject({ status: "failed", reasons: ["mp4_layout_incomplete"], decoded_seconds: null });
    expect(cutMp4.recorded.accepted).toBe(false);
    // An incomplete read: fewer bytes hashed than recorded is a failure before any decode.
    const short = await verifyFile(fixture("mkv-h264-aac.mkv"), "mkv-h264-aac.mkv", 100_000);
    if ("probe" in short) throw new Error(short.probe);
    expect(short.verification.integrity).toMatchObject({ status: "failed", reasons: ["content_size_mismatch"], decoded_seconds: null });
  });

  it("an unsupported codec is a limit of the decoder, and a container it cannot open is named as such", async () => {
    const unknown = Buffer.from(readFileSync(fixture("mkv-h264-aac.mkv"))); unknown.write("V_XXXXX/ISO/AVC", unknown.indexOf("V_MPEG4/ISO/AVC"));
    const decoded = await decodeStreams(tools!.ffmpeg, copy("codec-unknown.mkv", unknown), { video: 0, audio: [1] });
    expect(decoded.outcome).toBe("decode_failed");
    expect(decodeFailureReason(decoded, 12.021)).toBe("decode_codec_unsupported");
    // The bounded and full assessments refuse it before a decode is ever asked for.
    const probed = await probeMedia(tools!.ffprobe, join(work, "codec-unknown.mkv"));
    if (probed.ok) expect(assessOriginalMedia(probed.inspection, "codec-unknown.mkv").accepted).toBe(false);
    const noise = await decodeStreams(tools!.ffmpeg, copy("noise.mkv", Buffer.alloc(50_000, 7)), { video: 0, audio: [1] });
    expect(decodeFailureReason(noise, 12.021)).toBe("decode_container_unparsable");
  });
});
