import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import {
  STREAM_TOKEN_TTL_SECONDS,
  StreamCapabilityConfigError,
  issueStreamCapability,
  parseGatewayOrigin,
  streamCapabilityConfigFromEnv,
  type StreamCapabilityConfig,
} from "@/lib/playback/stream-capability";

const SECRET_TEXT = randomBytes(32).toString("base64url");
const SUBJECT = "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e";
const NOW_MS = 1_790_000_000_000;
const NOW = NOW_MS / 1000;
const config: StreamCapabilityConfig = streamCapabilityConfigFromEnv({
  NODE_ENV: "production",
  MEDIA_GATEWAY_TOKEN_SECRET: SECRET_TEXT,
  MEDIA_GATEWAY_PUBLIC_ORIGIN: "https://media.velora.example",
});

const tokenOf = (streamUrl: string) => new URL(streamUrl).searchParams.get("token") ?? undefined;
const verify = (token: string | undefined, expected: Partial<{ op: "stream" | "download"; movieVersionId: number; nowSeconds: number }> = {}) =>
  verifyMediaToken(config.secret, token, {
    op: "stream",
    movieVersionId: 1,
    nowSeconds: NOW,
    maxLifetimeSeconds: DEFAULT_LIMITS.maxTokenLifetimeSeconds,
    ...expected,
  });

