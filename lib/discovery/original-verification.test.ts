import { describe, expect, it } from "vitest";
import type { MediaInspection } from "@/lib/ingestion/media";
import { assessOriginalMedia } from "@/lib/ingestion/original-media";
import { decodeReaches, verifiedAssessment, verifyOriginal, type DecodeOutcome, type VerificationDecoder, type VerificationInput } from "./original-verification";
import { verifyChannelOriginal, transientMediaFailure, type WholeFilePorts } from "./media-verification";

/**
 * The Policy 3 verification contract (Checkpoint 10), with a scripted decoder:
 * what counts as verified, what each failure is called, and that nothing is
 * verified by default. The real tools and the database's own validation of the
 * same rules are in tests/integration/original-verification.test.tsx.
 */
const stream = (index: number, type: "video" | "audio" | "subtitle", codec: string, extra: Record<string, unknown> = {}) => ({ index, type, codec, codecTag: null, profile: type === "video" ? "High" : "LC", level: 40, width: type === "video" ? 1920 : null,
  height: type === "video" ? 1080 : null, pixelFormat: type === "video" ? "yuv420p" : null, fieldOrder: null, frameRate: null, timeBase: null, startSeconds: 0, durationSeconds: 5400, sampleRate: type === "audio" ? 48000 : null,
  channels: type === "audio" ? 2 : null, channelLayout: null, bitRate: null, attachedPicture: false, language: null, title: null, defaultTrack: true, forced: false, ...extra }) as unknown as MediaInspection["streams"][number];
const mp4 = (layout: Partial<NonNullable<MediaInspection["layout"]>> = {}, streams = [stream(0, "video", "h264"), stream(1, "audio", "aac"), stream(2, "audio", "aac")]): MediaInspection => ({ formatName: "mov,mp4,m4a,3gp,3g2,mj2", majorBrand: "isom", durationSeconds: 5400, sizeBytes: 1000, probeSizeBytes: 1000, streams,
  layout: { boxes: ["ftyp", "moov", "mdat"], fastStart: true, fragmented: false, complete: true, ...layout } });
const mkv = (): MediaInspection => ({ formatName: "matroska,webm", matroskaDocType: "matroska", majorBrand: null, durationSeconds: 5400, sizeBytes: 1000, probeSizeBytes: 1000, streams: [stream(0, "video", "hevc", { profile: "Main" }), stream(1, "audio", "ac3", { profile: null }), stream(2, "subtitle", "subrip")], layout: null });
const SHA = "a".repeat(64);
const input = (inspection: MediaInspection, extra: Partial<VerificationInput> = {}): VerificationInput => ({ inspection, assessment: assessOriginalMedia(inspection), sizeBytes: 1000, sha256: SHA, bytesHashed: 1000,
  tools: { ffmpeg: "9.0.2-essentials_build-www.gyan.dev", ffprobe: "9.0.2" }, now: () => new Date("2026-10-14T08:00:00.000Z"), ...extra });
/** A decoder that answers from a script and records what it was asked. */
function decoder(whole: Partial<DecodeOutcome> = {}, samples: (start: number) => Partial<DecodeOutcome> = () => ({})) {
  const calls: { streams: { video: number; audio: readonly number[] }; window: { start: number; seconds: number } | null }[] = [];
  const port: VerificationDecoder = { async decode(streams, window) {
    calls.push({ streams, window });
    return { outcome: "decoded", seconds: window ? window.seconds : 5399.6, frames: window ? 48 : 129_600, ...(window ? samples(window.start) : whole) };
  } };
  return { port, calls };
}

