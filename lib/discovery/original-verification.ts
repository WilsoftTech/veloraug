import { audioStreams, playableVideo, type MediaInspection } from "@/lib/ingestion/media";
import type { assessOriginalMedia } from "@/lib/ingestion/original-media";

/**
 * The Policy 3 verification contract (version 1): what a worker that holds the
 * whole original file must show before the database records its integrity and
 * its streaming readiness as verified. Both ingestion paths use it, on a file
 * the upload worker staged or on one spooled from Telegram through the
 * gateway's reader. The file is only read: nothing is converted, repackaged or
 * rewritten.
 *
 * Four separate findings, each with its own status and reasons:
 *
 * - digest:    SHA-256 of every byte, and how many bytes that was.
 * - integrity: the film's video and every audio track decode from the first
 *              packet to the last with errors fatal, and the decode reaches the
 *              container's duration. A file that ends early fails here.
 * - streaming: a layout the player can start from, and a decode after seeking
 *              to the start, the middle and near the end. Attempted only when
 *              integrity passed.
 * - download:  whether the gateway can serve the original as an attachment.
 *              Not a gate, and nothing to do with rights.
 *
 * Browser compatibility is not part of it: it stays the separate prediction of
 * the bounded assessment. A finding that was not made is reported as not made,
 * never as passed. The database validates the same rules again
 * (private.original_media_verification_valid) and binds the digest to the file
 * it has on record; this module decides nothing about rights, approval or
 * publication.
 */

export const VERIFICATION_CONTRACT = 1;
export const WHOLE_FILE_METHOD = "full_original_v1";
export const WHOLE_FILE_SCOPE = "whole_file";
/** The gateway's download ceiling (lib/media-gateway/download.ts), which is the Telegram upload ceiling. */
const DOWNLOAD_MAX_BYTES = 2000 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", mkv: "video/x-matroska" };

type Assessment = ReturnType<typeof assessOriginalMedia>;
/**
 * `exitCode` and `errors` (FFmpeg's error lines, kept in memory only) let a
 * failure be named. A decoder that does not report them leaves it unnamed:
 * `decode_failed`, which says nothing about whether the file is damaged.
 */
export type DecodeOutcome = { outcome: "decoded" | "decode_failed" | "decode_timeout"; seconds: number; frames: number; exitCode?: number | null; errors?: readonly string[] };
export interface VerificationDecoder {
  /** Decodes the film's video and these audio streams, whole (`window` null) or after a seek. */
  decode(streams: { video: number; audio: readonly number[] }, window: { start: number; seconds: number } | null): Promise<DecodeOutcome>;
}
export interface OriginalVerification {
  contract: 1;
  digest: { algorithm: "sha256"; value: string; bytes: number };
  integrity: { status: "verified" | "failed"; method: "whole_file_decode_v1"; duration_seconds: number | null; decoded_seconds: number | null; reasons: string[] };
  streaming: { status: "verified" | "failed" | "not_attempted"; method: "sampled_seek_decode_v1"; layout: "mp4_head_index" | "mp4_tail_index" | "matroska" | null;
    samples: { position: "start" | "middle" | "end"; seconds: number; decoded: boolean }[]; reasons: string[] };
  download: { status: "original_servable" | "not_servable"; reasons: string[] };
  tools: { ffmpeg: string; ffprobe: string };
  started_at: string;
  finished_at: string;
}
export interface VerificationInput {
  /** The inspection of the whole file (a full probe, not a bounded head). */
  inspection: MediaInspection;
  assessment: Assessment;
  /** The size the file is recorded with, and the digest and byte count of what was actually read. */
  sizeBytes: number;
  sha256: string;
  bytesHashed: number;
  /** The media type the document is recorded with. Undefined: not recorded yet (an upload before its transfer). */
  mediaType?: string | null;
  fileName?: string | null;
  tools: { ffmpeg: string; ffprobe: string };
  now: () => Date;
}

const toolToken = (version: string) => version.replace(/[^A-Za-z0-9._+:-]/g, "_").slice(0, 60) || "unknown";

/** The decode is complete when it comes within a second, or 2% for a long film, of the container's duration. */
export const decodeReaches = (decodedSeconds: number, durationSeconds: number): boolean => decodedSeconds >= durationSeconds - Math.max(1, durationSeconds * 0.02);

/** An error this close to the container's duration comes after the whole film has been decoded. */
const END_WINDOW_SECONDS = 1;
// FFmpeg 9 wording, from the committed fixtures damaged on purpose (lib/uploader/media-ffmpeg.test.ts).
const NO_DECODER = /no decoder found for|Decoder \(codec [^)]*\) not found|is not implemented|Unsupported codec/i;
const NOT_OPENED = /Error opening input|EBML header parsing failed|moov atom not found/i;
const ENDED_EARLY = /File ended prematurely|Truncating packet|partial file|End of file/i;
const DAMAGED = /error while decoding|Invalid NAL unit|corrupt (input packet|decoded frame)|Error submitting packet to decoder|invalid as first byte of an EBML number|missing picture|concealing|Reference \d+ >=|non-existing PPS|Header missing|invalid (new )?backstep|overread/i;

/**
 * Names a whole-file decode that did not succeed, from what FFmpeg reported and
 * where it stopped. Only data the decoder itself called damaged, before the
 * end of the film, is `decode_corrupt_data`. Anything that cannot be told
 * apart stays `decode_failed`: a failure with no verdict on the file.
 */
