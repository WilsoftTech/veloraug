import type { CatalogueKind } from "@/types/catalogue";
import type { MediaType } from "@/types/media";

/**
 * Identity of a saved title. Movie, series and TMDB ids are separate id spaces,
 * so the whole ref is the identity, never the number alone.
 *
 *   catalogue  a Velora UG movie or series (internal id). Canonical: new saves use it.
 *   tmdb       a legacy save of a TMDB title with no published catalogue entry.
 *              Kept readable and removable until it can be mapped.
 */
export type WatchlistRef =
  | { source: "catalogue"; kind: CatalogueKind; id: number }
  | { source: "tmdb"; mediaType: MediaType; id: number };

/** What My List needs to render, link and match a saved title. */
export interface WatchlistItem {
  ref: WatchlistRef;
  /**
   * For a catalogue title, the TMDB id it was matched to (if any), so a page that
   * still identifies it by TMDB id recognises it as saved.
   */
  tmdbId: number | null;
  title: string;
  posterPath: string | null;
  releaseYear: number | null;
  rating: number | null;
  /** Where the title opens; null when it is no longer available. */
  href: string | null;
}
