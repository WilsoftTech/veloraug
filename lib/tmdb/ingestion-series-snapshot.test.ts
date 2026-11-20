import { describe, expect, it } from "vitest";
import { toSeasonSnapshots, toSeriesSnapshot } from "@/lib/tmdb/ingestion-search";

describe("series publication snapshots", () => {
  it("maps TMDB TV details to the series snapshot the database takes", () => {
    expect(toSeriesSnapshot({
      id: 71446, name: "Money Heist", original_name: "La casa de papel", overview: "  A heist.  ", first_air_date: "2017-05-02",
      poster_path: "/p.jpg", backdrop_path: null, vote_average: 8.24, vote_count: 19000, genres: [{ id: 80, name: "Crime" }],
    })).toEqual({
      tmdb_id: 71446, title: "Money Heist", original_title: "La casa de papel", overview: "A heist.", first_air_date: "2017-05-02",
      poster_path: "/p.jpg", backdrop_path: null, vote_average: 8.24, vote_count: 19000, genres: [{ tmdb_id: 80, name: "Crime" }],
    });
  });

  it("drops an original title equal to the title and blanks", () => {
    const snapshot = toSeriesSnapshot({ id: 1, name: "Same", original_name: "Same", overview: " ", first_air_date: "" });
    expect(snapshot).toMatchObject({ original_title: null, overview: null, first_air_date: null, genres: [] });
  });

  it("refuses a nameless series or a URL as artwork", () => {
    expect(toSeriesSnapshot({ id: 1, name: " " })).toBeNull();
    expect(toSeriesSnapshot({ id: 1, name: "X", poster_path: "https://example.invalid/p.jpg" })).toBeNull();
  });

  it("maps a season and keys its episodes by number", () => {
    const result = toSeasonSnapshots({
      season_number: 1, name: "Part 1", overview: "", air_date: "2017-05-02", poster_path: null,
      episodes: [
        { id: 1, episode_number: 1, season_number: 1, name: "Episode 1", overview: "Start.", air_date: "2017-05-02", runtime: 47, still_path: "/s.jpg" },
        { id: 2, episode_number: 2, season_number: 1, name: null, runtime: 0 },
      ],
    });
    expect(result?.season).toEqual({ season_number: 1, title: "Part 1", overview: null, air_date: "2017-05-02", poster_path: null });
    expect([...result!.episodes.keys()]).toEqual([1, 2]);
    expect(result?.episodes.get(1)).toEqual({ tmdb_id: 1, episode_number: 1, title: "Episode 1", overview: "Start.", air_date: "2017-05-02", runtime_minutes: 47, still_path: "/s.jpg" });
    expect(result?.episodes.get(2)).toMatchObject({ title: null, runtime_minutes: null, air_date: null });
  });

  it("refuses a season with a repeated or foreign episode rather than return part of it", () => {
    const episode = { id: 1, episode_number: 1, season_number: 1 };
    expect(toSeasonSnapshots({ season_number: 1, episodes: [episode, { ...episode, id: 2 }] })).toBeNull();
    expect(toSeasonSnapshots({ season_number: 1, episodes: [{ ...episode, season_number: 2 }] })).toBeNull();
    expect(toSeasonSnapshots({ season_number: 1, episodes: [{ ...episode, episode_number: 0 }] })).toBeNull();
  });
});
