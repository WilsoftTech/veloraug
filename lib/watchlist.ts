import { useSyncExternalStore } from "react";
import { getSession, subscribeSession, type SessionState } from "@/lib/session";
import { mediaWatchlistItem, watchlistRefKey } from "@/lib/utils";
import {
  addToWatchlist,
  importWatchlist,
  loadWatchlist,
  removeFromWatchlist,
  type WatchlistError,
  type WatchlistResult,
} from "@/lib/watchlist-actions";
import type { MediaSummary } from "@/types/media";
import type { WatchlistItem, WatchlistRef } from "@/types/watchlist";

/**
 * My List. One interface, two homes:
 *
 *   guest      → localStorage (this file; only what is needed to render a row)
 *   signed in  → Postgres via server actions (ids only; the catalogue, or TMDB
 *                for legacy saves, supplies the rest)
 *
 * A title may be known by its catalogue id or by the TMDB id it was matched to,
 * so matching (`sameTitle`) accepts either.
 *
 * When a guest signs in, their local list is merged into the account and the
 * local copy is cleared only after the server confirms (see `runSync`).
 * Signed-in items are never written to localStorage.
 */
const STORAGE_KEY = "velora:my-list";

export type WatchlistStatus = "loading" | "ready" | "error";
export type MutationError = WatchlistError | "loading";

interface Snapshot {
  /** null until the current source is readable, so callers can show a skeleton instead of a false "empty" state. */
  items: WatchlistItem[] | null;
  status: WatchlistStatus;
  /** Guest items could not be moved into the account. They remain safe in this browser. */
  importFailed: boolean;
  loadError: WatchlistError | null;
  /** The last change that had to be rolled back, and the title it concerned. */
  mutationError: { item: WatchlistItem; error: MutationError } | null;
}

const LOADING: Snapshot = { items: null, status: "loading", importFailed: false, loadError: null, mutationError: null };

let snapshot = LOADING;
let session: SessionState = "unknown";
const listeners = new Set<() => void>();

function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  // "Still loading" stops being true the moment the list arrives; don't leave it on screen.
  if (snapshot.items && snapshot.mutationError?.error === "loading") snapshot = { ...snapshot, mutationError: null };
  listeners.forEach((listener) => listener());
}

/** The TMDB identity a catalogue item was matched to, as a ref. */
function tmdbAlias({ ref, tmdbId }: WatchlistItem): WatchlistRef | null {
  if (ref.source !== "catalogue" || tmdbId === null) return null;
  return { source: "tmdb", mediaType: ref.kind === "movie" ? "movie" : "tv", id: tmdbId };
}

/** Whether two entries are the same title, whichever id each page knows it by. */
export function sameTitle(a: WatchlistItem, b: WatchlistItem) {
  const keys = (item: WatchlistItem) => [item.ref, tmdbAlias(item)].flatMap((ref) => (ref ? [watchlistRefKey(ref)] : []));
  const other = keys(b);
  return keys(a).some((key) => other.includes(key));
}

// ---------------------------------------------------------------------------
// Guest storage
// ---------------------------------------------------------------------------

let guestCache: WatchlistItem[] | null = null;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null;
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const orNull = (value: unknown, type: "string" | "number") => value === null || typeof value === type;

function hasDisplayFields(item: Fields) {
  return typeof item.title === "string" && orNull(item.posterPath, "string") && orNull(item.releaseYear, "number") && orNull(item.rating, "number");
}

function isRef(value: unknown): value is WatchlistRef {
  if (!isObject(value) || !isId(value.id)) return false;
  if (value.source === "catalogue") return value.kind === "movie" || value.kind === "series";
  return value.source === "tmdb" && (value.mediaType === "movie" || value.mediaType === "tv");
}

const isLocalPath = (value: unknown) => value === null || (typeof value === "string" && value.startsWith("/") && !value.startsWith("//"));

/**
 * Accepts the current entry shape and the pre-catalogue one (a TMDB MediaSummary),
 * rebuilt from known fields only: storage is user-editable, and the ref is later
 * sent to a strict server schema.
 */
function fromStorage(value: unknown): WatchlistItem | null {
  if (!isObject(value) || !hasDisplayFields(value)) return null;
  const { ref, tmdbId, title, posterPath, releaseYear, rating, href } = value as Fields & Omit<WatchlistItem, "ref">;
  if (isRef(ref) && (tmdbId === null || isId(tmdbId)) && isLocalPath(href)) {
    const clean: WatchlistRef =
      ref.source === "catalogue" ? { source: "catalogue", kind: ref.kind, id: ref.id } : { source: "tmdb", mediaType: ref.mediaType, id: ref.id };
    // A legacy TMDB entry has no Velora page since B5 (its old /movie/:id link is dropped).
    return { ref: clean, tmdbId, title, posterPath, releaseYear, rating, href: clean.source === "tmdb" ? null : href };
  }
  if (isId(value.id) && (value.mediaType === "movie" || value.mediaType === "tv")) {
    return mediaWatchlistItem(value as unknown as MediaSummary);
  }
  return null;
}

function readGuest(): WatchlistItem[] {
  if (guestCache) return guestCache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    guestCache = Array.isArray(parsed) ? parsed.flatMap((value) => fromStorage(value) ?? []) : [];
  } catch (error) {
    console.warn("Could not read My List from storage.", error);
    guestCache = [];
  }
  return guestCache;
}

