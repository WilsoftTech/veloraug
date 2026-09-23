/**
 * Velora UG catalogue domain types: what the database publishes, independent of
 * Next.js and of TMDB. Ids are internal catalogue ids (not TMDB ids); movies and
 * series have separate id spaces, so `kind` is part of a title's identity.
 */
export type CatalogueKind = "movie" | "series";

export type VjBadgeVariant = "blue" | "amber" | "emerald" | "violet" | "rose" | "slate";

/** What a poster badge or a VJ link needs. */
export interface VjSummary {
  id: number;
  slug: string;
  name: string;
  badgeVariant: VjBadgeVariant;
}

export interface Vj extends VjSummary {
  description: string | null;
  avatarUrl: string | null;
}

export interface Genre {
  id: number;
  slug: string;
  name: string;
}

/** The fields a card or list row needs. `vjs` lists every VJ the title is available from. */
export interface TitleSummary {
  kind: CatalogueKind;
  id: number;
  slug: string;
  title: string;
  posterPath: string | null;
  releaseYear: number | null;
  /** TMDB average on a 0–10 scale, or null when unrated. */
  rating: number | null;
  /** The TMDB title this was matched to, if any. Links legacy TMDB-id saves to it. */
  tmdbId: number | null;
  vjs: VjSummary[];
}

interface TitleDetail extends TitleSummary {
  originalTitle: string | null;
  overview: string | null;
  backdropPath: string | null;
  genres: Genre[];
}

/** One VJ translation. `title` is the VJ-specific display title when it differs. */
export interface TitleVersion {
  id: number;
  vj: VjSummary;
  title: string | null;
}

export interface MovieDetail extends TitleDetail {
  kind: "movie";
  runtimeMinutes: number | null;
  versions: TitleVersion[];
}

export interface Episode {
  id: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
  stillPath: string | null;
  versions: TitleVersion[];
}

export interface Season {
  id: number;
  seasonNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  posterPath: string | null;
  /** Ordered by episode number; only episodes that are available. */
  episodes: Episode[];
}

export interface SeriesDetail extends TitleDetail {
  kind: "series";
  /** Ordered by season number; only seasons with an available episode. */
  seasons: Season[];
}

/** A keyset page. Pass `nextCursor` back to get the following page; null means the end. */
export interface CataloguePage<T> {
  items: T[];
  nextCursor: string | null;
}
