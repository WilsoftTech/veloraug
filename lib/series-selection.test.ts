import { describe, expect, it } from "vitest";
import { episodeLabel, seasonLabel, selectEpisode, seriesEpisodeHref } from "@/lib/series-selection";
import type { Episode, Season } from "@/types/catalogue";

const episode = (episodeNumber: number, title: string | null = null): Episode => ({
  id: episodeNumber * 100, episodeNumber, title, overview: null, airDate: null, runtimeMinutes: null, stillPath: null, versions: [],
});
const season = (seasonNumber: number, episodes: number[]): Season => ({
  id: seasonNumber + 1, seasonNumber, title: null, overview: null, airDate: null, posterPath: null, episodes: episodes.map((number) => episode(number)),
});
const SEASONS = [season(0, [1]), season(1, [1, 2, 3]), season(2, [1, 2])];
const pick = (query: { season?: string | string[]; episode?: string | string[] }) => {
  const selection = selectEpisode("money-heist-2017", SEASONS, query);
  return selection && { season: selection.season.seasonNumber, episode: selection.episode?.episodeNumber ?? null, href: selection.href, corrected: selection.corrected };
};

describe("series episode selection", () => {
  it("opens the first regular season and its first episode by default", () => {
    expect(pick({})).toEqual({ season: 1, episode: 1, href: "/series/money-heist-2017?season=1&episode=1", corrected: false });
  });

  it("selects the requested season and episode", () => {
    expect(pick({ season: "2", episode: "2" })).toEqual({ season: 2, episode: 2, href: "/series/money-heist-2017?season=2&episode=2", corrected: false });
    expect(pick({ season: "0", episode: "1" })).toMatchObject({ season: 0, episode: 1, corrected: false });
  });

  it("treats a season alone as its first episode without a correction", () => {
    expect(pick({ season: "2" })).toEqual({ season: 2, episode: 1, href: "/series/money-heist-2017?season=2&episode=1", corrected: false });
  });

  it("corrects an address naming something that is not published", () => {
    expect(pick({ season: "9" })).toMatchObject({ season: 1, episode: 1, corrected: true });
    expect(pick({ season: "2", episode: "3" })).toMatchObject({ season: 2, episode: 1, corrected: true });
    expect(pick({ episode: "2" })).toMatchObject({ season: 1, episode: 1, corrected: true });
    for (const bad of ["abc", "-1", "1.5", " 1", "1e2", "99999"]) expect(pick({ season: bad })).toMatchObject({ season: 1, corrected: true });
    expect(pick({ season: ["1", "2"] })).toMatchObject({ season: 1, corrected: true });
  });

  it("falls back to specials only when nothing else is published, and to nothing for no seasons", () => {
    expect(selectEpisode("x", [season(0, [1])], {})?.season.seasonNumber).toBe(0);
    expect(selectEpisode("x", [], {})).toBeNull();
    expect(selectEpisode("x", [season(1, [])], {})?.episode).toBeNull();
  });

  it("labels seasons and episodes", () => {
    expect(seasonLabel({ title: null, seasonNumber: 0 })).toBe("Specials");
    expect(seasonLabel({ title: null, seasonNumber: 2 })).toBe("Season 2");
    expect(seasonLabel({ title: "Part 3", seasonNumber: 3 })).toBe("Part 3");
    expect(episodeLabel(episode(4, "Plan Paris"))).toBe("E4 · Plan Paris");
    expect(episodeLabel(episode(5))).toBe("Episode 5");
    expect(seriesEpisodeHref("a-b", 1)).toBe("/series/a-b?season=1");
  });
});

describe("episode player wording", () => {
  it("says episode where the movie player says movie", async () => {
    const { forTarget, playerFailureMessage } = await import("@/lib/playback/player");
    expect(playerFailureMessage("auth_required", false, "episode")).toBe("Sign in to watch this episode.");
    expect(playerFailureMessage("unavailable", true, "episode")).toBe("This episode isn't available to watch right now.");
    expect(playerFailureMessage("auth_required", false)).toBe("Sign in to watch this movie.");
    expect(forTarget("This movie is no longer available to download.", "episode")).toBe("This episode is no longer available to download.");
  });
});
