import { describe, expect, it } from "vitest";
import { createReviewClient, toCandidate, type DiscoveryRpc } from "./database";
import { catalogueStage, guidance, steps } from "./guidance";
import { indicators, publicationRequirements } from "./media-report";

/**
 * Optional media verification and the rights review (migration 20261018090000).
 * Each case starts from the JSON private.channel_view returns. The database
 * decides every gate; these prove the page reads them without inventing any.
 */
const channel = -1001111111111;
const film = { tmdb_id: 9800001, title: "Example Movie", original_title: "Example Movie", overview: "Synthetic.", release_date: "2024-05-01", runtime_minutes: 100, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] };
const profile = { basis: "tested_fixture_combinations", perFile: "prediction", evidence: "docs/MP4_MKV_NATIVE_PLAYBACK.md", chromium: "tested_combination", firefox: "tested_combination", safari: "real_device_not_tested", ios: "real_device_not_tested", android: "real_device_not_tested" };
const policy3 = (extra: Record<string, unknown> = {}) => ({ identity: `tg1-${"d".repeat(64)}`, verified: false, method: "bounded_original_v2", scope: "bounded", policy_version: 3, media_class: "original", reasons: [] as string[],
  container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: false, bytes_read: 70000, checked_at: "2026-10-18T09:01:00+00:00",
  integrity_status: "metadata_consistent", streaming_status: "potentially_playable", download_status: "not_implemented_authorization_required", browser_profile: profile,
  tracks: [{ type: "video" }, { type: "audio" }], warnings: [] as string[], publishable_media: false, known_failure: false, ...extra });
const view = (extra: Record<string, unknown> = {}) => ({
  key: "a".repeat(64), revision: 3, status: "needs_review", error_code: null, attempts: 1, first_seen: "2026-10-18T09:00:00+00:00", last_seen: "2026-10-18T09:05:00+00:00",
  event: { event_id: "b".repeat(64), payload_digest: "c".repeat(64), chat_id: channel, message_id: 10, update_id: 100, kind: "channel_post", observed_at: 1760000000,
    file_unique_id: "AgADuniq10", size: 1048576, name: "Example.Movie.2024.VJ.Test.mp4", mime: "video/mp4", caption: null },
  identity: `tg1-${"d".repeat(64)}`, identity_state: "confirmed", title: "Example Movie", year: 2024, vj_text: "Test", warnings: [], tmdb_id: 9800001,
  vj: { id: 3, slug: "vj-test", name: "VJ Test", active: true }, relation: "new_movie", movie_id: null, duplicate_of: null, snapshot: film,
  evidence: null, rights: null, approval: null, publication: null, blockers: ["rights_clearance_required"],
  inspection: { retry_at: null, last: null }, media_inspection_mode: "optional", rights_status: "not_provided", rights_submissions: [], ...extra });
const candidate = (extra: Record<string, unknown> = {}) => toCandidate(view(extra));
const requirement = (item: ReturnType<typeof candidate>, label: string) => publicationRequirements(item).requirements.find((entry) => entry.label.startsWith(label))!;
const indicator = (item: ReturnType<typeof candidate>, label: string) => indicators(item).find((entry) => entry.label === label)!;
const submission = (extra: Record<string, unknown> = {}) => ({ id: 7, revision: 3, reference: "licence OPT-1", document_sha256: null, submitted_by: "00000000-0000-4000-8000-0000000000a1",
  submitted_at: "2026-10-18T09:02:00+00:00", decision: "pending", decided_by: null, decided_at: null, current: true, ...extra });

