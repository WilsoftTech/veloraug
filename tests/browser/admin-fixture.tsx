import { createRoot } from "react-dom/client";
import { ReviewDetail } from "@/components/discovery-review";
import { AdminUploadForm } from "@/components/admin-upload-form";
import { AdminUploadTransfer } from "@/components/admin-upload-transfer";
import "@/app/globals.css";
import type { ReviewCandidate } from "@/lib/discovery/model";

// Test-only host for the reviewer screen (Checkpoint 9): synthetic candidates, no database and no session.
// Vite substitutes next/link and next/image; the review components and their status mapping are the real ones.
type Evidence = NonNullable<ReviewCandidate["evidence"]>;
const at = "2026-10-12T08:00:00.000Z";
const browsers = (chromium: string, firefox: string) => ({ chromium, firefox, safari: "real_device_not_tested", ios: "real_device_not_tested", android: "real_device_not_tested" });
const original = (containerName: "mp4" | "mkv", facts: Partial<NonNullable<Evidence["facts"]>> = {}, extra: Partial<Evidence> = {}): Evidence => ({
  mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: true, checkedAt: at, reference: "bounded_original_v2: 70000 bytes read (bounded check, not full-file integrity)",
  mediaClass: "original", reasons: [], video: "h264", audio: "aac", bytesRead: 70000, policyVersion: 3, containerName, passed: false,
  facts: { integrity: "metadata_consistent", streaming: "potentially_playable", browsers: browsers("tested_combination", containerName === "mkv" ? "streaming_unreliable" : "tested_combination"),
    audioTracks: 1, subtitleTracks: 0, warnings: containerName === "mkv" ? ["firefox_mkv_streaming_unreliable"] : [], publishable: false, ...facts }, ...extra });
