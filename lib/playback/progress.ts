import type { ProgressRequest } from "@/lib/schemas";
import type { TitleSummary } from "@/types/catalogue";

/**
 * Movie viewing progress (roadmap E3 persistence, E5 Continue Watching): the
 * contract shared by the route handlers, the player and the home row. Free of
 * Next.js and server imports so a future Expo client can reuse it.
 *
 * Progress is per movie version, so a VJ translation or a numbered part resumes
 * itself. The database computes completion (at most 5% left) and clamps the
 * position; the browser only reports what the video element says.
 */

/** Saved positions shorter than this are treated as "not started". */
export const RESUME_MIN_SECONDS = 30;
/** How often a playing video reports its position; pause, end and leaving report at once. */
export const PROGRESS_SAVE_INTERVAL_MS = 15_000;
/** A periodic save is skipped unless the position moved at least this far. */
export const PROGRESS_MIN_STEP_SECONDS = 5;
/** Versions one progress read may ask about (a movie's VJs and parts). */
export const MAX_PROGRESS_VERSIONS = 20;
/** Titles in the home Continue Watching row. */
export const CONTINUE_WATCHING_LIMIT = 16;

export const PROGRESS_ENDPOINT = "/api/playback/progress";
export const CONTINUE_WATCHING_ENDPOINT = "/api/playback/continue-watching";

export interface VersionProgress {
  movieVersionId: number;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  updatedAt: string;
}

/** One Continue Watching card: the movie, and where its most recent unfinished version stopped. */
export interface ContinueWatchingItem {
  title: TitleSummary;
  movieVersionId: number;
  positionSeconds: number;
  durationSeconds: number | null;
}

/** The database's completion rule (viewing_progress_normalize): at most 5% left. */
export function isCompletedPosition(positionSeconds: number, durationSeconds: number | null): boolean {
  return durationSeconds !== null && positionSeconds * 20 >= durationSeconds * 19;
}

export function isResumable(progress: Pick<VersionProgress, "completed" | "positionSeconds">): boolean {
  return !progress.completed && progress.positionSeconds >= RESUME_MIN_SECONDS;
}

/** The most recently watched unfinished version among `versionIds`, if any. */
export function resumeVersion(versionIds: readonly number[], progress: readonly VersionProgress[]): VersionProgress | null {
  const ids = new Set(versionIds);
  let latest: VersionProgress | null = null;
  for (const entry of progress) {
    if (!ids.has(entry.movieVersionId) || !isResumable(entry)) continue;
    if (!latest || Date.parse(entry.updatedAt) > Date.parse(latest.updatedAt)) latest = entry;
  }
  return latest;
}

/** Watched share between 0 and 1, or null when the duration is unknown. */
export function progressFraction(positionSeconds: number, durationSeconds: number | null): number | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  return Math.min(1, Math.max(0, positionSeconds / durationSeconds));
}

/** "4:05", "12:34" or "1:02:03". */
export function formatPlaybackTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** What a <video> element reports, as a save request; null when there is nothing worth saving yet. */
export function progressFromMedia(movieVersionId: number, currentTime: number, duration: number, ended = false): ProgressRequest | null {
  const known = Number.isFinite(duration) && duration >= 1 ? Math.min(86_400, Math.round(duration)) : null;
  const raw = ended && known !== null ? known : currentTime;
  if (!Number.isFinite(raw) || raw < 0) return null;
  return { movieVersionId, positionSeconds: Math.min(86_400, Math.floor(raw)), durationSeconds: known };
}

/** Whether a periodic save is due: the position moved enough since the last saved one. */
export function shouldSaveProgress(lastSavedSeconds: number | null, positionSeconds: number): boolean {
  return lastSavedSeconds === null || Math.abs(positionSeconds - lastSavedSeconds) >= PROGRESS_MIN_STEP_SECONDS;
}

// ---------------------------------------------------------------------------
// Browser transport. Progress is a convenience: no outcome here blocks playback.
// "unavailable" means the service is off (signed out, or not deployed), so the
// caller stops asking; "failed" is transient and the next save tries again.
// ---------------------------------------------------------------------------
/** The part of fetch these helpers use (tests and other clients can supply their own). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ProgressReadResult = { ok: true; progress: VersionProgress[] } | { ok: false; reason: "unavailable" | "failed" };
export type ProgressSaveResult = "saved" | "unavailable" | "failed";

// 404: the version is no longer public, so saving it again cannot succeed.
const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 503]);

function isVersionProgress(value: unknown): value is VersionProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.movieVersionId) && Number.isSafeInteger(v.positionSeconds) && typeof v.completed === "boolean"
    && (v.durationSeconds === null || Number.isSafeInteger(v.durationSeconds)) && typeof v.updatedAt === "string";
}

export async function fetchVersionProgress(versionIds: readonly number[], fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<ProgressReadResult> {
  const ids = [...new Set(versionIds)].slice(0, MAX_PROGRESS_VERSIONS);
  if (ids.length === 0) return { ok: true, progress: [] };
  let response: Response;
  try {
    response = await fetchImpl(`${PROGRESS_ENDPOINT}?versions=${ids.join(",")}`, { credentials: "same-origin", cache: "no-store", signal });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (UNAVAILABLE_STATUSES.has(response.status)) return { ok: false, reason: "unavailable" };
  if (!response.ok) return { ok: false, reason: "failed" };
  try {
    const body = (await response.json()) as { items?: unknown };
    if (!Array.isArray(body.items) || !body.items.every(isVersionProgress)) return { ok: false, reason: "failed" };
    return { ok: true, progress: body.items };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

function isContinueWatchingItem(value: unknown): value is ContinueWatchingItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const title = v.title as Record<string, unknown> | null;
  return Number.isSafeInteger(v.movieVersionId) && Number.isSafeInteger(v.positionSeconds)
    && (v.durationSeconds === null || Number.isSafeInteger(v.durationSeconds))
    && typeof title === "object" && title !== null && title.kind === "movie" && typeof title.slug === "string"
    && typeof title.title === "string" && Array.isArray(title.vjs);
}

/** The signed-in viewer's unfinished movies; null when there is nothing to show (signed out, off, or a failure). */
export async function fetchContinueWatching(fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<ContinueWatchingItem[] | null> {
  try {
    const response = await fetchImpl(CONTINUE_WATCHING_ENDPOINT, { credentials: "same-origin", cache: "no-store", signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { items?: unknown };
    return Array.isArray(body.items) && body.items.every(isContinueWatchingItem) ? body.items : null;
  } catch {
    // Network failure or an aborted request: the row is simply not shown.
    return null;
  }
}

/** `keepalive` lets the last save leave with the page (pagehide). */
export async function saveVersionProgress(entry: ProgressRequest, fetchImpl: FetchLike = fetch, keepalive = false): Promise<ProgressSaveResult> {
  let response: Response;
  try {
    response = await fetchImpl(PROGRESS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      credentials: "same-origin",
      cache: "no-store",
      keepalive,
    });
  } catch {
    return "failed";
  }
  if (response.ok) return "saved";
  return UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "failed";
}
