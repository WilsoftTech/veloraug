import { createHash } from "node:crypto";
import * as z from "zod";
import type { ReadRange } from "@/lib/ingestion/fingerprint";
import type { MediaVerdict } from "@/types/ingestion";

/**
 * Media policy for browser playback (E3.5). Pure: ffprobe output, MP4 box
 * headers and FFmpeg packet listings come in as data, decisions come out. The
 * subprocess and file-system side is lib/uploader/media-tools.ts.
 *
 * Playback is progressive: one fast-start MP4 per version, read by the native
 * <video> element through HTTP ranges (docs/PHASE_E_PLAYBACK_DESIGN.md). A file
 * is classified from its streams, never from its extension:
 *
 * - canonical: fast-start ISO MP4, one H.264 video and one approved audio
 *   stream, nothing else. Uploaded as it is.
 * - remux: the same streams in another container (Matroska, AVI, QuickTime)
 *   or a non-fast-start MP4. Repackaged by stream copy only, then verified.
 * - audio_normalization: the video is acceptable, the audio is not. Would need
 *   an AAC conversion, which is not automated: it stops for the operator.
 * - video_transcode_required: the video is not H.264 8-bit 4:2:0 in policy.
 *   Stops; there is no video transcoding.
 * - manual_review: anything ambiguous or unsafe (no or several video/audio
 *   streams, subtitles, attachments, cover art, unknown duration, a size that
 *   does not match). Never guessed.
 *
 * MP3 audio stays approved: E3.1/E3.3 proved H.264 + MP3 in fast-start MP4 in
 * Chrome and Firefox. Safari/iOS on a real device remains a pre-launch gate; if
 * it fails, MP3 moves to audio_normalization by changing APPROVED_AUDIO here.
 */

/** Bump when the rules change: stored classifications are then recomputed from the stored inspection. */
export const MEDIA_POLICY_VERSION = 1;

export type MediaClass = MediaVerdict["class"];

export interface MediaStream {
  index: number;
  type: "video" | "audio" | "subtitle" | "data" | "attachment" | "other";
  codec: string | null;
  codecTag: string | null;
  profile: string | null;
  level: number | null;
  width: number | null;
  height: number | null;
  pixelFormat: string | null;
  fieldOrder: string | null;
  frameRate: string | null;
  timeBase: string | null;
  startSeconds: number | null;
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  bitRate: number | null;
  /** Cover art: an image stored as a video stream. */
  attachedPicture: boolean;
}

/** Top-level ISO-BMFF box order, read from the box headers only. */
export interface Mp4Layout {
  boxes: string[];
  fastStart: boolean;
  fragmented: boolean;
  /** The boxes cover the file exactly. */
  complete: boolean;
}

export interface MediaInspection {
  formatName: string;
  majorBrand: string | null;
  durationSeconds: number | null;
  /** Bytes on disk (stat), and what the probe reported. */
  sizeBytes: number;
  probeSizeBytes: number | null;
  streams: MediaStream[];
  /** Null when the file is not ISO-BMFF (its first box is not ftyp). */
  layout: Mp4Layout | null;
}

export interface MediaClassification {
  class: MediaClass;
  /** Machine-readable reasons; empty only for canonical. */
  reasons: string[];
  policyVersion: number;
}

// ---------------------------------------------------------------------------
// ffprobe output
// ---------------------------------------------------------------------------

const numeric = z.union([z.number(), z.string()]).optional().nullable();
const probeSchema = z.object({
  streams: z.array(z.object({
    index: z.number().int().nonnegative(),
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    codec_tag_string: z.string().optional(),
    profile: z.union([z.string(), z.number()]).optional(),
    level: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    pix_fmt: z.string().optional(),
    field_order: z.string().optional(),
    r_frame_rate: z.string().optional(),
    time_base: z.string().optional(),
    start_time: numeric,
    duration: numeric,
    sample_rate: numeric,
    channels: z.number().optional(),
    channel_layout: z.string().optional(),
    bit_rate: numeric,
    disposition: z.object({ attached_pic: z.number().optional() }).partial().optional(),
  })).default([]),
  format: z.object({
    format_name: z.string(),
    duration: numeric,
    size: numeric,
    tags: z.record(z.string(), z.string()).optional(),
  }),
});

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const STREAM_TYPES = new Set(["video", "audio", "subtitle", "data", "attachment"]);