function writeGuest(next: WatchlistItem[]) {
  guestCache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("Could not save My List to storage.", error);
  }
}

function removeFromGuest(imported: WatchlistItem[]) {
  // Re-read first: anything saved in another tab in the meantime must survive.
  guestCache = null;
  writeGuest(readGuest().filter((item) => !imported.some((gone) => sameTitle(gone, item))));
}

// ---------------------------------------------------------------------------
// Account sync
// ---------------------------------------------------------------------------

let syncing = false;
let syncAgain = false;

/** Serialises syncs; a request that arrives mid-sync runs once more afterwards. */
async function syncAccount() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      await runSync();
    } while (syncAgain && session === "signed-in");
  } catch (error) {
    console.error("Could not sync My List with the account.", error);
    if (session === "signed-in") publish({ status: "error", loadError: "unavailable" });
  } finally {
    syncing = false;
  }
}

async function runSync() {
  // Merge, never replace. Idempotent on the server, so a retry (or two tabs
  // racing) is harmless, and local items go away only once the server confirms.
  const pending = readGuest();
  let importFailed = false;

  if (pending.length > 0) {
    const imported = await importWatchlist(pending.map((item) => item.ref));
    if (session !== "signed-in") return;
    if (imported.ok) {
      removeFromGuest(pending);
      publish({ items: imported.items, status: "ready", importFailed: false, loadError: null });
      return;
    }
    console.warn("Could not move the guest My List into the account.", imported.error);
    importFailed = true;
  }

  const loaded = await loadWatchlist();
  if (session !== "signed-in") return;
  if (loaded.ok) publish({ items: loaded.items, status: "ready", importFailed, loadError: null });
  else publish({ status: "error", importFailed, loadError: loaded.error });
}

function onSessionChange() {
  const next = getSession();
  if (next === session) return;
  session = next;

  if (next === "signed-out") {
    guestCache = null;
    publish({ items: readGuest(), status: "ready", importFailed: false, loadError: null, mutationError: null });
  } else if (next === "signed-in") {
    publish({ ...LOADING });
    void syncAccount();
  } else {
    publish({ ...LOADING });
  }
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY) return;
  guestCache = null;
  if (session === "signed-out") publish({ items: readGuest() });
  else if (session === "signed-in" && readGuest().length > 0) void syncAccount();
}

function onVisibilityChange() {
  // Cheap cross-tab / cross-device freshness for the signed-in list.
  if (document.visibilityState === "visible" && session === "signed-in" && snapshot.status === "ready") void syncAccount();
}

let active = false;

/** Wires the browser listeners once, on the first subscriber (client only). */
function activate() {
  if (active) return;
  active = true;
  subscribeSession(onSessionChange);
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisibilityChange);
  onSessionChange();
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

function currentList() {
  return session === "signed-in" ? snapshot.items : readGuest();
}

function guestSet(entry: WatchlistItem, saved: boolean) {
  const others = readGuest().filter((item) => !sameTitle(item, entry));
  const next = saved ? [entry, ...others] : others;
  writeGuest(next);
  publish({ items: next, mutationError: null });
}

async function accountSet(entry: WatchlistItem, saved: boolean) {
  const before = snapshot.items;
  if (!before) {
    publish({ mutationError: { item: entry, error: "loading" } });
    return;
  }

  // Optimistic: the list changes now and is rolled back if the server refuses.
  const without = (list: WatchlistItem[]) => list.filter((item) => !sameTitle(item, entry));
  publish({ items: saved ? [entry, ...without(before)] : without(before), mutationError: null });

  let result: WatchlistResult;
  try {
    result = await (saved ? addToWatchlist(entry.ref) : removeFromWatchlist(entry.ref));
  } catch (error) {
    console.error("My List change did not reach the server.", error);
    result = { ok: false, error: "unavailable" };
  }
  if (result.ok) return;

  // Undo against the current list, so unrelated changes made meanwhile survive.
  const current = snapshot.items ?? [];
  publish({ items: saved ? without(current) : [entry, ...without(current)], mutationError: { item: entry, error: result.error } });
}

function setSaved(entry: WatchlistItem, saved: boolean) {
  if (session === "signed-in") void accountSet(entry, saved);
  else guestSet(entry, saved);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  activate();
  return () => {
    listeners.delete(listener);
  };
}

export function useWatchlist() {
  const { items, status, importFailed, loadError, mutationError } = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => LOADING,
  );

  return {
    items,
    status,
    importFailed,
    loadError,
    mutationError,
    has: (entry: WatchlistItem) => items?.some((item) => sameTitle(item, entry)) ?? false,
    /** Removing uses the saved entry, so the server matches the form it was stored in. */
    toggle: (entry: WatchlistItem) => {
      const existing = currentList()?.find((item) => sameTitle(item, entry));
      setSaved(existing ?? entry, !existing);
    },
    remove: (entry: WatchlistItem) => {
      const existing = currentList()?.find((item) => sameTitle(item, entry));
      if (existing) setSaved(existing, false);
    },
    /** Tries the account sync again after a load or import failure. */
    retry: () => {
      publish({ status: "loading", loadError: null });
      void syncAccount();
    },
  };
}
