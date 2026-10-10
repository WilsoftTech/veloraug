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
    const html = renderToStaticMarkup(<ReviewQueue candidates={[candidate]} search="" status="" />);
    expect(html).toContain("Awaiting verification"); expect(html).toContain("Awaiting clearance"); expect(html).toContain("md:grid-cols-2"); expect(html).toContain('for="q"');
    expect(renderToStaticMarkup(<ReviewQueue candidates={[candidate]} search="no-result" status="" />)).toContain("No review candidates");
  });
  it("detail names evidence, provenance and disabled production publishing", () => {
    const html = renderToStaticMarkup(<ReviewDetail candidate={candidate} vjs={fixture.vjs} action={async () => {}} error="Synthetic error" />);
    for (const text of ["role=\"alert\"", "No verification evidence", "No clearance; publication blocked", "Production publication is disabled", "Audit history", "revision", "Existing VJ", "md:grid-cols-3"]) expect(html).toContain(text);
    expect(html).not.toContain("file_id"); expect(html).not.toContain("synthetic-unused");
  });
  it("database mode shows authoritative gates and the psql owner command, never browser approval or publication", () => {
    const sql = "select catalogue_review.publish_channel_candidate('" + "a".repeat(64) + "', 3, '00000000-0000-4000-8000-0000000000a1');";
    const view = { ...candidate, status: "approved" as const, gates: [] as string[], evidence: { mediaKey: "d".repeat(64), container: true, gateway: true, browser: true, accessible: true, checkedAt: "2026-10-10T09:00:00.000Z", reference: "bounded_mtproto_v1: 3072 bytes read (bounded check, not full-file integrity)", mediaClass: "canonical", video: "h264", audio: "aac", reasons: [], bytesRead: 3072 } };
    const html = renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} mode="database" ownerCommand={{ kind: "publish", sql }} />);
    for (const text of ["Publication gates", "Every mandatory gate passes", "Publication command", "velora_review_service", "catalogue_review.publish_channel_candidate", "canonical", "not full-file integrity", "Record rights clearance"]) expect(html).toContain(text);
    expect(html).not.toContain("Approve local review"); expect(html).not.toContain("Prepare existing owner publication script"); expect(html).not.toContain("Refresh public pages");
    expect(html).not.toContain("bot-file"); expect(html).not.toContain("file_id");
    const blocked = renderToStaticMarkup(<ReviewDetail candidate={{ ...candidate, gates: ["rights_clearance_required"] }} vjs={fixture.vjs} action={async () => {}} mode="database" />);
    expect(blocked).toContain("rights clearance required"); expect(blocked).not.toContain("Publication command");
    const published = renderToStaticMarkup(<ReviewDetail candidate={{ ...view, status: "published", publication: { movieSlug: "example-movie-2024", versionId: 4 } }} vjs={fixture.vjs} action={async () => {}} mode="database" />);
    expect(published).toContain("Refresh public pages"); expect(published).toContain('href="/movies/example-movie-2024"');
    const queue = renderToStaticMarkup(<ReviewQueue candidates={[view]} search="" status="" mode="database" />);
    expect(queue).toContain("Movies channel"); expect(queue).not.toContain("fixture");
  });
  it("can export synthetic server markup for explicit offline responsive verification", () => {
    if (process.env.VELORA_E38_UI_PREVIEW !== "true") return;
    const directory = ".velora-ingest/e3.8"; mkdirSync(directory, { recursive: true });
    const view = { ...candidate, title: "Example Movie", snapshot: fixture.movies[0], choices: fixture.movies, vjText: "Test", year: 2024 };
    const parts = {
      queue: renderToStaticMarkup(<ReviewQueue candidates={[view]} search="" status="" />),
      detail: renderToStaticMarkup(<ReviewDetail candidate={view} vjs={fixture.vjs} action={async () => {}} />),
    };
    for (const [name, body] of Object.entries(parts)) writeFileSync(`${directory}/${name}.preview.html`, `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><body><main class="mx-auto max-w-6xl px-4 py-8 sm:px-6">${body}</main></body></html>`);
    expect(parts.detail).toContain("Example Movie");
  });
});
