import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findTitles,
  getMovie,
  getSeries,
  getVj,
  listFeatured,
  listGenres,
  listMovies,
  listSeries,
  listVjs,
  searchCatalogue,
  trendingSearches,
} from "@/lib/catalogue";
import { titleWatchlistItem } from "@/lib/utils";
import { buildLookup, toInsert } from "@/lib/watchlist-identity";
import type { Database } from "@/lib/supabase/database.types";

/**
 * B5 catalogue behaviour against the seeded local stack
 * (supabase/seeds/dev-catalogue.sql). Every read runs through lib/catalogue.ts
 * as the anonymous role, exactly as the pages do.
 *
 * Public fixture titles: movies last-kingdom-run (2 VJs, featured),
 * kampala-nights (no artwork), river-crossing and mountain-echo (same
 * published_at), city-of-gold; series pearl-of-africa (featured, seasons 1-2
 * public, season 3 hidden) and kampala-diaries. Hidden: secret-draft,
 * blocked-feature, unready-feature, retired-pick (inactive VJ), hidden-series.
 */

const PUBLIC_MOVIES = ["last-kingdom-run", "kampala-nights", "river-crossing", "mountain-echo", "city-of-gold"];
const HIDDEN_MOVIES = ["secret-draft", "blocked-feature", "unready-feature", "retired-pick"];

// Records every outgoing request, so the suite can prove no TMDB call happens.
const requestedHosts: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requestedHosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("movies", () => {
  it("lists only eligible published movies, newest first", async () => {
    const { items, nextCursor } = await listMovies();
    // Newest first; the published_at tie is broken by id, newest first.
    expect(items.map((item) => item.slug)).toEqual(["last-kingdom-run", "kampala-nights", "mountain-echo", "river-crossing", "city-of-gold"]);
    expect(items.every((item) => item.kind === "movie")).toBe(true);
    expect(nextCursor).toBeNull();
  });

  it("pages through ties without duplicates or gaps, ending with a null cursor", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listMovies({ limit: 2, cursor });
      seen.push(...page.items.map((item) => item.slug));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...PUBLIC_MOVIES].sort());
  });

  it("treats a garbage cursor as the first page", async () => {
    const { items } = await listMovies({ limit: 2, cursor: "not-a-cursor" });
    expect(items.map((item) => item.slug)).toEqual(["last-kingdom-run", "kampala-nights"]);
  });

  it("filters by genre and by VJ", async () => {
    expect((await listMovies({ genreSlug: "action" })).items.map((item) => item.slug)).toEqual(["last-kingdom-run", "city-of-gold"]);
    expect((await listMovies({ vjSlug: "vj-emmy" })).items.map((item) => item.slug)).toEqual(["last-kingdom-run", "river-crossing"]);
    expect((await listMovies({ genreSlug: "comedy" })).items).toEqual([]);
  });

  it("returns nothing for an unknown or inactive VJ slug", async () => {
    expect((await listMovies({ vjSlug: "no-such-vj" })).items).toEqual([]);
    expect((await listMovies({ vjSlug: "vj-retired" })).items).toEqual([]);
  });

  it("lists every VJ of a movie available from several", async () => {
    const movie = (await listMovies()).items.find((item) => item.slug === "last-kingdom-run");
    expect(movie?.vjs.map((vj) => vj.slug)).toEqual(["vj-emmy", "vj-junior"]);
  });

  it("keeps a movie with no artwork, with null paths", async () => {
    const movie = await getMovie("kampala-nights");
    expect(movie).toMatchObject({ posterPath: null, backdropPath: null, rating: null });
  });

  it("returns detail for a public movie and null for hidden or unknown slugs", async () => {
    const movie = await getMovie("last-kingdom-run");
    expect(movie).toMatchObject({ kind: "movie", title: "The Last Kingdom Run", runtimeMinutes: 118, tmdbId: 900001 });
    expect(movie?.genres.map((genre) => genre.slug)).toEqual(["action"]);
    expect(movie?.versions.map((version) => version.vj.slug)).toEqual(["vj-emmy", "vj-junior"]);
    for (const slug of [...HIDDEN_MOVIES, "no-such-movie"]) expect(await getMovie(slug)).toBeNull();
  });
});

describe("series", () => {
  it("lists only eligible published series", async () => {
    expect((await listSeries()).items.map((item) => item.slug)).toEqual(["pearl-of-africa", "kampala-diaries"]);
  });

  it("exposes only available seasons and episodes, in order", async () => {
    const series = await getSeries("pearl-of-africa");
    expect(series?.seasons.map((season) => season.seasonNumber)).toEqual([1, 2]);
    expect(series?.seasons[0].episodes.map((episode) => episode.title)).toEqual(["Homecoming", "The Harbour"]);
    expect(series?.seasons[1].episodes[0].versions.map((version) => version.vj.slug)).toEqual(["vj-junior"]);
    expect(series?.vjs.map((vj) => vj.slug)).toEqual(["vj-emmy", "vj-junior"]);
  });

  it("filters by VJ and genre, and hides draft series", async () => {
    expect((await listSeries({ vjSlug: "vj-emmy" })).items.map((item) => item.slug)).toEqual(["pearl-of-africa"]);
    expect((await listSeries({ genreSlug: "comedy" })).items.map((item) => item.slug)).toEqual(["kampala-diaries"]);
    expect(await getSeries("hidden-series")).toBeNull();
  });
});