const VERIFIED = { integrity: "verified", streaming: "verified", publishable: true };
const film = { tmdb_id: 900001, title: "Example Movie", original_title: "Example Movie", overview: "A synthetic film used to lay out the reviewer screen.", release_date: "2024-05-01", runtime_minutes: 100, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] };
const base: ReviewCandidate = {
  id: "a".repeat(64), revision: 3, firstSeen: at, lastSeen: at, status: "awaiting_media", attempts: 1, lease: null, retryAt: 0, error: null,
  event: { id: "b".repeat(64), messageKey: "a".repeat(64), updateId: 1, channelId: -1001111111111, messageId: 46, kind: "channel_post", timestamp: 1760000000, digest: "c".repeat(64),
    media: { uniqueId: "AgADsynthetic46", size: 1_917_405_700, name: "Example.Movie.2024.VJ.Test.With.A.Rather.Long.Release.Name.For.Wrapping.1080p.mkv", mime: "video/x-matroska", caption: "Example Movie (2024)\nVJ Test" } },
  title: "Example Movie", year: 2024, vjText: "Test", vjId: 1, tmdbId: 900001, movieId: null, identity: "confirmed", relation: "new_movie", choices: [film], snapshot: film, warnings: [],
  evidence: null, rights: null, approval: null, uploaderSource: null, duplicateOf: null, publication: null,
  audit: [{ at, actor: "discovery", action: "media_inspected (original:original)", revision: 3 }], gates: ["media_verification_required", "rights_clearance_required"],
  lastInspection: { at, action: "media_inspected", detail: "original:original", revision: 3 },
};
const SCENARIOS: Record<string, ReviewCandidate> = {
  // What a Policy 3 inspection records today: accepted, not verified.
  pending: { ...base, evidence: original("mkv", { audioTracks: 2, subtitleTracks: 3, warnings: ["firefox_mkv_streaming_unreliable", "audio_track_switching_not_available", "embedded_subtitles_not_displayed"] }) },
  verified: { ...base, status: "approved", gates: [], approval: { actor: "reviewer", at, revision: 3 }, rights: { actor: "rights", at, reference: "licence 2026-014", revision: 3 }, evidence: original("mp4", VERIFIED) },
  failed: { ...base, evidence: original("mp4", { integrity: "incomplete", streaming: "unverified", browsers: null, audioTracks: null, subtitleTracks: null }, { mediaClass: "unverified", reasons: ["size_mismatch", "video_metadata_incomplete"] }) },
  // A database without the Policy 3 update (the hosted schema today).
  earlier: { ...base, status: "awaiting_rights", gates: ["rights_clearance_required"],
    evidence: { mediaKey: "d".repeat(64), container: true, gateway: true, browser: true, accessible: true, checkedAt: at, reference: "bounded_mtproto_v1: 3072 bytes read (bounded check, not full-file integrity)",
      mediaClass: "canonical", reasons: [], video: "h264", audio: "aac", bytesRead: 3072, policyVersion: 2, containerName: "mp4", passed: true } },
  none: { ...base, evidence: null, lastInspection: { at, action: "media_inspected", detail: "no_evidence", revision: 3 } },
  // Legacy media check fix: a policy 2 refusal on a database that applies Policy 3 (In Cold Light's record) ...
  historical: { ...base, evidence: { mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: true, checkedAt: at, reference: "bounded_mtproto_v1: 64 bytes read (bounded check, not full-file integrity)",
    mediaClass: "unverified", reasons: ["mp4_not_fast_start"], bytesRead: 64, policyVersion: 2, containerName: "mp4", passed: false,
    facts: { integrity: "legacy_unassessed", streaming: "legacy_unassessed", browsers: null, audioTracks: null, subtitleTracks: null, warnings: [], publishable: false } } },
  // ... and a whole-file decode that ended on an error after the whole film (the finding All the Devil's Men's record is consistent with).
  inconclusive: { ...base, evidence: original("mkv", { integrity: "incomplete", streaming: "unverified" }, { mediaClass: "unverified", reasons: ["decode_error_at_end"], audio: "mp3",
    inspection: { scope: "whole_file", download: "original_servable", sha256: "e".repeat(64) } }) },
  // Optional media verification (migration 20261018090000): an uninspected trusted document, no rights document yet ...
  optional: { ...base, status: "awaiting_rights", gates: ["rights_clearance_required"], mediaInspection: "optional", evidence: null, lastInspection: null,
    rightsReview: { status: "not_provided", submissions: [] } },
  // ... and with a reference awaiting a rights reviewer, after an earlier one was rejected.
  rights_pending: { ...base, status: "awaiting_rights", gates: ["rights_clearance_required"], mediaInspection: "optional", evidence: null, lastInspection: null,
    rightsReview: { status: "pending_review", submissions: [
      { id: 8, revision: 3, reference: "licence 2026-021-B", documentSha256: "f".repeat(64), submittedBy: "reviewer", submittedAt: at, decision: "pending", decidedBy: null, decidedAt: null, current: true },
      { id: 7, revision: 3, reference: "licence 2026-021", documentSha256: null, submittedBy: "reviewer", submittedAt: at, decision: "rejected", decidedBy: "rights", decidedAt: at, current: true }] } },
};

const params = new URLSearchParams(location.search);
const candidate = SCENARIOS[params.get("scenario") ?? "pending"];
createRoot(document.getElementById("root")!).render(
  <main className="page-container py-6 sm:py-8">
    {params.get("screen") === "upload" ? <AdminUploadForm maxBytes={2_000_000_000} extensions={["mp4", "mkv"]} action={async (_previous, data) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { error: `Synthetic draft received: ${data.get("fileName")} (${data.get("sizeBytes")} bytes).` };
    }} /> : params.get("screen") === "transfer" ? <AdminUploadTransfer id="synthetic-upload" fileName={params.get("name") ?? "Example.Movie.mp4"} sizeBytes={4} storage={params.has("r2") ? "r2" : "disk"} /> :
      <ReviewDetail candidate={candidate} vjs={[{ id: 1, slug: "vj-test", name: "VJ Test", isActive: true }]} action={async () => {}} mode="database"
        capabilities={{ review: true, rights: true, publish: params.has("publisher") }} downloads={params.has("downloads")} />}
  </main>,
);
