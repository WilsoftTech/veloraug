import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialInbox, receive } from "./events";
import { fixtureSchema } from "./fixtures";
import { canReinspect, guidance, inspectionExhausted, lastFailure, mediaCheckAvailable, otherGates, reasonText, resultMessage, reviewOpen, steps } from "./guidance";
import { reviewStates, type ReviewCandidate } from "./model";

const fixture = fixtureSchema.parse(JSON.parse(readFileSync("scripts/discovery/example.json", "utf8")));
const inbox = initialInbox(fixture.channelId); receive(inbox, fixture.updates, "2026-10-09T12:00:00.000Z");
const base = Object.values(inbox.candidates)[0];
const at = (status: ReviewCandidate["status"], error: string | null = null): ReviewCandidate => ({ ...base, status, error });

describe("admin guidance", () => {
  it("gives every review state a group, a label and a next step", () => {
    for (const status of reviewStates) {
      const guide = guidance(at(status));
      expect(["action", "progress", "published", "closed"]).toContain(guide.group); expect(guide.label).not.toBe(""); expect(guide.next).not.toBe("");
    }
  });
  it("puts work that needs a person in the action group, and automatic work in progress", () => {
    for (const status of ["awaiting_metadata", "awaiting_identity", "awaiting_vj", "awaiting_rights", "awaiting_review", "approved"] as const) expect(guidance(at(status)).group).toBe("action");
    for (const status of ["detected", "inspecting", "failed", "awaiting_media", "publishing"] as const) expect(guidance(at(status)).group).toBe("progress");
    // Where a re-inspection keeps the confirmation, a candidate at the media gate is not queued anywhere: a reviewer runs the check.
    expect(mediaCheckAvailable(at("awaiting_media"))).toBe(false);
    expect(guidance({ ...at("awaiting_media"), lastInspection: null })).toMatchObject({ group: "action", label: "Media check needed" });
    expect(guidance(at("published")).group).toBe("published");
    for (const status of ["duplicate", "rejected"] as const) expect(guidance(at(status)).group).toBe("closed");
  });
  it("only an exhausted inspection is a blocked candidate a reviewer can act on", () => {
    const exhausted = at("blocked", "inspection_attempts_exhausted"), series = at("blocked", "series_out_of_scope");
    expect(inspectionExhausted(exhausted)).toBe(true); expect(guidance(exhausted)).toMatchObject({ group: "action", label: "Inspection failed" });
    expect(canReinspect(exhausted, true)).toBe(true); expect(canReinspect(exhausted, false)).toBe(false);
    expect(guidance(series)).toMatchObject({ group: "closed", label: "Blocked" }); expect(guidance(series).next).toContain("series");
    expect(canReinspect(series, true)).toBe(false); expect(reviewOpen(series)).toBe(false);
    expect(guidance(at("blocked", "something_new")).next).not.toBe("");
  });
  it("says why a media check or an inspection did not pass, from fixed codes only", () => {
    const inspection = (action: string, detail: string | null) => ({ at: "2026-10-11T12:00:00.000Z", action, detail, revision: 3 });
    const proof = (reasons: string[]) => ({ mediaKey: "d".repeat(64), container: false, gateway: true, browser: false, accessible: true, checkedAt: "2026-10-11T12:00:00.000Z", reference: "bounded", mediaClass: "unverified", reasons });
    // Confirmed, never checked: the worker ran without a reader.
    const unchecked = { ...at("awaiting_media"), lastInspection: inspection("media_inspected", "no_evidence") };
    expect(guidance(unchecked)).toMatchObject({ group: "action", label: "Media check needed" }); expect(guidance(unchecked).next).toContain("without its media reader");
    expect(guidance({ ...at("awaiting_media"), lastInspection: null }).next).toContain("Run the media check");
    // A database that would replace the confirmation on re-inspection never promises otherwise.
    expect(guidance(at("awaiting_media"))).toMatchObject({ group: "progress", label: "Waiting for media check" }); expect(guidance(at("awaiting_media")).next).not.toContain("Run");
    // Checked and outside the policy: the reason is the evidence's, and the confirmation is kept.
    const mkv = { ...at("awaiting_media"), evidence: proof(["container_not_mp4"]), lastInspection: inspection("media_inspected", "unverified:unverified") };
    expect(guidance(mkv)).toMatchObject({ group: "action", label: "Media check failed" }); expect(guidance(mkv).next).toContain("not an MP4"); expect(guidance(mkv).next).toContain("stay confirmed");
    expect(lastFailure({ ...mkv, evidence: proof(["h264_profile_high_10"]) })).toBe("Not accepted by the media policy: h264 profile high 10.");
    // Retrying by itself, then exhausted: the worker's own code.
    const retrying = { ...at("failed"), attempts: 2, lastInspection: inspection("inspection_failed", "media_read_flood_wait") };
    expect(guidance(retrying)).toMatchObject({ group: "progress", label: "Inspection retrying" }); expect(guidance(retrying).next).toContain("Attempt 2 of 5 failed. Telegram asked the media reader to slow down.");
    const exhausted = { ...at("blocked", "inspection_attempts_exhausted"), lastInspection: inspection("inspection_failed", "media_read_mtproto_disconnected") };
    expect(guidance(exhausted).next).toBe("Automatic inspection failed five times. The media reader lost its connection to Telegram. Reinspect to run it again.");
    // A verified file, or a candidate that never failed, reports nothing.
    expect(lastFailure({ ...at("awaiting_rights"), evidence: { ...proof([]), container: true, browser: true }, lastInspection: inspection("media_inspected", "verified") })).toBeNull();
    expect(lastFailure(at("awaiting_identity"))).toBeNull();
    expect(reasonText("some_new_code")).toBe("Not accepted by the media policy: some new code.");
  });
  it("reviewer decisions are open only while a candidate is neither finished nor being inspected", () => {
    for (const status of ["detected", "failed", "awaiting_identity", "awaiting_media", "approved"] as const) expect(reviewOpen(at(status))).toBe(true);
    for (const status of ["inspecting", "publishing", "published", "duplicate", "rejected", "blocked"] as const) expect(reviewOpen(at(status))).toBe(false);
  });
  it("maps the database gates onto the four steps and keeps the rest visible", () => {
    const gates = ["candidate_closed", "identity_unconfirmed", "vj_unresolved", "media_verification_required", "rights_clearance_required"];
    expect(steps(gates).map((step) => step.done)).toEqual([false, false, false, false]);
    expect(steps(["rights_clearance_required"]).map((step) => step.done)).toEqual([true, true, true, false]);
    expect(otherGates(gates)).toEqual(["candidate_closed"]); expect(otherGates(["duplicate_media", "vj_unresolved"])).toEqual(["duplicate_media"]);
  });
  it("turns an action result into one message, and nothing for an unknown code", () => {
    expect(resultMessage("confirmed")).toEqual({ notice: expect.stringContaining("confirmed") });
    expect(resultMessage("no_rights_permission").error).toContain("rights permission");
    expect(resultMessage("stale").notice).toBeUndefined();
    expect(resultMessage(undefined)).toEqual({}); expect(resultMessage("<script>")).toEqual({});
  });
});
