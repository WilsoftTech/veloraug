import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewQueue, ReviewDetail } from "./discovery-review";
import { initialInbox, receive } from "@/lib/discovery/events";
import { fixtureSchema } from "@/lib/discovery/fixtures";

const fixture = fixtureSchema.parse(JSON.parse(readFileSync("scripts/discovery/example.json", "utf8")));
const inbox = initialInbox(fixture.channelId); receive(inbox, fixture.updates, "2026-10-09T12:00:00.000Z");
const candidate = Object.values(inbox.candidates)[0];
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
    };
    // VELORA_E38_UI_PREVIEW_CSS: the running dev server's stylesheet URL, so the previews carry the real tokens and utilities.
    const css = process.env.VELORA_E38_UI_PREVIEW_CSS ? `<link rel="stylesheet" href="${process.env.VELORA_E38_UI_PREVIEW_CSS}">` : "";
    for (const [name, body] of Object.entries(parts)) writeFileSync(`${directory}/${name}.preview.html`, `<!doctype html><html lang="en" data-theme="dark"><meta name="viewport" content="width=device-width, initial-scale=1">${css}<body><main class="page-container py-6 sm:py-8">${body}</main></body></html>`);
    expect(parts.detail).toContain("Example Movie");
  });
});
