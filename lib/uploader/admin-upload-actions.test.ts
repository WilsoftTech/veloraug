import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), authed: vi.fn(), rpc: vi.fn(), redirect: vi.fn(), revalidate: vi.fn(), vjs: vi.fn() }));
vi.mock("@/lib/catalogue", () => ({ listVjs: mocks.vjs }));
vi.mock("@/lib/discovery/runtime", () => ({ requireReviewAdmin: mocks.requireAdmin, reviewMode: () => "database" }));
vi.mock("@/lib/auth", () => ({ getAuthedClient: mocks.authed }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { uploadClient } from "@/lib/uploader/admin-runtime";
import { createUploadAction, refreshUploadPagesAction } from "@/app/admin/uploads/actions";
import { emptyUploadMetadata } from "@/lib/uploader/admin-upload";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VELORA_ADMIN_UPLOADS_ENABLED", "true");
  mocks.authed.mockResolvedValue({ supabase: { rpc: mocks.rpc }, user: { id: "current-user" } });
});
describe("admin upload actions", () => {
  it("checks fresh admin authorization before obtaining the database client", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("not authorized"));
    await expect(uploadClient()).rejects.toThrow("not authorized");
    expect(mocks.authed).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("keeps the feature disabled by default", async () => {
    vi.stubEnv("VELORA_ADMIN_UPLOADS_ENABLED", "false");
    await expect(uploadClient()).rejects.toThrow("admin_uploads_disabled");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects oversized files before any RPC", async () => {
    const data = new FormData(); data.set("fileName","movie.mp4"); data.set("sizeBytes","2000000001");
    expect((await createUploadAction({ error: "" },data)).error).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  describe("public page refresh after publication", () => {
    const id = "00000000-0000-4000-8000-0000000000b1";
    const pipeline = { media_verified: true, telegram_status: "uploaded", rights_cleared: true, rights_rejected: false, rights_expires_at: "2027-01-01T00:00:00Z", rights_reference: "licence 1",
      approved: true, cleanup_state: "cleaned", cleanup_error: null, publication_slug: "uploaded-film-2025" as string | null, stored: true, audit: [] };
    const session = (stage: string, flow = pipeline) => ({ data: { id, source: "admin_upload", owner_id: "00000000-0000-4000-8000-0000000000a1", storage: "r2", file_name: "Uploaded.Film.2025.mp4", size_bytes: 100,
      stage, revision: 9, metadata: { ...emptyUploadMetadata, title: "Uploaded Film", year: 2025, vjId: 3 }, verified_sha256: "a".repeat(64), bytes_received: 100, error_code: null, retryable: false,
      created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", expires_at: "2026-10-18T00:00:00Z", pipeline: flow, inspection: null }, error: null });
    const form = () => { const data = new FormData(); data.set("id", id); return data; };
    const refreshed = () => mocks.revalidate.mock.calls.map(([path]) => path).filter((path) => path !== "/admin/uploads");

    it("refreshes every public page of the published movie, read back from the catalogue", async () => {
      mocks.rpc.mockResolvedValue(session("published")); mocks.vjs.mockResolvedValue([{ id: 2, slug: "vj-other" }, { id: 3, slug: "vj-test" }]);
      await refreshUploadPagesAction(form());
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("admin_upload_get", { p_id: id });
      expect(refreshed()).toEqual(["/", "/movies", "/vjs", "/search", "/movies/uploaded-film-2025", "/vjs/vj-test"]);
      expect(mocks.redirect).toHaveBeenLastCalledWith(`/admin/uploads/${id}?result=refreshed`);
    });
    it("refreshes nothing for a session that is not published and approved", async () => {
      mocks.vjs.mockResolvedValue([{ id: 3, slug: "vj-test" }]);
      for (const reply of [session("telegram_stored"), session("published", { ...pipeline, approved: false }), session("published", { ...pipeline, publication_slug: null })]) {
        mocks.rpc.mockResolvedValue(reply); await refreshUploadPagesAction(form());
        expect(mocks.redirect).toHaveBeenLastCalledWith(`/admin/uploads/${id}?result=blocked`);
      }
      expect(refreshed()).toEqual([]); expect(mocks.vjs).not.toHaveBeenCalled();
    });
    it("refreshes nothing without fresh admin authorization or for a session the database refuses", async () => {
      mocks.requireAdmin.mockRejectedValueOnce(new Error("not authorized"));
      await refreshUploadPagesAction(form());
      expect(mocks.rpc).not.toHaveBeenCalled();
      mocks.rpc.mockResolvedValue({ data: null, error: { message: "upload_not_found", code: "P0001" } });
      await refreshUploadPagesAction(form());
      expect(refreshed()).toEqual([]); expect(mocks.redirect).toHaveBeenLastCalledWith(`/admin/uploads/${id}?result=blocked`);
      await expect(refreshUploadPagesAction(new FormData())).rejects.toThrow();
    });
  });
  it("sanitizes database transport errors", async () => {
    mocks.rpc.mockRejectedValue(new Error("private connection credential"));
    const data = new FormData(); data.set("fileName","movie.mp4"); data.set("sizeBytes","100");
    const result = await createUploadAction({ error: "" },data);
    expect(result.error).not.toContain("credential");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
