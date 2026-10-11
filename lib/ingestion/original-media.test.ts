import { describe, expect, it } from "vitest";
import { assessOriginalMedia, classifyOriginalMovie } from "@/lib/ingestion/original-media";
import { canonicalInspection, matroskaInspection, MP3_STEREO } from "@/lib/uploader/test-media";
import { mediaAllowsUpload, mediaVerdict } from "@/lib/uploader/journal";
import { sourceMedia } from "@/lib/uploader/test-media";

describe("original movie acceptance", () => {
  it("accepts MKV and slow-start MP4 without modifying streams or historical evidence", () => {
    for (const inspection of [matroskaInspection(), canonicalInspection(1000000, { layout: { boxes: ["ftyp", "mdat", "moov"], fastStart: false, fragmented: false, complete: true } })]) {
      const media = sourceMedia(inspection);
      const before = structuredClone(media);
      expect(classifyOriginalMovie(inspection)).toMatchObject({ class: "original", policyVersion: 3 });
      expect(mediaVerdict(media, "movie")?.class).toBe("original");
      expect(mediaAllowsUpload(media, "movie")).toBe(true);
      expect(mediaAllowsUpload(media, "series")).toBe(false);
      expect(media).toEqual(before);
    }
  });
  it("preserves all audio, subtitle and cover tracks and records compatibility separately", () => {
    const inspection = matroskaInspection();
    inspection.streams.push({ ...MP3_STEREO, index: 2, language: "lug", defaultTrack: false });
    const result = assessOriginalMedia(inspection);
    expect(result.accepted).toBe(true);
    expect(result.tracks).toEqual(inspection.streams);
    expect(result.warnings).toContain("audio_track_switching_not_available");
    expect(result.compatibility).toMatchObject({ firefox: "streaming_unreliable", safari: "real_device_not_tested", perFile: "prediction" });
    expect(result.download).toBe("not_implemented_authorization_required");
    expect(result.integrity).toBe("metadata_consistent");
  });
  it("keeps unknown metadata, malformed layouts and other containers on hold", () => {
    for (const inspection of [canonicalInspection(10, { durationSeconds: null }), canonicalInspection(10, { streams: [] }), canonicalInspection(10, { formatName: "avi", layout: null }), canonicalInspection(10, { layout: { boxes: [], complete: false, fastStart: false, fragmented: false } })]) {
      expect(classifyOriginalMovie(inspection).class).toBe("manual_review");
      expect(assessOriginalMedia(inspection).accepted).toBe(false);
    }
  });
});
