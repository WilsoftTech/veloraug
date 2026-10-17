import { describe, expect, it } from "vitest";
import { toCandidate } from "./database";
import { guidance, lastFailure, verificationPending } from "./guidance";
import { candidateMedia, mediaReport, publicationRequirements, type MediaReport } from "./media-report";

/**
 * Checkpoint 9. Each case starts from the JSON the database returns
 * (private.channel_view), so the whole path is covered: view, review model,
 * report. "Verified" integrity and streaming are values no worker can record
 * yet; they are built here to prove what the page does when the database says so.
 */
const channel = -1001111111111;
const film = { tmdb_id: 9800001, title: "Example Movie", original_title: "Example Movie", overview: "Synthetic.", release_date: "2024-05-01", runtime_minutes: 100, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] };
const track = (index: number, type: string, codec: string, extra: Record<string, unknown> = {}) => ({ index, type, codec, attachedPicture: false, title: "PRIVATE TRACK TITLE", ...extra });
const profile = (chromium: string, firefox: string) => ({ basis: "tested_fixture_combinations", perFile: "prediction", evidence: "docs/MP4_MKV_NATIVE_PLAYBACK.md", chromium, firefox, safari: "real_device_not_tested", ios: "real_device_not_tested", android: "real_device_not_tested" });
/** Evidence as the earlier policies recorded it: what the hosted database returns today. */
const legacy = (extra: Record<string, unknown> = {}) => ({ identity: `tg1-${"d".repeat(64)}`, verified: true, method: "bounded_mtproto_v1", scope: "bounded", policy_version: 2, media_class: "canonical", reasons: [] as string[],
  container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: true, bytes_read: 3072, checked_at: "2026-10-10T09:01:00+00:00", ...extra });
/** Policy 3 evidence with the separate facts (migration 20261011192618). */
const policy3 = (extra: Record<string, unknown> = {}) => ({ ...legacy(), verified: false, method: "bounded_original_v2", policy_version: 3, media_class: "original", playback_ready: false, bytes_read: 70000,
  integrity_status: "metadata_consistent", streaming_status: "potentially_playable", download_status: "not_implemented_authorization_required",
  browser_profile: profile("tested_combination", "tested_combination"), tracks: [track(0, "video", "h264"), track(1, "audio", "aac")], warnings: [] as string[], publishable_media: false, ...extra });
const verified = (extra: Record<string, unknown> = {}) => policy3({ integrity_status: "verified", streaming_status: "verified", publishable_media: true, ...extra });
const view = (evidence: unknown, blockers: string[] = ["media_verification_required", "rights_clearance_required"], extra: Record<string, unknown> = {}) => toCandidate({
  key: "a".repeat(64), revision: 3, status: "needs_review", error_code: null, attempts: 1, first_seen: "2026-10-10T09:00:00+00:00", last_seen: "2026-10-10T09:05:00+00:00",
  event: { event_id: "b".repeat(64), payload_digest: "c".repeat(64), chat_id: channel, message_id: 10, update_id: 100, kind: "channel_post", observed_at: 1760000000,
    file_unique_id: "AgADuniq10", size: 1048576, name: "Example.Movie.2024.VJ.Test.mkv", mime: "video/x-matroska", caption: null },
  identity: `tg1-${"d".repeat(64)}`, identity_state: "confirmed", title: "Example Movie", year: 2024, vj_text: "Test", warnings: [], tmdb_id: 9800001,
  vj: { id: 3, slug: "vj-test", name: "VJ Test", active: true }, relation: "new_movie", movie_id: null, duplicate_of: null, snapshot: film,
  evidence, rights: null, approval: null, publication: null, blockers, inspection: { retry_at: null, last: { at: "2026-10-10T09:01:00+00:00", action: "media_inspected", detail: "original:original", revision: 3 } }, ...extra });
const report = (evidence: unknown, download?: { enabled: boolean; published: boolean }) => mediaReport(candidateMedia(view(evidence)), download);
const status = (result: MediaReport, label: string) => result.statuses.find((item) => item.label === label)!;
const detail = (result: MediaReport, label: string) => result.details.find((item) => item.label === label)!.value;
const requirement = (candidate: ReturnType<typeof view>, label: string) => publicationRequirements(candidate).requirements.find((item) => item.label === label)!;

