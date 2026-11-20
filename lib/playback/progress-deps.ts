import "server-only";
import { getAuthedClient } from "@/lib/auth";
import { findMovieVersionTitles } from "@/lib/catalogue";
import { supabaseProgressStore, type ProgressDeps } from "@/lib/playback/progress-route";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/** Production wiring for the progress routes: the cookie session's client, the published catalogue. */
export const progressDeps: ProgressDeps = {
  accountsConfigured: isSupabaseConfigured,
  async session() {
    const authed = await getAuthedClient();
    return authed && { userId: authed.user.id, store: supabaseProgressStore(authed.supabase) };
  },
  describeVersions: findMovieVersionTitles,
};
