import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), authed: vi.fn(), rpc: vi.fn(), redirect: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/discovery/runtime", () => ({ requireReviewAdmin: mocks.requireAdmin, reviewMode: () => "database" }));
vi.mock("@/lib/auth", () => ({ getAuthedClient: mocks.authed }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { uploadClient } from "@/lib/uploader/admin-runtime";
import { createUploadAction } from "@/app/admin/uploads/actions";

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
  it("sanitizes database transport errors", async () => {
    mocks.rpc.mockRejectedValue(new Error("private connection credential"));
    const data = new FormData(); data.set("fileName","movie.mp4"); data.set("sizeBytes","100");
    const result = await createUploadAction({ error: "" },data);
    expect(result.error).not.toContain("credential");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
