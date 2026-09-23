import type { CatalogueKind, TitleSummary } from "@/types/catalogue";
import type { BrowseList, MediaSummary, MediaType, SearchScope } from "@/types/media";
import type { WatchlistItem, WatchlistRef } from "@/types/watchlist";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

/** Narrows any media object to the fields safe to store or send to the client. */
export function toSummary({ id, mediaType, title, posterPath, releaseYear, rating }: MediaSummary): MediaSummary {
  return { id, mediaType, title, posterPath, releaseYear, rating };
}

export function mediaHref({ mediaType, id }: Pick<MediaSummary, "mediaType" | "id">) {
  return `/${mediaType}/${id}`;
}

/** Detail page of a published catalogue title. */
export function titleHref(kind: CatalogueKind, slug: string) {
  return `/${kind === "movie" ? "movies" : "series"}/${slug}`;
}

export function mediaTypeLabel(mediaType: MediaType) {
  return mediaType === "movie" ? "Movie" : "TV Show";
}

/** Stable string identity of a saved title; the id alone is ambiguous across id spaces. */
export function watchlistRefKey(ref: WatchlistRef) {
  return ref.source === "catalogue" ? `catalogue:${ref.kind}:${ref.id}` : `tmdb:${ref.mediaType}:${ref.id}`;
}

/** My List entry for a TMDB title (a legacy save until the title is in the catalogue). */
export function mediaWatchlistItem({ id, mediaType, title, posterPath, releaseYear, rating }: MediaSummary): WatchlistItem {
  return { ref: { source: "tmdb", mediaType, id }, tmdbId: null, title, posterPath, releaseYear, rating, href: mediaHref({ mediaType, id }) };
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

// TMDB rejects pages above 500.
const MAX_PAGE = 500;

export function parsePage(value: SearchParamValue) {
  const page = Number.parseInt(firstParam(value) ?? "", 10);
  return Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1;
}

export function parseBrowseList(value: SearchParamValue): BrowseList {
  return firstParam(value) === "top_rated" ? "top_rated" : "popular";
}

export function parseSearchScope(value: SearchParamValue): SearchScope {
  const scope = firstParam(value);
  return scope === "movie" || scope === "tv" ? scope : "all";
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
  return `/search?q=${encodeURIComponent(query)}${scope === "all" ? "" : `&type=${scope}`}`;
}

export const SEARCH_SCOPE_LABELS: Record<SearchScope, string> = { all: "All", movie: "Movies", tv: "TV Shows" };

/** Longest search query that is forwarded to TMDB. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * Ceiling of the result count public.record_search accepts (TMDB itself stops at
 * 500 pages x 20). Lives here, not in lib/schemas.ts, so the client recording
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
