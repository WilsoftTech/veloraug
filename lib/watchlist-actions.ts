"use server";

import { getAuthedClient } from "@/lib/auth";
import { findTitles } from "@/lib/catalogue";
import { watchlistRefListSchema, watchlistRefSchema } from "@/lib/schemas";
import { getMediaSummaries } from "@/lib/tmdb/media";
import { mediaWatchlistItem, titleWatchlistItem, watchlistRefKey } from "@/lib/utils";
import { buildLookup, rowRef, rowsOf, toInsert, type TitleLookup, type WatchlistRow } from "@/lib/watchlist-identity";
import type { WatchlistItem, WatchlistRef } from "@/types/watchlist";

/**
 * Server-side half of My List for signed-in users. Every action derives the
 * user from the verified session and never accepts a user id; Row Level
 * Security in Postgres is the second, independent guard on every query.
 *
 * Identity (lib/watchlist-identity.ts): saves are stored by internal catalogue
 * id. A TMDB ref is first resolved to the public catalogue title matched to it,
 * and is stored as a legacy TMDB row only when there is none, so pre-B5 pages
 * that still identify titles by TMDB id keep working. Reads show a legacy row as
 * its catalogue title once one is public; otherwise TMDB describes it. A row
 * neither can describe is still listed, so it can always be removed.
 */
export type WatchlistError = "signed-out" | "invalid" | "full" | "unavailable";
export type WatchlistResult = { ok: true } | { ok: false; error: WatchlistError };
export type WatchlistListResult = { ok: true; items: WatchlistItem[] } | { ok: false; error: WatchlistError };

const CHECK_VIOLATION = "23514"; // raised by the watchlist limit trigger
const UNIQUE_VIOLATION = "23505"; // a concurrent save of the same title committed first
// Raised by the insert trigger when an internal id is not a public title, e.g.
// one unpublished between our lookup and the insert.
const NOT_AVAILABLE = "23503";

type Client = NonNullable<Awaited<ReturnType<typeof getAuthedClient>>>["supabase"];

function failure(error: { code?: string; message: string }, action: string): { ok: false; error: WatchlistError } {
  if (error.code === CHECK_VIOLATION) return { ok: false, error: "full" };
  if (error.code === NOT_AVAILABLE) return { ok: false, error: "invalid" };
  console.error(`Watchlist ${action} failed`, error.code, error.message);
  return { ok: false, error: "unavailable" };
}

// ---------------------------------------------------------------------------
// Resolution against the published catalogue
// ---------------------------------------------------------------------------

async function lookupTitles(refs: WatchlistRef[]): Promise<TitleLookup> {
  const ids = (match: (ref: WatchlistRef) => boolean) => [...new Set(refs.filter(match).map((ref) => ref.id))];
  const found = await Promise.all([
    findTitles("movie", "id", ids((ref) => ref.source === "catalogue" && ref.kind === "movie")),
    findTitles("series", "id", ids((ref) => ref.source === "catalogue" && ref.kind === "series")),
    findTitles("movie", "tmdb_id", ids((ref) => ref.source === "tmdb" && ref.mediaType === "movie")),
    findTitles("series", "tmdb_id", ids((ref) => ref.source === "tmdb" && ref.mediaType === "tv")),
  ]);
  return buildLookup(found.flat());
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function unavailableItem(ref: WatchlistRef): WatchlistItem {
  return { ref, tmdbId: null, title: "Unavailable title", posterPath: null, releaseYear: null, rating: null, href: null };
}

async function toItems(rows: WatchlistRow[]): Promise<WatchlistItem[]> {
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

async function lookupOrFail(refs: WatchlistRef[]): Promise<TitleLookup | null> {
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
