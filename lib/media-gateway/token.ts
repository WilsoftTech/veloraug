/**
 * Media authorization tokens (E1.2). Server-only: the secret never leaves the
 * issuing server and the gateway.
 *
 * Format: `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`, where the MAC
 * covers `v1.<claims>`. The signature is checked in constant time before the
 * claims are parsed, so unauthenticated input is never interpreted.
 *
 * The claims name an internal Velora version and an operation, never a Telegram
 * identifier. A token authorizes exactly one operation (`stream` or `download`)
 * on exactly one movie version, for a short, capped lifetime. The gateway still
 * rechecks publication on every request, so an unpublished title stops being
 * served even while an old token is unexpired.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MEDIA_TOKEN_AUDIENCE = "velora-media-gateway";
export const MEDIA_OPERATIONS = ["stream", "download"] as const;
export type MediaOperation = (typeof MEDIA_OPERATIONS)[number];

export interface MediaTokenClaims {
  aud: typeof MEDIA_TOKEN_AUDIENCE;
  op: MediaOperation;
  /** Internal public.movie_versions id. */
  mv: number;
  /** Opaque authorization subject (a user or session id); only used for per-subject limits. */
  sub: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expires at, seconds since the epoch. */
  exp: number;
  /** Unique token id. */
  jti: string;
}

export type TokenFailure = "authorization_missing" | "authorization_invalid" | "authorization_expired" | "wrong_operation" | "wrong_version";

export type TokenResult = { ok: true; claims: MediaTokenClaims } | { ok: false; code: TokenFailure };

const PREFIX = "v1";
const MAX_TOKEN_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const SUBJECT = /^[A-Za-z0-9._:-]{1,128}$/;
const CLAIM_KEYS = ["aud", "exp", "iat", "jti", "mv", "op", "sub"];
/** Clock skew tolerated for `iat` issued slightly in the future. */
const MAX_CLOCK_SKEW_SECONDS = 30;
export const MIN_SECRET_BYTES = 32;

const mac = (secret: Uint8Array, signingInput: string) => createHmac("sha256", secret).update(signingInput).digest();

function assertSecret(secret: Uint8Array) {
  if (!(secret instanceof Uint8Array) || secret.length < MIN_SECRET_BYTES) throw new Error("media token secret too short");
}

export function signMediaToken(
  secret: Uint8Array,
  input: { op: MediaOperation; movieVersionId: number; subject: string; ttlSeconds: number; nowSeconds: number },
): string {
  assertSecret(secret);
  if (!MEDIA_OPERATIONS.includes(input.op)) throw new Error("invalid operation");
  if (!Number.isSafeInteger(input.movieVersionId) || input.movieVersionId <= 0) throw new Error("invalid movie version");
  if (!SUBJECT.test(input.subject)) throw new Error("invalid subject");
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) throw new Error("invalid ttl");
  const claims: MediaTokenClaims = {
    aud: MEDIA_TOKEN_AUDIENCE,
    op: input.op,
    mv: input.movieVersionId,
    sub: input.subject,
    iat: input.nowSeconds,
    exp: input.nowSeconds + input.ttlSeconds,
    jti: randomBytes(12).toString("base64url"),
  };
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

function parseClaims(json: string): MediaTokenClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null; // an authenticated but malformed body is treated as invalid, never repaired
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  if (Object.keys(claims).sort().join() !== CLAIM_KEYS.join()) return null;
  const { aud, op, mv, sub, iat, exp, jti } = claims;
  if (aud !== MEDIA_TOKEN_AUDIENCE) return null;
  if (typeof op !== "string" || !(MEDIA_OPERATIONS as readonly string[]).includes(op)) return null;
  if (typeof mv !== "number" || !Number.isSafeInteger(mv) || mv <= 0) return null;
  if (typeof sub !== "string" || !SUBJECT.test(sub)) return null;
  if (typeof iat !== "number" || !Number.isSafeInteger(iat) || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= iat) return null;
  if (typeof jti !== "string" || !SEGMENT.test(jti) || jti.length > 64) return null;
  return claims as unknown as MediaTokenClaims;
}

/**
 * Verifies a token for one operation on one movie version. Order matters: the
 * format and MAC first, then the claims, then time, then what the token is for.
 */
export function verifyMediaToken(
  secret: Uint8Array,
  token: string | undefined,
  expected: { op: MediaOperation; movieVersionId: number; nowSeconds: number; maxLifetimeSeconds: number },
): TokenResult {
  assertSecret(secret);
  if (token === undefined || token === "") return { ok: false, code: "authorization_missing" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, code: "authorization_invalid" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !SEGMENT.test(parts[1]) || !SEGMENT.test(parts[2])) {
    return { ok: false, code: "authorization_invalid" };
  }
  const given = Buffer.from(parts[2], "base64url");
  const wanted = mac(secret, `${parts[0]}.${parts[1]}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, code: "authorization_invalid" };

  const claims = parseClaims(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (!claims) return { ok: false, code: "authorization_invalid" };
  // A lifetime above the cap is refused outright: a leaked secret or issuer bug must not mint long-lived access.
  if (claims.exp - claims.iat > expected.maxLifetimeSeconds) return { ok: false, code: "authorization_invalid" };
  if (claims.iat > expected.nowSeconds + MAX_CLOCK_SKEW_SECONDS) return { ok: false, code: "authorization_invalid" };
  if (claims.exp <= expected.nowSeconds) return { ok: false, code: "authorization_expired" };
  if (claims.op !== expected.op) return { ok: false, code: "wrong_operation" };
  if (claims.mv !== expected.movieVersionId) return { ok: false, code: "wrong_version" };
  return { ok: true, claims };
}