export function decodeFailureReason(decode: DecodeOutcome, durationSeconds: number): string {
  if (decode.outcome === "decode_timeout") return "decode_timeout";
  if (decode.errors === undefined) return "decode_failed";
  const text = decode.errors.join("\n");
  // Stopped by the machine (killed, could not start, output over its limit), or exited non-zero naming nothing in the file.
  if (decode.exitCode === null || (!text.trim() && decode.exitCode !== 0)) return "decode_tool_failed";
  if (NO_DECODER.test(text)) return "decode_codec_unsupported";
  if (decode.seconds === 0 && decode.frames === 0 && NOT_OPENED.test(text)) return "decode_container_unparsable";
  if (decode.seconds >= durationSeconds - END_WINDOW_SECONDS) return "decode_error_at_end";
  if (DAMAGED.test(text)) return "decode_corrupt_data";
  if (ENDED_EARLY.test(text)) return "content_truncated";
  return "decode_failed";
}

export async function verifyOriginal(input: VerificationInput, decoder: VerificationDecoder): Promise<OriginalVerification> {
  const started = input.now().toISOString();
  const { inspection, assessment } = input;
  const video = playableVideo(inspection)[0];
  const audio = audioStreams(inspection);
  const duration = inspection.durationSeconds && inspection.durationSeconds > 0 ? inspection.durationSeconds : null;

  // Integrity. Inconsistent metadata is already a failure: there is nothing sound to decode against.
  const integrity: OriginalVerification["integrity"] = { status: "failed", method: "whole_file_decode_v1", duration_seconds: duration, decoded_seconds: null, reasons: [...assessment.reasons] };
  if (input.bytesHashed !== input.sizeBytes) integrity.reasons.push("content_size_mismatch");
  if (!integrity.reasons.length) {
    // Nothing is verified by default: without a film stream and a duration there is nothing to decode against.
    if (!video || !duration) integrity.reasons.push("media_not_decodable");
    else {
      const whole = await decoder.decode({ video: video.index, audio: audio.map((track) => track.index) }, null);
      integrity.decoded_seconds = whole.seconds;
      if (whole.outcome !== "decoded") integrity.reasons.push(decodeFailureReason(whole, duration));
      else if (!decodeReaches(whole.seconds, duration)) integrity.reasons.push("content_truncated");
    }
  }
  if (!integrity.reasons.length) integrity.status = "verified";

  // Streaming readiness, on bytes whose integrity held.
  const streaming: OriginalVerification["streaming"] = { status: "not_attempted", method: "sampled_seek_decode_v1", layout: null, samples: [], reasons: [] };
  if (integrity.status === "verified" && video && duration) {
    if (assessment.container === "mkv") streaming.layout = "matroska";
    else if (inspection.layout?.fragmented) streaming.reasons.push("mp4_fragmented_untested");
    else if (inspection.layout?.complete && inspection.layout.boxes.includes("moov")) streaming.layout = inspection.layout.fastStart ? "mp4_head_index" : "mp4_tail_index";
    else streaming.reasons.push("mp4_index_unusable");
    if (streaming.layout) {
      const length = Math.min(2, duration);
      const points = [["start", 0], ["middle", duration / 2], ["end", Math.max(0, duration - Math.max(length, duration * 0.1))]] as const;
      for (const [position, seconds] of points) {
        const sample = await decoder.decode({ video: video.index, audio: audio.slice(0, 1).map((track) => track.index) }, { start: seconds, seconds: length });
        streaming.samples.push({ position, seconds: Number(seconds.toFixed(3)), decoded: sample.outcome === "decoded" && sample.frames > 0 });
      }
      if (streaming.samples.some((sample) => !sample.decoded)) streaming.reasons.push("seek_decode_failed");
    }
    streaming.status = streaming.reasons.length ? "failed" : "verified";
  }

  // Download: can the gateway serve this original as it is? Judged on its own, whatever the findings above.
  const reasons: string[] = [];
  const container = assessment.container;
  if (container !== "mp4" && container !== "mkv") reasons.push("download_container_unsupported");
  if (input.sizeBytes > DOWNLOAD_MAX_BYTES) reasons.push("download_size_over_limit");
  if (container && input.mediaType !== undefined && input.mediaType !== MEDIA_TYPES[container]) reasons.push("download_media_type_mismatch");
  if (container && input.fileName && input.fileName.split(".").pop()?.toLowerCase() !== container) reasons.push("download_extension_mismatch");

  return {
    contract: VERIFICATION_CONTRACT, digest: { algorithm: "sha256", value: input.sha256, bytes: input.bytesHashed },
    integrity, streaming, download: { status: reasons.length ? "not_servable" : "original_servable", reasons },
    tools: { ffmpeg: toolToken(input.tools.ffmpeg), ffprobe: toolToken(input.tools.ffprobe) }, started_at: started, finished_at: input.now().toISOString(),
  };
}

/**
 * The assessment a whole-file inspection records: the bounded assessment's
 * facts (container, tracks, browser predictions, warnings) with the three
 * statuses taken from the verification. Accepted only when integrity and
 * streaming are both verified; otherwise the reasons say which finding failed.
 */
export function verifiedAssessment(assessment: Assessment, verification: OriginalVerification) {
  const reasons = [...new Set([...verification.integrity.reasons, ...verification.streaming.reasons])];
  return {
    ...assessment, reasons, accepted: reasons.length === 0,
    integrity: verification.integrity.status === "verified" ? "verified" : "incomplete",
    streaming: verification.streaming.status === "verified" ? "verified" : "unverified",
    download: verification.download.status,
    verification,
  };
}
