import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), get: vi.fn(), revalidate: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/discovery/runtime", () => ({ requireReviewAdmin: mocks.guard, reviewMode: () => "database", databaseReviewClient: async () => ({ get: mocks.get }), offlineReviewRuntime: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import { reviewAction } from "@/app/admin/discovery/actions";
const form = () => { const value = new FormData(); value.set("command", "refresh"); value.set("id", "a".repeat(64)); value.set("revision", "3"); return value; };
afterEach(() => vi.resetAllMocks());
describe("authenticated publication cache coordination", () => {
  it("refreshes every public surface from authoritative state and safely repeats after failure", async () => {
    mocks.guard.mockResolvedValue({ id: "reviewer", admin: true });
    mocks.get.mockResolvedValue({ candidate: { publication: { movieSlug: "approved-movie-2025" } }, vjSlug: "vj-test" });
    mocks.revalidate.mockImplementationOnce(() => { throw new Error("cache unavailable"); });
    await reviewAction(form()); expect(mocks.redirect).toHaveBeenLastCalledWith(expect.stringContaining("result=blocked"));
    mocks.revalidate.mockClear(); await reviewAction(form()); await reviewAction(form());
    for (const path of ["/", "/movies", "/vjs", "/search", "/movies/approved-movie-2025", "/vjs/vj-test"]) expect(mocks.revalidate).toHaveBeenCalledWith(path);
    expect(mocks.get).toHaveBeenCalledTimes(3); expect(mocks.redirect).toHaveBeenLastCalledWith(expect.stringContaining("result=refreshed"));
  });
  it("denies unauthenticated invalidation and refuses an unpublished candidate", async () => {
    mocks.guard.mockRejectedValue(new Error("404")); await expect(reviewAction(form())).rejects.toThrow("404");
    expect(mocks.revalidate).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
    mocks.guard.mockResolvedValue({ id: "reviewer", admin: true }); mocks.get.mockResolvedValue({ candidate: { publication: null } });
    await reviewAction(form()); expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith("/admin/discovery");
    expect(mocks.redirect).toHaveBeenLastCalledWith(expect.stringContaining("result=blocked"));
  });
});
