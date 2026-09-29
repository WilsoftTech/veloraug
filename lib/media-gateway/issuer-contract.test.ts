import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { createLogger } from "@/lib/media-gateway/log";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { FakeReader, FakeResolver, PUBLISHED_VERSION } from "@/lib/media-gateway/test-fakes";
import { parseMediaTokenSecret } from "@/lib/media-gateway/token";
import { issueStreamCapability, streamCapabilityConfigFromEnv, STREAM_TOKEN_TTL_SECONDS } from "@/lib/playback/stream-capability";

/**
 * E2 contract: a capability from the application's issuer, presented to the
 * real gateway HTTP core. Both sides read the same MEDIA_GATEWAY_TOKEN_SECRET
 * value. Requests carry no Range header, so an accepted capability stops at
 * `range_required` after authorization and publication have both passed, and
 * the reader (Telegram) is never called.
 */
const SECRET_TEXT = randomBytes(32).toString("base64url");
const SUBJECT = "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e";
let clockMs = Date.now();
let server: Server;
let base = "";
let reader: FakeReader;
let resolver: FakeResolver;
const logs: string[] = [];

beforeAll(async () => {
  reader = new FakeReader();
  resolver = new FakeResolver();
  const gateway = createMediaGateway({
    limits: DEFAULT_LIMITS,
    tokenSecret: parseMediaTokenSecret(SECRET_TEXT)!,
    resolver,
    reader,
    logger: createLogger((line) => logs.push(line)),
    now: () => clockMs,
  });
  server = createServer(gateway.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function issue(movieVersionId = PUBLISHED_VERSION) {
  // The issuer points at the gateway under test; loopback HTTP is allowed outside production.
  const config = streamCapabilityConfigFromEnv({ NODE_ENV: "test", MEDIA_GATEWAY_TOKEN_SECRET: SECRET_TEXT, MEDIA_GATEWAY_PUBLIC_ORIGIN: base });
  return issueStreamCapability(config, { movieVersionId, subject: SUBJECT }, clockMs);
}

async function get(url: string) {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

const withPath = (streamUrl: string, path: string) => {
  const url = new URL(streamUrl);
  url.pathname = path;
  return url.toString();
};

describe("issued stream capability against the real gateway", () => {
  it("is accepted for its version and stream: it reaches publication, with no media read", async () => {
    const resolverCalls = resolver.calls;
    const res = await get(issue().streamUrl);
    expect(res).toEqual({ status: 400, body: JSON.stringify({ error: "range_required" }) });
    expect(resolver.calls).toBe(resolverCalls + 1);
    expect(reader.calls).toBe(0);
  });

  it("cannot authorize the download route", async () => {
    const res = await get(withPath(issue().streamUrl, `/v1/movie-versions/${PUBLISHED_VERSION}/download`));
    expect(res).toEqual({ status: 403, body: JSON.stringify({ error: "forbidden" }) });
  });

  it("cannot authorize another version", async () => {
    const res = await get(withPath(issue().streamUrl, "/v1/movie-versions/2/stream"));
    expect(res).toEqual({ status: 403, body: JSON.stringify({ error: "forbidden" }) });
  });

  it("is refused once expired", async () => {
    const { streamUrl } = issue();
    const issuedAt = clockMs;
    try {
      clockMs = issuedAt + (STREAM_TOKEN_TTL_SECONDS - 1) * 1000;
      expect((await get(streamUrl)).status).toBe(400); // still valid: range_required
      clockMs = issuedAt + STREAM_TOKEN_TTL_SECONDS * 1000;
      expect(await get(streamUrl)).toEqual({ status: 401, body: JSON.stringify({ error: "authorization_expired" }) });
    } finally {
      clockMs = issuedAt;
    }
  });

  it("is refused after tampering", async () => {
    const url = new URL(issue().streamUrl);
    const [prefix, body, mac] = url.searchParams.get("token")!.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    url.searchParams.set("token", `${prefix}.${Buffer.from(JSON.stringify({ ...claims, exp: (claims.exp as number) + 3600 })).toString("base64url")}.${mac}`);
    expect(await get(url.toString())).toEqual({ status: 401, body: JSON.stringify({ error: "unauthorized" }) });
  });

  it("gets no bytes for a version the catalogue does not publish (the gateway's own check)", async () => {
    expect(await get(issue(99).streamUrl)).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
  });

  it("left no capability in the gateway's logs, and read no media", () => {
    expect(reader.calls).toBe(0);
    expect(logs.join("\n")).not.toMatch(/v1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    expect(logs.join("\n")).not.toContain(SECRET_TEXT);
  });
});
