import "server-only";
import type { MediaRef, MediaSummary } from "@/types/media";
import { isTmdbConfigured, tmdbFetch } from "./client";
import type { TmdbResult } from "./types";

/**
 * TEMPORARY MIGRATION COMPATIBILITY (roadmap B5). The only TMDB read left on a
 * user-facing path: it describes legacy My List rows saved by TMDB id before
 * the catalogue cutover, whose TMDB id has no public catalogue match. It never
 * decides what the catalogue offers, is never used for browsing, and returns
 * nothing (so rows read as "Unavailable title") when TMDB is not configured.
 * Remove it together with the legacy watchlist columns.
 */

const BATCH = 20;

function toYear(date: string | undefined) {
  const year = Number.parseInt(date?.slice(0, 4) ?? "", 10);
  return Number.isNaN(year) ? null : year;
}

async function describe({ mediaType, id }: MediaRef): Promise<MediaSummary | null> {
  const raw = await tmdbFetch<TmdbResult>(`/${mediaType}/${id}`);
  const title = raw?.title ?? raw?.name;
  if (!raw || !title) return null;
  return {
    id: raw.id,
    mediaType,
    title,
    posterPath: raw.poster_path ?? null,
    releaseYear: toYear(raw.release_date ?? raw.first_air_date),
    rating: raw.vote_count ? Math.round((raw.vote_average ?? 0) * 10) / 10 : null,
  };
}

/**
 * Card data for legacy saved TMDB titles. Titles TMDB no longer has are
 * dropped; any other failure throws, so a flaky lookup never looks like a
 * shorter list. Small batches keep a long list under TMDB's rate limit.
 */
export async function getLegacyTitleSummaries(refs: MediaRef[]): Promise<MediaSummary[]> {
  if (refs.length === 0 || !isTmdbConfigured()) return [];
  const summaries: (MediaSummary | null)[] = [];
  for (let start = 0; start < refs.length; start += BATCH) {
    summaries.push(...(await Promise.all(refs.slice(start, start + BATCH).map(describe))));
  }
  return summaries.flatMap((summary) => summary ?? []);
}
