import "server-only";
import type { CurrentUser } from "@/lib/auth";
import { WindowRateLimiter } from "@/lib/media-gateway/limits";
import type { StreamDecision } from "@/lib/playback/entitlement";
import { StreamCapabilityConfigError, issueStreamCapability, type StreamCapabilityConfig } from "@/lib/playback/stream-capability";
import { streamTokenRequestSchema } from "@/lib/schemas";

/**
 * POST /api/media/stream-token (E2). The browser sends `{ movieVersionId }` and
 * nothing else; the caller is the cookie session. An allowed request gets
 * `{ streamUrl, expiresAt }`. Renewal is the same request again, so every
 * renewal re-reads the session, re-runs entitlement and re-checks the catalogue.
 *
 * Every response is `no-store`. Errors are a fixed `{ error }` code. The
 * entitlement answer is checked before the catalogue, and every unplayable
 * version gets the same 404, so the endpoint cannot be used to enumerate the
 * catalogue. No token, user id or version id is logged.
 */

// A valid body is about 30 bytes.
const MAX_BODY_CHARS = 256;
/** Per signed-in user, per server instance. The gateway has its own limits on byte requests. */
export const STREAM_TOKEN_REQUESTS_PER_WINDOW = 30;
export const STREAM_TOKEN_WINDOW_MS = 60_000;

export type StreamTokenError =
  | "forbidden"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_request"
  | "authentication_required"
  | "not_entitled"
  | "unavailable"
  | "rate_limited"
  | "temporarily_unavailable";

const STATUS: Record<StreamTokenError, number> = {
  forbidden: 403,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_request: 400,
  authentication_required: 401,
  not_entitled: 403,
  unavailable: 404,
  rate_limited: 429,
  temporarily_unavailable: 503,
};

export interface StreamTokenDeps {
  accountsConfigured(): boolean;
  /** The verified session's user, or null when signed out. */
  currentUser(): Promise<CurrentUser | null>;
  decide(user: CurrentUser | null, movieVersionId: number): Promise<StreamDecision>;
  /** Throws StreamCapabilityConfigError when the issuer is not configured. */
  loadConfig(): StreamCapabilityConfig;
  now?: () => number;
  limiter?: WindowRateLimiter;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(error: StreamTokenError, extra: Record<string, string> = {}) {
  return Response.json({ error }, { status: STATUS[error], headers: { ...NO_STORE, ...extra } });
}

export function createStreamTokenHandler(deps: StreamTokenDeps) {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new WindowRateLimiter(STREAM_TOKEN_REQUESTS_PER_WINDOW, STREAM_TOKEN_WINDOW_MS);

  return async function POST(request: Request): Promise<Response> {
    // Route Handlers get no Origin check from Next.js (see app/api/search-events).
    // Cross-site pages cannot attach the SameSite=Lax session or send JSON without
    // a preflight this route never answers; these checks make that explicit.
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return fail("forbidden");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail("unsupported_media_type");

    let config: StreamCapabilityConfig;
    try {
      if (!deps.accountsConfigured()) return fail("temporarily_unavailable");
      config = deps.loadConfig();
    } catch (error) {
      if (!(error instanceof StreamCapabilityConfigError)) throw error;
      console.error("Stream capabilities are not configured:", error.variables.join(", "));
      return fail("temporarily_unavailable");
    }

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_CHARS) return fail("payload_too_large");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return fail("payload_too_large");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return fail("invalid_request");
    }
    const parsed = streamTokenRequestSchema.safeParse(payload);
    if (!parsed.success) return fail("invalid_request");

    const user = await deps.currentUser();
    if (user && !limiter.hit(user.id, now())) return fail("rate_limited", { "Retry-After": String(Math.ceil(STREAM_TOKEN_WINDOW_MS / 1000)) });

    let decision: StreamDecision;
    try {
      decision = await deps.decide(user, parsed.data.movieVersionId);
    } catch {
      // The catalogue read already logged its code; nothing here names the version.
      return fail("temporarily_unavailable");
    }
    if (!decision.allowed) return fail(decision.reason === "invalid_version" ? "invalid_request" : decision.reason);

    const capability = issueStreamCapability(config, decision, now());
    return Response.json(capability, { status: 200, headers: NO_STORE });
  };
}