describe("verification contract: what is verified", () => {
  it("verifies integrity and streaming of an MP4 from a whole decode and three seeks, and reads every audio track", async () => {
    const { port, calls } = decoder();
    const result = await verifyOriginal(input(mp4(), { mediaType: "video/mp4", fileName: "Film.mp4" }), port);
    expect(result).toEqual({ contract: 1, digest: { algorithm: "sha256", value: SHA, bytes: 1000 },
      integrity: { status: "verified", method: "whole_file_decode_v1", duration_seconds: 5400, decoded_seconds: 5399.6, reasons: [] },
      streaming: { status: "verified", method: "sampled_seek_decode_v1", layout: "mp4_head_index", reasons: [],
        samples: [{ position: "start", seconds: 0, decoded: true }, { position: "middle", seconds: 2700, decoded: true }, { position: "end", seconds: 4860, decoded: true }] },
      download: { status: "original_servable", reasons: [] }, tools: { ffmpeg: "9.0.2-essentials_build-www.gyan.dev", ffprobe: "9.0.2" },
      started_at: "2026-10-14T08:00:00.000Z", finished_at: "2026-10-14T08:00:00.000Z" });
    // The whole decode covers the film and both audio tracks; a seek sample needs only the first.
    expect(calls).toEqual([{ streams: { video: 0, audio: [1, 2] }, window: null }, { streams: { video: 0, audio: [1] }, window: { start: 0, seconds: 2 } },
      { streams: { video: 0, audio: [1] }, window: { start: 2700, seconds: 2 } }, { streams: { video: 0, audio: [1] }, window: { start: 4860, seconds: 2 } }]);
    const assessment = verifiedAssessment(input(mp4()).assessment, result);
    expect(assessment).toMatchObject({ accepted: true, reasons: [], integrity: "verified", streaming: "verified", download: "original_servable", container: "mp4" });
    expect(assessment.tracks).toHaveLength(3); expect(assessment.compatibility).toEqual(input(mp4()).assessment.compatibility);
  });

  it("an MKV with HEVC and AC-3 verifies: what a browser can play is a separate prediction and changes nothing here", async () => {
    const result = await verifyOriginal(input(mkv(), { mediaType: "video/x-matroska" }), decoder().port);
    expect([result.integrity.status, result.streaming.status, result.streaming.layout]).toEqual(["verified", "verified", "matroska"]);
    const assessment = verifiedAssessment(input(mkv()).assessment, result);
    expect(assessment).toMatchObject({ accepted: true, integrity: "verified", streaming: "verified", compatibility: { chromium: "device_dependent_or_untested", firefox: "streaming_unreliable" } });
    expect(assessment.warnings).toEqual(expect.arrayContaining(["ac3_audio_silent_in_tested_browsers", "hevc_device_decoder_required", "embedded_subtitles_not_displayed"]));
  });

  it("a tail-index MP4 is streamable; a fragmented one has verified integrity and failed streaming, with no seek attempted", async () => {
    expect((await verifyOriginal(input(mp4({ fastStart: false })), decoder().port)).streaming).toMatchObject({ status: "verified", layout: "mp4_tail_index" });
    const { port, calls } = decoder();
    const fragmented = await verifyOriginal(input(mp4({ fragmented: true, boxes: ["ftyp", "moov", "moof", "mdat"] })), port);
    expect(fragmented.integrity.status).toBe("verified");
    expect(fragmented.streaming).toEqual({ status: "failed", method: "sampled_seek_decode_v1", layout: null, samples: [], reasons: ["mp4_fragmented_untested"] });
    expect(calls).toHaveLength(1);
    expect(verifiedAssessment(input(mp4()).assessment, fragmented)).toMatchObject({ accepted: false, reasons: ["mp4_fragmented_untested"], integrity: "verified", streaming: "unverified" });
  });
});

describe("verification contract: what is not", () => {
  it.each([[{ outcome: "decode_failed" as const, seconds: 2700 }, "decode_failed"], [{ outcome: "decode_timeout" as const, seconds: 100 }, "decode_timeout"], [{ seconds: 5200 }, "content_truncated"]])(
    "a whole decode that %j fails integrity as %s, and streaming is not attempted", async (whole, reason) => {
      const { port, calls } = decoder(whole);
      const result = await verifyOriginal(input(mp4()), port);
      expect(result.integrity).toMatchObject({ status: "failed", reasons: [reason] });
      expect(result.streaming).toEqual({ status: "not_attempted", method: "sampled_seek_decode_v1", layout: null, samples: [], reasons: [] });
      expect(calls).toHaveLength(1);
      expect(verifiedAssessment(input(mp4()).assessment, result)).toMatchObject({ accepted: false, reasons: [reason], integrity: "incomplete", streaming: "unverified" });
    });

  it("a seek that does not decode, or decodes no frame, fails streaming and leaves integrity verified", async () => {
    for (const sample of [{ outcome: "decode_failed" as const }, { frames: 0 }]) {
      const result = await verifyOriginal(input(mp4()), decoder({}, (start) => (start === 2700 ? sample : {})).port);
      expect(result.integrity.status).toBe("verified");
      expect(result.streaming).toMatchObject({ status: "failed", reasons: ["seek_decode_failed"], samples: [{ decoded: true }, { decoded: false }, { decoded: true }] });
    }
  });

  it("fewer bytes than the file's size, or inconsistent metadata, is never decoded and never verified", async () => {
    const short = decoder();
    expect((await verifyOriginal(input(mp4(), { bytesHashed: 999 }), short.port)).integrity).toMatchObject({ status: "failed", reasons: ["content_size_mismatch"], decoded_seconds: null });
    const inconsistent = decoder();
    const noAudio = mp4({}, [stream(0, "video", "h264")]);
    expect((await verifyOriginal(input(noAudio), inconsistent.port)).integrity).toMatchObject({ status: "failed", reasons: ["audio_metadata_incomplete"] });
    expect(short.calls.length + inconsistent.calls.length).toBe(0);
  });

  it("nothing is verified by default: an assessment that claims acceptance without a film stream or a duration still fails", async () => {
    const empty = { ...mp4(), streams: [stream(1, "audio", "aac")] };
    const { port, calls } = decoder();
    const result = await verifyOriginal({ ...input(mp4()), inspection: empty }, port);
    expect(result.integrity).toMatchObject({ status: "failed", reasons: ["media_not_decodable"] }); expect(result.streaming.status).toBe("not_attempted"); expect(calls).toHaveLength(0);
    expect((await verifyOriginal({ ...input(mp4()), inspection: { ...mp4(), durationSeconds: null } }, decoder().port)).integrity.reasons).toEqual(["media_not_decodable"]);
  });

  it("the decode must reach the end: within a second, or 2% of a long film", () => {
    expect([decodeReaches(11.2, 12), decodeReaches(10.9, 12), decodeReaches(5292, 5400), decodeReaches(5291, 5400), decodeReaches(0, 0.5)]).toEqual([true, false, true, false, true]);
  });
});

