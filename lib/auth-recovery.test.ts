import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), request: vi.fn(), user: vi.fn(), update: vi.fn(), signOut: vi.fn(), exchange: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/auth", () => ({ getAuthedClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
import { requestPasswordReset, resetPassword } from "@/app/auth/actions";
import { GET } from "@/app/auth/callback/route";
const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3001"); vi.stubEnv("VELORA_PASSWORD_RECOVERY_ENABLED", "true");
  mocks.client.mockResolvedValue({ auth: { resetPasswordForEmail: mocks.request, getUser: mocks.user, updateUser: mocks.update, signOut: mocks.signOut, exchangeCodeForSession: mocks.exchange } });
  mocks.exchange.mockResolvedValue({ error: null });
  mocks.request.mockResolvedValue({ error: null }); mocks.user.mockResolvedValue({ data: { user: { id: "existing", is_anonymous: false } }, error: null });
  mocks.update.mockResolvedValue({ error: null }); mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("password recovery", () => {
  it("refuses sending until the trusted redirect is enabled", async () => {
    vi.stubEnv("VELORA_PASSWORD_RECOVERY_ENABLED", "false");
    expect(await requestPasswordReset({}, form({ email: "person@example.com" }))).toHaveProperty("message");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses the configured callback and rejects an external return destination", async () => {
    const result = await requestPasswordReset({}, form({ email: "person@example.com", next: "https://evil.example" }));
    expect(result.notice).toContain("If an account exists");
    const callback = new URL(mocks.request.mock.calls[0][1].redirectTo);
    expect(callback.origin).toBe("http://localhost:3001"); expect(callback.pathname).toBe("/auth/callback");
    expect(callback.searchParams.get("next")).toBe("/reset-password?next=%2F");
  });
  it("returns the same account-neutral response on provider failure and logs no secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = form({ email: "person@example.com" }); const normal = await requestPasswordReset({}, data);
    mocks.request.mockResolvedValue({ error: { code: "unexpected_failure", message: "private-token-value" } });
    expect(await requestPasswordReset({}, data)).toEqual(normal);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token-value"); warn.mockRestore();
  });
  it("reports blocked requests without claiming an email was sent or exposing account details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const code of ["over_email_send_rate_limit", "over_request_rate_limit"]) {
      mocks.request.mockResolvedValue({ error: { code, message: "private-token-value" } });
      const existing = await requestPasswordReset({}, form({ email: "person@example.com" }));
      const other = await requestPasswordReset({}, form({ email: "other@example.com" }));
      expect(existing).toEqual(other);
      expect(existing.message).toContain("did not send a reset email");
      expect(existing.notice).toBeUndefined();
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token-value");
    warn.mockRestore();
  });
  it("rejects invalid email before any auth operation", async () => {
    expect(await requestPasswordReset({}, form({ email: "invalid" }))).toHaveProperty("errors.email");
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("rejects insecure production redirect configuration", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await requestPasswordReset({}, form({ email: "person@example.com" }))).toHaveProperty("message");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("requires matching passwords and a fresh nonanonymous identity", async () => {
    expect(await resetPassword({}, form({ password: "synthetic-one", confirmPassword: "synthetic-two" }))).toHaveProperty("errors.confirmPassword");
    expect(mocks.client).not.toHaveBeenCalled();
    mocks.user.mockResolvedValue({ data: { user: null }, error: null });
    expect(await resetPassword({}, form({ password: "synthetic-one", confirmPassword: "synthetic-one" }))).toHaveProperty("message");
    mocks.user.mockResolvedValue({ data: { user: { is_anonymous: true } }, error: null });
    expect(await resetPassword({}, form({ password: "synthetic-one", confirmPassword: "synthetic-one" }))).toHaveProperty("message");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("updates only the authenticated user's password, signs out locally and returns to sign-in", async () => {
    await expect(resetPassword({}, form({ password: "synthetic-one", confirmPassword: "synthetic-one", next: "/admin/discovery", role: "admin", user_id: "someone-else" }))).rejects.toThrow("redirect:/sign-in?passwordReset=1&next=%2Fadmin%2Fdiscovery");
    expect(mocks.update).toHaveBeenCalledWith({ password: "synthetic-one" });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("does not claim success or sign out when the password update fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.update.mockResolvedValue({ error: { code: "weak_password", message: "private-value" } });
    expect(await resetPassword({}, form({ password: "synthetic-one", confirmPassword: "synthetic-one" }))).toEqual({ message: "Choose a stronger password." });
    expect(mocks.signOut).not.toHaveBeenCalled(); warn.mockRestore();
  });
  it("exchanges the PKCE recovery code and redirects without caching or leaking the callback as a referrer", async () => {
    const response = await GET(new Request("http://localhost:3001/auth/callback?code=synthetic-code&next=%2Freset-password"));
    expect(mocks.exchange).toHaveBeenCalledWith("synthetic-code");
    expect(response.headers.get("location")).toBe("http://localhost:3001/reset-password");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("an expired recovery code returns to recovery without exposing its error details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.exchange.mockResolvedValue({ error: { code: "otp_expired", message: "private-token-value" } });
    const response = await GET(new Request("http://localhost:3001/auth/callback?code=expired&next=%2Freset-password"));
    expect(response.headers.get("location")).toBe("http://localhost:3001/forgot-password?error=recovery");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token-value"); warn.mockRestore();
  });
  it("the existing confirmation callback still rejects external redirect destinations", async () => {
    const response = await GET(new Request("http://localhost:3001/auth/callback?code=synthetic&next=https%3A%2F%2Fevil.example"));
    expect(response.headers.get("location")).toBe("http://localhost:3001/");
  });
});
