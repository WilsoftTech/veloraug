"use server";

import { getAuthedClient } from "@/lib/auth";
import { findTitles } from "@/lib/catalogue";
import { watchlistRefListSchema, watchlistRefSchema } from "@/lib/schemas";
import type { Database } from "@/lib/supabase/database.types";
import { getMediaSummaries } from "@/lib/tmdb/media";
import { mediaWatchlistItem, titleWatchlistItem, watchlistRefKey } from "@/lib/utils";
import type { CatalogueKind, TitleSummary } from "@/types/catalogue";
import type { MediaType } from "@/types/media";
import type { WatchlistItem, WatchlistRef } from "@/types/watchlist";

/**
 * Server-side half of My List for signed-in users. Every action derives the
 * user from the verified session and never accepts a user id; Row Level
 * Security in Postgres is the second, independent guard on every query.
 *
 * Identity: saves are stored by internal catalogue id. A TMDB ref is first
 * resolved to the published catalogue title matched to it, and is stored as a
 * legacy TMDB row only when there is none, so pages that still identify titles
 * by TMDB id keep working. Reads show a legacy row as its catalogue title once
 * one is published; otherwise TMDB describes it. A row neither can describe is
 * still listed, so it can always be removed.
 */
export type WatchlistError = "signed-out" | "invalid" | "full" | "unavailable";
export type WatchlistResult = { ok: true } | { ok: false; error: WatchlistError };
export type WatchlistListResult = { ok: true; items: WatchlistItem[] } | { ok: false; error: WatchlistError };

const CHECK_VIOLATION = "23514"; // raised by the watchlist limit trigger
const UNIQUE_VIOLATION = "23505"; // a concurrent save of the same title committed first

type Client = NonNullable<Awaited<ReturnType<typeof getAuthedClient>>>["supabase"];
type Row = Pick<Database["public"]["Tables"]["watchlist_items"]["Row"], "movie_id" | "series_id" | "tmdb_id" | "media_type">;
type Insert = Database["public"]["Tables"]["watchlist_items"]["Insert"];

const TMDB_TYPE: Record<CatalogueKind, MediaType> = { movie: "movie", series: "tv" };

function failure(error: { code?: string; message: string }, action: string): { ok: false; error: WatchlistError } {
  if (error.code === CHECK_VIOLATION) return { ok: false, error: "full" };
  console.error(`Watchlist ${action} failed`, error.code, error.message);
  return { ok: false, error: "unavailable" };
}

// ---------------------------------------------------------------------------
// Resolution against the published catalogue
// ---------------------------------------------------------------------------

/** The published catalogue title a ref names (directly, or through its TMDB match), or null. */
type Lookup = (ref: WatchlistRef) => TitleSummary | null;

async function lookupTitles(refs: WatchlistRef[]): Promise<Lookup> {
  const ids = (match: (ref: WatchlistRef) => boolean) => [...new Set(refs.filter(match).map((ref) => ref.id))];
  const found = await Promise.all([
    findTitles("movie", "id", ids((ref) => ref.source === "catalogue" && ref.kind === "movie")),
    findTitles("series", "id", ids((ref) => ref.source === "catalogue" && ref.kind === "series")),
    findTitles("movie", "tmdb_id", ids((ref) => ref.source === "tmdb" && ref.mediaType === "movie")),
    findTitles("series", "tmdb_id", ids((ref) => ref.source === "tmdb" && ref.mediaType === "tv")),
  ]);

  const titles = new Map<string, TitleSummary>();
  for (const title of found.flat()) {
    titles.set(watchlistRefKey({ source: "catalogue", kind: title.kind, id: title.id }), title);
    if (title.tmdbId !== null) {
      titles.set(watchlistRefKey({ source: "tmdb", mediaType: TMDB_TYPE[title.kind], id: title.tmdbId }), title);
    }
  }
  return (ref) => titles.get(watchlistRefKey(ref)) ?? null;
}

/** The row a save writes: canonical when the title is published, legacy TMDB otherwise, null when unsavable. */
function toInsert(ref: WatchlistRef, lookup: Lookup): Insert | null {
  const title = lookup(ref);
  if (title) return title.kind === "movie" ? { movie_id: title.id, media_type: "movie" } : { series_id: title.id, media_type: "series" };
  // A catalogue id that is not (or no longer) published cannot be saved.
  return ref.source === "tmdb" ? { tmdb_id: ref.id, media_type: ref.mediaType } : null;
}

/**
 * PostgREST `or` filter matching every row that stores this title, in either
 * form. A tmdb_id is only ever set on rows for that TMDB title (legacy saves,
 * including those the insert trigger mapped to an internal id), so it is safe
 * to match on it alongside the internal id.
 */
