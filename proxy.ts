import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { redirectWithSession, updateSession } from "@/lib/supabase/proxy";

/**
 * Runs only where the server reads the session (see the matcher), so the public
 * catalogue keeps its static/cached rendering and pays nothing for auth.
 */
export async function proxy(request: NextRequest) {
  const { response, signedIn } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (signedIn && (pathname === "/sign-in" || pathname === "/sign-up")) {
    return redirectWithSession(response, new URL("/", request.url));
  }
  // Unconfigured, the account routes 404 themselves (assertAccountsAvailable).
  if (!signedIn && pathname.startsWith("/account") && isSupabaseConfigured()) {
    return redirectWithSession(response, new URL("/sign-in?next=/account", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/account/:path*", "/sign-in", "/sign-up", "/forgot-password", "/reset-password"],
};
