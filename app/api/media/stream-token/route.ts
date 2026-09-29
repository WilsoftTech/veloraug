import { getAuthedClient } from "@/lib/auth";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import { streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";
import { createStreamTokenHandler } from "@/lib/playback/stream-token";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Issues short-lived media-gateway stream capabilities (E2). The contract,
 * checks and error model are in lib/playback/stream-token.ts. Movie bytes never
 * pass through here: the response only points the player at the gateway.
 */
export const POST = createStreamTokenHandler({
  accountsConfigured: isSupabaseConfigured,
  currentUser: async () => (await getAuthedClient())?.user ?? null,
  decide: canStreamMovieVersion,
  loadConfig: () => streamCapabilityConfigFromEnv(),
});
