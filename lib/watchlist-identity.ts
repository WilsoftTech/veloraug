import { watchlistRefKey } from "@/lib/utils";
import type { Database } from "@/lib/supabase/database.types";
import type { CatalogueKind, TitleSummary } from "@/types/catalogue";
import type { MediaType } from "@/types/media";
import type { WatchlistRef } from "@/types/watchlist";

/**
 * Watchlist identity rules (roadmap B4), free of Next.js and Supabase clients so
 * they are unit-testable and reusable by a future Expo client.
 *
 *   Canonical  movie_id / series_id: a Velora UG catalogue title. New saves of
 *              a public title always use it, even when the caller only knew
 *              the title by its TMDB id.
 *   External   tmdb_id: TMDB metadata identity. Since B5 no save button sends
 *              it. It is stored as the identity only when a pre-B5 guest list
 *              is imported ("allow"): a TMDB title with no public catalogue
 *              match. Ordinary saves ("refuse") never create such a row, and
 *              no catalogue row is ever fabricated.
 *
 * The database enforces the same contract independently
 * (20260924195306_watchlist_public_identity_guard.sql).
 */

export type WatchlistRow = Pick<
  Database["public"]["Tables"]["watchlist_items"]["Row"],
  "movie_id" | "series_id" | "tmdb_id" | "media_type"
>;
export type WatchlistInsert = Database["public"]["Tables"]["watchlist_items"]["Insert"];

/** The public catalogue title a ref names (directly, or through its TMDB match), or null. */
export type TitleLookup = (ref: WatchlistRef) => TitleSummary | null;

export const TMDB_TYPE: Record<CatalogueKind, MediaType> = { movie: "movie", series: "tv" };

/** Indexes public titles under both their internal ref and the TMDB ref they were matched to. */
export function buildLookup(titles: TitleSummary[]): TitleLookup {
  const byRef = new Map<string, TitleSummary>();
  for (const title of titles) {
    byRef.set(watchlistRefKey({ source: "catalogue", kind: title.kind, id: title.id }), title);
    if (title.tmdbId !== null) {
      byRef.set(watchlistRefKey({ source: "tmdb", mediaType: TMDB_TYPE[title.kind], id: title.tmdbId }), title);
    }
  }
  return (ref) => byRef.get(watchlistRefKey(ref)) ?? null;
}

/** Whether a TMDB ref with no public catalogue match may still be stored as a legacy row. */
export type LegacyPolicy = "refuse" | "allow";

/**
 * The row a save writes: canonical when the ref resolves to a public title;
 * a legacy TMDB row only for an unmatched TMDB ref under "allow" (pre-B5 guest
 * import); otherwise null (unsavable).
 */
export function toInsert(ref: WatchlistRef, lookup: TitleLookup, legacy: LegacyPolicy): WatchlistInsert | null {
  const title = lookup(ref);
  if (title) return title.kind === "movie" ? { movie_id: title.id, media_type: "movie" } : { series_id: title.id, media_type: "series" };
  return ref.source === "tmdb" && legacy === "allow" ? { tmdb_id: ref.id, media_type: ref.mediaType } : null;
}

/**
 * PostgREST `or` filter matching every row that stores this title, in either
 * form. A tmdb_id is only ever set on rows for that TMDB title (legacy saves,
 * including those the insert trigger mapped to an internal id), so it is safe
 * to match on it alongside the internal id.
 */
export function rowsOf(ref: WatchlistRef, lookup: TitleLookup): string {
  const title = lookup(ref);
  const kind = title?.kind ?? (ref.source === "catalogue" ? ref.kind : null);
  const id = title?.id ?? (ref.source === "catalogue" ? ref.id : null);
  const tmdbId = title ? title.tmdbId : ref.source === "tmdb" ? ref.id : null;
  const mediaType = kind ? TMDB_TYPE[kind] : ref.source === "tmdb" ? ref.mediaType : "movie";

  const filters: string[] = [];
  if (kind && id !== null) filters.push(`${kind}_id.eq.${id}`);
  if (tmdbId !== null) filters.push(`and(tmdb_id.eq.${tmdbId},media_type.in.(${mediaType === "movie" ? "movie" : "tv,series"}))`);
  return filters.join(",");
}

/** A stored row's identity. Internal identity wins whenever present. */
export function rowRef(row: WatchlistRow): WatchlistRef | null {
  if (row.movie_id !== null) return { source: "catalogue", kind: "movie", id: row.movie_id };
  if (row.series_id !== null) return { source: "catalogue", kind: "series", id: row.series_id };
  if (row.tmdb_id === null) return null; // excluded by watchlist_items_identity_check
  return { source: "tmdb", mediaType: row.media_type === "movie" ? "movie" : "tv", id: row.tmdb_id };
}
