import { getAuthedClient } from "@/lib/auth";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import { downloadsEnabled, streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";
import { createStreamTokenHandler } from "@/lib/playback/stream-token";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/** Capability metadata only. Original media bytes go directly through the gateway. */
export const POST = createStreamTokenHandler({
  accountsConfigured: isSupabaseConfigured,
  currentUser: async () => {
    const session = await getAuthedClient();
    if (!session) return null;
    // Download renewal verifies the current Auth user, not just cached JWT claims.
    const { data, error } = await session.supabase.auth.getUser();
    return !error && data.user?.id === session.user.id && !data.user.is_anonymous ? session.user : null;
  },
  decide: canStreamMovieVersion,
  loadConfig: () => streamCapabilityConfigFromEnv(),
  downloadsEnabled: () => downloadsEnabled(),
}, "download");