describe("issueStreamCapability", () => {
  const capability = issueStreamCapability(config, { movieVersionId: 1, subject: SUBJECT }, NOW_MS);

  it("points at the configured gateway's stream route for exactly that version, and nothing else", () => {
    const url = new URL(capability.streamUrl);
    expect(url.origin).toBe("https://media.velora.example");
    expect(url.pathname).toBe("/v1/movie-versions/1/stream");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    expect(Object.keys(capability).sort()).toEqual(["expiresAt", "streamUrl"]);
  });

  it("is accepted by the gateway verifier as a stream capability for that version, audience and user", () => {
    const result = verify(tokenOf(capability.streamUrl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({ aud: "velora-media-gateway", op: "stream", mv: 1, sub: SUBJECT, iat: NOW, exp: NOW + STREAM_TOKEN_TTL_SECONDS });
  });

  it("is short-lived: 10 minutes, well inside the gateway's lifetime cap", () => {
    expect(STREAM_TOKEN_TTL_SECONDS).toBe(600);
    expect(STREAM_TOKEN_TTL_SECONDS).toBeLessThan(DEFAULT_LIMITS.maxTokenLifetimeSeconds);
    expect(capability.expiresAt).toBe(new Date((NOW + 600) * 1000).toISOString());
  });

  it("expires: refused at and after expiresAt", () => {
    expect(verify(tokenOf(capability.streamUrl), { nowSeconds: NOW + 599 }).ok).toBe(true);
    expect(verify(tokenOf(capability.streamUrl), { nowSeconds: NOW + 600 })).toEqual({ ok: false, code: "authorization_expired" });
  });

  it("cannot authorize a download", () => {
    expect(verify(tokenOf(capability.streamUrl), { op: "download" })).toEqual({ ok: false, code: "wrong_operation" });
  });

  it("cannot authorize another version", () => {
    expect(verify(tokenOf(capability.streamUrl), { movieVersionId: 2 })).toEqual({ ok: false, code: "wrong_version" });
  });

  it("is refused after any tampering with its claims or signature", () => {
    const token = tokenOf(capability.streamUrl)!;
    const [prefix, body, mac] = token.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = (patch: Record<string, unknown>) => `${prefix}.${Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url")}.${mac}`;
    expect(verify(forged({ mv: 2 }), { movieVersionId: 2 })).toEqual({ ok: false, code: "authorization_invalid" });
    expect(verify(forged({ op: "download" }), { op: "download" })).toEqual({ ok: false, code: "authorization_invalid" });
    expect(verify(forged({ exp: NOW + 3000 }))).toEqual({ ok: false, code: "authorization_invalid" });
    const flipped = `${mac.slice(0, -2)}${mac.at(-2) === "A" ? "B" : "A"}${mac.at(-1)}`;
    expect(verify(`${prefix}.${body}.${flipped}`)).toEqual({ ok: false, code: "authorization_invalid" });
    const otherSecret = streamCapabilityConfigFromEnv({ MEDIA_GATEWAY_TOKEN_SECRET: randomBytes(32).toString("base64url"), MEDIA_GATEWAY_PUBLIC_ORIGIN: "https://media.velora.example" });
    expect(verify(tokenOf(issueStreamCapability(otherSecret, { movieVersionId: 1, subject: SUBJECT }, NOW_MS).streamUrl))).toEqual({ ok: false, code: "authorization_invalid" });
  });

  it("mints a fresh capability each time, never reusing an earlier one", () => {
    const again = issueStreamCapability(config, { movieVersionId: 1, subject: SUBJECT }, NOW_MS);
    expect(tokenOf(again.streamUrl)).not.toBe(tokenOf(capability.streamUrl));
  });
});

describe("parseGatewayOrigin", () => {
  it.each(["https://media.velora.example", "https://media.velora.example:8443", "https://127.0.0.1"])("accepts the HTTPS origin %s in production", (origin) => {
    expect(parseGatewayOrigin(origin, true)).toBe(origin);
  });

  it.each(["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"])("accepts loopback HTTP %s outside production only", (origin) => {
    expect(parseGatewayOrigin(origin, false)).toBe(origin);
    expect(parseGatewayOrigin(origin, true)).toBeNull();
  });

  it.each([
    undefined,
    "",
    "media.velora.example",
    "http://media.velora.example",
    "http://192.168.1.10:8787",
    "http://127.0.0.1.evil.example",
    "https://media.velora.example/",
    "https://media.velora.example/v1",
    "https://media.velora.example?next=https://evil.example",
    "https://media.velora.example#x",
    "https://user:pass@media.velora.example",
    "https://evil.example@media.velora.example",
    "https://MEDIA.velora.example",
    "https://media.velora.example:443",
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "ftp://media.velora.example",
    "//media.velora.example",
  ])("refuses %s", (origin) => {
    expect(parseGatewayOrigin(origin, false)).toBeNull();
    expect(parseGatewayOrigin(origin, true)).toBeNull();
  });
});

describe("streamCapabilityConfigFromEnv", () => {
  it("fails closed, naming the variables but never their values", () => {
    const cases: [Record<string, string | undefined>, string[]][] = [
      [{}, ["MEDIA_GATEWAY_TOKEN_SECRET", "MEDIA_GATEWAY_PUBLIC_ORIGIN"]],
      [{ MEDIA_GATEWAY_TOKEN_SECRET: "too-short", MEDIA_GATEWAY_PUBLIC_ORIGIN: "https://media.velora.example" }, ["MEDIA_GATEWAY_TOKEN_SECRET"]],
      [{ MEDIA_GATEWAY_TOKEN_SECRET: `${SECRET_TEXT}!`, MEDIA_GATEWAY_PUBLIC_ORIGIN: "https://media.velora.example" }, ["MEDIA_GATEWAY_TOKEN_SECRET"]],
      [{ NODE_ENV: "production", MEDIA_GATEWAY_TOKEN_SECRET: SECRET_TEXT, MEDIA_GATEWAY_PUBLIC_ORIGIN: "http://127.0.0.1:8787" }, ["MEDIA_GATEWAY_PUBLIC_ORIGIN"]],
    ];
    for (const [env, variables] of cases) {
      let caught: unknown;
      try {
        streamCapabilityConfigFromEnv(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StreamCapabilityConfigError);
      expect((caught as StreamCapabilityConfigError).variables).toEqual(variables);
      expect((caught as Error).message).not.toContain(SECRET_TEXT);
    }
  });

  it("allows a loopback HTTP gateway in development and test", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(streamCapabilityConfigFromEnv({ NODE_ENV, MEDIA_GATEWAY_TOKEN_SECRET: SECRET_TEXT, MEDIA_GATEWAY_PUBLIC_ORIGIN: "http://127.0.0.1:8787" }).gatewayOrigin).toBe("http://127.0.0.1:8787");
    }
  });
});
