import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthedClient: mocks.auth }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("404"); } }));
import { requireReviewAdmin, assertOfflineReviewMode } from "./runtime";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VELORA_DISCOVERY_MODE", "fixture");
  mocks.auth.mockResolvedValue({ user: { id: "a" }, supabase: { auth: { getUser: mocks.user } } });
  mocks.user.mockResolvedValue({ data: { user: { id: "a", app_metadata: { role: "admin" }, user_metadata: {} } }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("offline review server authorization", () => {
  it("requires a fresh authenticated admin record", async () => { expect(await requireReviewAdmin()).toEqual({ id: "a", admin: true }); expect(mocks.user).toHaveBeenCalledTimes(1); });
  it("denies ordinary and anonymous users, including forged user metadata", async () => {
    mocks.user.mockResolvedValue({ data: { user: { id: "a", app_metadata: {}, user_metadata: { role: "admin" } } }, error: null });
    await expect(requireReviewAdmin()).rejects.toThrow("404");
    mocks.user.mockResolvedValue({ data: { user: { id: "a", is_anonymous: true, app_metadata: { role: "admin" } } }, error: null });
    await expect(requireReviewAdmin()).rejects.toThrow("404");
    mocks.auth.mockResolvedValue(null); await expect(requireReviewAdmin()).rejects.toThrow("404");
  });
  it("denies stale identities and role revocation even when JWT previously identified an admin", async () => {
    mocks.user.mockResolvedValue({ data: { user: { id: "different", app_metadata: { role: "admin" } } }, error: null }); await expect(requireReviewAdmin()).rejects.toThrow("404");
    mocks.user.mockResolvedValue({ data: { user: null }, error: { message: "session revoked" } }); await expect(requireReviewAdmin()).rejects.toThrow("404");
  });
  it("production and absent explicit fixture mode stay closed", async () => {
    vi.stubEnv("NODE_ENV", "production"); await expect(requireReviewAdmin()).rejects.toThrow("404"); expect(mocks.auth).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VELORA_DISCOVERY_MODE", "live"); expect(() => assertOfflineReviewMode()).toThrow("offline_review_disabled");
  });
  it("every admin page and server action calls the authorization guard", () => {
    for (const path of ["app/admin/discovery/page.tsx", "app/admin/discovery/[id]/page.tsx", "app/admin/discovery/actions.ts"]) expect(readFileSync(path, "utf8")).toContain("await requireReviewAdmin()");
  });
  it("worker and runtime have no live Telegram or hosted publication adapter", () => {
    for (const path of ["lib/discovery/runtime.ts", "lib/discovery/worker.ts", "lib/discovery/fixtures.ts", "scripts/discovery/replay.mts"]) {
      const text = readFileSync(path, "utf8"); expect(text).not.toMatch(/getUpdates|setWebhook|sendDocument|REAL_TELEGRAM_UPLOADS_AUTHORIZED|DATABASE_URL|SERVICE_ROLE_KEY/);
    }
    const packageFile = JSON.parse(readFileSync("package.json", "utf8")); expect(packageFile.scripts.dev).toBe("next dev"); expect(packageFile.scripts.build).toBe("next build"); expect(packageFile.scripts["discovery:replay"]).not.toContain("--env-file");
  });
});
