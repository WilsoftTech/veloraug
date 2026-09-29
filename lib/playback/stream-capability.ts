import "server-only";
import { parseMediaTokenSecret, signMediaToken } from "@/lib/media-gateway/token";

/**
 * Issues short-lived `stream` capabilities for the media gateway (E2), in the
 * gateway's own token format (lib/media-gateway/token.ts, shared HMAC key).
 * Only call this with an allowed decision from canStreamMovieVersion.
 *
 * Lifetime and renewal: a capability lasts 10 minutes. There is no refresh
 * token and an old capability cannot be exchanged for a new one. The player
 * asks the issuing endpoint again before `expiresAt`, and every request
 * re-reads the session, re-runs entitlement and re-checks the catalogue.
 * Revocation is therefore bounded by one lifetime, and the gateway rechecks
 * publication on every range request, so an unpublished version stops at once.
 *
 * Both variables are server-only and are never NEXT_PUBLIC_. Configuration
 * failures name the variable, never its value.
 */

export const STREAM_TOKEN_TTL_SECONDS = 600;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface StreamCapabilityConfig {
  secret: Uint8Array;
  /** The one gateway origin capabilities are issued for. Never taken from a request. */
  gatewayOrigin: string;
}

export interface StreamCapability {
  /** Gateway stream URL carrying the capability (media elements cannot send headers). */
  streamUrl: string;
  /** ISO 8601. Renew before this; the gateway refuses the capability from then on. */
  expiresAt: string;
}

export class StreamCapabilityConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`stream capability configuration invalid: ${variables.join(", ")}`);
    this.name = "StreamCapabilityConfigError";
    this.variables = variables;
  }
}

/**
 * A bare origin only: no path, query, fragment, credentials or explicit default
 * port. HTTPS always; plain HTTP only for a loopback gateway outside production
 * (local development and tests).
 */
export function parseGatewayOrigin(value: string | undefined, production: boolean): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin === "null" || url.origin !== value) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && !production && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

type Env = Record<string, string | undefined>;

export function streamCapabilityConfigFromEnv(env: Env = process.env): StreamCapabilityConfig {
  const secret = parseMediaTokenSecret(env.MEDIA_GATEWAY_TOKEN_SECRET);
  const gatewayOrigin = parseGatewayOrigin(env.MEDIA_GATEWAY_PUBLIC_ORIGIN, env.NODE_ENV === "production");
  const bad = [...(secret ? [] : ["MEDIA_GATEWAY_TOKEN_SECRET"]), ...(gatewayOrigin ? [] : ["MEDIA_GATEWAY_PUBLIC_ORIGIN"])];
  if (!secret || !gatewayOrigin) throw new StreamCapabilityConfigError(bad);
  return { secret, gatewayOrigin };
}

export function issueStreamCapability(config: StreamCapabilityConfig, grant: { movieVersionId: number; subject: string }, nowMs: number): StreamCapability {
  const nowSeconds = Math.floor(nowMs / 1000);
  const token = signMediaToken(config.secret, {
    op: "stream",
    movieVersionId: grant.movieVersionId,
    subject: grant.subject,
    ttlSeconds: STREAM_TOKEN_TTL_SECONDS,
    nowSeconds,
  });
  const url = new URL(`/v1/movie-versions/${grant.movieVersionId}/stream`, config.gatewayOrigin);
  url.searchParams.set("token", token);
  return { streamUrl: url.toString(), expiresAt: new Date((nowSeconds + STREAM_TOKEN_TTL_SECONDS) * 1000).toISOString() };
}
