import "server-only";
import { tmdbFetch } from "@/lib/tmdb/client";
import type { TmdbResult, TmdbSearchResponse } from "@/lib/tmdb/types";
import type { MatchQuery, TmdbCandidate, TmdbSearch } from "@/types/ingestion";

/**
 * Ingestion-only TMDB search (Phase C matching). It maps raw search results to
 * the matcher's TmdbCandidate and nothing else: it is not a catalogue search,
 * and no public route may reach it (lib/catalogue-boundary.test.ts). A match
 * proposes metadata for an ingested file; it never creates, approves or
 * publishes a catalogue record.
 *
 * The year is deliberately not sent as a filter: the matcher needs remakes,
 * namesakes and off-by-one release years in the results to tell a unique
 * match from an ambiguous one.
 */

const yearOf = (date: string | undefined) => {
  const year = Number.parseInt(date?.slice(0, 4) ?? "", 10);
  return Number.isInteger(year) && year > 1800 ? year : null;
};

export function toTmdbCandidate(result: TmdbResult, mediaType: TmdbCandidate["mediaType"]): TmdbCandidate | null {
  const title = mediaType === "movie" ? result.title : result.name;
  if (!Number.isInteger(result.id) || result.id <= 0 || !title) return null;
  const original = mediaType === "movie" ? result.original_title : result.original_name;
  return {
    tmdbId: result.id,
    mediaType,
    title,
    originalTitle: original && original !== title ? original : null,
    year: yearOf(mediaType === "movie" ? result.release_date : result.first_air_date),
  };
}

/** Throws on transport failure; matchTitle() turns that into a retryable `error`. */
export const searchTmdbForIngestion: TmdbSearch = async (query: MatchQuery) => {
  const mediaType = query.kind === "movie" ? "movie" : "tv";
  const response = await tmdbFetch<TmdbSearchResponse>(`/search/${mediaType}`, { query: query.title, include_adult: "false", page: 1 });
  return (response?.results ?? []).flatMap((result) => toTmdbCandidate(result, mediaType) ?? []);
};
