import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ seriesQueue: vi.fn(), capabilities: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/lib/discovery/runtime", () => ({ requireReviewAdmin: mocks.requireAdmin, reviewMode: () => "database", databaseReviewClient: async () => mocks }));
vi.mock("@/lib/artwork-storage", () => ({ postersConfigured: () => true }));
vi.mock("@/app/admin/series/actions", () => ({ seriesFileAction: async () => {}, saveSeriesDetails: async () => ({}) }));
import AdminSeriesPage from "@/app/admin/series/page";
import { DiscoveryStoreError } from "@/lib/discovery/database";
import { seriesItemStage, type SeriesReviewItem } from "@/lib/series-review";

const base: SeriesReviewItem = {
  media_id: 7, post: 60, file_name: "Heros Eo1 Ice P.mp4", file_size_bytes: 270_000_000, mime_type: "video/mp4", received_at: "2026-11-20T19:23:11Z",
  verification: null, job: null, revision: 0, series_id: null, season_number: null, episode_number: null, episode_title: null, episode_overview: null,
  vj_id: null, rights_cleared: false, published_at: null, episode_version_id: null,
};
const verified = { scope: "whole_file", integrity: "verified", streaming: "verified", publishable: true, reasons: [], checked_at: "2026-11-20T20:00:00Z" };
const series = { id: 3, slug: "heroes-2024", publication_status: "draft" as const, updated_at: "2026-11-20T19:30:00Z", manual: true,
  metadata: { title: "Heroes", original_title: null, overview: "Manual.", first_air_date: "2024-03-01", poster_path: null, backdrop_path: null, genres: ["Drama"] } };
const render = async (params = {}) => renderToStaticMarkup(await AdminSeriesPage({ searchParams: Promise.resolve(params) }));

describe("series review stages", () => {
  it("names the next step for each file", () => {
    expect(seriesItemStage(base)).toBe("unassigned");
    expect(seriesItemStage({ ...base, series_id: 3, season_number: 1, episode_number: 1, vj_id: 1, revision: 1 })).toBe("awaiting_rights");
    expect(seriesItemStage({ ...base, series_id: 3, season_number: 1, episode_number: 1, vj_id: 1, revision: 1, rights_cleared: true, job: { attempts: 1, error: null, running: true, completed: false } })).toBe("checking");
    expect(seriesItemStage({ ...base, series_id: 3, season_number: 1, episode_number: 1, vj_id: 1, revision: 1, rights_cleared: true, verification: verified })).toBe("ready");
    expect(seriesItemStage({ ...base, verification: { ...verified, publishable: false, integrity: "failed", reasons: ["decode_corrupt_data"] } })).toBe("check_failed");
    expect(seriesItemStage({ ...base, published_at: "2026-11-20T21:00:00Z", episode_version_id: 9 })).toBe("published");
  });
});

describe("admin series page", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.seriesQueue.mockResolvedValue({ items: [base], series: [series], vjs: [{ id: 1, name: "VJ Ice P" }] });
    mocks.capabilities.mockResolvedValue({ review: true, rights: false, publish: false });
  });

  it("authorizes before reading and lists the waiting files with their next step", async () => {
    const html = await render();
    expect(mocks.requireAdmin.mock.invocationCallOrder[0]).toBeLessThan(mocks.seriesQueue.mock.invocationCallOrder[0]);
    expect(html).toContain("Heros Eo1 Ice P.mp4");
    expect(html).toContain("Needs series and episode");
    expect(html).toContain("VJ Ice P");
    expect(html).toContain("Add a series TMDB doesn&#x27;t have");
    expect(html).toContain("Heroes");
  });

  it("disables the steps the account has no permission for", async () => {
    mocks.seriesQueue.mockResolvedValue({ items: [{ ...base, series_id: 3, season_number: 1, episode_number: 1, vj_id: 1, revision: 1 }], series: [series], vjs: [{ id: 1, name: "VJ Ice P" }] });
    const html = await render();
    expect(html).toMatch(/<button[^>]*value="clear_rights"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*value="publish"[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*value="assign"[^>]*disabled=""/);
  });

  it("explains a missing database update and a refusal without listing files", async () => {
    mocks.seriesQueue.mockResolvedValue(null);
    expect(await render()).toContain("waiting for its database update");
    mocks.seriesQueue.mockRejectedValue(new DiscoveryStoreError("review_not_authorized"));
    const refused = await render();
    expect(refused).toContain("Series review unavailable");
    expect(refused).not.toContain("Heros Eo1");
  });

  it("shows the outcome of the last action", async () => {
    expect(await render({ result: "not_verified" })).toContain("The media check has not passed for this file yet.");
  });
});