describe("media status mapping", () => {
  it("MP4 verified profile: both facts verified, the details named, nothing failed", () => {
    const result = report(verified());
    expect(status(result, "Media integrity")).toMatchObject({ value: "Verified", tone: "verified" });
    expect(status(result, "Streaming readiness")).toMatchObject({ value: "Verified", tone: "verified" });
    expect(status(result, "Browser compatibility")).toMatchObject({ value: "Tested combination on desktop", tone: "pending" });
    expect(result.details).toEqual([
      { label: "Original container", value: "MP4" }, { label: "Original filename", value: "Example.Movie.2024.VJ.Test.mkv" }, { label: "Video codec", value: "h264" }, { label: "Audio codec", value: "aac" },
      { label: "Audio tracks", value: "1" }, { label: "Subtitle tracks", value: "0" }, { label: "Inspection policy", value: "Version 3" }, { label: "Inspected", value: "2026-10-10 09:01 UTC" }]);
    expect(result.reasons).toEqual([]); expect(result.warnings).toEqual([]); expect(result.basis).toContain("Policy 3");
  });

  it("MKV verified profile: verified, with Firefox named as a limitation that blocks nothing", () => {
    const evidence = verified({ container: "mkv", browser_profile: profile("tested_combination", "streaming_unreliable"), warnings: ["firefox_mkv_streaming_unreliable"] });
    const result = report(evidence);
    expect(detail(result, "Original container")).toBe("MKV");
    expect(status(result, "Media integrity").tone).toBe("verified"); expect(status(result, "Streaming readiness").tone).toBe("verified");
    expect(status(result, "Browser compatibility")).toMatchObject({ value: "Limited in some browsers", tone: "warning" });
    expect(status(result, "Browser compatibility").detail).toContain("does not block publication");
    expect(result.warnings).toEqual(["Firefox does not stream MKV reliably."]);
    expect(result.browsers).toEqual([{ name: "Chrome and Edge", value: "Tested combination" }, { name: "Firefox", value: "Streaming unreliable" },
      { name: "Safari (macOS)", value: "Not tested on a real device" }, { name: "iPhone and iPad", value: "Not tested on a real device" }, { name: "Android", value: "Not tested on a real device" }]);
  });

  it("what the worker records today is not verification: metadata consistent and potentially playable stay pending", () => {
    const result = report(policy3());
    expect(status(result, "Media integrity")).toMatchObject({ value: "Metadata consistent, not verified", tone: "pending" });
    expect(status(result, "Streaming readiness")).toMatchObject({ value: "Potentially playable, not verified", tone: "pending" });
    expect(status(report(policy3({ streaming_status: "potentially_playable_startup_warning", warnings: ["mp4_startup_tail_required"] })), "Streaming readiness").value).toBe("Potentially playable, slow start, not verified");
    expect(status(report(policy3({ streaming_status: "untested", warnings: ["fragmented_mp4_not_tested"] })), "Streaming readiness").value).toBe("Untested layout, not verified");
    for (const item of result.statuses) expect(item.tone, item.label).not.toBe("verified");
  });

  it("unknown inspection profile: no evidence, or a status this page does not know, is never verified", () => {
    const none = report(null);
    for (const label of ["Media integrity", "Streaming readiness", "Browser compatibility"]) expect(status(none, label)).toMatchObject({ value: "Not inspected", tone: "missing" });
    expect(none.basis).toBe("No inspection evidence is recorded for this file.");
    expect(detail(none, "Inspected")).toBe("Never"); expect(detail(none, "Original container")).toBe("Not reported"); expect(detail(none, "Audio tracks")).toBe("Not reported");
    const strange = report(policy3({ integrity_status: "VERIFIED ", streaming_status: "certified", browser_profile: profile("great", "tested_combination") }));
    expect(status(strange, "Media integrity")).toMatchObject({ value: "Unrecognised: VERIFIED ", tone: "missing" });
    expect(status(strange, "Streaming readiness")).toMatchObject({ value: "Unrecognised: certified", tone: "missing" });
    expect(status(strange, "Browser compatibility")).toMatchObject({ value: "Unknown", tone: "missing" });
    // A Policy 3 row with no assessment (the check stopped early): no profile, no track counts.
    const early = report(policy3({ media_class: "unverified", integrity_status: "incomplete", streaming_status: "unverified", browser_profile: null, tracks: null, warnings: null, container: null, video_codec: null, audio_codec: null, reasons: ["media_unreadable"] }));
    expect(status(early, "Browser compatibility")).toMatchObject({ value: "Unknown", tone: "missing" });
    expect(detail(early, "Audio tracks")).toBe("Not reported"); expect(detail(early, "Video codec")).toBe("Not reported");
  });

  it("failed media integrity: a refused file is a failure, with its reasons in plain words", () => {
    const result = report(policy3({ media_class: "unverified", integrity_status: "incomplete", streaming_status: "unverified", reasons: ["size_mismatch", "video_metadata_incomplete"] }));
    expect(status(result, "Media integrity")).toMatchObject({ value: "Failed", tone: "failed" });
    expect(result.reasons).toEqual(["The file's size does not match what its container reports.", "The video track is missing its codec or dimensions."]);
  });

  it("failed streaming readiness: under Policy 3 and under the earlier MP4 policy", () => {
    const refused = report(policy3({ media_class: "unverified", integrity_status: "incomplete", streaming_status: "unverified", reasons: ["mp4_layout_incomplete"] }));
    expect(status(refused, "Streaming readiness")).toMatchObject({ value: "Failed", tone: "failed" });
    // The earlier policy's refusal remains history, pending a current Policy 3 inspection.
    const earlier = report(legacy({ verified: false, media_class: "unverified", playback_ready: false, reasons: ["mp4_not_fast_start"], integrity_status: "legacy_unassessed", streaming_status: "legacy_unassessed", browser_profile: null, tracks: null, warnings: null, publishable_media: false }));
    expect(status(earlier, "Streaming readiness")).toMatchObject({ value: "Awaiting Policy 3 inspection", tone: "missing" });
    expect(status(earlier, "Media integrity")).toMatchObject({ value: "Awaiting Policy 3 inspection", tone: "missing" });
    expect(earlier.history[0]).toContain("index at the end"); expect(earlier.basis).toContain("Historical result only: policy 2");
  });

  it("an inspection that could not read the file is incomplete, not a failed file", () => {
    for (const reason of ["media_read_flood_wait", "media_unreadable", "probe_timeout", "moov_over_budget"]) {
      const result = report(policy3({ media_class: "unverified", integrity_status: "incomplete", streaming_status: "unverified", reasons: [reason], browser_profile: null, tracks: null, warnings: null }));
      expect(status(result, "Media integrity"), reason).toMatchObject({ value: "Inspection incomplete", tone: "pending" });
      expect(status(result, "Streaming readiness"), reason).toMatchObject({ value: "Not verified", tone: "pending" });
    }
  });

  it("browser warning with otherwise verified media: shown as a warning, and no requirement fails because of it", () => {
    for (const [chromium, firefox, value] of [["tested_video_only_silent_audio", "tested_video_only_silent_audio", "Limited in some browsers"], ["device_dependent_or_untested", "device_dependent_or_untested", "Browser-dependent"]] as const) {
      const candidate = view(verified({ video_codec: "hevc", browser_profile: profile(chromium, firefox), warnings: ["hevc_device_decoder_required", "ac3_audio_silent_in_tested_browsers"] }), ["rights_clearance_required"]);
      const result = mediaReport(candidateMedia(candidate));
      expect(status(result, "Browser compatibility")).toMatchObject({ value, tone: "warning" });
      expect(result.warnings).toHaveLength(2);
      expect(requirement(candidate, "Media integrity verified").done).toBe(true); expect(requirement(candidate, "Streaming readiness verified").done).toBe(true);
      expect(publicationRequirements(candidate).requirements.map((item) => item.label).join()).not.toMatch(/browser/i);
      expect(publicationRequirements(candidate).also).toEqual([]);
    }
  });

  it("multiple audio tracks and embedded subtitles are counted, and no track title leaves the database view", () => {
    const evidence = verified({ container: "mkv", browser_profile: profile("tested_combination", "streaming_unreliable"),
      tracks: [track(0, "video", "h264"), track(1, "audio", "aac", { language: "eng" }), track(2, "audio", "aac", { language: "lug" }), track(3, "subtitle", "subrip"), track(4, "subtitle", "ass"), track(5, "subtitle", "subrip")],
      warnings: ["firefox_mkv_streaming_unreliable", "audio_track_switching_not_available", "embedded_subtitles_not_displayed"] });
    const candidate = view(evidence);
    const result = mediaReport(candidateMedia(candidate));
    expect(detail(result, "Audio tracks")).toBe("2"); expect(detail(result, "Subtitle tracks")).toBe("3");
    expect(result.warnings).toEqual(["Firefox does not stream MKV reliably.", "More than one audio track; the player plays only the default one.", "Embedded subtitles are not shown by the player."]);
    expect(candidate.evidence!.facts).toMatchObject({ audioTracks: 2, subtitleTracks: 3 });
    expect(JSON.stringify(candidate)).not.toContain("PRIVATE TRACK TITLE");
  });

  it("missing Policy 3 database functions: the earlier fields still show, and every Policy 3 fact says it is not reported", () => {
    const candidate = view(legacy(), ["rights_clearance_required"]);
    expect(candidate.evidence!.facts).toBeUndefined();
    const result = mediaReport(candidateMedia(candidate));
    expect(status(result, "Media integrity")).toMatchObject({ value: "Not reported", tone: "missing" });
    expect(status(result, "Media integrity").detail).toContain("migration 20261011192618");
    expect(status(result, "Streaming readiness")).toMatchObject({ value: "Verified by the earlier MP4 policy", tone: "verified" });
    expect(status(result, "Browser compatibility")).toMatchObject({ value: "Not reported", tone: "missing" });
    expect(result.details).toEqual(expect.arrayContaining([{ label: "Original container", value: "MP4" }, { label: "Video codec", value: "h264" }, { label: "Audio codec", value: "aac" },
      { label: "Audio tracks", value: "Not reported" }, { label: "Subtitle tracks", value: "Not reported" }, { label: "Inspection policy", value: "Version 2" }, { label: "Inspected", value: "2026-10-10 09:01 UTC" }]));
    expect(result.browsers).toEqual([]); expect(result.warnings).toEqual([]);
  });

  it("a Policy 3 field of the wrong shape is dropped, not trusted and not fatal", () => {
    const candidate = view(policy3({ integrity_status: 7, streaming_status: ["verified"], browser_profile: "all", tracks: { length: 2 }, warnings: "none", publishable_media: "true" }));
    expect(candidate.evidence!.facts).toBeUndefined();
    expect(status(mediaReport(candidateMedia(candidate)), "Media integrity").value).toBe("Not reported");
    const partial = view(policy3({ integrity_status: "verified", streaming_status: "verified", tracks: "many", warnings: 3, publishable_media: 1, browser_profile: { chromium: 1, firefox: "tested_combination", extra: "x".repeat(500) } }));
    expect(partial.evidence!.facts).toEqual({ integrity: "verified", streaming: "verified", browsers: { firefox: "tested_combination" }, audioTracks: null, subtitleTracks: null, warnings: [], publishable: false });
  });
});