function rowsOf(ref: WatchlistRef, lookup: Lookup) {
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function rowRef(row: Row): WatchlistRef | null {
  if (row.movie_id !== null) return { source: "catalogue", kind: "movie", id: row.movie_id };
  if (row.series_id !== null) return { source: "catalogue", kind: "series", id: row.series_id };
  if (row.tmdb_id === null) return null; // excluded by watchlist_items_identity_check
  return { source: "tmdb", mediaType: row.media_type === "movie" ? "movie" : "tv", id: row.tmdb_id };
}

function unavailableItem(ref: WatchlistRef): WatchlistItem {
  return { ref, tmdbId: null, title: "Unavailable title", posterPath: null, releaseYear: null, rating: null, href: null };
}

async function toItems(rows: Row[]): Promise<WatchlistItem[]> {
  const saved = rows.flatMap((row) => {
    const ref = rowRef(row);
    return ref ? [{ row, ref }] : [];
  });
  const lookup = await lookupTitles(saved.map(({ ref }) => ref));

  // Rows without a published catalogue title fall back to TMDB when their TMDB id is known.
  const tmdbRefs = saved.flatMap(({ row, ref }) =>
    lookup(ref) || row.tmdb_id === null ? [] : [{ id: row.tmdb_id, mediaType: row.media_type === "movie" ? ("movie" as const) : ("tv" as const) }],
  );
  const described = new Map(
    (await getMediaSummaries(tmdbRefs)).map((summary) => [
      watchlistRefKey({ source: "tmdb", mediaType: summary.mediaType, id: summary.id }),
      summary,
    ]),
  );

  const items = new Map<string, WatchlistItem>();
  for (const { row, ref } of saved) {
    const title = lookup(ref);
    let item: WatchlistItem;
    if (title) {
      item = titleWatchlistItem(title);
    } else if (row.tmdb_id !== null) {
      const legacyRef: WatchlistRef = { source: "tmdb", mediaType: row.media_type === "movie" ? "movie" : "tv", id: row.tmdb_id };
      const summary = described.get(watchlistRefKey(legacyRef));
      item = summary ? mediaWatchlistItem(summary) : unavailableItem(legacyRef);
    } else {
      item = unavailableItem(ref);
    }
    const key = watchlistRefKey(item.ref);
    if (!items.has(key)) items.set(key, item);
  }
  return [...items.values()];
}

async function readList(supabase: Client): Promise<WatchlistListResult> {
  const { data, error } = await supabase
    .from("watchlist_items")
    .select("movie_id, series_id, tmdb_id, media_type")
    .order("created_at", { ascending: false });
  if (error) return failure(error, "load");

  try {
    return { ok: true, items: await toItems(data) };
  } catch (lookupError) {
    console.error("Watchlist titles could not be resolved", lookupError);
    return { ok: false, error: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function loadWatchlist(): Promise<WatchlistListResult> {
  const session = await getAuthedClient();
  if (!session) return { ok: false, error: "signed-out" };
  return readList(session.supabase);
}

async function lookupOrFail(refs: WatchlistRef[]): Promise<Lookup | null> {
  try {
    return await lookupTitles(refs);
  } catch (lookupError) {
    console.error("Watchlist titles could not be resolved", lookupError);
    return null;
  }
}

export async function addToWatchlist(input: WatchlistRef): Promise<WatchlistResult> {
  const ref = watchlistRefSchema.safeParse(input);
  if (!ref.success) return { ok: false, error: "invalid" };
  const session = await getAuthedClient();
  if (!session) return { ok: false, error: "signed-out" };

  const lookup = await lookupOrFail([ref.data]);
  if (!lookup) return { ok: false, error: "unavailable" };
  const row = toInsert(ref.data, lookup);
  if (!row) return { ok: false, error: "invalid" };

  // Saving twice is a no-op, not an error: the insert trigger skips a title
  // already saved in either form, and a unique index catches a concurrent save.
  const { error } = await session.supabase.from("watchlist_items").insert(row);
  return error && error.code !== UNIQUE_VIOLATION ? failure(error, "add") : { ok: true };
}

export async function removeFromWatchlist(input: WatchlistRef): Promise<WatchlistResult> {
  const ref = watchlistRefSchema.safeParse(input);
  if (!ref.success) return { ok: false, error: "invalid" };
  const session = await getAuthedClient();
  if (!session) return { ok: false, error: "signed-out" };

  const lookup = await lookupOrFail([ref.data]);
  if (!lookup) return { ok: false, error: "unavailable" };

  // No user filter needed: Row Level Security limits the delete to the caller's rows.
  const { error } = await session.supabase.from("watchlist_items").delete().or(rowsOf(ref.data, lookup));
  return error ? failure(error, "remove") : { ok: true };
}

/**
 * Merges a guest list into the account, then returns the full account list.
 * Merge, never replace: titles already saved are untouched, duplicates are
 * skipped, and running it twice with the same input changes nothing. A guest
 * save of a catalogue title that is no longer published has nothing to save
 * and is dropped. The caller clears its local copy only after this returns ok.
 */
export async function importWatchlist(input: WatchlistRef[]): Promise<WatchlistListResult> {
  const refs = watchlistRefListSchema.safeParse(input);
  if (!refs.success) return { ok: false, error: "invalid" };
  const session = await getAuthedClient();
  if (!session) return { ok: false, error: "signed-out" };

  const lookup = await lookupOrFail(refs.data);
  if (!lookup) return { ok: false, error: "unavailable" };
  const rows = [...new Map(refs.data.flatMap((ref) => toInsert(ref, lookup) ?? []).map((row) => [JSON.stringify(row), row])).values()];

  if (rows.length > 0) {
    let { error } = await session.supabase.from("watchlist_items").insert(rows);
    // One statement: a concurrent save aborts it, and on retry the trigger skips what that save committed.
    if (error?.code === UNIQUE_VIOLATION) ({ error } = await session.supabase.from("watchlist_items").insert(rows));
    if (error) return failure(error, "import");
  }
  return readList(session.supabase);
}
