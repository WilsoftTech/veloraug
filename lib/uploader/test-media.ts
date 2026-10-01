import { classifyMedia, type MediaInspection, type MediaStream } from "@/lib/ingestion/media";
import type { JournalMedia } from "@/lib/uploader/journal";

/**
 * Test fixtures for media inspections (E3.5): the shapes the policy sees, so
 * tests do not need FFmpeg. Imported by tests only.
 */

const stream = (overrides: Partial<MediaStream>): MediaStream => ({
  index: 0, type: "video", codec: null, codecTag: null, profile: null, level: null, width: null, height: null, pixelFormat: null, fieldOrder: null,
  frameRate: null, timeBase: null, startSeconds: 0, durationSeconds: null, sampleRate: null, channels: null, channelLayout: null, bitRate: null, attachedPicture: false,
  ...overrides,
});

export const H264_HIGH_1080P = stream({ index: 0, type: "video", codec: "h264", codecTag: "avc1", profile: "High", level: 40, width: 1920, height: 1080, pixelFormat: "yuv420p", fieldOrder: "progressive", frameRate: "24/1", timeBase: "1/12288" });
export const MP3_STEREO = stream({ index: 1, type: "audio", codec: "mp3", codecTag: "mp4a", sampleRate: 44100, channels: 2, channelLayout: "stereo", bitRate: 128000, timeBase: "1/44100" });

/** A fast-start ISO MP4 with one H.264 and one MP3 stream: the E3.3 playback shape. */
export function canonicalInspection(sizeBytes = 1_000_000, overrides: Partial<MediaInspection> = {}): MediaInspection {
  return {
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    majorBrand: "isom",
    durationSeconds: 5208.29,
    sizeBytes,
    probeSizeBytes: sizeBytes,
    streams: [H264_HIGH_1080P, MP3_STEREO],
    layout: { boxes: ["ftyp", "moov", "free", "mdat"], fastStart: true, fragmented: false, complete: true },
    ...overrides,
  };
}

/** The same streams in Matroska: Class 2. */
export function matroskaInspection(sizeBytes = 1_000_000): MediaInspection {
  return { ...canonicalInspection(sizeBytes), formatName: "matroska,webm", majorBrand: null, layout: null, streams: [{ ...H264_HIGH_1080P, codecTag: null, timeBase: "1/1000" }, { ...MP3_STEREO, codecTag: null, timeBase: "1/1000" }] };
}

export function sourceMedia(inspection: MediaInspection = canonicalInspection()): JournalMedia {
  return {
    role: "source",
    inspectedAt: "2026-10-01T00:00:00.000Z",
    tools: { ffprobe: "9.0.2-test", ffmpeg: "9.0.2-test" },
    inspection,
    classification: classifyMedia(inspection),
    rendition: null,
    derivedFrom: null,
    normalizationFailure: null,
  };
}
