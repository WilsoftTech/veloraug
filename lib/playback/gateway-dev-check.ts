import "server-only";
import { parseGatewayOrigin } from "@/lib/playback/stream-capability";

type Env = Record<string, string | undefined>;

/**
 * Development aid (E3.4): playback needs the media gateway, a separate service
 * that `npm run dev` does not start. When it is configured but not answering
 * its liveness route, this warns once with the configured origin, never a
 * secret. It never throws and never decides anything: the player reports the
 * same condition to viewers on its own.
 */
export async function warnIfGatewayDown(env: Env = process.env, fetchImpl: typeof fetch = fetch, warn: (message: string) => void = console.warn): Promise<boolean> {
  const origin = parseGatewayOrigin(env.MEDIA_GATEWAY_PUBLIC_ORIGIN, false);
  if (!origin) return false; // Playback is not configured; the stream-token endpoint reports that itself.
  try {
    const response = await fetchImpl(`${origin}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    if (response.ok) return false;
  } catch {
    // Not reachable: warn below.
  }
  warn(`Media gateway is not running at ${origin}: movies will not play. Start it with "npm run gateway:dev" (needs Docker Desktop).`);
  return true;
}
