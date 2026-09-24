import { describe, expect, it } from "vitest";
import {
  containsPattern,
  mediaWatchlistItem,
  parseSearchScope,
  parseSlug,
  rankByTitleMatch,
  searchHref,
  titleHref,
  titleWatchlistItem,
} from "@/lib/utils";

describe("containsPattern: catalogue search ILIKE pattern", () => {
  it("wraps the query in wildcards", () => {
    expect(containsPattern("kampala")).toBe("%kampala%");
    expect(containsPattern("  kampala nights ")).toBe("%kampala nights%");
  });

  it("escapes LIKE wildcards so they match literally", () => {
    expect(containsPattern("100%")).toBe("%100\\%%");
    expect(containsPattern("a_b")).toBe("%a\\_b%");
    expect(containsPattern("back\\slash")).toBe("%back\\\\slash%");
  });

  it("turns PostgREST's * wildcard into a one-character match", () => {
    expect(containsPattern("M*A*S*H")).toBe("%M_A_S_H%");
  });

  it("is null for an empty query", () => {
    expect(containsPattern("   ")).toBeNull();
  });
});

describe("rankByTitleMatch", () => {
  it("ranks exact, then prefix, then contains, keeping order within a rank", () => {
    const titles = ["Nights in Kampala", "Kampala Nights", "kampala", "Kampala Diaries"];
    expect(rankByTitleMatch(titles, "Kampala", (title) => title)).toEqual([
      "kampala",
      "Kampala Nights",
      "Kampala Diaries",
      "Nights in Kampala",
    ]);
  });
});

describe("search scope URLs", () => {
  it("says series in URLs and keeps the stored tv scope", () => {
    expect(searchHref("pearl", "tv")).toBe("/search?q=pearl&type=series");
    expect(searchHref("pearl", "movie")).toBe("/search?q=pearl&type=movie");
    expect(searchHref("pearl")).toBe("/search?q=pearl");
    expect(parseSearchScope("series")).toBe("tv");
    expect(parseSearchScope("tv")).toBe("tv");
    expect(parseSearchScope("people")).toBe("all");
  });
});

describe("parseSlug", () => {
  it("accepts only database-shaped slugs", () => {
    expect(parseSlug("vj-junior")).toBe("vj-junior");
    expect(parseSlug(["pearl-of-africa", "x"])).toBe("pearl-of-africa");
    for (const bad of ["", "Upper", "a--b", "-a", "a b", "a,b", "x".repeat(101), undefined]) {
      expect(parseSlug(bad)).toBeNull();
    }
  });
});

describe("watchlist items use Velora identity", () => {
  const summary = { kind: "movie" as const, id: 7, slug: "last-kingdom-run", title: "T", posterPath: null, releaseYear: null, rating: null, tmdbId: 550, vjs: [] };

  it("a catalogue item saves by internal id and links to its Velora page", () => {
    expect(titleWatchlistItem(summary)).toMatchObject({ ref: { source: "catalogue", kind: "movie", id: 7 }, tmdbId: 550, href: "/movies/last-kingdom-run" });
    expect(titleWatchlistItem({ ...summary, kind: "series" })).toMatchObject({ ref: { source: "catalogue", kind: "series", id: 7 }, href: "/series/last-kingdom-run" });
    expect(titleHref("series", "pearl-of-africa")).toBe("/series/pearl-of-africa");
  });

  it("a legacy TMDB item has no Velora page", () => {
    const legacy = mediaWatchlistItem({ id: 550, mediaType: "movie", title: "T", posterPath: null, releaseYear: null, rating: null });
    expect(legacy.ref).toEqual({ source: "tmdb", mediaType: "movie", id: 550 });
    expect(legacy.href).toBeNull();
  });
});
