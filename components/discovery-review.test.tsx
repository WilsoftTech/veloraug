import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewQueue, ReviewDetail } from "./discovery-review";
import { initialInbox, receive } from "@/lib/discovery/events";
import { fixtureSchema } from "@/lib/discovery/fixtures";
import type { ReviewCandidate } from "@/lib/discovery/model";

const fixture = fixtureSchema.parse(JSON.parse(readFileSync("scripts/discovery/example.json", "utf8")));
const inbox = initialInbox(fixture.channelId); receive(inbox, fixture.updates, "2026-10-09T12:00:00.000Z");
const candidate = Object.values(inbox.candidates)[0];
function mediaPreviews(view: typeof candidate) {
  const reviewer = { review: true, rights: true, publish: false };
  const at = "2026-10-11T12:00:00.000Z";
  const waiting = { ...view, status: "awaiting_media" as const, identity: "confirmed" as const, tmdbId: fixture.movies[0].tmdb_id, vjId: fixture.vjs[0].id, revision: 3, attempts: 1,
    gates: ["media_verification_required", "rights_clearance_required"], lastInspection: { at, action: "media_inspected", detail: "no_evidence", revision: 3 } };
  const refused = { ...waiting, id: "d".repeat(64), lastInspection: { at, action: "media_inspected", detail: "unverified:unverified", revision: 3 },
    evidence: { mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: false, checkedAt: at, reference: "bounded_mtproto_v1: 16 bytes read (bounded check, not full-file integrity)", mediaClass: "unverified", reasons: ["container_not_mp4"] } };
  const retrying = { ...waiting, id: "e".repeat(64), status: "failed" as const, attempts: 2, retryAt: Date.parse("2026-10-11T12:01:00Z"), gates: ["inspection_pending", ...waiting.gates],
    lastInspection: { at, action: "inspection_failed", detail: "media_read_flood_wait", revision: 3 } };
  const detail = (item: ReviewCandidate) => renderToStaticMarkup(<ReviewDetail candidate={item} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewer} />);
  return { "queue-media": renderToStaticMarkup(<ReviewQueue candidates={[waiting, refused, retrying]} search="" group="" mode="database" />),
    "detail-media-needed": detail(waiting), "detail-media-failed": detail(refused), "detail-media-retrying": detail(retrying) };
}
// Checkpoint 9: the Policy 3 media model on the reviewer screen. Evidence is written as the review model carries it
// (lib/discovery/database.ts builds it from the database view; lib/discovery/media-report.test.ts covers that path).
const at = "2026-10-12T08:00:00.000Z";
const browsers = (chromium: string, firefox: string) => ({ chromium, firefox, safari: "real_device_not_tested", ios: "real_device_not_tested", android: "real_device_not_tested" });
const original = (containerName: "mp4" | "mkv", facts: Partial<NonNullable<NonNullable<ReviewCandidate["evidence"]>["facts"]>> = {}, extra: Partial<NonNullable<ReviewCandidate["evidence"]>> = {}) => ({
  mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: true, checkedAt: at, reference: "bounded_original_v2: 70000 bytes read (bounded check, not full-file integrity)",
  mediaClass: "original", reasons: [] as string[], video: "h264", audio: "aac", bytesRead: 70000, policyVersion: 3, containerName, passed: false,
  facts: { integrity: "metadata_consistent", streaming: "potentially_playable", browsers: browsers("tested_combination", containerName === "mkv" ? "streaming_unreliable" : "tested_combination"),
    audioTracks: 1, subtitleTracks: 0, warnings: containerName === "mkv" ? ["firefox_mkv_streaming_unreliable"] : [], publishable: false, ...facts }, ...extra });
const VERIFIED = { integrity: "verified", streaming: "verified", publishable: true };
const confirmed = { ...candidate, title: "Example Movie", identity: "confirmed" as const, tmdbId: fixture.movies[0].tmdb_id, vjId: fixture.vjs[0].id, revision: 3, attempts: 1,
  lastInspection: { at, action: "media_inspected", detail: "original:original", revision: 3 } };
