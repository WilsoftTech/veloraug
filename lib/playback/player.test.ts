import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import {
  INITIAL_PLAYER_STATE,
  MIN_RENEWAL_INTERVAL_MS,
  PLAYER_FAILURE_MESSAGES,
  RENEW_BEFORE_EXPIRY_MS,
  defaultVersion,
  detachMediaSource,
  failureFromMediaError,
  needsRenewal,
  playerReducer,
  renewalDelayMs,
  requestStreamCapability,
  type PlayerEvent,
  type PlayerState,
} from "@/lib/playback/player";
import { streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";
import { createStreamTokenHandler } from "@/lib/playback/stream-token";

const CAP = { streamUrl: "https://media.velora.example/v1/movie-versions/1/stream?token=v1.a.b", expiresAt: "2026-09-30T12:10:00.000Z", expiresAtMs: Date.parse("2026-09-30T12:10:00.000Z") };
const CAP2 = { streamUrl: "https://media.velora.example/v1/movie-versions/1/stream?token=v1.c.d", expiresAt: "2026-09-30T12:18:30.000Z", expiresAtMs: Date.parse("2026-09-30T12:18:30.000Z") };
const REPLY = { streamUrl: CAP.streamUrl, expiresAt: CAP.expiresAt };
const run = (events: PlayerEvent[], from: PlayerState = INITIAL_PLAYER_STATE) => events.reduce(playerReducer, from);

describe("playerReducer", () => {
  it("goes idle → requesting → loading → playing ↔ paused/buffering", () => {
    expect(run([{ type: "play_requested" }]).status).toBe("requesting");
    expect(run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }])).toEqual({ status: "loading", failure: null, capability: CAP });
    const playing = run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }, { type: "media_ready" }, { type: "media_playing" }]);
    expect(playing.status).toBe("playing");
    expect(playerReducer(playing, { type: "media_waiting" }).status).toBe("buffering");
    expect(playerReducer(playing, { type: "media_paused" }).status).toBe("paused");
  });

  it("stays loading while the first data is awaited, even if the element reports waiting", () => {
    expect(run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }, { type: "media_waiting" }]).status).toBe("loading");
  });

  it("ends in an error with no capability when access is denied, and never starts media", () => {
    const denied = run([{ type: "play_requested" }, { type: "capability_denied", failure: "auth_required" }]);
    expect(denied).toEqual({ status: "error", failure: "auth_required", capability: null });
    // Media events without a capability change nothing.
    expect(run([{ type: "media_playing" }, { type: "media_ready" }], denied)).toEqual(denied);
  });

  it("ignores a capability that arrives when nothing was requested (a late or stray reply)", () => {
    expect(run([{ type: "capability_granted", capability: CAP }])).toEqual(INITIAL_PLAYER_STATE);
    expect(run([{ type: "play_requested" }, { type: "closed" }, { type: "capability_granted", capability: CAP }])).toEqual(INITIAL_PLAYER_STATE);
  });

  it("replaces the capability on renewal, keeping playback state", () => {
    const playing = run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }, { type: "media_playing" }]);
    expect(playerReducer(playing, { type: "renewed", capability: CAP2 })).toEqual({ status: "playing", failure: null, capability: CAP2 });
    expect(playerReducer(INITIAL_PLAYER_STATE, { type: "renewed", capability: CAP2 })).toEqual(INITIAL_PLAYER_STATE);
  });

  it("drops the capability when renewal is denied mid-film", () => {
    const playing = run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }, { type: "media_playing" }]);
    expect(playerReducer(playing, { type: "capability_denied", failure: "unavailable" })).toEqual({ status: "error", failure: "unavailable", capability: null });
  });

  it("reports unsupported media and drops the capability", () => {
    const loading = run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }]);
    expect(playerReducer(loading, { type: "media_failed", failure: "unsupported" })).toEqual({ status: "error", failure: "unsupported", capability: null });
  });

  it("returns to idle on close", () => {
    const playing = run([{ type: "play_requested" }, { type: "capability_granted", capability: CAP }, { type: "media_playing" }]);
    expect(playerReducer(playing, { type: "closed" })).toEqual(INITIAL_PLAYER_STATE);
  });
});