/**
 * Validates `ffprobe -show_format -show_streams -print_format json` output and
 * keeps only what the policy and its verification need. Throws on output that
 * is not a probe result.
 */
export function inspectionFromProbe(probe: unknown, sizeBytes: number, layout: Mp4Layout | null): MediaInspection {
  const parsed = probeSchema.parse(probe);
  const tags = parsed.format.tags ?? {};
  return {
    formatName: parsed.format.format_name,
    majorBrand: (tags.major_brand ?? tags.MAJOR_BRAND ?? null)?.trim() || null,
    durationSeconds: num(parsed.format.duration),
    sizeBytes,
    probeSizeBytes: num(parsed.format.size),
    streams: parsed.streams.map((s) => ({
      index: s.index,
      type: (STREAM_TYPES.has(s.codec_type ?? "") ? s.codec_type : "other") as MediaStream["type"],
      codec: s.codec_name ?? null,
      codecTag: s.codec_tag_string ?? null,
      profile: s.profile === undefined ? null : String(s.profile),
      level: s.level ?? null,
      width: s.width ?? null,
      height: s.height ?? null,
      pixelFormat: s.pix_fmt ?? null,
      fieldOrder: s.field_order ?? null,
      frameRate: s.r_frame_rate && s.r_frame_rate !== "0/0" ? s.r_frame_rate : null,
      timeBase: s.time_base ?? null,
      startSeconds: num(s.start_time),
      durationSeconds: num(s.duration),
      sampleRate: num(s.sample_rate),
      channels: s.channels ?? null,
      channelLayout: s.channel_layout ?? null,
      bitRate: num(s.bit_rate),
      attachedPicture: s.disposition?.attached_pic === 1,
    })),
    layout,
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const H264_PROFILES = new Set(["Constrained Baseline", "Baseline", "Main", "High"]);
const H264_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"]);
/** Level 5.1 (ffprobe reports level × 10). */
const H264_MAX_LEVEL = 51;
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 2304;
const INTERLACED = new Set(["tt", "bb", "tb", "bt"]);
const APPROVED_AUDIO = new Set(["aac", "mp3"]);
const AAC_PROFILES = new Set(["LC"]);
const SAMPLE_RATES = new Set([16000, 22050, 24000, 32000, 44100, 48000]);
const MAX_CHANNELS = 2;
/** ISO base media brands; QuickTime ("qt  ") and anything else is repackaged. */
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V", "M4V "]);

export const playableVideo = (inspection: MediaInspection) => inspection.streams.filter((s) => s.type === "video" && !s.attachedPicture);
export const audioStreams = (inspection: MediaInspection) => inspection.streams.filter((s) => s.type === "audio");

function topologyReasons(inspection: MediaInspection): string[] {
  const reasons: string[] = [];
  const video = playableVideo(inspection);
  const audio = audioStreams(inspection);
  if (inspection.streams.length === 0) reasons.push("no_streams");
  if (video.length === 0) reasons.push("no_video");
  if (video.length > 1) reasons.push("multiple_video_streams");
  if (inspection.streams.some((s) => s.type === "video" && s.attachedPicture)) reasons.push("attached_picture");
  if (audio.length === 0) reasons.push("no_audio");
  if (audio.length > 1) reasons.push("multiple_audio_streams");
  for (const type of ["subtitle", "data", "attachment", "other"] as const) {
    if (inspection.streams.some((s) => s.type === type)) reasons.push(`${type}_streams`);
  }
  if (inspection.durationSeconds === null || inspection.durationSeconds <= 0) reasons.push("duration_unknown");
  else {
    const stream = video[0]?.durationSeconds;
    if (video.length === 1 && stream != null && Math.abs(stream - inspection.durationSeconds) > Math.max(2, inspection.durationSeconds * 0.01)) reasons.push("duration_inconsistent");
  }
  if (inspection.probeSizeBytes !== null && inspection.probeSizeBytes !== inspection.sizeBytes) reasons.push("size_mismatch");
  if (video.length === 1 && (video[0].width === null || video[0].height === null)) reasons.push("dimensions_unknown");
  if (video.length === 1 && video[0].frameRate === null) reasons.push("frame_rate_unknown");
  return reasons;
}

function videoReasons(v: MediaStream): string[] {
  if (v.codec !== "h264") return [`video_codec_${v.codec ?? "unknown"}`];
  const reasons: string[] = [];
  if (!v.profile || !H264_PROFILES.has(v.profile)) reasons.push(`h264_profile_${slug(v.profile)}`);
  if (!v.pixelFormat || !H264_PIXEL_FORMATS.has(v.pixelFormat)) reasons.push(`h264_pixel_format_${slug(v.pixelFormat)}`);
  if (v.level !== null && v.level > H264_MAX_LEVEL) reasons.push(`h264_level_${v.level}`);
  if ((v.width ?? 0) > MAX_WIDTH || (v.height ?? 0) > MAX_HEIGHT) reasons.push("video_dimensions_over_policy");
  if (v.fieldOrder !== null && INTERLACED.has(v.fieldOrder)) reasons.push("video_interlaced");
  return reasons;
}

function audioReasons(a: MediaStream): string[] {
  if (!a.codec || !APPROVED_AUDIO.has(a.codec)) return [`audio_codec_${a.codec ?? "unknown"}`];
  const reasons: string[] = [];
  if (a.codec === "aac" && (!a.profile || !AAC_PROFILES.has(a.profile))) reasons.push(`aac_profile_${slug(a.profile)}`);
  if (a.channels === null || a.channels < 1 || a.channels > MAX_CHANNELS) reasons.push(`audio_channels_${a.channels ?? "unknown"}`);
  if (a.sampleRate === null || !SAMPLE_RATES.has(a.sampleRate)) reasons.push(`audio_sample_rate_${a.sampleRate ?? "unknown"}`);
  return reasons;
}

function containerReasons(inspection: MediaInspection, video: MediaStream): string[] {
  const iso = inspection.layout !== null && inspection.formatName.split(",").includes("mp4");
  if (!iso) return [`container_${slug(inspection.formatName.split(",")[0])}`];
  const reasons: string[] = [];
  const layout = inspection.layout!;
  if (!inspection.majorBrand || !MP4_BRANDS.has(inspection.majorBrand)) reasons.push(`mp4_brand_${slug(inspection.majorBrand)}`);
  if (layout.fragmented) reasons.push("mp4_fragmented");
  if (!layout.fastStart) reasons.push("mp4_not_fast_start");
  if (!layout.complete) reasons.push("mp4_layout_incomplete");
  if (video.codecTag !== "avc1") reasons.push(`h264_tag_${slug(video.codecTag)}`);
  return reasons;
}

const slug = (value: string | null | undefined) => (value ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown";

/** Deterministic: the same inspection always yields the same class and reasons. */
export function classifyMedia(inspection: MediaInspection): MediaClassification {
  const result = (cls: MediaClass, reasons: string[]): MediaClassification => ({ class: cls, reasons, policyVersion: MEDIA_POLICY_VERSION });
  const topology = topologyReasons(inspection);
  const videos = playableVideo(inspection);
  const audios = audioStreams(inspection);
  if (topology.length > 0) {
    // Whatever else is already known travels with it (e.g. HEVC beside a cover image).
    const known = [...(videos.length === 1 ? videoReasons(videos[0]) : []), ...(audios.length === 1 ? audioReasons(audios[0]) : [])];
    return result("manual_review", [...topology, ...known]);
  }
  const [video] = videos;
  const [audio] = audios;
  const v = videoReasons(video);
  const a = audioReasons(audio);
  // Audio reasons travel with a video stop so the operator sees everything at once.
  if (v.length > 0) return result("video_transcode_required", [...v, ...a]);
  if (a.length > 0) return result("audio_normalization", a);
  const c = containerReasons(inspection, video);
  return c.length > 0 ? result("remux", c) : result("canonical", []);
}

/** A classification that came from a probe failure rather than a probe result. */
export function unreadableMedia(code: string): MediaClassification {
  return { class: "manual_review", reasons: [code], policyVersion: MEDIA_POLICY_VERSION };
}

// ---------------------------------------------------------------------------
// Fast start: top-level MP4 boxes, from their headers only
// ---------------------------------------------------------------------------

const MAX_BOXES = 4096;

/**
 * Walks the top-level ISO-BMFF boxes with one 16-byte read per box, so a
 * multi-gigabyte file costs a few kilobytes of reads. Returns null when the
 * file does not start with an ftyp box (not ISO-BMFF). Fast start means the
 * movie index (moov) precedes the first media data (mdat).
 */
export async function readMp4Layout(sizeBytes: number, read: ReadRange): Promise<Mp4Layout | null> {
  const boxes: string[] = [];
  let offset = 0;
  let complete = false;
  while (offset < sizeBytes && boxes.length < MAX_BOXES) {
    const header = await read(offset, Math.min(16, sizeBytes - offset));
    if (header.byteLength < 8) break;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (boxes.length === 0 && type !== "ftyp") return null;
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (size === 1) {
      if (header.byteLength < 16) break;
      size = Number(view.getBigUint64(8));
      if (size < 16) break;
    } else if (size === 0) {
      size = sizeBytes - offset;
    } else if (size < 8) {
      break;
    }
    boxes.push(type);
    offset += size;
    if (offset === sizeBytes) complete = true;
  }
  if (boxes.length === 0) return null;
  const moov = boxes.indexOf("moov");
  const mdat = boxes.indexOf("mdat");
  return {
    boxes: boxes.slice(0, 32),
    fastStart: boxes[0] === "ftyp" && moov !== -1 && mdat !== -1 && moov < mdat && boxes.filter((b) => b === "moov").length === 1,
    fragmented: boxes.includes("moof"),
    complete,
  };
}

// ---------------------------------------------------------------------------
// Class 2: stream-copy repackaging and its verification
// ---------------------------------------------------------------------------

/**
 * FFmpeg arguments for a Class 2 repackage: the one video and one audio stream,
 * copied, into a fast-start MP4. Built from fixed strings and the two paths,
 * passed as an argument array (never through a shell). Nothing from the file's
 * metadata can add an argument, and there is no codec, filter or bitrate option
 * an encoder could act on. The same arguments as the E3.1/E3.3 proof.
 */
export function remuxArguments(sourcePath: string, outputPath: string): string[] {
  return ["-hide_banner", "-nostdin", "-v", "error", "-n", "-i", sourcePath, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputPath];
}

/** FFmpeg arguments that list every packet of the selected video and audio stream, copied (no decoding). */
export function packetListArguments(path: string): string[] {
  return ["-hide_banner", "-nostdin", "-v", "error", "-i", path, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "framemd5", "-"];
}

export interface StreamDigest {
  packets: number;
  bytes: number;
  /** SHA-256 over the ordered (size, payload MD5) of every packet. */
  sha256: string;
}

export interface PacketDigest {
  video: StreamDigest;
  audio: StreamDigest;
}

/**
 * Folds FFmpeg framemd5 output into one digest per stream: each stream's
 * codec configuration (`#extradata`, e.g. the H.264 avcC with SPS/PPS) and
 * every packet's (size, payload MD5), in order. Timestamps are left out on
 * purpose: each container has its own time base, while a copied packet keeps
 * its exact size and payload. So is packet side data (`S=…` after the MD5,
 * e.g. MP3 skip samples), which a container may express differently while the
 * payload is untouched. Memory stays constant whatever the file length.
 */
export function createPacketDigest() {
  const state = [0, 1].map(() => ({ packets: 0, bytes: 0, hash: createHash("sha256") }));
  let malformed = 0;
  return {
    push(line: string) {
      if (line.length === 0) return;
      const extradata = /^#extradata (\d+),\s*(\d+),\s*([0-9a-f]{32})$/.exec(line);
      if (extradata) {
        const stream = Number(extradata[1]);
        if (stream === 0 || stream === 1) state[stream].hash.update(`extradata,${extradata[2]},${extradata[3]}\n`);
        return;
      }
      if (line.startsWith("#")) return;
      const fields = line.split(",").map((field) => field.trim());
      const stream = Number(fields[0]);
      const size = Number(fields[4]);
      const md5 = fields[5];
      const sideData = fields.length === 6 || fields[6]?.startsWith("S=");
      if (fields.length < 6 || !sideData || (stream !== 0 && stream !== 1) || !Number.isSafeInteger(size) || !/^[0-9a-f]{32}$/.test(md5 ?? "")) {
        malformed += 1;
        return;
      }
      const target = state[stream];
      target.packets += 1;
      target.bytes += size;
      target.hash.update(`${size},${md5}\n`);
    },
    result(): PacketDigest | null {
      if (malformed > 0) return null;
      const [video, audio] = state.map((s) => ({ packets: s.packets, bytes: s.bytes, sha256: s.hash.digest("hex") }));
      return { video, audio };
    },
  };
}

export interface RemuxVerification {
  passed: boolean;
  /** Empty when passed. */
  failures: string[];
  source: PacketDigest;
  output: PacketDigest;
}

const DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * Proves a Class 2 output carries the source's streams unchanged: the output
 * is canonical (fast-start MP4), both streams keep their codec parameters,
 * and every packet of both streams is present, in order, byte-identical
 * (equal digests). Any difference fails it; nothing is tolerated except a
 * container-level duration rounding of half a second.
 */
export function verifyRemux(source: MediaInspection, output: MediaInspection, sourcePackets: PacketDigest, outputPackets: PacketDigest): RemuxVerification {
  const failures: string[] = [];
  const outputClass = classifyMedia(output);
  if (outputClass.class !== "canonical") failures.push(`output_not_canonical:${outputClass.reasons.join("+")}`);
  const [sv] = playableVideo(source);
  const [ov] = playableVideo(output);
  const [sa] = audioStreams(source);
  const [oa] = audioStreams(output);
  if (!sv || !ov || !sa || !oa) {
    failures.push("streams_missing");
  } else {
    for (const field of ["codec", "profile", "level", "width", "height", "pixelFormat", "frameRate"] as const) {
      if (sv[field] !== ov[field]) failures.push(`video_${field}_changed`);
    }
    for (const field of ["codec", "profile", "sampleRate", "channels", "channelLayout"] as const) {
      if (sa[field] !== oa[field]) failures.push(`audio_${field}_changed`);
    }
  }
  if (source.durationSeconds === null || output.durationSeconds === null || Math.abs(source.durationSeconds - output.durationSeconds) > DURATION_TOLERANCE_SECONDS) failures.push("duration_changed");
  for (const stream of ["video", "audio"] as const) {
    const a = sourcePackets[stream];
    const b = outputPackets[stream];
    if (a.packets === 0) failures.push(`${stream}_no_packets`);
    if (a.packets !== b.packets) failures.push(`${stream}_packet_count_changed`);
    if (a.bytes !== b.bytes) failures.push(`${stream}_payload_bytes_changed`);
    if (a.sha256 !== b.sha256) failures.push(`${stream}_packets_changed`);
  }
  return { passed: failures.length === 0, failures, source: sourcePackets, output: outputPackets };
}
