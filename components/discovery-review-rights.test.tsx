import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewDetail, ReviewQueue } from "./discovery-review";
import { toCandidate } from "@/lib/discovery/database";

/**
 * The reviewer screen under optional media verification and the rights review
 * (migration 20261018090000), rendered from the JSON private.channel_view returns.
 */
const film = { tmdb_id: 9800001, title: "Example Movie", original_title: "Example Movie", overview: "Synthetic.", release_date: "2024-05-01", runtime_minutes: 100, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] };
const vjs = [{ id: 3, slug: "vj-test", name: "VJ Test", isActive: true }];
const candidate = (extra: Record<string, unknown> = {}) => toCandidate({
  key: "a".repeat(64), revision: 3, status: "needs_review", error_code: null, attempts: 1, first_seen: "2026-10-18T09:00:00+00:00", last_seen: "2026-10-18T09:05:00+00:00",
  event: { event_id: "b".repeat(64), payload_digest: "c".repeat(64), chat_id: -1001111111111, message_id: 10, update_id: 100, kind: "channel_post", observed_at: 1760000000,
    file_unique_id: "AgADuniq10", size: 1048576, name: "Example.Movie.2024.VJ.Test.mp4", mime: "video/mp4", caption: null },
  identity: `tg1-${"d".repeat(64)}`, identity_state: "confirmed", title: "Example Movie", year: 2024, vj_text: "Test", warnings: [], tmdb_id: 9800001,
  vj: { id: 3, slug: "vj-test", name: "VJ Test", active: true }, relation: "new_movie", movie_id: null, duplicate_of: null, snapshot: film,
  evidence: null, rights: null, approval: null, publication: null, blockers: ["rights_clearance_required"],
  inspection: { retry_at: null, last: null }, media_inspection_mode: "optional", rights_status: "not_provided", rights_submissions: [], ...extra });
const pending = { id: 7, revision: 3, reference: "licence OPT-1", document_sha256: "e".repeat(64), submitted_by: "00000000-0000-4000-8000-0000000000a1",
  submitted_at: "2026-10-18T09:02:00+00:00", decision: "pending", decided_by: null, decided_at: null, current: true };
const screen = (item: ReturnType<typeof candidate>, capabilities: { review: boolean; rights: boolean; publish: boolean } | null) =>
  renderToStaticMarkup(<ReviewDetail candidate={item} vjs={vjs} action={async () => {}} mode="database" capabilities={capabilities} />);

describe("reviewer screen: optional media and the rights review", () => {
  it("an uninspected trusted movie is ready for authorization: the five facts stand separately and nothing reads as verified", () => {
    const html = screen(candidate(), { review: true, rights: false, publish: false });
    for (const text of ["Where this movie stands", "Awaiting publication authorization", "Telegram source", "Movies channel, message 10", "Film and VJ", "Confirmed",
      "Media verification", "Not inspected", "Optional on this server", "Distribution authorization", "Not provided", "Publication approval", "Not approved",
      "Media integrity (verification optional)", "verification is optional on this server", "Distribution rights", "Submit for rights review", 'value="submit_rights"', "Document SHA-256 (optional)", "Rights needed"])
      expect(html, text).toContain(text);
    // No approval or publication while the rights decision is missing; the database refuses it as well.
    for (const text of ['value="approve"', 'value="publish"', ">Verified<", 'value="decide_rights"']) expect(html, text).not.toContain(text);
  });
  it("a pending submission: a rights reviewer may verify or reject it, a review-only account may not", () => {
    const item = candidate({ rights_status: "pending_review", rights_submissions: [pending] });
    const rights = screen(item, { review: false, rights: true, publish: false });
    for (const text of ["Pending review", 'value="decide_rights"', 'name="submission" value="7"', 'value="verified"', 'value="rejected"', "Verify rights: licence OPT-1", "document eeeeeeeeeeee", "Rights awaiting review"])
      expect(rights, text).toContain(text);
    expect(rights).not.toContain('value="submit_rights"');
    const review = screen(item, { review: true, rights: false, publish: false });
    expect(review).toContain("needs the rights permission"); expect(review).not.toContain('value="decide_rights"');
  });
  it("a rejected submission stays in the history and a corrected one can be submitted", () => {
    const html = screen(candidate({ rights_status: "rejected", rights_submissions: [{ ...pending, document_sha256: null, decision: "rejected", decided_by: "00000000-0000-4000-8000-0000000000a2", decided_at: "2026-10-18T09:03:00+00:00" }] }),
      { review: true, rights: false, publish: false });
    for (const text of ["Rights rejected", "licence OPT-1 · no document · Rejected", 'value="submit_rights"']) expect(html, text).toContain(text);
  });
  it("a known media failure still blocks under optional mode and reads as failed", () => {
    const html = screen(candidate({ blockers: ["media_known_failure", "rights_clearance_required"],
      evidence: { identity: `tg1-${"d".repeat(64)}`, verified: false, method: "bounded_original_v2", scope: "bounded", policy_version: 3, media_class: "unverified", reasons: ["size_mismatch"],
        container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: false, bytes_read: 70000, checked_at: "2026-10-18T09:01:00+00:00",
        integrity_status: "incomplete", streaming_status: "unverified", download_status: "not_implemented_authorization_required", publishable_media: false, known_failure: true } }),
      { review: true, rights: true, publish: true });
    for (const text of ["Catalogue-ready", ">Failed<", "Media check failed"]) expect(html, text).toContain(text);
    expect(html).not.toContain('value="approve"');
  });
  it("a database without the migration shows neither the overview's rights review nor its commands", () => {
    const older = candidate(); delete older.rightsReview; delete older.mediaInspection;
    const html = screen(older, { review: true, rights: true, publish: false });
    for (const text of ['value="submit_rights"', 'value="decide_rights"', "Submit for rights review"]) expect(html, text).not.toContain(text);
    expect(html).toContain("Record rights clearance");
  });
  it("the queue names each candidate's stage and rights status", () => {
    const html = renderToStaticMarkup(<ReviewQueue candidates={[candidate({ rights_status: "pending_review" })]} search="" group="" mode="database" />);
    for (const text of ["Stage", "Awaiting publication authorization", "Pending review"]) expect(html, text).toContain(text);
  });
});
