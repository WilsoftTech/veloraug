import { describe, expect, it } from "vitest";
import { ADMIN_UPLOAD_MAX_BYTES, allowsUploadTransition, emptyUploadMetadata, uploadFileSchema, uploadMetadataSchema, uploadReviewBlockers } from "./admin-upload";

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
  it("keeps unsupported episodes and incomplete metadata blocked", () => {
    expect(uploadReviewBlockers(emptyUploadMetadata)).toEqual(["identity_unconfirmed", "vj_unresolved", "provenance_required"]);
    expect(uploadReviewBlockers({ ...emptyUploadMetadata, kind: "series" })).toContain("episode_publication_not_supported");
  });
});
