import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowRateLimiter } from "@/lib/media-gateway/limits";
import type { VersionProgress } from "@/lib/playback/progress";
import {
  PROGRESS_REQUESTS_PER_WINDOW,
  ProgressStoreError,
  createContinueWatchingHandler,
  createProgressHandlers,
  parseVersionList,
  supabaseProgressStore,
  type ProgressDeps,
  type ProgressStore,
} from "@/lib/playback/progress-route";
import type { TitleSummary } from "@/types/catalogue";

const USER = "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e";
const ORIGIN = "https://velora.example";
const movie = (id: number): TitleSummary => ({ kind: "movie", id, slug: `movie-${id}`, title: `Movie ${id}`, posterPath: null, releaseYear: 2024, rating: null, tmdbId: null, vjs: [] });
const row = (movieVersionId: number, positionSeconds = 120): VersionProgress => ({ movieVersionId, positionSeconds, durationSeconds: 6000, completed: false, updatedAt: "2026-11-17T12:00:00Z" });

function world() {
  const state = { signedIn: true, configured: true, recordError: null as ProgressStoreError | Error | null, rows: [row(1)], recent: [] as VersionProgress[], titles: new Map<number, TitleSummary>() };
  const calls = { session: 0, record: [] as unknown[], read: [] as number[][], recentLimits: [] as number[] };
  const store: ProgressStore = {
    async record(entry) {
      calls.record.push(entry);
      if (state.recordError) throw state.recordError;
      return entry.positionSeconds * 20 >= (entry.durationSeconds ?? Infinity) * 19;
    },
    async read(ids) {
      calls.read.push(ids);
      return state.rows.filter((item) => ids.includes(item.movieVersionId));
    },
    async recent(limit) {
      calls.recentLimits.push(limit);
      return state.recent;
    },
  };
  const deps: ProgressDeps = {
    accountsConfigured: () => state.configured,
    async session() {
      calls.session += 1;
      return state.signedIn ? { userId: USER, store } : null;
    },
    describeVersions: async (ids) => new Map(ids.flatMap((id) => (state.titles.has(id) ? [[id, state.titles.get(id)!] as const] : []))),
    now: () => 1_790_000_000_000,
  };
  return { state, calls, deps };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/playback/progress`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (query: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => new Request(`${ORIGIN}/api/playback/progress${query}`, { headers });
const SAVE = { movieVersionId: 1, positionSeconds: 754, durationSeconds: 6000 };

afterEach(() => vi.restoreAllMocks());

describe("POST /api/playback/progress", () => {
  it("records the caller's position and returns the database's completion answer, no-store", async () => {
    const { calls, deps } = world();
    const response = await createProgressHandlers(deps).POST(post(SAVE));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ completed: false });
    expect(calls.record).toEqual([SAVE]);
    expect(await (await createProgressHandlers(deps).POST(post({ ...SAVE, positionSeconds: 5700 }))).json()).toEqual({ completed: true });
  });

  it("refuses cross-site, non-JSON, oversized and malformed requests before reading the session", async () => {
    const { calls, deps } = world();
    const { POST } = createProgressHandlers(deps);
    const cases: [Request, number, string][] = [
      [post(SAVE, { "sec-fetch-site": "cross-site" }), 403, "forbidden"],
      [post(SAVE, { "content-type": "text/plain" }), 415, "unsupported_media_type"],
      [post(SAVE, { "content-length": "4096" }), 413, "payload_too_large"],
      [post(JSON.stringify({ ...SAVE, padding: "x".repeat(300) })), 413, "payload_too_large"],
      [post("{not json"), 400, "invalid_request"],
      [post({ ...SAVE, userId: USER }), 400, "invalid_request"],
      [post({ ...SAVE, positionSeconds: -1 }), 400, "invalid_request"],
      [post({ ...SAVE, positionSeconds: 1.5 }), 400, "invalid_request"],
      [post({ ...SAVE, durationSeconds: 0 }), 400, "invalid_request"],
      [post({ ...SAVE, movieVersionId: 0 }), 400, "invalid_request"],
      [post({ movieVersionId: 1, positionSeconds: 1 }), 400, "invalid_request"],
    ];
    for (const [request, status, error] of cases) {
      const response = await POST(request);
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
    expect(calls.session).toBe(0);
    expect(calls.record).toEqual([]);
  });

  it("requires a session, and is off without accounts", async () => {
    const { state, calls, deps } = world();
    state.signedIn = false;
    expect((await createProgressHandlers(deps).POST(post(SAVE))).status).toBe(401);
    state.configured = false;
    const off = await createProgressHandlers(deps).POST(post(SAVE));
    expect([off.status, await off.json()]).toEqual([503, { error: "progress_unavailable" }]);
    expect(calls.record).toEqual([]);
  });

  it("maps store outcomes: not public 404, not deployed 503 (stop asking), invalid 400, failure 500", async () => {
    const { state, deps } = world();
    const { POST } = createProgressHandlers(deps);
    const expectations: [ProgressStoreError | Error, number, string][] = [
      [new ProgressStoreError("not_public"), 404, "unavailable"],
      [new ProgressStoreError("not_deployed"), 503, "progress_unavailable"],
      [new ProgressStoreError("invalid"), 400, "invalid_request"],
      [new ProgressStoreError("failed"), 500, "failed"],
    ];
    for (const [error, status, code] of expectations) {
      state.recordError = error;
      const response = await POST(post(SAVE));
      expect([response.status, await response.json()]).toEqual([status, { error: code }]);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.recordError = new Error("boom");
    expect((await POST(post(SAVE))).status).toBe(500);
  });

  it("limits each user to the window's request budget", async () => {
    const { deps } = world();
    const { POST } = createProgressHandlers({ ...deps, limiter: new WindowRateLimiter(PROGRESS_REQUESTS_PER_WINDOW, 60_000) });
    for (let index = 0; index < PROGRESS_REQUESTS_PER_WINDOW; index += 1) expect((await POST(post(SAVE))).status).toBe(200);
    const limited = await POST(post(SAVE));
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "60"]);
  });
});

describe("GET /api/playback/progress", () => {
  it("returns only the caller's rows for the requested versions", async () => {
    const { calls, deps } = world();
    const response = await createProgressHandlers(deps).GET(get("?versions=1,4,1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [row(1)] });
    expect(calls.read).toEqual([[1, 4]]);
  });

  it("validates the version list and refuses cross-site reads", async () => {
    const { calls, deps } = world();
    const { GET } = createProgressHandlers(deps);
    for (const query of ["", "?versions=", "?versions=a", "?versions=1,,2", "?versions=0", "?versions=-1", "?versions=1.5", `?versions=${Array.from({ length: 21 }, (_, i) => i + 1).join(",")}`, "?versions=99999999999999999"]) {
      expect((await GET(get(query))).status).toBe(400);
    }
    expect((await GET(get("?versions=1", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(calls.session).toBe(0);
  });

  it("parses a version list strictly", () => {
    expect(parseVersionList("3,1,3")).toEqual([3, 1]);
    expect(parseVersionList(null)).toBeNull();
    expect(parseVersionList(" 1")).toBeNull();
  });
});

describe("GET /api/playback/continue-watching", () => {
  const request = new Request(`${ORIGIN}/api/playback/continue-watching`, { headers: { "sec-fetch-site": "same-origin" } });

  it("lists one card per published movie, most recent first, dropping versions that are no longer public", async () => {
    const { state, calls, deps } = world();
    // Versions 1 and 2 belong to movie 10 (two VJs); 3 is movie 30; 4 is no longer public.
    state.titles = new Map([[1, movie(10)], [2, movie(10)], [3, movie(30)]]);
    state.recent = [row(2, 900), row(4, 300), row(1, 600), row(3, 200)];
    const response = await createContinueWatchingHandler(deps)(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [
      { title: movie(10), movieVersionId: 2, positionSeconds: 900, durationSeconds: 6000 },
      { title: movie(30), movieVersionId: 3, positionSeconds: 200, durationSeconds: 6000 },
    ] });
    expect(calls.recentLimits).toEqual([40]);
  });

  it("is capped at 16 cards", async () => {
    const { state, deps } = world();
    state.recent = Array.from({ length: 40 }, (_, index) => row(index + 1));
    state.titles = new Map(state.recent.map((item) => [item.movieVersionId, movie(item.movieVersionId)]));
    expect((await (await createContinueWatchingHandler(deps)(request)).json()).items).toHaveLength(16);
  });

  it("requires a session and reports a missing migration as off", async () => {
    const { state, deps } = world();
    state.signedIn = false;
    expect((await createContinueWatchingHandler(deps)(request)).status).toBe(401);
    state.signedIn = true;
    const store = (await deps.session())!.store;
    store.recent = async () => { throw new ProgressStoreError("not_deployed"); };
    const off = await createContinueWatchingHandler({ ...deps, session: async () => ({ userId: USER, store }) })(request);
    expect([off.status, await off.json()]).toEqual([503, { error: "progress_unavailable" }]);
  });
});

describe("Supabase store error mapping", () => {
  /** Just enough of the client: rpc() and from().select().in() resolve to the given result. */
  const client = (result: { data: unknown; error: { code?: string; message: string } | null }) => {
    const query = { select: () => query, in: () => query, eq: () => query, gte: () => query, order: () => query, limit: () => query, then: (resolve: (value: unknown) => void) => resolve(result) };
    return { rpc: async () => result, from: () => query } as unknown as Parameters<typeof supabaseProgressStore>[0];
  };

  it("maps a missing table or function to 'not deployed' and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const code of ["PGRST202", "PGRST205", "42P01", "42883"]) {
      await expect(supabaseProgressStore(client({ data: null, error: { code, message: "missing" } })).record(SAVE)).rejects.toMatchObject({ kind: "not_deployed" });
    }
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("maps Row Level Security refusals to 'not public', bounds to 'invalid', anything else to 'failed'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(supabaseProgressStore(client({ data: null, error: { code: "42501", message: "rls" } })).record(SAVE)).rejects.toMatchObject({ kind: "not_public" });
    await expect(supabaseProgressStore(client({ data: null, error: { code: "22023", message: "bounds" } })).record(SAVE)).rejects.toMatchObject({ kind: "invalid" });
    await expect(supabaseProgressStore(client({ data: null, error: { code: "57014", message: "timeout" } })).read([1])).rejects.toMatchObject({ kind: "failed" });
  });

  it("returns the completion flag and maps rows to the domain shape", async () => {
    expect(await supabaseProgressStore(client({ data: true, error: null })).record(SAVE)).toBe(true);
    const rows = [{ movie_version_id: 1, position_seconds: 120, duration_seconds: 6000, completed: false, updated_at: "2026-11-17T12:00:00Z" }];
    expect(await supabaseProgressStore(client({ data: rows, error: null })).recent(40)).toEqual([row(1)]);
  });
});