describe("download availability", () => {
  it("is not shown where there is no server setting, and names the switch when it is off", () => {
    expect(report(verified()).statuses.map((item) => item.label)).toEqual(["Media integrity", "Streaming readiness", "Browser compatibility"]);
    const off = status(report(verified(), { enabled: false, published: true }), "Download availability");
    expect(off).toMatchObject({ value: "Switched off", tone: "missing" }); expect(off.detail).toContain("MEDIA_GATEWAY_DOWNLOADS_ENABLED");
  });
  it("switched on, it is offered only for a published version and is never called verified", () => {
    expect(status(report(verified(), { enabled: true, published: false }), "Download availability")).toMatchObject({ value: "Not available until published", tone: "missing" });
    const on = status(report(verified(), { enabled: true, published: true }), "Download availability");
    expect(on).toMatchObject({ value: "Switched on", tone: "pending" }); expect(on.detail).toContain("cannot confirm");
    expect(status(report(policy3({ container: "webm" }), { enabled: true, published: true }), "Download availability").value).toBe("Not available");
  });
});

describe("publication requirements", () => {
  const labels = ["Media integrity verified", "Streaming readiness verified", "Film identity confirmed", "VJ identity confirmed", "Rights clearance approved", "Final publication approval granted"];
  it("lists the six requirements separately, and a recorded Policy 3 inspection satisfies neither media requirement", () => {
    const candidate = view(policy3());
    const { requirements, also } = publicationRequirements(candidate);
    expect(requirements.map((item) => item.label)).toEqual(labels);
    expect(requirements.map((item) => item.done)).toEqual([false, false, true, true, false, false]);
    expect(requirement(candidate, "Media integrity verified").detail).toBe("metadata consistent, not verified");
    expect(requirement(candidate, "Final publication approval granted").detail).toBe("not approved");
    expect(also).toEqual([]);
    expect(verificationPending(candidate)).toBe(true); expect(lastFailure(candidate)).toBeNull();
    expect(guidance(candidate)).toMatchObject({ group: "progress", label: "Verification pending" });
  });
  it("each media requirement follows its own fact", () => {
    const half = view(policy3({ integrity_status: "verified" }));
    expect(requirement(half, "Media integrity verified").done).toBe(true); expect(requirement(half, "Streaming readiness verified").done).toBe(false);
  });
  it("everything verified and approved at the current revision: all six are done", () => {
    const ready = view(verified(), [], { status: "matched", approval: { revision: 3, by: "00000000-0000-4000-8000-0000000000a1", at: "2026-10-10T09:06:00+00:00" },
      rights: { reference: "licence 1", cleared_by: "00000000-0000-4000-8000-0000000000a2", cleared_at: "2026-10-10T09:05:00+00:00", revision: 3 } });
    expect(publicationRequirements(ready).requirements.map((item) => item.done)).toEqual([true, true, true, true, true, true]);
    // An approval of an older revision is not the final approval.
    const stale = view(verified(), [], { revision: 4, approval: { revision: 3, by: "00000000-0000-4000-8000-0000000000a1", at: "2026-10-10T09:06:00+00:00" } });
    expect(requirement(stale, "Final publication approval granted")).toMatchObject({ done: false, detail: "approved at revision 3, which is not the current one" });
  });
  it("the database's media gate has the last word: verified facts with the gate still closed are reported as blocking", () => {
    const closed = view(verified({ publishable_media: false }), ["media_verification_required"]);
    expect(publicationRequirements(closed).also).toEqual(["media_verification_required"]);
  });
  it("under the earlier policy the media requirements follow the database gate and the recorded verdict, never a missing value", () => {
    const passed = view(legacy(), ["rights_clearance_required"]);
    expect(requirement(passed, "Media integrity verified")).toMatchObject({ done: true, detail: "accepted under the earlier MP4 policy" });
    expect(requirement(passed, "Streaming readiness verified")).toMatchObject({ done: true, detail: "passed the earlier MP4 policy" });
    for (const candidate of [view(legacy()), view(legacy({ verified: false, media_class: "unverified", reasons: ["container_not_mp4"] })), view(null), view(null, ["rights_clearance_required"])]) {
      expect(requirement(candidate, "Media integrity verified").done).toBe(false); expect(requirement(candidate, "Streaming readiness verified").done).toBe(false);
    }
    expect(requirement(view(null), "Media integrity verified").detail).toBe("not inspected");
  });
});