describe("home, VJs and genres", () => {
  it("features only featured catalogue titles, newest first", async () => {
    const featured = await listFeatured(5);
    expect(featured.map((title) => `${title.kind}:${title.slug}`)).toEqual(["movie:last-kingdom-run", "series:pearl-of-africa"]);
    expect(featured[0].backdropPath).not.toBeNull();
  });

  it("lists active VJs only and hides inactive ones", async () => {
    expect((await listVjs()).map((vj) => vj.slug)).toEqual(["vj-junior", "vj-emmy"]);
    expect(await getVj("vj-retired")).toBeNull();
    expect(await getVj("vj-emmy")).toMatchObject({ name: "VJ Emmy" });
  });

  it("lists genres", async () => {
    expect((await listGenres()).map((genre) => genre.slug)).toEqual(["action", "comedy", "drama"]);
  });
});

describe("search (catalogue only)", () => {
  it("finds movies and series, prefix matches first", async () => {
    const { titles, vjs } = await searchCatalogue("kampala", "all");
    expect(titles.map((title) => `${title.kind}:${title.slug}`)).toEqual(["movie:kampala-nights", "series:kampala-diaries"]);
    expect(vjs).toEqual([]);
  });

  it("respects the movie and series scopes", async () => {
    expect((await searchCatalogue("kampala", "movie")).titles.map((title) => title.slug)).toEqual(["kampala-nights"]);
    expect((await searchCatalogue("kampala", "tv")).titles.map((title) => title.slug)).toEqual(["kampala-diaries"]);
  });

  it("finds VJs in the all scope, never inactive ones", async () => {
    expect((await searchCatalogue("junior", "all")).vjs.map((vj) => vj.slug)).toEqual(["vj-junior"]);
    expect((await searchCatalogue("retired", "all")).vjs).toEqual([]);
  });

  it("never surfaces hidden titles, and a miss is a real empty result", async () => {
    for (const query of ["secret", "blocked", "unready", "retired pick", "hidden series"]) {
      expect(await searchCatalogue(query, "all")).toEqual({ titles: [], vjs: [] });
    }
  });

  it("treats wildcard characters literally", async () => {
    expect((await searchCatalogue("%", "all")).titles).toEqual([]);
    expect((await searchCatalogue("_", "all")).titles).toEqual([]);
  });

  it("reads trending searches from Velora's own analytics", async () => {
    expect(await trendingSearches()).toEqual([]);
  });
});

describe("legacy TMDB links resolve through the catalogue", () => {
  it("maps a TMDB id only to a public title", async () => {
    expect((await findTitles("movie", "tmdb_id", [900001])).map((title) => title.slug)).toEqual(["last-kingdom-run"]);
    expect(await findTitles("movie", "tmdb_id", [900010])).toEqual([]); // draft
    expect(await findTitles("movie", "tmdb_id", [550])).toEqual([]); // not in the catalogue
  });
});

describe("watchlist saves use Velora identity (authenticated user)", () => {
  it("saves catalogue movies and series by internal id and refuses what is not public", async () => {
    const client = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: auth, error: authError } = await client.auth.signUp({
      email: `b5-${Date.now()}@example.test`,
      password: "b5-integration-password",
    });
    expect(authError).toBeNull();
    expect(auth.session).not.toBeNull();

    const movie = (await getMovie("last-kingdom-run"))!;
    const series = (await getSeries("pearl-of-africa"))!;
    const lookup = buildLookup([movie, series]);

    // What the Add to My List buttons on catalogue pages send, and what the server stores.
    const movieRow = toInsert(titleWatchlistItem(movie).ref, lookup, "refuse");
    const seriesRow = toInsert(titleWatchlistItem(series).ref, lookup, "refuse");
    expect(movieRow).toEqual({ movie_id: movie.id, media_type: "movie" });
    expect(seriesRow).toEqual({ series_id: series.id, media_type: "series" });
    expect((await client.from("watchlist_items").insert([movieRow!, seriesRow!])).error).toBeNull();

    // An ordinary save of an unmatched TMDB title produces nothing to insert.
    expect(toInsert({ source: "tmdb", mediaType: "movie", id: 550 }, lookup, "refuse")).toBeNull();

    // A crafted save of a hidden internal id is refused by the database.
    const { error: draftError } = await client.from("watchlist_items").insert({ movie_id: 999_999, media_type: "movie" });
    expect(draftError?.code).toBe("23503");

    const { data: rows } = await client.from("watchlist_items").select("movie_id, series_id, tmdb_id, media_type");
    expect(rows).toEqual(
      expect.arrayContaining([
        { movie_id: movie.id, series_id: null, tmdb_id: null, media_type: "movie" },
        { movie_id: null, series_id: series.id, tmdb_id: null, media_type: "series" },
      ]),
    );
    expect(rows?.filter((row) => row.movie_id === null && row.series_id === null)).toEqual([]);
  });
});

describe("TMDB boundary at runtime", () => {
  it("made no request to TMDB during any catalogue read", () => {
    expect(requestedHosts.length).toBeGreaterThan(0);
    expect(requestedHosts.filter((host) => host.includes("themoviedb.org"))).toEqual([]);
  });
});