describe("the database view", () => {
  it("carries the owner's mode and the rights review into the review model", () => {
    const item = candidate({ rights_status: "pending_review", rights_submissions: [submission({ document_sha256: "e".repeat(64) })] });
    expect(item.mediaInspection).toBe("optional");
    expect(item.rightsReview).toEqual({ status: "pending_review", submissions: [{ id: 7, revision: 3, reference: "licence OPT-1", documentSha256: "e".repeat(64),
      submittedBy: "00000000-0000-4000-8000-0000000000a1", submittedAt: "2026-10-18T09:02:00.000Z", decision: "pending", decidedBy: null, decidedAt: null, current: true }] });
  });
  it("a database without the migration reports neither, so the page keeps its earlier rights field", () => {
    const older = view(); delete (older as Record<string, unknown>).media_inspection_mode; delete (older as Record<string, unknown>).rights_status; delete (older as Record<string, unknown>).rights_submissions;
    const item = toCandidate(older);
    expect(item.mediaInspection).toBeUndefined(); expect(item.rightsReview).toBeUndefined();
  });
  it("an unknown mode or rights status is dropped, never trusted", () => {
    const item = candidate({ media_inspection_mode: "off", rights_status: "auto_cleared" });
    expect(item.mediaInspection).toBeUndefined(); expect(item.rightsReview).toBeUndefined();
  });
  it("a known media failure is a media step, and rights alone leave it awaiting rights", () => {
    expect(candidate({ blockers: ["media_known_failure", "rights_clearance_required"] }).status).toBe("awaiting_media");
    expect(candidate().status).toBe("awaiting_rights");
    expect(steps(["media_known_failure"]).map((step) => step.done)).toEqual([true, true, false, true]);
  });
});

describe("catalogue stages", () => {
  it("separate catalogue preparation from publication authorization", () => {
    expect(catalogueStage(candidate({ status: "received" }))).toBe("discovered");
    expect(catalogueStage(candidate({ snapshot: null, identity_state: "unknown", blockers: ["identity_unconfirmed", "rights_clearance_required"] }))).toBe("discovered");
    expect(catalogueStage(candidate({ identity_state: "proposed", blockers: ["identity_unconfirmed", "rights_clearance_required"] }))).toBe("identified");
    expect(catalogueStage(candidate({ media_inspection_mode: "required", blockers: ["media_verification_required", "rights_clearance_required"] }))).toBe("catalogue_ready");
    expect(catalogueStage(candidate({ blockers: ["media_known_failure", "rights_clearance_required"] }))).toBe("catalogue_ready");
    // Optional mode: an uninspected file with confirmed film and VJ waits only for authorization.
    expect(catalogueStage(candidate())).toBe("awaiting_authorization");
    expect(catalogueStage(candidate({ blockers: [] }))).toBe("awaiting_authorization");
    expect(catalogueStage(candidate({ status: "matched", blockers: [] }))).toBe("awaiting_authorization");
    expect(catalogueStage(candidate({ status: "published", blockers: ["candidate_closed"] }))).toBe("published");
    expect(catalogueStage(candidate({ status: "rejected", blockers: ["candidate_closed", "rights_clearance_required"] }))).toBe("rejected_or_blocked");
    expect(catalogueStage(candidate({ blockers: ["existing_version_replacement_requires_separate_workflow", "rights_clearance_required"] }))).toBe("rejected_or_blocked");
  });
});

