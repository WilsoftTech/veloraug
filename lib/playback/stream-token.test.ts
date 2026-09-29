import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import { StreamCapabilityConfigError, streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";
import { STREAM_TOKEN_REQUESTS_PER_WINDOW, createStreamTokenHandler, type StreamTokenDeps } from "@/lib/playback/stream-token";

const SECRET_TEXT = randomBytes(32).toString("base64url");
const GATEWAY = "https://media.velora.example";
const config = streamCapabilityConfigFromEnv({ NODE_ENV: "production", MEDIA_GATEWAY_TOKEN_SECRET: SECRET_TEXT, MEDIA_GATEWAY_PUBLIC_ORIGIN: GATEWAY });
const USER: CurrentUser = { id: "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e", email: "viewer@example.com" };
const ON_THE_HUNT = 1;
const NOW_MS = 1_790_000_000_000;

/** A mutable world: who is signed in, who is entitled, what the catalogue publishes. */
function world() {
  const state = { user: USER as CurrentUser | null, entitled: true, playable: new Set([ON_THE_HUNT]), catalogueFails: false, configured: true, accounts: true, now: NOW_MS };
  const calls = { session: 0, entitlement: 0, catalogue: 0 };
  const deps: StreamTokenDeps = {
    accountsConfigured: () => state.accounts,
    async currentUser() {
      calls.session += 1;
      return state.user;
    },
    decide: (user, id) =>
      canStreamMovieVersion(user, id, {
        async hasStreamingEntitlement() {
          calls.entitlement += 1;
          return state.entitled;
        },
        async isMovieVersionPlayable(versionId) {
          calls.catalogue += 1;
          if (state.catalogueFails) throw new Error("Could not load the catalogue.");
          return state.playable.has(versionId);
        },
      }),
    loadConfig: () => {
      if (!state.configured) throw new StreamCapabilityConfigError(["MEDIA_GATEWAY_TOKEN_SECRET"]);
      return config;
    },
    now: () => state.now,
  };
  return { state, calls, handler: createStreamTokenHandler(deps) };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://velora.example/api/media/stream-token", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: text,
  });
}

async function call(handler: (request: Request) => Promise<Response>, request: Request) {
  const response = await handler(request);
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: (await response.json()) as Record<string, unknown> };
}

const tokenOf = (streamUrl: unknown) => new URL(String(streamUrl)).searchParams.get("token") ?? undefined;

describe("POST /api/media/stream-token: allowed", () => {
  it("returns only a gateway stream URL and its expiry, bound to the session's user and the requested version", async () => {
    const w = world();
    const res = await call(w.handler, post({ movieVersionId: ON_THE_HUNT }));
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(["expiresAt", "streamUrl"]);
    expect(new URL(String(res.body.streamUrl)).origin).toBe(GATEWAY);
    const verified = verifyMediaToken(config.secret, tokenOf(res.body.streamUrl), { op: "stream", movieVersionId: ON_THE_HUNT, nowSeconds: NOW_MS / 1000, maxLifetimeSeconds: DEFAULT_LIMITS.maxTokenLifetimeSeconds });
    expect(verified.ok && verified.claims.sub).toBe(USER.id);
  });

  it("returns no Telegram, catalogue-workflow or secret material", async () => {
    const res = await call(world().handler, post({ movieVersionId: ON_THE_HUNT }));
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/chat|message|file|access_?hash|dc_?id|mime|size|channel|telegram|rights|publication|ingest/i);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain(USER.email!);
  });
});

describe("POST /api/media/stream-token: renewal", () => {
  it("is the same request again, re-reading the session, entitlement and catalogue every time", async () => {
    const w = world();
    const first = await call(w.handler, post({ movieVersionId: ON_THE_HUNT }));
    w.state.now += 540_000; // 9 minutes later, before expiry
    const second = await call(w.handler, post({ movieVersionId: ON_THE_HUNT }));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(w.calls).toEqual({ session: 2, entitlement: 2, catalogue: 2 });
    expect(tokenOf(second.body.streamUrl)).not.toBe(tokenOf(first.body.streamUrl));
    expect(Date.parse(String(second.body.expiresAt)) - Date.parse(String(first.body.expiresAt))).toBe(540_000);
  });

  it("stops when the user has signed out", async () => {
    const w = world();
    expect((await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).status).toBe(200);
    w.state.user = null;
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toMatchObject({ status: 401, body: { error: "authentication_required" } });
  });

  it("stops when entitlement is withdrawn", async () => {
    const w = world();
    expect((await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).status).toBe(200);
    w.state.entitled = false;
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toMatchObject({ status: 403, body: { error: "not_entitled" } });
  });

  it("stops when the version is no longer playable (unpublished, rights withdrawn, VJ inactive, unavailable)", async () => {
    const w = world();
    expect((await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).status).toBe(200);
    w.state.playable.delete(ON_THE_HUNT);
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toMatchObject({ status: 404, body: { error: "unavailable" } });
  });

  it("cannot be done by presenting an earlier capability", async () => {
    const w = world();
    const first = await call(w.handler, post({ movieVersionId: ON_THE_HUNT }));
    w.state.user = null;
    const token = tokenOf(first.body.streamUrl)!;
    // Refused by size (413) before the strict schema would refuse the extra key (400).
    const inBody = await call(w.handler, post({ movieVersionId: ON_THE_HUNT, token }));
    expect([400, 413]).toContain(inBody.status);
    expect(inBody.body.streamUrl).toBeUndefined();
    expect((await call(w.handler, post({ movieVersionId: ON_THE_HUNT, token: "v1.x.y" }))).status).toBe(400);
    expect((await call(w.handler, post({ movieVersionId: ON_THE_HUNT }, { authorization: `Bearer ${token}` }))).status).toBe(401);
  });
});

