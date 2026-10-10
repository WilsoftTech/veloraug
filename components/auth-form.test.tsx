import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/auth/actions", () => ({ signIn: vi.fn(), signUp: vi.fn(), requestPasswordReset: vi.fn(), resetPassword: vi.fn() }));
import { AuthForm } from "./auth-form";

describe("password recovery forms", () => {
  it("sign-in links to recovery while preserving the local return destination", () => {
    const html = renderToStaticMarkup(<AuthForm mode="sign-in" next="/admin/discovery" />);
    expect(html).toContain('href="/forgot-password?next=%2Fadmin%2Fdiscovery"');
    expect(html).toContain("Forgot password?");
  });
  it("recovery collects only an email, with accessible labels and pending-capable submit", () => {
    const html = renderToStaticMarkup(<AuthForm mode="forgot-password" next="/admin/discovery" />);
    expect(html).toContain('for="email"'); expect(html).toContain('type="email"');
    expect(html).not.toContain('type="password"'); expect(html).toContain("Send reset link");
  });
  it("password update collects two new passwords and never an email or account ID", () => {
    const html = renderToStaticMarkup(<AuthForm mode="reset-password" next="/admin/discovery" />);
    expect(html.match(/autocomplete="new-password"/gi)).toHaveLength(2);
    expect(html).toContain('for="confirmPassword"'); expect(html).not.toContain('type="email"');
    expect(html).not.toContain('name="user_id"'); expect(html).toContain("Update password");
  });
});