describe("failureFromMediaError", () => {
  it("maps MediaError codes to safe states", () => {
    expect(failureFromMediaError(1)).toBeNull();
    expect(failureFromMediaError(2)).toBe("network");
    expect(failureFromMediaError(3)).toBe("unsupported");
    expect(failureFromMediaError(4)).toBe("unsupported");
    expect(failureFromMediaError(undefined)).toBe("playback_error");
  });

  it("has a plain message for every failure, with no internals", () => {
    for (const message of Object.values(PLAYER_FAILURE_MESSAGES)) expect(message).not.toMatch(/telegram|mtproto|gateway|token|database|sql|\d{3}/i);
  });
});

describe("renewal timing", () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");
  it("renews 90 s before a 10-minute capability expires", () => {
    expect(renewalDelayMs(CAP, now)).toBe(600_000 - RENEW_BEFORE_EXPIRY_MS);
    expect(RENEW_BEFORE_EXPIRY_MS).toBe(90_000);
  });

  it("never schedules a renewal in the past or in a tight loop", () => {
    expect(renewalDelayMs(CAP, now + 599_000)).toBe(5_000);
    expect(MIN_RENEWAL_INTERVAL_MS).toBe(30_000);
  });

  it("says a capability near or past expiry must be renewed before playing", () => {
    expect(needsRenewal(CAP, now)).toBe(false);
    expect(needsRenewal(CAP, now + 510_000)).toBe(true);
    expect(needsRenewal(CAP, now + 700_000)).toBe(true);
  });
});

describe("version selection", () => {
  it("plays the first catalogue version by default and has none without versions", () => {
    expect(defaultVersion([{ id: 1, label: "VJ Ice P" }])).toEqual({ id: 1, label: "VJ Ice P" });
    expect(defaultVersion([{ id: 7, label: "VJ Emmy" }, { id: 3, label: "VJ Junior" }])?.id).toBe(7);
    expect(defaultVersion([])).toBeNull();
  });
});

describe("detachMediaSource", () => {
  it("pauses, drops the source and reloads, which aborts the element's range requests", () => {
    const calls: string[] = [];
    detachMediaSource({ pause: () => calls.push("pause"), removeAttribute: (name: string) => calls.push(`remove ${name}`), load: () => calls.push("load") });
    expect(calls).toEqual(["pause", "remove src", "load"]);
  });
});

describe("requestStreamCapability", () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("POSTs only the version id, same-origin and uncached", async () => {
    const fetchImpl = vi.fn(async () => Response.json(REPLY)) as unknown as typeof fetch;
    expect(await requestStreamCapability(1, fetchImpl)).toEqual({ ok: true, capability: CAP });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/media/stream-token");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ movieVersionId: 1 }) });
  });

  it("measures expiry on this device's clock, so a skewed clock neither loops nor over-trusts", async () => {
    const serverNow = Date.parse("2026-09-30T12:00:00.000Z");
    const replyAt = (dateHeader: string | null) =>
      vi.fn(async () => new Response(JSON.stringify(REPLY), { status: 200, headers: dateHeader ? { date: dateHeader } : {} })) as unknown as typeof fetch;
    const serverDate = new Date(serverNow).toUTCString();
    for (const skewMs of [0, 520_000, -300_000, 3_600_000]) {
      const deviceNow = serverNow + skewMs;
      const result = await requestStreamCapability(1, replyAt(serverDate), undefined, () => deviceNow);
      if (!result.ok) throw new Error("expected a capability");
      expect(result.capability.expiresAtMs - deviceNow).toBe(600_000);
      expect(needsRenewal(result.capability, deviceNow)).toBe(false);
      expect(renewalDelayMs(result.capability, deviceNow)).toBe(510_000);
    }
    // Without a Date header the device clock is assumed to match the server's.
    const result = await requestStreamCapability(1, replyAt(null), undefined, () => serverNow + 520_000);
    expect(result.ok && result.capability.expiresAtMs).toBe(CAP.expiresAtMs);
  });
  it.each([
    [401, { error: "authentication_required" }, "auth_required"],
    [403, { error: "not_entitled" }, "not_entitled"],
    [403, { error: "forbidden" }, "temporarily_unavailable"],
    [404, { error: "unavailable" }, "unavailable"],
    [400, { error: "invalid_request" }, "temporarily_unavailable"],
    [429, { error: "rate_limited" }, "temporarily_unavailable"],
    [503, { error: "temporarily_unavailable" }, "temporarily_unavailable"],
    [500, "not json", "temporarily_unavailable"],
  ])("maps %i %j to %s", async (status, body, failure) => {
    expect(await requestStreamCapability(1, reply(status, body))).toEqual({ ok: false, failure });
  });

  it("refuses a malformed success body instead of loading it", async () => {
    for (const body of [{}, { streamUrl: "javascript:alert(1)", expiresAt: CAP.expiresAt }, { streamUrl: CAP.streamUrl, expiresAt: "never" }, null]) {
      expect(await requestStreamCapability(1, reply(200, body))).toEqual({ ok: false, failure: "temporarily_unavailable" });
    }
  });

  it("reports a network failure", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await requestStreamCapability(1, failing)).toEqual({ ok: false, failure: "network" });
  });
});

