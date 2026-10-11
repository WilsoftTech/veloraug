import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialInbox, receive } from "./events";
import { fixtureSchema } from "./fixtures";
import { canReinspect, guidance, inspectionExhausted, otherGates, resultMessage, reviewOpen, steps } from "./guidance";
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
