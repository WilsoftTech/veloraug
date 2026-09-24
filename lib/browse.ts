import { firstParam, parseSlug } from "@/lib/utils";
import type { CatalogueKind } from "@/types/catalogue";

/**
 * The /movies and /series URL contract: filters are catalogue slugs and paging
 * is an opaque keyset cursor. Free of Next.js imports so a future Expo client
 * can reuse it. Invalid values are dropped, never queried.
 */
export interface BrowseFilters {
  genre: string | null;
  vj: string | null;
  cursor: string | null;
}

type Params = Record<string, string | string[] | undefined>;

export const BROWSE_PATH: Record<CatalogueKind, string> = { movie: "/movies", series: "/series" };

function parseCursor(value: string | string[] | undefined): string | null {
  const cursor = firstParam(value);
  return cursor && /^[A-Za-z0-9_-]{1,200}$/.test(cursor) ? cursor : null;
}

export function parseBrowseFilters(params: Params): BrowseFilters {
  return { genre: parseSlug(params.genre), vj: parseSlug(params.vj), cursor: parseCursor(params.cursor) };
}

/** The one canonical URL for a filter set: empty values omitted, fixed parameter order. */
export function browseHref(kind: CatalogueKind, filters: Partial<BrowseFilters> = {}) {
  const params = new URLSearchParams();
  if (filters.genre) params.set("genre", filters.genre);
  if (filters.vj) params.set("vj", filters.vj);
  if (filters.cursor) params.set("cursor", filters.cursor);
  const query = params.toString();
  return query ? `${BROWSE_PATH[kind]}?${query}` : BROWSE_PATH[kind];
}

export function hasBrowseFilters({ genre, vj }: BrowseFilters) {
  return genre !== null || vj !== null;
}
