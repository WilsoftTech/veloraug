import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WindowRateLimiter } from "@/lib/media-gateway/limits";
import {
  CONTINUE_WATCHING_LIMIT,
  MAX_PROGRESS_VERSIONS,
  RESUME_MIN_SECONDS,
  type ContinueWatchingItem,
  type VersionProgress,
} from "@/lib/playback/progress";
import { progressRequestSchema, type ProgressRequest } from "@/lib/schemas";
import type { Database } from "@/lib/supabase/database.types";
import type { TitleSummary } from "@/types/catalogue";

/**
 * Route handlers for movie viewing progress:
 *   GET  /api/playback/progress?versions=1,2   the caller's progress for those versions
 *   POST /api/playback/progress                 { movieVersionId, positionSeconds, durationSeconds }
 *   GET  /api/playback/continue-watching       the caller's unfinished movies, most recent first
 *
 * The caller is the cookie session; a user id is never accepted. The store acts
 * as that user, so Row Level Security decides which rows exist and whether a
 * version is public enough to save. Every response is `no-store` and errors
 * are a fixed `{ error }` code. Nothing logged names a user or a title.
 *
 * 503 `progress_unavailable` means progress is off here (accounts not configured,
 * or the 20261117203000 migration is not applied). The browser then stops asking,
 * and playback is unaffected.
 */

const MAX_BODY_CHARS = 256;
export const PROGRESS_REQUESTS_PER_WINDOW = 60;
export const PROGRESS_WINDOW_MS = 60_000;
/** Rows read to fill the row after dropping titles that are no longer public. */
const CONTINUE_WATCHING_SCAN = 40;

export type ProgressError =
  | "forbidden"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_request"
  | "authentication_required"
  | "unavailable"
  | "rate_limited"
  | "progress_unavailable"
  | "failed";

const STATUS: Record<ProgressError, number> = {
  forbidden: 403,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_request: 400,
  authentication_required: 401,
  unavailable: 404,
  rate_limited: 429,
  progress_unavailable: 503,
  failed: 500,
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(error: ProgressError, extra: Record<string, string> = {}) {
  return Response.json({ error }, { status: STATUS[error], headers: { ...NO_STORE, ...extra } });
}

/** Why a store call failed. `not_deployed`: the table or function does not exist in this database. */
export class ProgressStoreError extends Error {
  constructor(readonly kind: "not_deployed" | "not_public" | "invalid" | "failed") {
    super(`progress_${kind}`);
  }
}

export interface ProgressStore {
  /** Upserts one save; resolves to whether the version now counts as watched. */
  record(entry: ProgressRequest): Promise<boolean>;
  read(versionIds: number[]): Promise<VersionProgress[]>;
  /** Unfinished, resumable rows, most recently updated first. */
  recent(limit: number): Promise<VersionProgress[]>;
}

export interface ProgressDeps {
  accountsConfigured(): boolean;
  /** The verified session's user and a store acting as that user, or null when signed out. */
  session(): Promise<{ userId: string; store: ProgressStore } | null>;
  /** Published movies of public versions; other versions are absent. */
  describeVersions(versionIds: number[]): Promise<Map<number, TitleSummary>>;
  now?: () => number;
  limiter?: WindowRateLimiter;
}

/** Cross-site pages cannot attach the SameSite=Lax session; refusing them here makes that explicit. */
function crossSite(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin";
}

function storeFailure(error: unknown): Response {
  if (!(error instanceof ProgressStoreError)) {
    console.error("Viewing progress failed unexpectedly", error instanceof Error ? error.name : typeof error);
    return fail("failed");
  }
  if (error.kind === "not_deployed") return fail("progress_unavailable");
  if (error.kind === "not_public") return fail("unavailable");
  if (error.kind === "invalid") return fail("invalid_request");
  return fail("failed");
}

/** `1,2,3`: 1 to MAX_PROGRESS_VERSIONS positive safe integers. */
export function parseVersionList(value: string | null): number[] | null {
  if (!value || !/^\d{1,16}(,\d{1,16})*$/.test(value)) return null;
  const ids = [...new Set(value.split(",").map(Number))];
  if (ids.length > MAX_PROGRESS_VERSIONS || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return null;
  return ids;
}

export function createProgressHandlers(deps: ProgressDeps) {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new WindowRateLimiter(PROGRESS_REQUESTS_PER_WINDOW, PROGRESS_WINDOW_MS);
  const retryAfter = { "Retry-After": String(Math.ceil(PROGRESS_WINDOW_MS / 1000)) };

  /** Common gate: configured, signed in, within the rate limit. */
  async function caller() {
    if (!deps.accountsConfigured()) return { response: fail("progress_unavailable") } as const;
    const session = await deps.session();
    if (!session) return { response: fail("authentication_required") } as const;
    if (!limiter.hit(session.userId, now())) return { response: fail("rate_limited", retryAfter) } as const;
    return { session } as const;
  }

  async function GET(request: Request): Promise<Response> {
    if (crossSite(request)) return fail("forbidden");
    const ids = parseVersionList(new URL(request.url).searchParams.get("versions"));
    if (!ids) return fail("invalid_request");
    const { session, response } = await caller();
    if (response) return response;
    try {
      return Response.json({ items: await session.store.read(ids) }, { headers: NO_STORE });
    } catch (error) {
      return storeFailure(error);
    }
  }

  async function POST(request: Request): Promise<Response> {
    if (crossSite(request)) return fail("forbidden");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail("unsupported_media_type");
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_CHARS) return fail("payload_too_large");
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return fail("payload_too_large");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return fail("invalid_request");
    }
    const parsed = progressRequestSchema.safeParse(payload);
    if (!parsed.success) return fail("invalid_request");
    const { session, response } = await caller();
    if (response) return response;
    try {
      return Response.json({ completed: await session.store.record(parsed.data) }, { headers: NO_STORE });
    } catch (error) {
      return storeFailure(error);
    }
  }

  return { GET, POST };
}

