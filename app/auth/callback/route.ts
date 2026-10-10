import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/utils";

/**
 * Landing point of the email-confirmation link. Exchanges the one-time `code`
 * for a session cookie, then sends the user on to a same-origin path.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const response = NextResponse.redirect(new URL(next, origin));
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("cache-control", "private, no-store");
      return response;
    }
    console.warn("Email confirmation code exchange failed.", error.code ?? error.status);
  }
  const recovery = next.split("?")[0] === "/reset-password";
  const response = NextResponse.redirect(new URL(recovery ? "/forgot-password?error=recovery" : "/sign-in?error=callback", origin));
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cache-control", "private, no-store");
  return response;
}