// Legacy media check fix (2026-10-17). The three candidates as the hosted database records them, read through the same view.
describe("historical results and inconclusive decodes are never shown as a current Policy 3 verdict", () => {
  /** A refusal by the earlier MP4-only policy on a database that applies Policy 3 (In Cold Light, Hunting Grounds). */
  const policy2Refusal = (reason: string, container: string | null) => legacy({ verified: false, media_class: "unverified", playback_ready: false, reasons: [reason], container, video_codec: null, audio_codec: null,
    bytes_read: container ? 64 : 16, integrity_status: "legacy_unassessed", streaming_status: "legacy_unassessed", browser_profile: null, tracks: null, warnings: null, publishable_media: false,
    download_status: "not_implemented_authorization_required" });
  /** A whole-file Policy 3 result that failed integrity (All the Devil's Men, with the reason it recorded or a named one). */
  const wholeFile = (reason: string) => policy3({ scope: "whole_file", method: "full_original_v1", media_class: "unverified", container: "mkv", audio_codec: "mp3", reasons: [reason], integrity_status: "incomplete",
    streaming_status: "unverified", download_status: "original_servable", content_sha256: "e".repeat(64), warnings: ["firefox_mkv_streaming_unreliable"],
    browser_profile: profile("tested_combination", "streaming_unreliable") });

  it.each([["mp4_not_fast_start", "mp4", "index at the end"], ["container_not_mp4", null, "not an MP4"]])("a policy 2 refusal (%s) is history, awaiting a Policy 3 inspection", (reason, container, text) => {
    const candidate = view(policy2Refusal(reason, container));
    const result = mediaReport(candidateMedia(candidate));
    for (const label of ["Media integrity", "Streaming readiness", "Browser compatibility"]) expect(status(result, label), label).toMatchObject({ value: "Awaiting Policy 3 inspection", tone: "missing" });
    expect(result.statuses.some((item) => item.tone === "failed")).toBe(false);
    expect(result.reasons).toEqual([]); expect(result.history).toHaveLength(1); expect(result.history[0]).toContain(text); expect(result.history[0]).toContain("Policy 3 accepts");
    expect(result.basis).toContain("Historical result only"); expect(detail(result, "Inspection policy")).toBe("Version 2");
    expect(guidance(candidate)).toMatchObject({ group: "action", label: "Awaiting Policy 3 inspection" });
    expect(guidance(candidate).next).toContain("not a current verdict"); expect(lastFailure(candidate)).toBeNull();
    expect(requirement(candidate, "Media integrity verified").done).toBe(false); expect(requirement(candidate, "Streaming readiness verified").done).toBe(false);
  });

  it("a policy 2 pass is unchanged, and so is a policy 2 refusal on a database without the separate facts", () => {
    expect(status(report(legacy()), "Streaming readiness")).toMatchObject({ value: "Verified by the earlier MP4 policy" });
    const older = report({ ...legacy({ verified: false, media_class: "unverified", playback_ready: false, reasons: ["container_not_mp4"] }) });
    expect(status(older, "Streaming readiness")).toMatchObject({ value: "Failed", tone: "failed" }); expect(older.history).toEqual([]);
  });

  it("All the Devil's Men's recorded decode_failed is not called damage: integrity not verified, streaming not assessed", () => {
    const candidate = view(wholeFile("decode_failed"));
    const result = mediaReport(candidateMedia(candidate));
    expect(status(result, "Media integrity")).toMatchObject({ value: "Not verified", tone: "pending" });
    expect(status(result, "Streaming readiness")).toMatchObject({ value: "Not verified", tone: "pending", detail: "Not assessed: streaming is checked only once integrity is verified." });
    expect(result.reasons[0]).toContain("does not show that the file is damaged"); expect(result.reasons[0]).not.toContain(": the file is damaged");
    expect(status(result, "Browser compatibility").tone).toBe("warning");
    expect(guidance(candidate)).toMatchObject({ group: "action", label: "Verification inconclusive" });
    expect(requirement(candidate, "Media integrity verified").done).toBe(false);
  });

  it.each([["decode_error_at_end", "Not verified", "Verification inconclusive"], ["decode_codec_unsupported", "Not verified", "Verification inconclusive"],
    ["decode_corrupt_data", "Failed", "Media check failed"], ["content_truncated", "Failed", "Media check failed"], ["decode_container_unparsable", "Failed", "Media check failed"]])(
    "a whole-file %s reads %s", (reason, value, label) => {
      const candidate = view(wholeFile(reason));
      expect(status(mediaReport(candidateMedia(candidate)), "Media integrity").value).toBe(value);
      expect(guidance(candidate).label).toBe(label);
    });

  it("a later Policy 3 verification replaces the historical result as current; rights and approval still stand between it and publication", () => {
    const candidate = view(verified({ scope: "whole_file", method: "full_original_v1", content_sha256: "f".repeat(64), download_status: "original_servable" }), ["rights_clearance_required"]);
    const result = mediaReport(candidateMedia(candidate));
    expect(result.history).toEqual([]); expect(status(result, "Media integrity").value).toBe("Verified");
    expect(guidance(candidate).label).toBe("Rights needed");
    expect(requirement(candidate, "Rights clearance approved")).toMatchObject({ done: false });
    expect(requirement(candidate, "Final publication approval granted")).toMatchObject({ done: false, detail: "not approved" });
    const cleared = view(verified({ scope: "whole_file", method: "full_original_v1", content_sha256: "f".repeat(64) }), []);
    expect(guidance(cleared).label).toBe("Ready to approve");
    expect(requirement(cleared, "Final publication approval granted").done).toBe(false);
  });
});