const everything = { review: true, rights: true, publish: true };
const screen = (item: ReviewCandidate, capabilities: { review: boolean; rights: boolean; publish: boolean } | null = everything, downloads = false) =>
  renderToStaticMarkup(<ReviewDetail candidate={item} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={capabilities} downloads={downloads} />);
// The page up to the overview (migration 20261018090000), which repeats the media status and names the rights status.
const mediaPart = (html: string) => html.split("Where this movie stands")[0];
const REQUIREMENTS = ["Media integrity verified", "Streaming readiness verified", "Film identity confirmed", "VJ identity confirmed", "Rights clearance approved", "Final publication approval granted"];

describe("admin media verification dashboard", () => {
  it("MP4 verified profile: every media fact is named, and the six requirements stand separately", () => {
    const html = screen({ ...confirmed, status: "awaiting_review", gates: [], rights: { actor: "r", at, reference: "licence 1", revision: 3 }, evidence: original("mp4", VERIFIED) });
    for (const text of ["Media inspection", "Media integrity", "Streaming readiness", "Browser compatibility", "Download availability", "Original container", "MP4", "Original filename", "Example.Movie.2024.VJ.Test.mp4",
      "Video codec", "h264", "Audio codec", "aac", "Audio tracks", "Subtitle tracks", "Inspection policy", "Version 3", "2026-10-12 08:00 UTC", "Tested combination on desktop", "Browser by browser", "Not tested on a real device", ...REQUIREMENTS,
      "Every mandatory gate passes", "Browser compatibility is not a gate", 'value="approve"']) expect(html, text).toContain(text);
    expect(mediaPart(html).match(/>Verified</g)).toHaveLength(2); // integrity and streaming, and nothing else
    for (const text of ["Why the inspection did not pass", 'value="publish"', "Readiness", "Container / gateway / browser"]) expect(html).not.toContain(text);
  });

  it("MKV verified profile: the Firefox limitation is a warning, and approval is still offered", () => {
    const html = screen({ ...confirmed, status: "awaiting_review", gates: [], evidence: original("mkv", VERIFIED) });
    for (const text of ["MKV", "Limited in some browsers", "Playback warnings", "Firefox does not stream MKV reliably.", "They do not block publication", "Streaming unreliable", 'value="approve"']) expect(html, text).toContain(text);
    expect(mediaPart(html).match(/>Verified</g)).toHaveLength(2);
  });

  it("what a Policy 3 inspection records today is shown as pending, never as verified, and nothing can be approved", () => {
    const item = { ...confirmed, status: "awaiting_media" as const, gates: ["media_verification_required", "rights_clearance_required"], evidence: original("mkv") };
    const html = screen(item);
    for (const text of ["Verification pending", "Metadata consistent, not verified", "Potentially playable, not verified", "metadata consistent, not verified", "It is not proof that the whole file is intact", "Policy 3"]) expect(html, text).toContain(text);
    for (const text of [">Verified<", 'value="approve"', 'value="publish"', "Every mandatory gate passes", "Run media check", "Media check failed", "did not pass the media policy"]) expect(html, text).not.toContain(text);
    // Reinspection stays available as a secondary action, once.
    expect(html.match(/value="retry"/g)).toHaveLength(1);
    const queue = renderToStaticMarkup(<ReviewQueue candidates={[item]} search="" group="" mode="database" />);
    for (const text of ["Verification pending", "In progress (1)", "Needs you (0)"]) expect(queue).toContain(text);
    expect(queue).not.toContain("Last failure");
  });

  it("unknown inspection profile: no evidence reads as not inspected", () => {
    const html = screen({ ...confirmed, status: "awaiting_media", gates: ["media_verification_required", "rights_clearance_required"], evidence: null, lastInspection: { at, action: "media_inspected", detail: "no_evidence", revision: 3 } });
    for (const text of ["No inspection evidence is recorded for this file.", "Not inspected", "No verification evidence", "not inspected", "Run media check"]) expect(html, text).toContain(text);
    expect(html.match(/Not inspected/g)!.length).toBeGreaterThanOrEqual(3);
    for (const text of [">Verified<", ">Failed<", 'value="approve"']) expect(html).not.toContain(text);
  });

  it("failed media integrity and failed streaming readiness are failures with their reasons, distinct from a missing check", () => {
    const refused = screen({ ...confirmed, status: "awaiting_media", gates: ["media_verification_required"],
      evidence: original("mp4", { integrity: "incomplete", streaming: "unverified", browsers: null, audioTracks: null, subtitleTracks: null }, { mediaClass: "unverified", reasons: ["size_mismatch"] }) });
    for (const text of ["Why the inspection did not pass", "does not match what its container reports", "Media check failed"]) expect(refused, text).toContain(text);
    expect(mediaPart(refused).match(/>Failed</g)).toHaveLength(2); expect(refused).not.toContain(">Verified<"); expect(refused).not.toContain('value="approve"');
    // A historical MP4-policy refusal is not a current Policy 3 failure.
    const earlier = screen({ ...confirmed, status: "awaiting_media", gates: ["media_verification_required"], evidence: { mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: true, checkedAt: at,
      reference: "bounded_mtproto_v1: 64 bytes read (bounded check, not full-file integrity)", mediaClass: "unverified", reasons: ["mp4_not_fast_start"], policyVersion: 2, containerName: "mp4", passed: false,
      facts: { integrity: "legacy_unassessed", streaming: "legacy_unassessed", browsers: null, audioTracks: null, subtitleTracks: null, warnings: [], publishable: false } } });
    expect(earlier).not.toContain(">Failed<");
    for (const text of ["Awaiting Policy 3 inspection", "Policy 2", "index at the end", "Version 2"]) expect(earlier, text).toContain(text);
  });

  it("browser warning with otherwise verified media does not block: approval is offered and the warning is still shown", () => {
    const item = { ...confirmed, status: "awaiting_review" as const, gates: [] as string[],
      evidence: original("mp4", { ...VERIFIED, browsers: browsers("tested_video_only_silent_audio", "tested_video_only_silent_audio"), warnings: ["ac3_audio_silent_in_tested_browsers"] }, { audio: "ac3" }) };
    const html = screen(item, { review: true, rights: false, publish: false });
    for (const text of ["Limited in some browsers", "AC-3 audio was silent in every browser tested.", "Picture only, audio silent", 'value="approve"', "Every mandatory gate passes"]) expect(html, text).toContain(text);
  });

  it("multiple audio tracks and embedded subtitles are counted and explained", () => {
    const html = screen({ ...confirmed, status: "awaiting_media", gates: ["media_verification_required"],
      evidence: original("mkv", { audioTracks: 2, subtitleTracks: 3, warnings: ["firefox_mkv_streaming_unreliable", "audio_track_switching_not_available", "embedded_subtitles_not_displayed"] }) });
    expect(html).toMatch(/Audio tracks<\/dt><dd[^>]*>2</); expect(html).toMatch(/Subtitle tracks<\/dt><dd[^>]*>3</);
    for (const text of ["plays only the default one", "Embedded subtitles are not shown by the player."]) expect(html).toContain(text);
  });

  it("missing Policy 3 database functions: the page renders, keeps the earlier facts and says what is not reported", () => {
    // The evidence shape of a database without migration 20261011192618 (the hosted schema today).
    const earlier = { mediaKey: "d".repeat(64), container: true, gateway: true, browser: true, accessible: true, checkedAt: at, reference: "bounded_mtproto_v1: 3072 bytes read (bounded check, not full-file integrity)",
      mediaClass: "canonical", reasons: [], video: "h264", audio: "aac", bytesRead: 3072, policyVersion: 2, containerName: "mp4", passed: true };
    const html = screen({ ...confirmed, status: "awaiting_rights", gates: ["rights_clearance_required"], evidence: earlier }, null);
    for (const text of ["Media inspection", "Not reported", "migration 20261011192618", "Verified by the earlier MP4 policy", "MP4", "h264", "Version 2", "canonical", "accepted under the earlier MP4 policy", ...REQUIREMENTS]) expect(html, text).toContain(text);
    expect(html.match(/Not reported/g)!.length).toBeGreaterThanOrEqual(4); // integrity, browsers, both track counts
    for (const text of ["Browser by browser", "Playback warnings", ">Failed<", 'value="approve"', 'value="publish"']) expect(html).not.toContain(text);
    // Neither of the older schemas shows the media-only check (no migration 20261011112745): the screen still renders.
    expect(screen({ ...confirmed, lastInspection: undefined, status: "awaiting_media", gates: ["media_verification_required"], evidence: null }, null)).toContain("Waiting for media check");
  });

  it("a reviewer without the publish permission sees the verified state and an explanation, never the button", () => {
    const approved = { ...confirmed, status: "approved" as const, gates: [] as string[], approval: { actor: "a", at, revision: 3 }, rights: { actor: "r", at, reference: "licence 1", revision: 3 }, evidence: original("mp4", VERIFIED) };
    const limited = screen(approved, { review: true, rights: true, publish: false });
    expect(limited).toContain("Publishing needs the publish permission"); expect(limited).toContain("approved at revision 3");
    for (const text of ['value="publish"', 'value="approve"', 'disabled=""']) expect(limited).not.toContain(text);
    expect(screen(approved)).toContain('value="publish"');
    // Verified media alone opens nothing: without rights or approval there is no publication control for anyone.
    const waiting = screen({ ...approved, status: "awaiting_rights", approval: null, rights: null, gates: ["rights_clearance_required"] });
    for (const text of ['value="publish"', 'value="approve"']) expect(waiting).not.toContain(text);
    expect(waiting).toContain("rights clearance required");
  });

  it("shows the server's download setting and never offers a control for it", () => {
    const published = { ...confirmed, status: "published" as const, gates: ["candidate_closed"], publication: { movieSlug: "example-movie-2024", versionId: 4 }, evidence: original("mp4", VERIFIED) };
    const off = screen(published);
    for (const text of ["Download availability", "Switched off", "MEDIA_GATEWAY_DOWNLOADS_ENABLED"]) expect(off).toContain(text);
    const on = screen(published, everything, true);
    expect(on).toContain("Switched on"); expect(on).not.toContain("Switched off");
    expect(screen({ ...published, status: "awaiting_review", publication: null, gates: [] }, everything, true)).toContain("Not available until published");
    for (const html of [off, on]) expect(html).not.toMatch(/name="downloads"|value="enable|value="download/);
    // The offline fixture has no server setting to show.
    expect(renderToStaticMarkup(<ReviewDetail candidate={published} vjs={fixture.vjs} action={async () => {}} />)).not.toContain("Download availability");
  });

  it("names the Movies channel without its identifier, and shows no Telegram document identifier", () => {
    const html = screen({ ...confirmed, status: "awaiting_media", gates: ["media_verification_required"], evidence: original("mkv", {}, { identity: `tg1-${"e".repeat(64)}` }) });
    expect(html).toContain(`Movies channel, message ${candidate.event.messageId}`);
    for (const secret of [String(candidate.event.channelId), String(Math.abs(candidate.event.channelId)), candidate.event.media.uniqueId, "e".repeat(64), "d".repeat(64), "tg1-", "file_id"]) expect(html, secret).not.toContain(secret);
  });
});

