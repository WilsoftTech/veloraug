import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signMediaToken, verifyMediaToken, type MediaOperation } from "@/lib/media-gateway/token";

const SECRET = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(8);
const NOW = 1_800_000_000;
const expectFor = (op: MediaOperation = "stream", movieVersionId = 1, nowSeconds = NOW) => ({ op, movieVersionId, nowSeconds, maxLifetimeSeconds: 3600 });
const issue = (overrides: Partial<Parameters<typeof signMediaToken>[1]> = {}) =>
  signMediaToken(SECRET, { op: "stream", movieVersionId: 1, subject: "user-1", ttlSeconds: 600, nowSeconds: NOW, ...overrides });

/** Re-signs arbitrary claims with the real secret, to test claim validation behind a valid MAC. */
const forge = (claims: unknown, secret = SECRET) => {
  const body = `v1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const baseClaims = { aud: "velora-media-gateway", op: "stream", mv: 1, sub: "user-1", iat: NOW, exp: NOW + 600, jti: "abc" };

describe("media tokens", () => {
  it("round-trips a stream token for its version", () => {
    const result = verifyMediaToken(SECRET, issue(), expectFor());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toMatchObject({ op: "stream", mv: 1, sub: "user-1", exp: NOW + 600 });
  });

  it("reports a missing token", () => {
    expect(verifyMediaToken(SECRET, undefined, expectFor())).toEqual({ ok: false, code: "authorization_missing" });
    expect(verifyMediaToken(SECRET, "", expectFor())).toEqual({ ok: false, code: "authorization_missing" });
  });

  it("rejects a token signed with another secret", () => {
    const token = signMediaToken(OTHER, { op: "stream", movieVersionId: 1, subject: "u", ttlSeconds: 60, nowSeconds: NOW });
    expect(verifyMediaToken(SECRET, token, expectFor()).ok).toBe(false);
  });

  it("rejects any single-character change to body or signature", () => {
    const token = issue();
    for (const index of [4, 10, token.length - 3]) {
      const flipped = token.slice(0, index) + (token[index] === "A" ? "B" : "A") + token.slice(index + 1);
      expect(verifyMediaToken(SECRET, flipped, expectFor())).toEqual({ ok: false, code: "authorization_invalid" });
    }
  });

  it.each(["x", "v1.a", "v2.a.b", "v1.a.b.c", "v1.a+b.c", "v1..c", `v1.${"a".repeat(2000)}.b`])("rejects malformed %j", (token) => {
    expect(verifyMediaToken(SECRET, token, expectFor())).toEqual({ ok: false, code: "authorization_invalid" });
  });

  it("reports expiry at and after exp", () => {
    const token = issue({ ttlSeconds: 60 });
    expect(verifyMediaToken(SECRET, token, expectFor("stream", 1, NOW + 59)).ok).toBe(true);
    expect(verifyMediaToken(SECRET, token, expectFor("stream", 1, NOW + 60))).toEqual({ ok: false, code: "authorization_expired" });
  });

  it("refuses a lifetime above the configured cap even when unexpired", () => {
    const token = issue({ ttlSeconds: 3601 });
    expect(verifyMediaToken(SECRET, token, expectFor())).toEqual({ ok: false, code: "authorization_invalid" });
  });

  it("refuses a token issued in the future beyond clock skew", () => {
    const token = forge({ ...baseClaims, iat: NOW + 120, exp: NOW + 600 });
    expect(verifyMediaToken(SECRET, token, expectFor())).toEqual({ ok: false, code: "authorization_invalid" });
  });

  it("does not let a stream token authorize download, or the reverse", () => {
    expect(verifyMediaToken(SECRET, issue(), expectFor("download"))).toEqual({ ok: false, code: "wrong_operation" });
    expect(verifyMediaToken(SECRET, issue({ op: "download" }), expectFor("stream"))).toEqual({ ok: false, code: "wrong_operation" });
  });

  it("binds a token to exactly one movie version", () => {
    expect(verifyMediaToken(SECRET, issue(), expectFor("stream", 2))).toEqual({ ok: false, code: "wrong_version" });
  });

  it.each([
    ["wrong audience", { ...baseClaims, aud: "other" }],
    ["unknown operation", { ...baseClaims, op: "upload" }],
    ["string version", { ...baseClaims, mv: "1" }],
    ["zero version", { ...baseClaims, mv: 0 }],
    ["fractional version", { ...baseClaims, mv: 1.5 }],
    ["exp before iat", { ...baseClaims, exp: NOW - 1 }],
    ["subject with spaces", { ...baseClaims, sub: "a b" }],
    ["extra claim", { ...baseClaims, chat_id: -1001234567890 }],
    ["Telegram message id claim", { ...baseClaims, message_id: 23 }],
    ["missing claim", { aud: baseClaims.aud, op: "stream", mv: 1, sub: "u", iat: NOW, exp: NOW + 60 }],
    ["array body", [baseClaims]],
  ])("rejects a validly signed token with %s", (_label, claims) => {
    expect(verifyMediaToken(SECRET, forge(claims), expectFor())).toEqual({ ok: false, code: "authorization_invalid" });
  });

  it("refuses short secrets on both sides", () => {
    expect(() => signMediaToken(new Uint8Array(16), { op: "stream", movieVersionId: 1, subject: "u", ttlSeconds: 1, nowSeconds: NOW })).toThrow();
    expect(() => verifyMediaToken(new Uint8Array(16), "x", expectFor())).toThrow();
  });

  it("refuses to sign invalid input", () => {
    expect(() => issue({ movieVersionId: 0 })).toThrow();
    expect(() => issue({ subject: "has space" })).toThrow();
    expect(() => issue({ ttlSeconds: 0 })).toThrow();
    expect(() => issue({ op: "upload" as MediaOperation })).toThrow();
  });
});
