/**
 * The gateway's closed error model (E1.2). Every failure becomes one internal
 * code; the browser only ever sees that code's fixed public status and body.
 * Raw Telegram/MTProto/database errors are classified at their adapter and
 * never serialized.
 */
export const GATEWAY_ERROR_CODES = [
  "authorization_missing",
  "authorization_invalid",
  "authorization_expired",
  "wrong_operation",
  "wrong_version",
  "version_unavailable",
  "invalid_request",
  "range_required",
  "invalid_range",
  "range_not_satisfiable",
  "rate_limited",
  "too_many_streams",
  "not_ready",
  "catalogue_unavailable",
  "telegram_unavailable",
  "flood_wait",
  "mtproto_disconnected",
  "document_resolution_failed",
  "upstream_timeout",
  "not_found",
  "method_not_allowed",
  "not_implemented",
  "internal_error",
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/** Public shape: an HTTP status and a stable, non-revealing error string. */
const PUBLIC: Record<GatewayErrorCode, { status: number; error: string }> = {
  authorization_missing: { status: 401, error: "unauthorized" },
  authorization_invalid: { status: 401, error: "unauthorized" },
  authorization_expired: { status: 401, error: "authorization_expired" },
  wrong_operation: { status: 403, error: "forbidden" },
  wrong_version: { status: 403, error: "forbidden" },
  // Unpublished, not ready, rights not cleared, inactive VJ, no media and
  // unknown ids are indistinguishable, so availability cannot be probed.
  version_unavailable: { status: 404, error: "not_found" },
  invalid_request: { status: 400, error: "invalid_request" },
  range_required: { status: 400, error: "range_required" },
  invalid_range: { status: 400, error: "invalid_range" },
  range_not_satisfiable: { status: 416, error: "range_not_satisfiable" },
  rate_limited: { status: 429, error: "rate_limited" },
  too_many_streams: { status: 429, error: "too_many_streams" },
  not_ready: { status: 503, error: "temporarily_unavailable" },
  catalogue_unavailable: { status: 503, error: "temporarily_unavailable" },
  telegram_unavailable: { status: 503, error: "temporarily_unavailable" },
  flood_wait: { status: 503, error: "temporarily_unavailable" },
  mtproto_disconnected: { status: 503, error: "temporarily_unavailable" },
  document_resolution_failed: { status: 502, error: "media_unavailable" },
  upstream_timeout: { status: 504, error: "upstream_timeout" },
  not_found: { status: 404, error: "not_found" },
  method_not_allowed: { status: 405, error: "method_not_allowed" },
  not_implemented: { status: 501, error: "not_implemented" },
  internal_error: { status: 500, error: "internal_error" },
};

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  /** Seconds a client should wait before retrying, when known (flood waits). */
  readonly retryAfterSeconds?: number;

  constructor(code: GatewayErrorCode, options?: { retryAfterSeconds?: number }) {
    // The message is the code alone, so a stray log of the error reveals nothing more.
    super(code);
    this.name = "GatewayError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

/** Anything that is not an explicitly classified GatewayError is an internal error. */
export const gatewayCodeOf = (error: unknown): GatewayErrorCode => (error instanceof GatewayError ? error.code : "internal_error");

export function publicError(code: GatewayErrorCode): { status: number; body: string } {
  const { status, error } = PUBLIC[code];
  return { status, body: JSON.stringify({ error }) };
}
