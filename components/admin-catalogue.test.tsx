import { mkdirSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminCatalogue } from "./admin-catalogue";
import type { AdminMovie } from "@/lib/discovery/database";

const movie = (id: number, changes: Partial<AdminMovie> = {}): AdminMovie => ({
  id, slug: `example-movie-${id}`, title: `Example Movie ${id}`, overview: "A synthetic film.", release_year: 2024, poster_path: null,
  publication_status: "published", is_featured: false, published_at: "2026-10-01T00:00:00Z",
  versions: [{ id: id * 10, vj: "VJ Test", availability_status: "ready", rights_status: "cleared" }], ...changes });
const movies = [movie(1), movie(2, { is_featured: true }), movie(3, { publication_status: "archived" }), movie(4, { publication_status: "draft", versions: [] })];
const vjs = [{ id: 1, slug: "vj-test", name: "VJ Test" }];
const noop = async () => {};

describe("admin catalogue markup", () => {
  it("offers each movie only the changes its state allows", () => {
    const html = renderToStaticMarkup(<AdminCatalogue movies={movies} vjs={vjs} canManage movieAction={noop} addVjAction={noop} notice="Movie withdrawn." />);
    for (const text of ["Live", "Withdrawn", "Draft", "Featured", "Feature on home", "Stop featuring", "Withdraw from site", "Restore to site", "Edit title and description", "Add a VJ", "VJ Test", 'role="status"', 'href="/movies/example-movie-1"']) expect(html).toContain(text);
    // One withdraw per live movie, one restore for the withdrawn one, nothing for the draft.
    expect(html.match(/value="withdraw"/g)).toHaveLength(2); expect(html.match(/value="restore"/g)).toHaveLength(1);
    expect(html.match(/value="feature"/g)).toHaveLength(1); expect(html.match(/value="unfeature"/g)).toHaveLength(1);
    // A withdrawn movie has no public page to link to.
    expect(html).not.toContain('href="/movies/example-movie-3"'); expect(html).not.toContain('disabled=""');
  });
  it("is a read-only list for an account without the publish permission", () => {
    const html = renderToStaticMarkup(<AdminCatalogue movies={movies} vjs={vjs} canManage={false} movieAction={noop} addVjAction={noop} error="Not allowed." />);
    for (const text of ["Example Movie 1", "Withdrawn", "needs the publish permission", 'role="alert"']) expect(html).toContain(text);
    for (const text of ["<form", "Withdraw from site", "Add a VJ", "Edit title and description"]) expect(html).not.toContain(text);
  });
  it("shows empty states", () => {
    const html = renderToStaticMarkup(<AdminCatalogue movies={[]} vjs={[]} canManage movieAction={noop} addVjAction={noop} />);
    expect(html).toContain("No movies"); expect(html).toContain("No VJs");
  });
  it("can export synthetic server markup for explicit offline responsive verification", () => {
    if (process.env.VELORA_E38_UI_PREVIEW !== "true") return;
    const directory = ".velora-ingest/e3.8"; mkdirSync(directory, { recursive: true });
    const css = process.env.VELORA_E38_UI_PREVIEW_CSS ? `<link rel="stylesheet" href="${process.env.VELORA_E38_UI_PREVIEW_CSS}">` : "";
    const body = renderToStaticMarkup(<AdminCatalogue movies={movies} vjs={vjs} canManage movieAction={noop} addVjAction={noop} notice="Movie withdrawn. It is no longer on the site and cannot be played." />);
    writeFileSync(`${directory}/catalogue.preview.html`, `<!doctype html><html lang="en" data-theme="dark"><meta name="viewport" content="width=device-width, initial-scale=1">${css}<body><main class="page-container py-6 sm:py-8">${body}</main></body></html>`);
    expect(body).toContain("Catalogue");
  });
});
