import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import { canStreamEpisodeVersion, canStreamMovieVersion } from "@/lib/playback/entitlement";
import { prepareDownload } from "@/lib/playback/download";
import { requestStreamCapability } from "@/lib/playback/player";
import { streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";
import { createStreamTokenHandler, type StreamTokenDeps } from "@/lib/playback/stream-token";

const SECRET_TEXT = randomBytes(32).toString("base64url");
const config = streamCapabilityConfigFromEnv({ NODE_ENV: "production", MEDIA_GATEWAY_TOKEN_SECRET: SECRET_TEXT, MEDIA_GATEWAY_PUBLIC_ORIGIN: "https://media.velora.example" });
const USER: CurrentUser = { id: "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e", email: "viewer@example.com" };
const EPISODE = 7;
const NOW_MS = 1_790_000_000_000;

function handlerWith(options: { episodes?: boolean; operation?: "stream" | "download"; playable?: number[] } = {}) {
  const calls = { movie: 0, episode: 0 };
  const playable = new Set(options.playable ?? [EPISODE]);
  const entitled = { async hasStreamingEntitlement() { return true; } };
  const deps: StreamTokenDeps = {
    accountsConfigured: () => true,
    currentUser: async () => USER,
    decide: (user, id) => canStreamMovieVersion(user, id, { ...entitled, async isMovieVersionPlayable(version) { calls.movie += 1; return playable.has(version); } }),
    ...(options.episodes === false ? {} : {
      decideEpisode: (user: CurrentUser | null, id: number) => canStreamEpisodeVersion(user, id, { ...entitled, async isEpisodeVersionPlayable(version) { calls.episode += 1; return playable.has(version); } }),
    }),
    loadConfig: () => config,
    now: () => NOW_MS,
    downloadsEnabled: () => true,
  };
  return { calls, handler: createStreamTokenHandler(deps, options.operation ?? "stream") };
}

const post = (body: unknown) => new Request("https://velora.example/api/media/stream-token", {
  method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
});

describe("episode stream capabilities", () => {
  it("issue an episode capability for the episode route only", async () => {
    const { calls, handler } = handlerWith();
    const response = await handler(post({ episodeVersionId: EPISODE }));
    expect(response.status).toBe(200);
    const { streamUrl } = (await response.json()) as { streamUrl: string };
    const url = new URL(streamUrl);
    expect(url.pathname).toBe(`/v1/episode-versions/${EPISODE}/stream`);
    const token = url.searchParams.get("token") ?? "";
    const expected = { op: "stream" as const, movieVersionId: EPISODE, nowSeconds: NOW_MS / 1000, maxLifetimeSeconds: 600 };
    expect(verifyMediaToken(config.secret, token, { ...expected, target: "episode" }).ok).toBe(true);
    expect(verifyMediaToken(config.secret, token, expected)).toEqual({ ok: false, code: "wrong_version" });
    expect(calls).toEqual({ movie: 0, episode: 1 });
  });

  it("answer an unpublished episode with the same 404 as any unavailable version", async () => {
    const { handler } = handlerWith({ playable: [] });
    expect((await handler(post({ episodeVersionId: EPISODE }))).status).toBe(404);
  });

  it("are refused where the episode decision is not wired in, for streams and downloads", async () => {
    expect((await handlerWith({ episodes: false }).handler(post({ episodeVersionId: EPISODE }))).status).toBe(400);
    const download = handlerWith({ episodes: false, operation: "download" });
    expect((await download.handler(post({ episodeVersionId: EPISODE }))).status).toBe(400);
    expect(download.calls).toEqual({ movie: 0, episode: 0 });
  });

  it("issue an episode download capability for the episode download route only", async () => {
    const { calls, handler } = handlerWith({ operation: "download" });
    const response = await handler(post({ episodeVersionId: EPISODE }));
    expect(response.status).toBe(200);
    const { downloadUrl } = (await response.json()) as { downloadUrl: string };
    const url = new URL(downloadUrl);
    expect(url.pathname).toBe(`/v1/episode-versions/${EPISODE}/download`);
    const token = url.searchParams.get("token") ?? "";
    const expected = { op: "download" as const, movieVersionId: EPISODE, nowSeconds: NOW_MS / 1000, maxLifetimeSeconds: 600 };
    expect(verifyMediaToken(config.secret, token, { ...expected, target: "episode" }).ok).toBe(true);
    expect(verifyMediaToken(config.secret, token, expected)).toEqual({ ok: false, code: "wrong_version" });
    expect(calls).toEqual({ movie: 0, episode: 1 });
    expect((await handlerWith({ operation: "download", playable: [] }).handler(post({ episodeVersionId: EPISODE }))).status).toBe(404);
  });

  it("refuse a body naming both kinds or anything else", async () => {
    const { calls, handler } = handlerWith();
    expect((await handler(post({ episodeVersionId: EPISODE, movieVersionId: EPISODE }))).status).toBe(400);
    expect((await handler(post({ episodeVersionId: EPISODE, extra: 1 }))).status).toBe(400);
    expect((await handler(post({ episodeVersionId: 0 }))).status).toBe(400);
    expect(calls).toEqual({ movie: 0, episode: 0 });
  });

  it("decide in the same order as movies: signed-out callers never reach the catalogue", async () => {
    const isEpisodeVersionPlayable = vi.fn(async () => true);
    const decision = await canStreamEpisodeVersion(null, EPISODE, { hasStreamingEntitlement: async () => true, isEpisodeVersionPlayable });
    expect(decision).toEqual({ allowed: false, reason: "authentication_required" });
    expect(isEpisodeVersionPlayable).not.toHaveBeenCalled();
    expect(await canStreamEpisodeVersion(USER, "7", { hasStreamingEntitlement: async () => true, isEpisodeVersionPlayable })).toEqual({ allowed: false, reason: "invalid_version" });
  });
});

describe("player capability request", () => {
  it("names the episode version for an episode, and the movie version otherwise", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ streamUrl: "https://media.velora.example/v1/x", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }) as typeof fetch;
    await requestStreamCapability(EPISODE, fetchImpl, undefined, Date.now, "episode");
    await requestStreamCapability(EPISODE, fetchImpl);
    expect(bodies).toEqual([{ episodeVersionId: EPISODE }, { movieVersionId: EPISODE }]);
  });
});

describe("episode downloads in the browser", () => {
  const issued = (path: string) => Response.json({ downloadUrl: `https://media.velora.example${path}?token=opaque`, expiresAt: "2026-10-11T12:10:00Z" }, { headers: { date: "Sun, 11 Oct 2026 12:00:00 GMT" } });
  const probe = () => new Response("x", { status: 206, headers: { "content-type": "video/mp4", "content-length": "1", "content-range": "bytes 0-0/100" } });

  it("asks for the episode version and accepts only the episode download route", async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => issued(`/v1/episode-versions/${EPISODE}/download`));
    fetcher.mockResolvedValueOnce(issued(`/v1/episode-versions/${EPISODE}/download`)).mockResolvedValueOnce(probe());
    expect(await prepareDownload(EPISODE, fetcher, undefined, undefined, "episode")).toMatchObject({ ok: true, format: "MP4" });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ episodeVersionId: EPISODE }) });

    // A movie route for the same number is never followed.
    const movieRoute = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => issued(`/v1/movie-versions/${EPISODE}/download`));
    expect(await prepareDownload(EPISODE, movieRoute, undefined, undefined, "episode")).toEqual({ ok: false, failure: "temporarily_unavailable" });
    expect(movieRoute).toHaveBeenCalledTimes(1);
  });
});