describe("download evidence", () => {
  it("is judged on its own: size, container, recorded media type and extension, whatever the other findings are", async () => {
    const check = async (extra: Partial<VerificationInput>, inspection = mp4()) => (await verifyOriginal(input(inspection, extra), decoder().port)).download;
    expect(await check({ mediaType: "video/mp4", fileName: "Film.MP4" })).toEqual({ status: "original_servable", reasons: [] });
    // Not recorded yet (an upload before its transfer) is not a mismatch; recorded as null or as another type is.
    expect((await check({})).status).toBe("original_servable");
    expect(await check({ mediaType: null })).toEqual({ status: "not_servable", reasons: ["download_media_type_mismatch"] });
    expect((await check({ mediaType: "application/octet-stream" })).reasons).toEqual(["download_media_type_mismatch"]);
    expect((await check({ mediaType: "video/mp4" }, mkv())).reasons).toEqual(["download_media_type_mismatch"]);
    expect((await check({ fileName: "Film.mkv" })).reasons).toEqual(["download_extension_mismatch"]);
    expect((await check({ sizeBytes: 2000 * 1024 * 1024 + 1, bytesHashed: 2000 * 1024 * 1024 + 1 })).reasons).toEqual(["download_size_over_limit"]);
    // A file that failed integrity still has its own download finding, and a download finding never fails the file.
    const failed = await verifyOriginal(input(mp4(), { mediaType: "video/mp4" }), decoder({ outcome: "decode_failed" }).port);
    expect([failed.integrity.status, failed.download.status]).toEqual(["failed", "original_servable"]);
    const unservable = await verifyOriginal(input(mp4(), { mediaType: null }), decoder().port);
    expect(verifiedAssessment(input(mp4()).assessment, unservable)).toMatchObject({ accepted: true, integrity: "verified", streaming: "verified", download: "not_servable", reasons: [] });
  });

  it("records tool versions as short tokens", async () => {
    const result = await verifyOriginal(input(mp4(), { tools: { ffmpeg: "N-1 (built on ~host)", ffprobe: "" } }), decoder().port);
    expect(result.tools).toEqual({ ffmpeg: "N-1__built_on__host_", ffprobe: "unknown" });
  });
});

describe("whole-file verification of a channel document", () => {
  const identity = `tg1-${"b".repeat(64)}`;
  const bytes = new Uint8Array(1000);
  /** The bounded stage is stubbed by a probe that describes an accepted MP4; the whole-file ports are scripted. */
  const ports = (extra: Partial<WholeFilePorts> = {}): { ports: WholeFilePorts; spooled: number[] } => {
    const spooled: number[] = [];
    return { spooled, ports: {
      read: async (offset, length) => bytes.subarray(offset, offset + length), gatewayCompatible: true,
      probe: async () => { throw new Error("probe_failed"); },
      spool: async (read, sizeBytes, handle) => { let total = 0; while (total < sizeBytes) { const chunk = await read(total, 400); if (!chunk.byteLength) break; total += chunk.byteLength; } spooled.push(total); return handle({ path: "/spool/original", sha256: SHA, bytes: total }); },
      inspect: async () => mp4(), decoder: () => decoder().port, tools: { ffmpeg: "9", ffprobe: "9" }, now: () => new Date("2026-10-14T08:00:00.000Z"), ...extra } };
  };

  it("a document the bounded inspection refuses is never read whole", async () => {
    const { ports: p, spooled } = ports();
    const evidence = await verifyChannelOriginal({ identity, sizeBytes: 1000, mediaType: "video/mp4" }, p);
    expect(evidence).toMatchObject({ method: "bounded_original_v2", media_class: "unverified" });
    expect(evidence.assessment?.integrity ?? "none").not.toBe("verified");
    expect(spooled).toEqual([]);
  });
});

describe("failures that are not findings", () => {
  it("a full disk is retried like a reader outage; a short or damaged document is a finding and is not", () => {
    const evidence = (reasons: string[]) => ({ identity: `tg1-${"c".repeat(64)}`, method: "full_original_v1", policy_version: 3, media_class: "unverified" as const, reasons, container: null, video_codec: null, audio_codec: null,
      accessible: false, gateway_compatible: true, playback_ready: false, bytes_read: 10, inspection_scope: "whole_file" as const });
    expect(transientMediaFailure(evidence(["verification_storage_unavailable"]))).toBe("verification_storage_unavailable");
    expect(transientMediaFailure(evidence(["media_read_flood_wait"]))).toBe("media_read_flood_wait");
    for (const reason of ["content_size_mismatch", "decode_failed", "content_truncated", "probe_failed"]) expect(transientMediaFailure(evidence([reason])), reason).toBeNull();
  });
});
