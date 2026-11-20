import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { createLogger } from "@/lib/media-gateway/log";
import type { CatalogueMediaResolver, MediaLocator } from "@/lib/media-gateway/ports";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { FakeReader, FakeResolver, PUBLISHED_VERSION, expectedBytes, publishedLocator } from "@/lib/media-gateway/test-fakes";
import { signMediaToken, verifyMediaToken } from "@/lib/media-gateway/token";

const SECRET = new Uint8Array(32).fill(5);
const now = () => Math.floor(Date.now() / 1000);
const EPISODE = 1;
const episodeLocator: MediaLocator = { ...publishedLocator, movieVersionId: EPISODE, chatId: "-1008888888888", messageId: 12, fileSize: 899_923_994, mimeType: "video/mp4" };

/** A resolver that also knows episodes; it counts both lookups separately. */
class EpisodeResolver extends FakeResolver {
  episodeCalls = 0;
  async resolveEpisodeVersion(id: number) {
    this.episodeCalls += 1;
    return id === EPISODE ? episodeLocator : null;
  }
}

const episodeToken = (id = EPISODE, op: "stream" | "download" = "stream") =>
  signMediaToken(SECRET, { op, movieVersionId: id, subject: "user-1", ttlSeconds: 300, nowSeconds: now(), target: "episode" });
const movieToken = (id = PUBLISHED_VERSION) => signMediaToken(SECRET, { op: "stream", movieVersionId: id, subject: "user-1", ttlSeconds: 300, nowSeconds: now() });
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;

describe("media tokens: episode capabilities", () => {
  it("carry `ev` instead of `mv`, and movie tokens are unchanged", () => {
    expect(Object.keys(claimsOf(episodeToken())).sort()).toEqual(["aud", "ev", "exp", "iat", "jti", "op", "sub"]);
    expect(Object.keys(claimsOf(movieToken())).sort()).toEqual(["aud", "exp", "iat", "jti", "mv", "op", "sub"]);
  });

  it("verify only for the same kind and number", () => {
    const expected = { op: "stream" as const, movieVersionId: EPISODE, nowSeconds: now(), maxLifetimeSeconds: 600 };
    expect(verifyMediaToken(SECRET, episodeToken(), { ...expected, target: "episode" }).ok).toBe(true);
    // Same number, other kind: never interchangeable.
    expect(verifyMediaToken(SECRET, episodeToken(), expected)).toEqual({ ok: false, code: "wrong_version" });
    expect(verifyMediaToken(SECRET, movieToken(EPISODE), { ...expected, target: "episode" })).toEqual({ ok: false, code: "wrong_version" });
    expect(verifyMediaToken(SECRET, episodeToken(2), { ...expected, target: "episode" })).toEqual({ ok: false, code: "wrong_version" });
  });

  it("are stream-only", () => {
    expect(() => episodeToken(EPISODE, "download")).toThrow("invalid operation");
  });
});

let server: Server | null = null;
async function start(resolver: CatalogueMediaResolver, reader = new FakeReader()) {
  const logs: string[] = [];
  const gateway = createMediaGateway({ limits: DEFAULT_LIMITS, tokenSecret: SECRET, resolver, reader, logger: createLogger((line) => logs.push(line)), downloadsEnabled: () => true });
  server = createServer(gateway.handle);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reader, logs };
}
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
  server = null;
});

describe("media gateway HTTP: episodes", () => {
  it("serves byte ranges of a published episode through the episode resolver", async () => {
    const resolver = new EpisodeResolver();
    const h = await start(resolver);
    const response = await fetch(`${h.base}/v1/episode-versions/${EPISODE}/stream?token=${episodeToken()}`, { headers: { Range: "bytes=0-1023" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-1023/${episodeLocator.fileSize}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expectedBytes(0, 1024));
    expect([resolver.episodeCalls, resolver.calls]).toEqual([1, 0]);
    expect(h.logs.some((line) => line.includes('"target":"episode"'))).toBe(true);
  });

  it("refuses a movie capability on the episode route, and the reverse, before any lookup", async () => {
    const resolver = new EpisodeResolver();
    const h = await start(resolver);
    expect((await fetch(`${h.base}/v1/episode-versions/${EPISODE}/stream?token=${movieToken(EPISODE)}`)).status).toBe(403);
    expect((await fetch(`${h.base}/v1/movie-versions/${EPISODE}/stream?token=${episodeToken()}`)).status).toBe(403);
    expect([resolver.episodeCalls, resolver.calls, h.reader.calls]).toEqual([0, 0, 0]);
  });

  it("has no episode download route", async () => {
    const resolver = new EpisodeResolver();
    const h = await start(resolver);
    expect((await fetch(`${h.base}/v1/episode-versions/${EPISODE}/download?token=${episodeToken()}`)).status).toBe(404);
    expect(resolver.episodeCalls).toBe(0);
  });

  it("answers an unpublished episode like any unavailable version", async () => {
    const resolver = new EpisodeResolver();
    const h = await start(resolver);
    expect((await fetch(`${h.base}/v1/episode-versions/2/stream?token=${episodeToken(2)}`)).status).toBe(404);
    expect(h.reader.calls).toBe(0);
  });

  it("is not ready for episodes on an adapter without the episode resolver", async () => {
    const resolver = new FakeResolver();
    const h = await start(resolver);
    expect((await fetch(`${h.base}/v1/episode-versions/${EPISODE}/stream?token=${episodeToken()}`)).status).toBe(503);
    expect([resolver.calls, h.reader.calls]).toEqual([0, 0]);
  });
});