describe("review UI server markup", () => {
  it("shows queue state, safe empty filtering, labeled controls and responsive grid", () => {
    const html = renderToStaticMarkup(<ReviewQueue candidates={[candidate]} search="" group="" />);
    expect(html).toContain("Awaiting verification"); expect(html).toContain("Awaiting clearance"); expect(html).toContain("md:grid-cols-2"); expect(html).toContain('for="q"');
    expect(renderToStaticMarkup(<ReviewQueue candidates={[candidate]} search="no-result" group="" />)).toContain("No review candidates");
  });
  it("detail names evidence, provenance and disabled production publishing", () => {
    const html = renderToStaticMarkup(<ReviewDetail candidate={candidate} vjs={fixture.vjs} action={async () => {}} error="Synthetic error" />);
    for (const text of ["role=\"alert\"", "No verification evidence", "No clearance; publication blocked", "Production publication is disabled", "Audit history", "revision", "Existing VJ", "md:grid-cols-3"]) expect(html).toContain(text);
    expect(html).not.toContain("file_id"); expect(html).not.toContain("synthetic-unused");
  });
  it("database mode offers approval and publication only to an account that holds the capability", () => {
    const all = { review: true, rights: true, publish: true }, reviewOnly = { review: true, rights: false, publish: false };
    const view = { ...candidate, status: "approved" as const, revision: 3, approval: { actor: "a", at: "2026-10-10T09:00:00.000Z", revision: 3 }, gates: [] as string[], evidence: { mediaKey: "d".repeat(64), container: true, gateway: true, browser: true, accessible: true, checkedAt: "2026-10-10T09:00:00.000Z", reference: "bounded_mtproto_v1: 3072 bytes read (bounded check, not full-file integrity)", mediaClass: "canonical", video: "h264", audio: "aac", reasons: [], bytesRead: 3072 } };
    const html = renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={all} />);
    for (const text of ["Publication gates", "Every mandatory gate passes", 'value="publish"', "Publish to the site", "canonical", "not full-file integrity", "Record rights clearance"]) expect(html).toContain(text);
    for (const text of ["Approve local review", "Prepare existing owner publication script", "Refresh public pages", "psql", "catalogue_review", 'value="approve"', "bot-file", "file_id"]) expect(html).not.toContain(text);
    // An approval of an older revision is not an offer to publish.
    expect(renderToStaticMarkup(<ReviewDetail candidate={{ ...view, revision: 4 }} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={all} />)).not.toContain('value="publish"');
    // Without the capability there is an explanation, not a button; rights likewise.
    const limited = renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewOnly} />);
    for (const text of ["Publishing needs the publish permission", "Recording rights clearance needs the rights permission"]) expect(limited).toContain(text);
    for (const text of ['value="publish"', 'value="rights"', 'disabled=""']) expect(limited).not.toContain(text);
    // A database without the dashboard commands yet: no button, and it says why.
    const pending = renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} mode="database" />);
    expect(pending).toContain("not switched on yet"); expect(pending).not.toContain('value="publish"');
    // Approval is offered only when the database reports no gate.
    const ready = { ...view, status: "awaiting_review" as const, approval: null };
    expect(renderToStaticMarkup(<ReviewDetail candidate={ready} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewOnly} />)).toContain('value="approve"');
    const blocked = renderToStaticMarkup(<ReviewDetail candidate={{ ...ready, gates: ["rights_clearance_required"] }} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={all} />);
    expect(blocked).toContain("rights clearance required"); expect(blocked).not.toContain('value="approve"'); expect(blocked).not.toContain('value="publish"');
    const published = renderToStaticMarkup(<ReviewDetail candidate={{ ...view, status: "published", publication: { movieSlug: "example-movie-2024", versionId: 4 } }} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={all} />);
    expect(published).toContain("Refresh public pages"); expect(published).toContain('href="/movies/example-movie-2024"'); expect(published).not.toContain('value="publish"');
    const queue = renderToStaticMarkup(<ReviewQueue candidates={[view]} search="" group="" mode="database" />);
    expect(queue).toContain("Movies channel"); expect(queue).not.toContain("fixture");
  });
  it("a failed inspection explains itself and offers the one action, with no disabled controls", () => {
    const stuck = { ...candidate, status: "blocked" as const, error: "inspection_attempts_exhausted", gates: ["candidate_closed", "identity_unconfirmed", "vj_unresolved", "media_verification_required", "rights_clearance_required"] };
    const html = renderToStaticMarkup(<ReviewDetail candidate={stuck} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={{ review: true, rights: false, publish: false }} notice="Reinspection requested." />);
    for (const text of ["What happens next", "Inspection failed", "Reinspect now", "Also blocking: candidate closed", "vj unresolved", 'role="status"']) expect(html).toContain(text);
    for (const text of ['disabled=""', "Confirm film and VJ", "Record rights clearance", "Reject candidate"]) expect(html).not.toContain(text);
    // The offline fixture has no reinspection of a blocked candidate.
    expect(renderToStaticMarkup(<ReviewDetail candidate={stuck} vjs={fixture.vjs} action={async () => {}} />)).not.toContain('value="retry"');
    const queue = renderToStaticMarkup(<ReviewQueue candidates={[stuck, candidate]} search="" group="" mode="database" reinspectAll={async () => {}} />);
    for (const text of ["Reinspect all failed (1)", "All (2)", "Needs you (1)", "In progress (1)", 'href="/admin/discovery?show=action"']) expect(queue).toContain(text);
    expect(renderToStaticMarkup(<ReviewQueue candidates={[stuck, candidate]} search="" group="progress" mode="database" />)).not.toContain("Inspection failed");
  });
  it("a confirmed candidate waiting at the media gate offers the media check, with the last inspection and its reason", () => {
    const reviewer = { review: true, rights: false, publish: false };
    const waiting = { ...candidate, status: "awaiting_media" as const, identity: "confirmed" as const, title: "Example Movie", revision: 3, attempts: 1, gates: ["media_verification_required", "rights_clearance_required"],
      lastInspection: { at: "2026-10-11T12:00:00.000Z", action: "media_inspected", detail: "no_evidence", revision: 3 } };
    const html = renderToStaticMarkup(<ReviewDetail candidate={waiting} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewer} />);
    for (const text of ["Media check needed", "Run media check", "Last inspection", "2026-10-11 12:00 UTC · media inspected · revision 3", "Last failure", "without its media reader", "Inspection attempts", "1 of 5", "Manual action", "Needed", "Reject candidate"]) expect(html).toContain(text);
    // One inspection control, the primary one; no disabled buttons.
    expect(html.match(/value="retry"/g)).toHaveLength(1); expect(html).not.toContain('disabled=""'); expect(html).not.toContain("Reinspect now");
    // Without the review permission there is an explanation instead of the button.
    const limited = renderToStaticMarkup(<ReviewDetail candidate={waiting} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={{ review: false, rights: true, publish: false }} />);
    expect(limited).toContain("needs the review permission"); expect(limited).not.toContain('value="retry"');
    // Checked and refused by the policy: the reason, the same single action, and the confirmation kept.
    const mkv = { ...waiting, evidence: { mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: false, checkedAt: "2026-10-11T12:00:00.000Z", reference: "bounded_mtproto_v1: 16 bytes read (bounded check, not full-file integrity)", mediaClass: "unverified", reasons: ["container_not_mp4"] },
      lastInspection: { at: "2026-10-11T12:00:00.000Z", action: "media_inspected", detail: "unverified:unverified", revision: 3 } };
    const failed = renderToStaticMarkup(<ReviewDetail candidate={mkv} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewer} />);
    for (const text of ["Media check failed", "not an MP4", "stay confirmed", "Run media check"]) expect(failed).toContain(text);
    // A retrying inspection shows when it runs next; the queue names the failure and counts it as needing a person only when it does.
    const retrying = { ...waiting, id: "c".repeat(64), status: "failed" as const, attempts: 2, retryAt: Date.parse("2026-10-11T12:01:00Z"), lastInspection: { at: "2026-10-11T12:00:00.000Z", action: "inspection_failed", detail: "media_read_flood_wait", revision: 3 } };
    const retryHtml = renderToStaticMarkup(<ReviewDetail candidate={retrying} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewer} />);
    for (const text of ["Inspection retrying", "2 of 5 · next retry 2026-10-11 12:01 UTC", "slow down", "Not needed now", "Reinspect now"]) expect(retryHtml).toContain(text);
    const queue = renderToStaticMarkup(<ReviewQueue candidates={[waiting, retrying]} search="" group="" mode="database" />);
    for (const text of ["Needs you (1)", "In progress (1)", "Media check needed", "Last failure", "without its media reader"]) expect(queue).toContain(text);
    // A database where a re-inspection would replace the confirmation (no migration 20261011112745): the screen is as it was.
    const older = { ...waiting, lastInspection: undefined };
    const olderHtml = renderToStaticMarkup(<ReviewDetail candidate={older} vjs={fixture.vjs} action={async () => {}} mode="database" capabilities={reviewer} />);
    for (const text of ["Waiting for media check", 'value="retry"']) expect(olderHtml).toContain(text);
    for (const text of ["Run media check", "Last inspection", "stay confirmed", "Manual action"]) expect(olderHtml).not.toContain(text);
    expect(renderToStaticMarkup(<ReviewQueue candidates={[older]} search="" group="" mode="database" />)).toContain("In progress (1)");
    // The offline fixture has no worker diagnostics.
    expect(renderToStaticMarkup(<ReviewDetail candidate={candidate} vjs={fixture.vjs} action={async () => {}} />)).not.toContain("Last inspection");
  });
  it("database review picks the film from poster choices; the year comes from the choice", () => {
    const view = { ...candidate, status: "awaiting_identity" as const, title: "Example Movie", choices: fixture.movies, vjId: fixture.vjs[0].id, gates: ["identity_unconfirmed"] };
    const html = renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} mode="database" />);
    for (const text of ["Which film is this?", 'type="radio"', 'name="tmdbId"', "Example Movie (2024)", "TMDB 900001", "Confirm film and VJ", "Choose the film", "Reject candidate"]) expect(html).toContain(text);
    for (const text of ['name="year"', 'name="title"', "Reinspect now", "No film found"]) expect(html).not.toContain(text);
    const none = renderToStaticMarkup(<ReviewDetail candidate={{ ...view, choices: [] }} vjs={fixture.vjs} action={async () => {}} mode="database" />);
    for (const text of ["No film found for this title", "tmdb:movie:NUMBER"]) expect(none).toContain(text);
    expect(none).not.toContain("Confirm film and VJ");
  });
  it("can export synthetic server markup for explicit offline responsive verification", () => {
    if (process.env.VELORA_E38_UI_PREVIEW !== "true") return;
    const directory = ".velora-ingest/e3.8"; mkdirSync(directory, { recursive: true });
    const view = { ...candidate, title: "Example Movie", snapshot: fixture.movies[0], choices: fixture.movies, vjText: "Test", year: 2024 };
    // Database-mode screens with the states a reviewer meets: a failed inspection, a choice of films, no film found.
    const stuck = { ...candidate, status: "blocked" as const, error: "inspection_attempts_exhausted", gates: ["candidate_closed", "identity_unconfirmed", "vj_unresolved", "media_verification_required", "rights_clearance_required"] };
    const choose = { ...view, snapshot: null, status: "awaiting_identity" as const, identity: "ambiguous" as const, vjId: fixture.vjs[0].id, gates: ["identity_unconfirmed", "media_verification_required", "rights_clearance_required"],
      choices: [fixture.movies[0], { ...fixture.movies[0], tmdb_id: 900002, release_date: "1994-05-06", original_title: "An Older Namesake With A Rather Long Original Title", overview: "A second synthetic film with the same name, to show how a reviewer tells two candidates apart by year and description. ".repeat(3) }] };
    const parts = {
      queue: renderToStaticMarkup(<ReviewQueue candidates={[view]} search="" group="" />),
      detail: renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} />),
      "queue-database": renderToStaticMarkup(<ReviewQueue candidates={[stuck, choose, { ...choose, id: "c".repeat(64), choices: [] }]} search="" group="" mode="database" reinspectAll={async () => {}} notice="Reinspection requested." />),
      "detail-failed": renderToStaticMarkup(<ReviewDetail candidate={stuck} vjs={fixture.vjs} action={async () => {}} mode="database" />),
      "detail-choose": renderToStaticMarkup(<ReviewDetail candidate={choose} vjs={fixture.vjs} action={async () => {}} mode="database" />),
      "detail-nofilm": renderToStaticMarkup(<ReviewDetail candidate={{ ...choose, choices: [] }} vjs={fixture.vjs} action={async () => {}} mode="database" />),
      // The media gate (E3.8 media recovery): a check to run, a file outside the policy, and a reader outage retrying by itself.
      ...mediaPreviews(view),
    };
    // VELORA_E38_UI_PREVIEW_CSS: the running dev server's stylesheet URL, so the previews carry the real tokens and utilities.
    const css = process.env.VELORA_E38_UI_PREVIEW_CSS ? `<link rel="stylesheet" href="${process.env.VELORA_E38_UI_PREVIEW_CSS}">` : "";
    for (const [name, body] of Object.entries(parts)) writeFileSync(`${directory}/${name}.preview.html`, `<!doctype html><html lang="en" data-theme="dark"><meta name="viewport" content="width=device-width, initial-scale=1">${css}<body><main class="page-container py-6 sm:py-8">${body}</main></body></html>`);
    expect(parts.detail).toContain("Example Movie");
  });
});