describe("media verification: optional for publication, never shown as verified", () => {
  it("optional mode: an uninspected file does not block, and still reads as not inspected", () => {
    const item = candidate();
    expect(requirement(item, "Media integrity")).toMatchObject({ label: "Media integrity (verification optional)", done: true, detail: "not inspected · verification is optional on this server" });
    expect(indicator(item, "Media verification")).toMatchObject({ value: "Not inspected", tone: "missing" });
    expect(indicators(item).some((entry) => entry.label === "Media verification" && entry.value === "Verified")).toBe(false);
  });
  it("optional mode: a known failure blocks and reads as failed", () => {
    const item = candidate({ blockers: ["media_known_failure", "rights_clearance_required"], status: "needs_review",
      evidence: policy3({ media_class: "unverified", reasons: ["size_mismatch"], integrity_status: "incomplete", streaming_status: "unverified", known_failure: true }) });
    expect(requirement(item, "Media integrity")).toMatchObject({ done: false, detail: "failed" });
    expect(indicator(item, "Media verification")).toMatchObject({ value: "Failed", tone: "failed" });
    expect(guidance(item).label).toBe("Media check failed");
  });
  it("optional mode: an inconclusive whole-file decode stays not verified", () => {
    const item = candidate({ evidence: policy3({ scope: "whole_file", method: "full_original_v1", media_class: "unverified", reasons: ["decode_failed"], integrity_status: "incomplete", streaming_status: "unverified" }) });
    expect(indicator(item, "Media verification")).toMatchObject({ value: "Verification inconclusive", tone: "pending" });
    expect(requirement(item, "Media integrity")).toMatchObject({ done: true });
  });
  it("required mode is unchanged: verified media is a requirement", () => {
    const item = candidate({ media_inspection_mode: "required", blockers: ["media_verification_required", "rights_clearance_required"] });
    expect(requirement(item, "Media integrity")).toMatchObject({ label: "Media integrity verified", done: false, detail: "not inspected" });
    expect(indicator(item, "Media verification").detail).toContain("Required");
  });
});

describe("distribution authorization", () => {
  it("each rights status is named, and only a clearance satisfies the requirement", () => {
    for (const [status, value] of [["not_provided", "Not provided"], ["pending_review", "Pending review"], ["rejected", "Rejected"]] as const) {
      const item = candidate({ rights_status: status });
      expect(indicator(item, "Distribution authorization").value).toBe(value);
      expect(requirement(item, "Rights clearance approved")).toMatchObject({ done: false, detail: "rights clearance required" });
    }
    const cleared = candidate({ rights_status: "verified", blockers: [], rights: { reference: "licence OPT-1", cleared_by: "00000000-0000-4000-8000-0000000000a2", cleared_at: "2026-10-18T09:03:00+00:00", revision: 3 } });
    expect(indicator(cleared, "Distribution authorization")).toMatchObject({ value: "Verified", tone: "verified" });
    expect(requirement(cleared, "Rights clearance approved")).toMatchObject({ done: true });
  });
  it("the next step follows the rights status", () => {
    expect(guidance(candidate()).label).toBe("Rights needed");
    expect(guidance(candidate({ rights_status: "pending_review" })).label).toBe("Rights awaiting review");
    expect(guidance(candidate({ rights_status: "rejected" })).label).toBe("Rights rejected");
  });
  it("the Telegram source is trusted provenance, not integrity or rights", () => {
    expect(indicator(candidate(), "Telegram source")).toMatchObject({ value: "Movies channel, message 10", tone: "verified" });
    expect(indicator(candidate(), "Telegram source").detail).toContain("does not prove");
    expect(indicator(candidate({ blockers: ["channel_not_registered", "rights_clearance_required"] }), "Telegram source")).toMatchObject({ value: "Unregistered channel", tone: "failed" });
  });
});

describe("rights commands", () => {
  it("call the reviewer's own session commands with exactly the reviewer's input", async () => {
    const seen: { fn: string; args: Record<string, unknown> }[] = [];
    const rpc: DiscoveryRpc = async (fn, args) => { seen.push({ fn, args }); return { data: view(), error: null }; };
    const client = createReviewClient(rpc);
    await client.submitRights("a".repeat(64), 3, "licence OPT-1", null);
    await client.decideRights("a".repeat(64), 3, 7, "rejected");
    expect(seen).toEqual([
      { fn: "discovery_review_submit_rights", args: { p_key: "a".repeat(64), p_revision: 3, p_reference: "licence OPT-1", p_document_sha256: null } },
      { fn: "discovery_review_decide_rights", args: { p_key: "a".repeat(64), p_revision: 3, p_submission: 7, p_decision: "rejected" } },
    ]);
  });
});
