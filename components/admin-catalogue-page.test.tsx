import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moviePage: vi.fn(), movies: vi.fn(), capabilities: vi.fn(), requireAdmin: vi.fn(), listVjs: vi.fn(), listMovies: vi.fn() }));
vi.mock("@/lib/discovery/runtime", () => ({ requireReviewAdmin: mocks.requireAdmin, reviewMode: () => "database", databaseReviewClient: async () => mocks }));
vi.mock("@/lib/catalogue", () => ({ listVjs: mocks.listVjs, listMovies: mocks.listMovies }));
vi.mock("@/app/admin/catalogue/actions", () => ({ addVjAction: async () => {}, movieAction: async () => {} }));
import AdminCataloguePage from "@/app/admin/catalogue/page";
import { DiscoveryStoreError } from "@/lib/discovery/database";

const movie = { id: 1, slug: "older-title", title: "Older Title", overview: null, release_year: 2001, poster_path: null, publication_status: "draft" as const, is_featured: false, published_at: null, versions: [] };
const render = async (params = {}) => renderToStaticMarkup(await AdminCataloguePage({ searchParams: Promise.resolve(params) }));

describe("admin catalogue page orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.moviePage.mockResolvedValue({ items: [movie], nextCursor: null });
    mocks.capabilities.mockResolvedValue({ publish: false });
    mocks.listVjs.mockResolvedValue([]);
    mocks.movies.mockResolvedValue([movie]);
  });
  it("authorizes before reading and passes URL filters to the full-catalogue query", async () => {
    const html = await render({ q: " Older Title ", status: "draft", cursor: "22" });
    expect(mocks.moviePage).toHaveBeenCalledWith({ q: "Older Title", status: "draft", cursor: "22" });
    expect(mocks.requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(mocks.moviePage.mock.invocationCallOrder[0]);
    expect(mocks.movies).not.toHaveBeenCalled();
    expect(html).toContain("Older Title");
    expect(html).toContain("Search movies");
  });
  it("labels the limited legacy fallback when the new command is missing", async () => {
    mocks.moviePage.mockResolvedValue(null);
    const html = await render();
    expect(mocks.movies).toHaveBeenCalledOnce();
    expect(html).toContain("Full-catalogue search is waiting for a database update");
    expect(html).toContain("Search loaded movies");
  });
  it("retains the published-only fallback on schemas without either admin read", async () => {
    mocks.moviePage.mockResolvedValue(null);
    mocks.movies.mockResolvedValue(null);
    mocks.listMovies.mockResolvedValue({ items: [] });
    const html = await render();
    expect(html).toContain("This is the published list only");
    expect(html).not.toContain("Add a VJ");
  });
  it("does not fall back or expose movies after authorization or transport failures", async () => {
    for (const code of ["review_not_authorized", "store_unavailable"]) {
      mocks.moviePage.mockRejectedValue(new DiscoveryStoreError(code));
      expect(await render()).toContain("Catalogue unavailable");
      expect(mocks.movies).not.toHaveBeenCalled();
      expect(mocks.listMovies).not.toHaveBeenCalled();
    }
    mocks.requireAdmin.mockRejectedValue(new Error("unauthorized"));
    mocks.moviePage.mockClear();
    await expect(render()).rejects.toThrow("unauthorized");
    expect(mocks.moviePage).not.toHaveBeenCalled();
  });
});
