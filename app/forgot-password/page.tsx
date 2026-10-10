import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { assertAccountsAvailable } from "@/lib/auth";
import { firstParam, safeRedirectPath } from "@/lib/utils";

export const metadata: Metadata = { title: "Reset password", robots: { index: false } };
export default async function ForgotPassword({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  assertAccountsAvailable();
  const params = await searchParams;
  return <AuthForm mode="forgot-password" next={safeRedirectPath(firstParam(params.next))} callbackFailed={params.error === "recovery"} />;
}
