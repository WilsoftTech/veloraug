import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { assertAccountsAvailable } from "@/lib/auth";
import { firstParam, safeRedirectPath } from "@/lib/utils";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  assertAccountsAvailable();
  const params = await searchParams;
  return <AuthForm mode="sign-in" next={safeRedirectPath(firstParam(params.next))} callbackFailed={firstParam(params.error) === "callback"} passwordReset={firstParam(params.passwordReset) === "1"} />;
}
