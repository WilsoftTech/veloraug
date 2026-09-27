import "server-only";
import { tmdbFetch } from "@/lib/tmdb/client";
import * as z from "zod";
import type { TmdbMovieDetails, TmdbResult, TmdbSearchResponse } from "@/lib/tmdb/types";
import type { MatchQuery, TmdbCandidate, TmdbSearch } from "@/types/ingestion";

/**
 * Ingestion-only TMDB access (Phase C matching and publication snapshots). It
 * maps raw search results to the matcher's TmdbCandidate, and one approved
 * movie's details to the snapshot the owner's publication command stores. It
 * is not a catalogue search, and no public route may reach it
 * (lib/catalogue-boundary.test.ts). A match proposes metadata for an ingested
 * file; it never creates, approves or publishes a catalogue record.
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

/**
 * The metadata snapshot private.catalogue_publish_movie takes (snake_case, as
 * stored). Validated here and again by the database. Artwork is a TMDB path
 * only, never a URL.
 */
const artworkPath = z.string().regex(/^\/[A-Za-z0-9_.-]{1,200}$/).nullable();
export const movieSnapshotSchema = z.strictObject({
  tmdb_id: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  original_title: z.string().trim().min(1).max(300).nullable(),
  overview: z.string().trim().min(1).max(10000).nullable(),
  release_date: z.iso.date().nullable(),
  runtime_minutes: z.number().int().positive().nullable(),
  poster_path: artworkPath,
  backdrop_path: artworkPath,
  vote_average: z.number().min(0).max(10).nullable(),
  vote_count: z.number().int().nonnegative().nullable(),
  genres: z.array(z.strictObject({ tmdb_id: z.number().int().positive(), name: z.string().trim().min(1).max(100) })).max(20),
});
export type MovieSnapshot = z.infer<typeof movieSnapshotSchema>;

const blankToNull = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

/** Pure mapping of TMDB movie details; null when they do not form a valid snapshot. */
export function toMovieSnapshot(details: TmdbMovieDetails): MovieSnapshot | null {
  const title = blankToNull(details.title);
  const original = blankToNull(details.original_title);
  const parsed = movieSnapshotSchema.safeParse({
    tmdb_id: details.id,
    title,
    original_title: original && original !== title ? original : null,
    overview: blankToNull(details.overview),
    release_date: blankToNull(details.release_date),
    runtime_minutes: details.runtime && details.runtime > 0 ? details.runtime : null,
    poster_path: details.poster_path ?? null,
    backdrop_path: details.backdrop_path ?? null,
    vote_average: details.vote_average ?? null,
    vote_count: details.vote_count ?? null,
    genres: (details.genres ?? []).map((genre) => ({ tmdb_id: genre.id, name: genre.name })),
  });
  return parsed.success ? parsed.data : null;
}

/** Details of one approved TMDB movie. Null when TMDB has no such movie or the payload is unusable. */
export async function fetchMovieSnapshot(tmdbId: number): Promise<MovieSnapshot | null> {
  const details = await tmdbFetch<TmdbMovieDetails>(`/movie/${tmdbId}`);
  if (details === null || details.id !== tmdbId) return null;
  return toMovieSnapshot(details);
}
