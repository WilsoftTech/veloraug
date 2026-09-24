import { describe, expect, it } from "vitest";
import { buildLookup, rowRef, rowsOf, toInsert } from "@/lib/watchlist-identity";
import type { TitleSummary } from "@/types/catalogue";

function title(kind: TitleSummary["kind"], id: number, tmdbId: number | null): TitleSummary {
  return { kind, id, slug: `${kind}-${id}`, title: `${kind} ${id}`, posterPath: null, releaseYear: null, rating: null, tmdbId, vjs: [] };
}

// Public catalogue: movie 7 (TMDB 550), series 7 (TMDB 1399), movie 8 (no TMDB match).
const lookup = buildLookup([title("movie", 7, 550), title("series", 7, 1399), title("movie", 8, null)]);

describe("toInsert: which identity a save stores", () => {
  it("stores the internal id when the internal id is given", () => {
    expect(toInsert({ source: "catalogue", kind: "movie", id: 7 }, lookup, "refuse")).toEqual({ movie_id: 7, media_type: "movie" });
    expect(toInsert({ source: "catalogue", kind: "series", id: 7 }, lookup, "refuse")).toEqual({ series_id: 7, media_type: "series" });
    expect(toInsert({ source: "catalogue", kind: "movie", id: 8 }, lookup, "refuse")).toEqual({ movie_id: 8, media_type: "movie" });
  });

  it("stores the internal id, never the TMDB id, when a TMDB ref maps to a public title", () => {
    expect(toInsert({ source: "tmdb", mediaType: "movie", id: 550 }, lookup, "refuse")).toEqual({ movie_id: 7, media_type: "movie" });
    expect(toInsert({ source: "tmdb", mediaType: "tv", id: 1399 }, lookup, "refuse")).toEqual({ series_id: 7, media_type: "series" });
  });

  it("never creates a TMDB-only row from an ordinary save (B5)", () => {
    expect(toInsert({ source: "tmdb", mediaType: "movie", id: 999 }, lookup, "refuse")).toBeNull();
    expect(toInsert({ source: "tmdb", mediaType: "tv", id: 999 }, lookup, "refuse")).toBeNull();
  });

  it("keeps an unmatched TMDB title as a legacy row only when importing a pre-B5 guest list", () => {
    expect(toInsert({ source: "tmdb", mediaType: "movie", id: 999 }, lookup, "allow")).toEqual({ tmdb_id: 999, media_type: "movie" });
    expect(toInsert({ source: "tmdb", mediaType: "tv", id: 999 }, lookup, "allow")).toEqual({ tmdb_id: 999, media_type: "tv" });
  });

  it("stores a matched TMDB ref canonically under either policy", () => {
    expect(toInsert({ source: "tmdb", mediaType: "movie", id: 550 }, lookup, "allow")).toEqual({ movie_id: 7, media_type: "movie" });
  });

  it("refuses an internal id that is not public, and never falls back to TMDB for it", () => {
    expect(toInsert({ source: "catalogue", kind: "movie", id: 99 }, lookup, "refuse")).toBeNull();
    expect(toInsert({ source: "catalogue", kind: "series", id: 99 }, lookup, "allow")).toBeNull();
  });

  it("keeps movie, series and TMDB id spaces apart", () => {
    // Series 7 exists; movie 1399 does not, even though a series has TMDB id 1399.
    expect(toInsert({ source: "catalogue", kind: "movie", id: 1399 }, lookup, "refuse")).toBeNull();
    // TMDB movie 1399 is not the TMDB tv title 1399.
    expect(toInsert({ source: "tmdb", mediaType: "movie", id: 1399 }, lookup, "allow")).toEqual({ tmdb_id: 1399, media_type: "movie" });
  });
});

describe("rowRef: reading a stored row", () => {
  it("prefers internal identity over a TMDB id stored on the same row", () => {
    expect(rowRef({ movie_id: 7, series_id: null, tmdb_id: 550, media_type: "movie" })).toEqual({ source: "catalogue", kind: "movie", id: 7 });
    expect(rowRef({ movie_id: null, series_id: 7, tmdb_id: 1399, media_type: "series" })).toEqual({ source: "catalogue", kind: "series", id: 7 });
  });

  it("reads legacy TMDB-only rows as TMDB refs", () => {
    expect(rowRef({ movie_id: null, series_id: null, tmdb_id: 42, media_type: "movie" })).toEqual({ source: "tmdb", mediaType: "movie", id: 42 });
    expect(rowRef({ movie_id: null, series_id: null, tmdb_id: 42, media_type: "tv" })).toEqual({ source: "tmdb", mediaType: "tv", id: 42 });
  });

  it("returns null for a row with no identity", () => {
    expect(rowRef({ movie_id: null, series_id: null, tmdb_id: null, media_type: "movie" })).toBeNull();
  });
});

describe("rowsOf: removal matches every stored form of the title", () => {
  it("matches the internal id and its TMDB alias", () => {
    expect(rowsOf({ source: "catalogue", kind: "movie", id: 7 }, lookup)).toBe("movie_id.eq.7,and(tmdb_id.eq.550,media_type.in.(movie))");
    expect(rowsOf({ source: "tmdb", mediaType: "tv", id: 1399 }, lookup)).toBe("series_id.eq.7,and(tmdb_id.eq.1399,media_type.in.(tv,series))");
  });

  it("matches only the stored form when the title is not public", () => {
    expect(rowsOf({ source: "catalogue", kind: "movie", id: 99 }, lookup)).toBe("movie_id.eq.99");
    expect(rowsOf({ source: "tmdb", mediaType: "movie", id: 999 }, lookup)).toBe("and(tmdb_id.eq.999,media_type.in.(movie))");
  });
});
