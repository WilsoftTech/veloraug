import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "@/lib/media-gateway/errors";
import { DEFAULT_LIMITS, type GatewayLimits } from "@/lib/media-gateway/limits";
import { createLogger } from "@/lib/media-gateway/log";
import { createMediaGateway, type MediaGateway } from "@/lib/media-gateway/server";
import { FILE_SIZE, FakeReader, FakeResolver, PUBLISHED_VERSION, expectedBytes, publishedLocator } from "@/lib/media-gateway/test-fakes";
import { signMediaToken, type MediaOperation } from "@/lib/media-gateway/token";

const SECRET = new Uint8Array(32).fill(3);
const MIB = 1024 * 1024;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const token = (op: MediaOperation = "stream", movieVersionId = PUBLISHED_VERSION, ttlSeconds = 300, subject = "user-1") =>
  signMediaToken(SECRET, { op, movieVersionId, subject, ttlSeconds, nowSeconds: nowSeconds() });

interface Harness {
  base: string;
  reader: FakeReader;
  resolver: FakeResolver;
  logs: string[];
  gateway: MediaGateway;
  server: Server;
}
let current: Harness | null = null;

async function start(options: { limits?: Partial<GatewayLimits>; reader?: FakeReader; resolver?: FakeResolver } = {}): Promise<Harness> {
  const reader = options.reader ?? new FakeReader();
  const resolver = options.resolver ?? new FakeResolver();
  const logs: string[] = [];
  const gateway = createMediaGateway({
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    tokenSecret: SECRET,
    resolver,
    reader,
    logger: createLogger((line) => logs.push(line)),
  });
  const server = createServer(gateway.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  current = { base: `http://127.0.0.1:${port}`, reader, resolver, logs, gateway, server };
  return current;
}

afterEach(async () => {
  if (!current) return;
  current.server.closeAllConnections();
  await new Promise((resolve) => current!.server.close(resolve));
  current = null;
});

const streamUrl = (h: Harness, t: string | null = token(), version = PUBLISHED_VERSION, op: MediaOperation = "stream") =>
  `${h.base}/v1/movie-versions/${version}/${op}${t === null ? "" : `?token=${encodeURIComponent(t)}`}`;

async function get(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return { status: response.status, headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("media gateway HTTP: ranges", () => {
  it("serves a 206 with exact headers and bytes", async () => {
    const h = await start();
    const res = await get(streamUrl(h), { Range: "bytes=123456789-124505364" });
    expect(res.status).toBe(206);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-range")).toBe(`bytes 123456789-124505364/${FILE_SIZE}`);
    expect(res.headers.get("content-length")).toBe("1048576");
    expect(res.headers.get("content-type")).toBe("video/x-matroska");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.compare(Buffer.from(res.body), Buffer.from(expectedBytes(123_456_789, 1_048_576)))).toBe(0);
    expect(h.reader.calls).toBe(2);
  });

  it("serves the final 64 KiB via a suffix range", async () => {
    const h = await start();
    const res = await get(streamUrl(h), { Range: "bytes=-65536" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${FILE_SIZE - 65536}-${FILE_SIZE - 1}/${FILE_SIZE}`);
    expect(Buffer.compare(Buffer.from(res.body), Buffer.from(expectedBytes(FILE_SIZE - 65536, 65536)))).toBe(0);
  });

  it("bounds an open-ended request instead of serving the whole movie", async () => {
    const h = await start({ limits: { maxResponseBytes: 2 * MIB } });
    const res = await get(streamUrl(h), { Range: "bytes=0-" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${2 * MIB - 1}/${FILE_SIZE}`);
    expect(res.body.length).toBe(2 * MIB);
  });

  it("refuses a request without Range before touching Telegram", async () => {
    const h = await start();
    const res = await get(streamUrl(h));
    expect(res.status).toBe(400);
    expect(new TextDecoder().decode(res.body)).toBe('{"error":"range_required"}');
    expect(h.reader.calls).toBe(0);
  });

  it("answers 416 with Content-Range: bytes */size and no media read", async () => {
    const h = await start();
    const res = await get(streamUrl(h), { Range: `bytes=${FILE_SIZE}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1004462878");
    expect(h.reader.calls).toBe(0);
  });

  it("rejects malformed and multi-range headers", async () => {
    const h = await start();
    for (const range of ["bytes=5-1", "bytes=0-1,4-5", "pages=1-2"]) {
      expect((await get(streamUrl(h), { Range: range })).status).toBe(400);
    }
    expect(h.reader.calls).toBe(0);
  });
});

describe("media gateway HTTP: authorization and publication", () => {
  const denied = async (h: Harness, url: string, status: number, headers: Record<string, string> = { Range: "bytes=0-1023" }) => {
    const res = await get(url, headers);
    expect(res.status).toBe(status);
    return new TextDecoder().decode(res.body);
  };

  it("denies missing, malformed, forged and expired tokens before catalogue or Telegram work", async () => {
    const h = await start();
    await denied(h, streamUrl(h, null), 401);
    await denied(h, streamUrl(h, "v1.abc.def"), 401);
    await denied(h, streamUrl(h, signMediaToken(new Uint8Array(32).fill(9), { op: "stream", movieVersionId: 1, subject: "u", ttlSeconds: 60, nowSeconds: nowSeconds() })), 401);
    const expired = signMediaToken(SECRET, { op: "stream", movieVersionId: 1, subject: "u", ttlSeconds: 60, nowSeconds: nowSeconds() - 120 });
    expect(await denied(h, streamUrl(h, expired), 401)).toBe('{"error":"authorization_expired"}');
    expect(h.resolver.calls).toBe(0);
    expect(h.reader.calls).toBe(0);
  });

  it("denies a download token on the stream endpoint and a token for another version", async () => {
    const h = await start();
    await denied(h, streamUrl(h, token("download")), 403);
    await denied(h, streamUrl(h, token("stream", 1), 2), 403);
    expect(h.resolver.calls + h.reader.calls).toBe(0);
  });

  it("keeps the download endpoint closed: a stream token is forbidden, a download token gets no bytes", async () => {
    const h = await start();
    await denied(h, streamUrl(h, token("stream"), 1, "download"), 403);
    expect(await denied(h, streamUrl(h, token("download"), 1, "download"), 501)).toBe('{"error":"not_implemented"}');
    expect(h.resolver.calls + h.reader.calls).toBe(0);
  });

  it("accepts no Telegram identifiers or other parameters from the client", async () => {
    const h = await start();
    const t = encodeURIComponent(token());
    for (const query of [`token=${t}&chat_id=-1001`, `token=${t}&message_id=23`, `token=${t}&file_id=abc`, `token=${t}&token=${t}`]) {
      await denied(h, `${h.base}/v1/movie-versions/1/stream?${query}`, 400);
    }
    await denied(h, `${h.base}/v1/movie-versions/-1001/stream?token=${t}`, 404);
    await denied(h, `${h.base}/v1/telegram/23/stream?token=${t}`, 404);
    expect(h.resolver.calls + h.reader.calls).toBe(0);
  });

  it("accepts a bearer token, but not a bearer and query token together", async () => {
    const h = await start();
    const ok = await get(streamUrl(h, null), { Range: "bytes=0-1023", Authorization: `Bearer ${token()}` });
    expect(ok.status).toBe(206);
    await denied(h, streamUrl(h), 400, { Range: "bytes=0-1023", Authorization: `Bearer ${token()}` });
    await denied(h, streamUrl(h, null), 401, { Range: "bytes=0-1023", Authorization: "Basic abc" });
  });

  it("serves nothing for an unpublished or unknown version, even with a valid token", async () => {
    const h = await start();
    expect(await denied(h, streamUrl(h, token("stream", 2), 2), 404)).toBe('{"error":"not_found"}');
    expect(h.resolver.calls).toBe(1);
    expect(h.reader.calls).toBe(0);
  });

  it("rechecks publication on every request (a title unpublished after issuing stops at once)", async () => {
    const published = new Map([[1, publishedLocator]]);
    const h = await start({ resolver: new FakeResolver(published) });
    const t = token();
    expect((await get(streamUrl(h, t), { Range: "bytes=0-1023" })).status).toBe(206);
    published.delete(1);
    expect((await get(streamUrl(h, t), { Range: "bytes=0-1023" })).status).toBe(404);
    expect(h.reader.calls).toBe(1);
  });
});

describe("media gateway HTTP: failures and limits", () => {
  it("maps upstream failures to safe statuses without leaking their text", async () => {
    for (const [error, status] of [
      [new GatewayError("flood_wait", { retryAfterSeconds: 12 }), 503],
      [new GatewayError("mtproto_disconnected"), 503],
      [new GatewayError("document_resolution_failed"), 502],
      [new Error("FLOOD_WAIT_12 chat -1001234567890 access_hash 998877"), 500],
    ] as const) {
      const h = await start({ reader: new FakeReader({ failWith: error }) });
      const res = await get(streamUrl(h), { Range: "bytes=0-1023" });
      const body = new TextDecoder().decode(res.body);
      expect(res.status).toBe(status);
      expect(body).not.toMatch(/FLOOD|-100|998877|chat/);
      if (error instanceof GatewayError && error.code === "flood_wait") expect(res.headers.get("retry-after")).toBe("12");
      for (const line of h.logs) expect(line).not.toMatch(/-100|998877|FLOOD_WAIT_12/);
      current!.server.closeAllConnections();
      await new Promise((resolve) => current!.server.close(resolve));
      current = null;
    }
  });

  it("returns 503 when the catalogue cannot be read", async () => {
    const resolver = new FakeResolver();
    resolver.failure = new GatewayError("catalogue_unavailable");
    const h = await start({ resolver });
    expect((await get(streamUrl(h), { Range: "bytes=0-1" })).status).toBe(503);
    expect(h.reader.calls).toBe(0);
  });

  it("refuses streams while the reader is not ready, without resolving", async () => {
    const h = await start({ reader: new FakeReader({ ready: false }) });
    expect((await get(streamUrl(h), { Range: "bytes=0-1" })).status).toBe(503);
    expect(h.resolver.calls).toBe(0);
  });

  it("rate-limits repeated range requests per subject", async () => {
    const h = await start({ limits: { requestsPerSubjectPerWindow: 3 } });
    const t = token();
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await get(streamUrl(h, t), { Range: `bytes=${i}-${i}` })).status);
    expect(statuses).toEqual([206, 206, 206, 429, 429]);
    expect(h.reader.calls).toBe(3);
  });

  it("limits concurrent streams per subject", async () => {
    const h = await start({ reader: new FakeReader({ delayMs: 200 }), limits: { maxStreamsPerSubject: 1 } });
    const first = get(streamUrl(h), { Range: "bytes=0-1023" });
    await tick(30);
    expect((await get(streamUrl(h), { Range: "bytes=0-1023" })).status).toBe(429);
    expect((await first).status).toBe(206);
    expect((await get(streamUrl(h), { Range: "bytes=0-1023" })).status).toBe(206);
  });

  it("never logs the token or Telegram identifiers", async () => {
    const h = await start();
    const t = token();
    await get(streamUrl(h, t), { Range: "bytes=0-1023" });
    await get(streamUrl(h, "v1.bad.token"), { Range: "bytes=0-1023" });
    const joined = h.logs.join("\n");
    expect(joined).not.toContain(t.split(".")[1]);
    expect(joined).not.toContain("bad.token");
    expect(joined).not.toContain(publishedLocator.chatId);
    expect(joined).not.toContain(publishedLocator.fileUniqueId);
    const line = JSON.parse(h.logs[0]);
    expect(line).toMatchObject({ event: "media_request", movieVersionId: 1, status: 206, servedBytes: 1024, requestedBytes: 1024, outcome: "complete", rpcCount: 1 });
  });
});

describe("media gateway HTTP: disconnect and backpressure", () => {
  /** Opens a range request and returns the raw response without consuming its body. */
  const open = (url: string, range: string) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; response: import("node:http").IncomingMessage }>((resolve, reject) => {
      const req = httpRequest(url, { headers: { Range: range } }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, response }));
      req.on("error", reject);
      req.end();
    });

  it("stops scheduling reads once the client disconnects", async () => {
    const h = await start({ reader: new FakeReader({ delayMs: 40 }), limits: { maxResponseBytes: 16 * MIB } });
    const { status, response } = await open(streamUrl(h), "bytes=0-16777215");
    expect(status).toBe(206);
    await new Promise((resolve) => response.once("data", resolve));
    response.destroy();
    await tick(300);
    const callsAfter = h.reader.calls;
    await tick(300);
    expect(h.reader.calls).toBe(callsAfter); // nothing new scheduled after the disconnect
    expect(h.gateway.activeStreams).toBe(0);
    const line = h.logs.map((l) => JSON.parse(l)).find((l) => l.event === "media_request");
    expect(line).toMatchObject({ outcome: "client_closed", readsPlanned: 16 });
    // Reads already delivered before the server observes the close may schedule up to
    // readAhead more each; after the close nothing is scheduled (checked above).
    expect(line.readsIssued).toBeLessThan(line.readsPlanned / 2);
  });

  it("does not read ahead of a client that stops reading", async () => {
    const h = await start({ limits: { maxResponseBytes: 64 * MIB } });
    const { response } = await open(streamUrl(h), "bytes=0-67108863");
    response.pause();
    await tick(500);
    const calls = h.reader.calls;
    // Bounded by socket buffers plus read-ahead, far below the 64 reads the range needs.
    expect(calls).toBeLessThan(40);
    await tick(300);
    expect(h.reader.calls).toBe(calls);
    response.destroy();
  });
});

describe("media gateway HTTP: health and readiness", () => {
  it("reports liveness with no dependency calls and no identifiers", async () => {
    const h = await start();
    const res = await get(`${h.base}/healthz`);
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('{"status":"ok"}');
    expect(h.reader.calls + h.resolver.calls).toBe(0);
  });

  it("reports readiness from the reader and shutdown state", async () => {
    const reader = new FakeReader();
    const h = await start({ reader });
    expect((await get(`${h.base}/readyz`)).status).toBe(200);
    reader.options.ready = false;
    const notReady = await get(`${h.base}/readyz`);
    expect(notReady.status).toBe(503);
    expect(new TextDecoder().decode(notReady.body)).toBe('{"status":"not_ready","state":"connecting"}');
    reader.options.ready = true;
    h.gateway.beginShutdown();
    expect((await get(`${h.base}/readyz`)).status).toBe(503);
    expect((await get(streamUrl(h), { Range: "bytes=0-1" })).status).toBe(503);
    expect(reader.calls).toBe(0);
  });

  it("answers CORS preflight only for allow-listed origins, GET and the Range/Authorization headers", async () => {
    const reader = new FakeReader();
    const resolver = new FakeResolver();
    const logs: string[] = [];
    const gateway = createMediaGateway({ limits: DEFAULT_LIMITS, tokenSecret: SECRET, resolver, reader, logger: createLogger((l) => logs.push(l)), allowedOrigins: ["https://velora.example"] });
    const server = createServer(gateway.handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const preflight = (origin: string, headers = "range", method = "GET") =>
      fetch(`${base}/v1/movie-versions/1/stream`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers } });
    const ok = await preflight("https://velora.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://velora.example");
    expect(ok.headers.get("access-control-allow-headers")).toBe("Range, Authorization");
    expect((await preflight("https://evil.example")).status).toBe(405);
    expect((await preflight("https://velora.example", "range, x-telegram-message")).status).toBe(405);
    expect((await preflight("https://velora.example", "range", "POST")).status).toBe(405);
    const cors = await fetch(`${base}/v1/movie-versions/1/stream?token=${encodeURIComponent(token())}`, { headers: { Origin: "https://velora.example", Range: "bytes=-1024" } });
    expect(cors.status).toBe(206);
    expect(cors.headers.get("access-control-allow-origin")).toBe("https://velora.example");
    expect(cors.headers.get("access-control-expose-headers")).toContain("Content-Range");
    const other = await fetch(`${base}/v1/movie-versions/1/stream?token=${encodeURIComponent(token())}`, { headers: { Origin: "https://evil.example", Range: "bytes=0-1" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(resolver.calls).toBe(2); // the two GETs only; preflights never resolve
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("allows GET only", async () => {
    const h = await start();
    expect((await fetch(streamUrl(h), { method: "HEAD" })).status).toBe(405);
    expect((await fetch(`${h.base}/healthz`, { method: "POST" })).status).toBe(405);
  });
});