describe("POST /api/media/stream-token: denials are normalized", () => {
  it("answers every unplayable version identically, whatever the reason", async () => {
    const w = world();
    // Unknown, unpublished, not ready and media-only (Fuze: no version exists) all read as "not playable".
    const bodies = new Set<string>();
    for (const id of [2, 3, 42, 999_999_999]) {
      const res = await call(w.handler, post({ movieVersionId: id }));
      expect(res.status).toBe(404);
      bodies.add(JSON.stringify(res.body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "unavailable" })]);
  });

  it("tells a signed-out caller nothing about the version, and does not read the catalogue", async () => {
    const w = world();
    w.state.user = null;
    const published = await call(w.handler, post({ movieVersionId: ON_THE_HUNT }));
    const unknown = await call(w.handler, post({ movieVersionId: 999_999_999 }));
    expect(published).toEqual(unknown);
    expect(published).toMatchObject({ status: 401, body: { error: "authentication_required" } });
    expect(w.calls.catalogue).toBe(0);
  });

  it("tells a caller without entitlement nothing about the version, and does not read the catalogue", async () => {
    const w = world();
    w.state.entitled = false;
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toEqual(await call(w.handler, post({ movieVersionId: 999_999_999 })));
    expect(w.calls.catalogue).toBe(0);
  });

  it("answers a catalogue outage with a generic 503", async () => {
    const w = world();
    w.state.catalogueFails = true;
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toEqual({ status: 503, cacheControl: "no-store", body: { error: "temporarily_unavailable" } });
  });

  it("is unavailable without Supabase accounts, before reading any session", async () => {
    const w = world();
    w.state.accounts = false;
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toEqual({ status: 503, cacheControl: "no-store", body: { error: "temporarily_unavailable" } });
    expect(w.calls.session).toBe(0);
  });

  it("fails closed when the issuer is not configured", async () => {
    const w = world();
    w.state.configured = false;
    expect(await call(w.handler, post({ movieVersionId: ON_THE_HUNT }))).toEqual({ status: 503, cacheControl: "no-store", body: { error: "temporarily_unavailable" } });
    expect(w.calls).toEqual({ session: 0, entitlement: 0, catalogue: 0 });
  });
});

describe("POST /api/media/stream-token: request validation", () => {
  it.each([
    ["a Telegram channel id", { movieVersionId: 1, chatId: "-1001234567890" }],
    ["a message id", { movieVersionId: 1, messageId: 23 }],
    ["a document id", { movieVersionId: 1, documentId: "5123" }],
    ["a file id", { movieVersionId: 1, fileId: "BQACAgQAAx0" }],
    ["an access hash", { movieVersionId: 1, accessHash: "123" }],
    ["a file reference", { movieVersionId: 1, fileReference: "AQID" }],
    ["a DC", { movieVersionId: 1, dcId: 4 }],
    ["a MIME type", { movieVersionId: 1, mimeType: "video/mp4" }],
    ["a file size", { movieVersionId: 1, fileSize: 1004462878 }],
    ["a gateway database id", { movieVersionId: 1, telegramMediaId: 7 }],
    ["a user id", { movieVersionId: 1, userId: "someone-else" }],
    ["an operation", { movieVersionId: 1, op: "download" }],
    ["a gateway origin", { movieVersionId: 1, gatewayOrigin: "https://evil.example" }],
    ["Telegram identifiers instead of a version", { chatId: "-1001234567890", messageId: 23 }],
  ])("refuses a body carrying %s", async (_label, body) => {
    const w = world();
    expect(await call(w.handler, post(body))).toEqual({ status: 400, cacheControl: "no-store", body: { error: "invalid_request" } });
    expect(w.calls).toEqual({ session: 0, entitlement: 0, catalogue: 0 });
  });

  it.each([{}, { movieVersionId: "1" }, { movieVersionId: 0 }, { movieVersionId: -1 }, { movieVersionId: 1.5 }, { movieVersionId: 2 ** 53 }, [], null, 1, "x"])(
    "refuses the malformed body %j",
    async (body) => {
      expect((await call(world().handler, post(body))).status).toBe(400);
    },
  );

  it("refuses non-JSON text", async () => {
    expect((await call(world().handler, post("{movieVersionId:1"))).status).toBe(400);
  });

  it("refuses cross-site requests", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(await call(world().handler, post({ movieVersionId: 1 }, { "sec-fetch-site": site }))).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
  });

  it("refuses anything but JSON", async () => {
    expect((await call(world().handler, post({ movieVersionId: 1 }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await call(world().handler, post({ movieVersionId: 1 }, { "content-type": "application/x-www-form-urlencoded" }))).status).toBe(415);
  });

  it("refuses oversized bodies, declared or actual", async () => {
    expect((await call(world().handler, post({ movieVersionId: 1, pad: "x".repeat(300) }))).status).toBe(413);
    expect((await call(world().handler, post({ movieVersionId: 1 }, { "content-length": "100000" }))).status).toBe(413);
  });

  it("rate-limits one user, with no-store and Retry-After", async () => {
    const w = world();
    for (let i = 0; i < STREAM_TOKEN_REQUESTS_PER_WINDOW; i += 1) expect((await call(w.handler, post({ movieVersionId: 1 }))).status).toBe(200);
    const response = await w.handler(post({ movieVersionId: 1 }));
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    w.state.now += 60_000;
    expect((await call(w.handler, post({ movieVersionId: 1 }))).status).toBe(200);
  });
});
