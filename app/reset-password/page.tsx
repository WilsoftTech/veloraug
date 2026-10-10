import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { assertAccountsAvailable } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { firstParam, safeRedirectPath } from "@/lib/utils";

export const metadata: Metadata = { title: "New password", robots: { index: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";
export default async function ResetPassword({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  assertAccountsAvailable();
  const params = await searchParams;
  const next = safeRedirectPath(firstParam(params.next));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || data.user.is_anonymous) redirect(`/forgot-password?error=recovery&next=${encodeURIComponent(next)}`);
  return <AuthForm mode="reset-password" next={next} />;
}