export function createContinueWatchingHandler(deps: ProgressDeps) {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new WindowRateLimiter(PROGRESS_REQUESTS_PER_WINDOW, PROGRESS_WINDOW_MS);

  return async function GET(request: Request): Promise<Response> {
    if (crossSite(request)) return fail("forbidden");
    if (!deps.accountsConfigured()) return fail("progress_unavailable");
    const session = await deps.session();
    if (!session) return fail("authentication_required");
    if (!limiter.hit(session.userId, now())) return fail("rate_limited", { "Retry-After": String(Math.ceil(PROGRESS_WINDOW_MS / 1000)) });

    let rows: VersionProgress[];
    try {
      rows = await session.store.recent(CONTINUE_WATCHING_SCAN);
    } catch (error) {
      return storeFailure(error);
    }
    let titles: Map<number, TitleSummary>;
    try {
      titles = await deps.describeVersions(rows.map((row) => row.movieVersionId));
    } catch {
      // The catalogue read logged its own code.
      return fail("failed");
    }
    // One card per movie: its most recently watched unfinished version.
    const seen = new Set<number>();
    const items: ContinueWatchingItem[] = [];
    for (const row of rows) {
      const title = titles.get(row.movieVersionId);
      if (!title || seen.has(title.id)) continue;
      seen.add(title.id);
      items.push({ title, movieVersionId: row.movieVersionId, positionSeconds: row.positionSeconds, durationSeconds: row.durationSeconds });
      if (items.length === CONTINUE_WATCHING_LIMIT) break;
    }
    return Response.json({ items }, { headers: NO_STORE });
  };
}

// ---------------------------------------------------------------------------
// Supabase store (the session client: every call runs as the signed-in user)
// ---------------------------------------------------------------------------
// The table or function is missing: PostgREST schema cache (PGRST202/PGRST205) or Postgres (42P01/42883).
const NOT_DEPLOYED = new Set(["PGRST202", "PGRST205", "42P01", "42883"]);
let reportedNotDeployed = false;

function storeError(error: { code?: string; message: string }, action: string): ProgressStoreError {
  if (error.code && NOT_DEPLOYED.has(error.code)) {
    if (!reportedNotDeployed) {
      reportedNotDeployed = true;
      console.warn("Viewing progress is off: migration 20261117203000 is not applied to this database.");
    }
    return new ProgressStoreError("not_deployed");
  }
  // Row Level Security refused the row: the version is not public (or no longer is).
  if (error.code === "42501") return new ProgressStoreError("not_public");
  if (error.code === "22023") return new ProgressStoreError("invalid");
  console.error(`Viewing progress ${action} failed`, error.code, error.message);
  return new ProgressStoreError("failed");
}

type ProgressRow = Pick<Database["public"]["Tables"]["viewing_progress"]["Row"], "movie_version_id" | "position_seconds" | "duration_seconds" | "completed" | "updated_at">;
const COLUMNS = "movie_version_id, position_seconds, duration_seconds, completed, updated_at";

function toProgress(row: ProgressRow): VersionProgress {
  return {
    movieVersionId: row.movie_version_id,
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    completed: row.completed,
    updatedAt: row.updated_at,
  };
}

export function supabaseProgressStore(client: SupabaseClient<Database>): ProgressStore {
  return {
    async record(entry) {
      const { data, error } = await client.rpc("record_movie_progress", {
        p_movie_version_id: entry.movieVersionId,
        p_position_seconds: entry.positionSeconds,
        p_duration_seconds: entry.durationSeconds,
      });
      if (error) throw storeError(error, "save");
      return data === true;
    },
    async read(versionIds) {
      const { data, error } = await client.from("viewing_progress").select(COLUMNS).in("movie_version_id", versionIds);
      if (error) throw storeError(error, "read");
      return data.map(toProgress);
    },
    async recent(limit) {
      const { data, error } = await client
        .from("viewing_progress")
        .select(COLUMNS)
        .eq("completed", false)
        .gte("position_seconds", RESUME_MIN_SECONDS)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw storeError(error, "list");
      return data.map(toProgress);
    },
  };
}
