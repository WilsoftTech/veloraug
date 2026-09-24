/**
 * TMDB-shaped identity kept for two purposes only since B5: legacy My List rows
 * saved by TMDB id, and the search scope values stored by Phase 3 analytics.
 * Catalogue content uses types/catalogue.ts.
 */
export type MediaType = "movie" | "tv";

/** A legacy saved title as TMDB describes it (lib/tmdb/legacy-watchlist.ts). */
export interface MediaSummary {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  releaseYear: number | null;
  /** TMDB average on a 0–10 scale, or null when the title is unrated. */
  rating: number | null;
}

/** Identity of a legacy TMDB title. */
export type MediaRef = Pick<MediaSummary, "id" | "mediaType">;

/**
 * Search scope. `tv` is the stored value (a database check constraint on
 * search analytics and history); product copy and URLs say "series".
 */
export type SearchScope = "all" | MediaType;

/** One remembered search of a signed-in user. `query` is the canonical form the database stored. */
export interface SearchHistoryEntry {
  query: string;
  scope: SearchScope;
}
