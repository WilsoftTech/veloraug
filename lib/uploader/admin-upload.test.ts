import { describe, expect, it } from "vitest";
import { ADMIN_UPLOAD_MAX_BYTES, allowsUploadTransition, emptyUploadMetadata, uploadFileSchema, uploadMedia, uploadMetadataSchema, uploadReviewBlockers, uploadSessionSchema } from "./admin-upload";

describe("admin upload boundary", () => {
  it("accepts the decimal 2 GB boundary and rejects larger, empty and fractional sizes", () => {
    expect(uploadFileSchema.safeParse({ fileName: "Movie.MP4", sizeBytes: ADMIN_UPLOAD_MAX_BYTES }).success).toBe(true);
    for (const sizeBytes of [0, -1, 1.5, ADMIN_UPLOAD_MAX_BYTES + 1]) expect(uploadFileSchema.safeParse({ fileName: "movie.mp4", sizeBytes }).success).toBe(false);
  });
  it("rejects paths, control characters and unsupported files", () => {
    for (const fileName of ["../movie.mp4", "C:\\movie.mp4", "movie\n.mp4", "movie.exe", "movie.avi", "movie.mov", "movie.webm", "..", ""]) expect(uploadFileSchema.safeParse({ fileName, sizeBytes: 100 }).success).toBe(false);
    expect(uploadFileSchema.parse({ fileName: " Film VJ Junior.MKV", sizeBytes: 100 }).fileName).toBe(" Film VJ Junior.MKV");
  });
  it("does not accept privileged metadata, including nested forged clearance", () => {
    for (const field of ["rights", "approved", "owner_id", "stage", "verified_sha256", "app_metadata"]) expect(uploadMetadataSchema.safeParse({ ...emptyUploadMetadata, [field]: true }).success).toBe(false);
    expect(uploadMetadataSchema.parse(emptyUploadMetadata)).toEqual(emptyUploadMetadata);
  });
  it("separates transport success from verification, rights and publication", () => {
    expect(allowsUploadTransition("uploading", "verifying", "owner")).toBe(true);
    expect(allowsUploadTransition("uploading", "uploaded", "owner")).toBe(false);
    expect(allowsUploadTransition("verifying", "uploaded", "worker")).toBe(true);
    expect(allowsUploadTransition("uploaded", "approved", "worker")).toBe(false);
    expect(allowsUploadTransition("awaiting_approval", "approved", "owner")).toBe(false);
    expect(allowsUploadTransition("publishing", "published", "publisher")).toBe(true);
  });
  it("does not permit blind retry or cancellation of ambiguous Telegram transfers", () => {
    expect(allowsUploadTransition("telegram_uncertain", "telegram_uploading", "worker")).toBe(false);
    expect(allowsUploadTransition("telegram_uncertain", "cancelled", "owner")).toBe(false);
    expect(allowsUploadTransition("telegram_uncertain", "telegram_stored", "worker")).toBe(true);
    expect(allowsUploadTransition("published", "uploading", "owner")).toBe(false);
  });
  // Checkpoint 9: what the admin media panel reads from a session (migration 20261011192619 adds the assessment).
  it("reads the Policy 3 assessment when the database returns it, and reports nothing it was not given", () => {
    const session = (inspection: unknown) => uploadSessionSchema.parse({ id: "00000000-0000-4000-8000-0000000000b1", source: "admin_upload", owner_id: "00000000-0000-4000-8000-0000000000a1", storage: "r2",
      file_name: "Film.VJ.Test.mkv", size_bytes: 1000, stage: "metadata_review", revision: 2, metadata: emptyUploadMetadata, verified_sha256: "a".repeat(64), bytes_received: 1000, error_code: null, retryable: false,
      created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", expires_at: "2026-10-18T00:00:00Z", inspection });
    const classification = { class: "original", reasons: [], policyVersion: 3 };
    const assessment = { accepted: true, container: "mkv", reasons: [], warnings: ["firefox_mkv_streaming_unreliable"], integrity: "metadata_consistent", streaming: "potentially_playable", download: "not_implemented_authorization_required",
      compatibility: { basis: "tested_fixture_combinations", chromium: "tested_combination", firefox: "streaming_unreliable", safari: "real_device_not_tested", unknown_browser: "x" },
      tracks: [{ index: 0, type: "video", codec: "mjpeg", attachedPicture: true }, { index: 1, type: "video", codec: "H264", attachedPicture: false, title: "private" }, { index: 2, type: "audio", codec: "aac" }, { index: 3, type: "audio", codec: "mp3" }, { index: 4, type: "subtitle", codec: "subrip" }] };
    expect(uploadMedia(session({ choices: [], proposed_tmdb_id: null, classification, assessment }))).toEqual({ fileName: "Film.VJ.Test.mkv", inspected: true, policyVersion: 3, checkedAt: null, container: "mkv", video: "h264", audio: "aac", reasons: [], passed: null,
      policy3: { integrity: "metadata_consistent", streaming: "potentially_playable", browsers: { chromium: "tested_combination", firefox: "streaming_unreliable", safari: "real_device_not_tested" }, audioTracks: 2, subtitleTracks: 1, warnings: ["firefox_mkv_streaming_unreliable"] } });
    // A database without the migration returns no assessment; one of another shape is dropped. Neither is guessed from the file name.
    for (const inspection of [{ choices: [], proposed_tmdb_id: null, classification }, { choices: [], proposed_tmdb_id: null, classification, assessment: { integrity: "verified", streaming: "verified", tracks: "all" } }, { choices: [], proposed_tmdb_id: null, classification, assessment: null }])
      expect(uploadMedia(session(inspection))).toEqual({ fileName: "Film.VJ.Test.mkv", inspected: true, policyVersion: 3, checkedAt: null, container: null, video: null, audio: null, reasons: [], passed: null, policy3: undefined });
    // The earlier policies' single verdict, and no inspection at all.
    expect(uploadMedia(session({ choices: [], proposed_tmdb_id: null, classification: { class: "canonical", reasons: [], policyVersion: 2 } }))).toMatchObject({ policyVersion: 2, passed: true, policy3: undefined });
    expect(uploadMedia(session({ choices: [], proposed_tmdb_id: null, classification: { class: "remux", reasons: ["mp4_not_fast_start"], policyVersion: 2 } }))).toMatchObject({ passed: false, reasons: ["mp4_not_fast_start"] });
    expect(uploadMedia(session(null))).toMatchObject({ inspected: false, policyVersion: null, passed: null, policy3: undefined });
  });
  it("keeps unsupported episodes and incomplete metadata blocked", () => {
    expect(uploadReviewBlockers(emptyUploadMetadata)).toEqual(["identity_unconfirmed", "vj_unresolved", "provenance_required"]);
    expect(uploadReviewBlockers({ ...emptyUploadMetadata, kind: "series" })).toContain("episode_publication_not_supported");
  });
});
