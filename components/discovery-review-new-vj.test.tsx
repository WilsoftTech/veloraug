import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewDetail, ReviewQueue } from "./discovery-review";
import { toCandidate } from "@/lib/discovery/database";
import { awaitingNewVj, detectedNewVj, newVjsDetected, proposedVjName } from "@/lib/discovery/guidance";

/**
 * A VJ read from an upload that is not in the VJ list: detected, offered to a reviewer with the publish
 * permission under a name they can correct, and attached by reading the waiting uploads again.
 */
const vjs = [{ id: 1, slug: "vj-ice-p", name: "VJ Ice P", isActive: true }, { id: 2, slug: "vj-junior", name: "VJ JUNIOR", isActive: true }];
let message = 10;
const candidate = (extra: Record<string, unknown> = {}) => toCandidate({
  key: String(message).padStart(64, "a"), revision: 2, status: "needs_review", error_code: null, attempts: 1, first_seen: "2026-10-18T09:00:00+00:00", last_seen: "2026-10-18T09:05:00+00:00",
  event: { event_id: "b".repeat(64), payload_digest: "c".repeat(64), chat_id: -1001111111111, message_id: message++, update_id: 100, kind: "channel_post", observed_at: 1760000000,
    file_unique_id: "AgADuniq10", size: 1048576, name: "RETURN TO THE JURASSIC.VJ SHIELD.mp4", mime: "video/mp4", caption: null },
  identity: `tg1-${"d".repeat(64)}`, identity_state: "unknown", title: "RETURN TO THE JURASSIC", year: null, vj_text: "SHIELD", warnings: [], tmdb_id: null,
  vj: null, relation: "unknown", movie_id: null, duplicate_of: null, snapshot: null,
  evidence: null, rights: null, approval: null, publication: null, blockers: ["identity_unconfirmed", "vj_unresolved", "media_verification_required", "rights_clearance_required"],
  inspection: { retry_at: null, last: null }, ...extra });
const known = (extra: Record<string, unknown> = {}) => candidate({ identity_state: "confirmed", vj_text: "Ice P", tmdb_id: 9800001, vj: { id: 1, slug: "vj-ice-p", name: "VJ Ice P", active: true }, ...extra });
const publish = { review: true, rights: true, publish: true };
const noop = async () => {};

describe("new VJ detection", () => {
  it("proposes the house form of the name, keeping a mixed-case word as typed", () => {
    expect(proposedVjName("SHIELD")).toBe("VJ Shield");
    expect(proposedVjName("emmy")).toBe("VJ Emmy");
    expect(proposedVjName("VJ_DJ_McKay")).toBe("VJ Dj McKay");
    expect(proposedVjName("ICE P")).toBe("VJ Ice P");
    expect(proposedVjName("VJ")).toBe("");
  });
  it("a VJ name that matches no VJ is new; an exact or listener-prefix match, a missing name or a closed candidate is not", () => {
    expect(detectedNewVj(candidate(), vjs)).toBe("VJ Shield");
    expect(detectedNewVj(candidate({ vj_text: "ICEP" }), vjs)).toBeNull();
    expect(detectedNewVj(candidate({ vj_text: "ICE P NO'S" }), vjs)).toBeNull();
    expect(detectedNewVj(candidate({ vj_text: null }), vjs)).toBeNull();
    expect(detectedNewVj(known(), vjs)).toBeNull();
    expect(detectedNewVj(candidate({ status: "rejected" }), vjs)).toBeNull();
  });
  it("lists each new name once with its upload count", () => {
    const found = newVjsDetected([candidate(), candidate({ vj_text: "Shield" }), candidate({ vj_text: "EMMY" }), known()], vjs);
    expect(found).toEqual([{ name: "VJ Shield", count: 2 }, { name: "VJ Emmy", count: 1 }]);
  });
  it("after adding, rereads only open unconfirmed uploads without a VJ or a rights decision that name it", () => {
    const shield = { id: 9, slug: "vj-shield", name: "VJ Shield", isActive: true };
    const waiting = candidate();
    const cleared = candidate({ rights: { reference: null, cleared_by: "00000000-0000-4000-8000-0000000000a1", cleared_at: "2026-10-18T09:03:00+00:00", revision: 2 } });
    const other = candidate({ vj_text: "EMMY" });
    const confirmed = candidate({ identity_state: "confirmed", tmdb_id: 9800001 });
    expect(awaitingNewVj([waiting, cleared, other, confirmed, known()], shield).map((item) => item.id)).toEqual([waiting.id]);
  });
});

describe("new VJ on the reviewer screens", () => {
  const detail = (item: ReturnType<typeof candidate>, capabilities: typeof publish | null, withAdd = true) =>
    renderToStaticMarkup(<ReviewDetail candidate={item} vjs={vjs} action={noop} mode="database" capabilities={capabilities} addVj={withAdd ? noop : undefined} />);
  it("the review screen offers the corrected name and one Add VJ and assign button, returning to this candidate", () => {
    const item = candidate();
    const form = detail(item, publish).split('id="new-vj-heading"')[1].split("</section>")[0];
    for (const text of ["New VJ detected", "The post names “SHIELD”", 'name="name"', 'value="VJ Shield"', "Add VJ and assign", `name="id" value="${item.id}"`]) expect(form, text).toContain(text);
    expect(form).not.toContain('name="revision"');
  });
  it("without the publish permission the reason is shown instead of the form", () => {
    const html = detail(candidate(), { review: true, rights: false, publish: false });
    expect(html).toContain("New VJ detected");
    expect(html).toContain("Adding a VJ needs the publish permission");
    expect(html).not.toContain("Add VJ and assign");
  });
  it("nothing is offered for a known VJ, in fixture mode, or without the add command", () => {
    expect(detail(known(), publish)).not.toContain("New VJ detected");
    expect(detail(candidate(), publish, false)).not.toContain("New VJ detected");
    expect(renderToStaticMarkup(<ReviewDetail candidate={candidate()} vjs={vjs} action={noop} addVj={noop} />)).not.toContain("New VJ detected");
  });
  it("the queue lists each new VJ with its upload count; nothing when every VJ is known", () => {
    const queue = (items: ReturnType<typeof candidate>[]) => renderToStaticMarkup(<ReviewQueue candidates={items} search="" group="" mode="database" vjs={vjs} addVj={noop} canAddVj />);
    const html = queue([candidate(), candidate({ vj_text: "Shield" }), candidate({ vj_text: "EMMY" })]);
    for (const text of ["New VJs detected", 'value="VJ Shield"', "Read from 2 uploads.", 'value="VJ Emmy"', "Read from 1 upload."]) expect(html, text).toContain(text);
    expect(queue([known()])).not.toContain("New VJs detected");
  });
});