/**
 * The client against the real E2 handler: renewal is the same request, so it
 * re-reads the session and re-runs entitlement and eligibility every time.
 */
describe("capability renewal through the E2 issuer", () => {
  const USER: CurrentUser = { id: "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e", email: null };
  const config = streamCapabilityConfigFromEnv({ MEDIA_GATEWAY_TOKEN_SECRET: randomBytes(32).toString("base64url"), MEDIA_GATEWAY_PUBLIC_ORIGIN: "http://127.0.0.1:8787" });

  function world() {
    const state = { user: USER as CurrentUser | null, entitled: true, playable: true, now: Date.parse("2026-09-30T12:00:00.000Z") };
    const calls = { session: 0, entitlement: 0, catalogue: 0 };
    const handler = createStreamTokenHandler({
      accountsConfigured: () => true,
      currentUser: async () => {
        calls.session += 1;
        return state.user;
      },
      decide: (user, id) =>
        canStreamMovieVersion(user, id, {
          hasStreamingEntitlement: async () => {
            calls.entitlement += 1;
            return state.entitled;
          },
          isMovieVersionPlayable: async () => {
            calls.catalogue += 1;
            return state.playable;
          },
        }),
      loadConfig: () => config,
      now: () => state.now,
    });
    const fetchImpl = (async (input: string, init?: RequestInit) =>
      handler(new Request(`http://127.0.0.1:3000${input}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "sec-fetch-site": "same-origin" } }))) as unknown as typeof fetch;
    return { state, calls, fetchImpl };
  }

  it("renews with a fresh capability after re-checking session, entitlement and catalogue", async () => {
    const w = world();
    const first = await requestStreamCapability(1, w.fetchImpl);
    if (!first.ok) throw new Error("first grant failed");
    w.state.now += renewalDelayMs(first.capability, w.state.now);
    const second = await requestStreamCapability(1, w.fetchImpl);
    if (!second.ok) throw new Error("renewal failed");
    expect(second.capability.streamUrl).not.toBe(first.capability.streamUrl);
    expect(Date.parse(second.capability.expiresAt)).toBeGreaterThan(Date.parse(first.capability.expiresAt));
    expect(w.calls).toEqual({ session: 2, entitlement: 2, catalogue: 2 });
    const state = run([{ type: "play_requested" }, { type: "capability_granted", capability: first.capability }, { type: "media_playing" }, { type: "renewed", capability: second.capability }]);
    expect(state).toEqual({ status: "playing", failure: null, capability: second.capability });
  });

  it("stops playback when entitlement disappears before renewal", async () => {
    const w = world();
    const first = await requestStreamCapability(1, w.fetchImpl);
    w.state.entitled = false;
    const second = await requestStreamCapability(1, w.fetchImpl);
    expect(second).toEqual({ ok: false, failure: "not_entitled" });
    if (!first.ok || second.ok) return;
    expect(run([{ type: "play_requested" }, { type: "capability_granted", capability: first.capability }, { type: "media_playing" }, { type: "capability_denied", failure: second.failure }])).toEqual({ status: "error", failure: "not_entitled", capability: null });
  });

  it("stops playback when the movie stops being playable before renewal", async () => {
    const w = world();
    expect((await requestStreamCapability(1, w.fetchImpl)).ok).toBe(true);
    w.state.playable = false;
    expect(await requestStreamCapability(1, w.fetchImpl)).toEqual({ ok: false, failure: "unavailable" });
  });

  it("stops playback when the session ends before renewal", async () => {
    const w = world();
    expect((await requestStreamCapability(1, w.fetchImpl)).ok).toBe(true);
    w.state.user = null;
    expect(await requestStreamCapability(1, w.fetchImpl)).toEqual({ ok: false, failure: "auth_required" });
  });

  it("never reaches the catalogue or mints anything for a signed-out Play", async () => {
    const w = world();
    w.state.user = null;
    expect(await requestStreamCapability(1, w.fetchImpl)).toEqual({ ok: false, failure: "auth_required" });
    expect(w.calls.catalogue).toBe(0);
  });
});
