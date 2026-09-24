import type { CatalogueKind, TitleSummary } from "@/types/catalogue";
import type { MediaSummary, MediaType, SearchScope } from "@/types/media";
import type { WatchlistItem, WatchlistRef } from "@/types/watchlist";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

/** Detail page of a published catalogue title. */
export function titleHref(kind: CatalogueKind, slug: string) {
  return `/${kind === "movie" ? "movies" : "series"}/${slug}`;
}

export function mediaTypeLabel(mediaType: MediaType) {
  return mediaType === "movie" ? "Movie" : "Series";
}

/** Stable string identity of a saved title; the id alone is ambiguous across id spaces. */
export function watchlistRefKey(ref: WatchlistRef) {
  return ref.source === "catalogue" ? `catalogue:${ref.kind}:${ref.id}` : `tmdb:${ref.mediaType}:${ref.id}`;
}

/**
 * My List entry for a legacy TMDB save (temporary migration compatibility, B5).
 * Velora has no page for a TMDB-only title, so the row does not link anywhere.
 */
export function mediaWatchlistItem({ id, mediaType, title, posterPath, releaseYear, rating }: MediaSummary): WatchlistItem {
  return { ref: { source: "tmdb", mediaType, id }, tmdbId: null, title, posterPath, releaseYear, rating, href: null };
}

/** My List entry for a published catalogue title. */
export function titleWatchlistItem({ kind, id, slug, tmdbId, title, posterPath, releaseYear, rating }: TitleSummary): WatchlistItem {
  return { ref: { source: "catalogue", kind, id }, tmdbId, title, posterPath, releaseYear, rating, href: titleHref(kind, slug) };
}

/** Meta-description length: trimmed at a word boundary, undefined when empty. */
export function summarize(text: string, maxLength = 160) {
  const clean = text.trim();
  if (!clean) return undefined;
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).replace(/\s+\S*$/, "")}…`;
}

export function formatRuntime(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

type SearchParamValue = string | string[] | undefined;

export function firstParam(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Search scope in URLs. Product copy says "Series"; the stored analytics and
 * history scope stays `tv` (a database check constraint). `?type=tv` from
 * older links is still accepted.
 */
export function parseSearchScope(value: SearchParamValue): SearchScope {
  const scope = firstParam(value);
  if (scope === "series" || scope === "tv") return "tv";
  return scope === "movie" ? "movie" : "all";
}

export function searchScopeParam(scope: SearchScope): string | null {
  return scope === "all" ? null : scope === "tv" ? "series" : "movie";
}

/** A catalogue slug as the database allows it; anything else is ignored rather than queried. */
export function parseSlug(value: SearchParamValue): string | null {
  const slug = firstParam(value);
  return slug && slug.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

/**
 * ILIKE "contains" pattern for a search query. LIKE wildcards in the query are
 * escaped; PostgREST also treats `*` as a wildcard, so it becomes a
 * one-character match (`M*A*S*H` still finds itself). Null for an empty query.
 */
export function containsPattern(query: string): string | null {
  const clean = query.trim();
  if (!clean) return null;
  return `%${clean.replace(/[\\%_]/g, (char) => `\\${char}`).replaceAll("*", "_")}%`;
}

/** Stable sort: exact matches, then prefix matches, then the rest, each group in its given order. */
export function rankByTitleMatch<T>(items: T[], query: string, titleOf: (item: T) => string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  const rank = (item: T) => {
    const title = titleOf(item).toLocaleLowerCase();
    return title === needle ? 0 : title.startsWith(needle) ? 1 : 2;
  };
  return items.map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

export function parseMediaType(value: string): MediaType | null {
  return value === "movie" || value === "tv" ? value : null;
}

/**
 * Validates the `/[mediaType]/[id]` params without any network call. Digits
 * only, so "1e3" or "0x10" cannot alias another title's URL.
 */
export function parseMediaRoute(mediaType: string, rawId: string): { mediaType: MediaType; id: number } | null {
  const type = parseMediaType(mediaType);
  const id = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN;
  return type && Number.isSafeInteger(id) && id > 0 ? { mediaType: type, id } : null;
}

/**
 * A `next` redirect target taken from a URL or form, reduced to a same-origin
 * path. Anything else (absolute URLs, `//host`, backslash tricks, control
 * characters) falls back, so sign-in can never bounce a user to another site.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return new URL(value, "http://velora.invalid").origin === "http://velora.invalid" ? value : fallback;
}

/** The one place a search URL is built, so results, tabs and history links always agree. */
export function searchHref(query: string, scope: SearchScope = "all") {
  const type = searchScopeParam(scope);
  return `/search?q=${encodeURIComponent(query)}${type ? `&type=${type}` : ""}`;
}

export const SEARCH_SCOPE_LABELS: Record<SearchScope, string> = { all: "All", movie: "Movies", tv: "Series" };

/** Longest search query the catalogue search accepts. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * Ceiling of the result count public.record_search accepts. Lives here, not in lib/schemas.ts, so the client recording
 * island can clamp without pulling Zod into the guest bundle.
 */
export const MAX_SEARCH_RESULT_COUNT = 10_000;

/**
 * Trims and caps a search query. Counts code points rather than UTF-16 units so
 * an emoji is never cut in half (a lone surrogate makes encodeURIComponent throw).
 */
export function normalizeSearchQuery(value: string | undefined) {
  return Array.from((value ?? "").trim()).slice(0, MAX_SEARCH_LENGTH).join("").trim();
}
