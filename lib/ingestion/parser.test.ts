import { describe, expect, it } from "vitest";
import { normalizeTitle, unifySeparators, vjKey } from "@/lib/ingestion/normalize";
import { decideKind, parseFilename } from "@/lib/ingestion/parser";

const parse = (name: string) => parseFilename(name, { maxYear: 2027 });
const codes = (name: string) => parse(name).issues.map((issue) => issue.code);
const facts = (name: string) => {
  const { inferredKind, title, vjText, year, season, episode } = parse(name);
  return { inferredKind, title, vjText, year, season, episode };
};

describe("normalize", () => {
  it("unifies dots, underscores and repeated whitespace", () => {
    expect(unifySeparators("John.Wick__2014   VJ\tJunior")).toBe("John Wick 2014 VJ Junior");
  });

  it("keeps in-word hyphens and turns spaced hyphens into segment separators", () => {
    expect(unifySeparators("Spider-Man.-.VJ.Junior")).toBe("Spider-Man - VJ Junior");
    expect(unifySeparators("John Wick -VJ Junior- 2014")).toBe("John Wick - VJ Junior - 2014");
  });

  it("normalizes titles: case, punctuation, accents, ampersands", () => {
    expect(normalizeTitle("Mission: Impossible – Dead Reckoning")).toBe("mission impossible dead reckoning");
    expect(normalizeTitle("Amélie")).toBe("amelie");
    expect(normalizeTitle("Fast & Furious")).toBe("fast and furious");
    expect(normalizeTitle("Ocean's  Eleven!!")).toBe("oceans eleven");
  });

  it("gives one VJ key for spelling variants and drops a leading VJ", () => {
    for (const variant of ["VJ Junior", "vj-junior", "Junior", "VJ.JUNIOR", " vj  junior "]) expect(vjKey(variant)).toBe("junior");
    expect(vjKey("Ice P")).toBe(vjKey("VJ IceP"));
    expect(vjKey("Vjunior")).toBe("vjunior");
  });
});

describe("parseFilename: movies", () => {
  it("reads title + VJ", () => {
    expect(facts("John Wick VJ Junior.mp4")).toEqual({ inferredKind: "movie", title: "John Wick", vjText: "Junior", year: null, season: null, episode: null });
    expect(parse("John Wick VJ Junior.mp4").confidence).toBe("high");
  });

  it("reads dotted names with a year", () => {
    expect(facts("John.Wick.2014.VJ.Junior.mp4")).toMatchObject({ title: "John Wick", vjText: "Junior", year: 2014 });
  });

  it("reads a VJ prefix and a parenthesised year", () => {
    expect(facts("VJ Junior - John Wick (2014).mkv")).toMatchObject({ title: "John Wick", vjText: "Junior", year: 2014 });
  });

  it("reads hyphen-separated segments", () => {
    expect(facts("John Wick - VJ Junior - 2014.mp4")).toMatchObject({ title: "John Wick", vjText: "Junior", year: 2014 });
  });

  it("ignores case, underscores and release noise", () => {
    expect(facts("spider-man_no_way_home_2021_1080p_x264_vj_junior.MP4")).toMatchObject({ title: "spider-man no way home", vjText: "junior", year: 2021 });
    expect(parse("Avatar.2009.VJ.Junior.MKV").extension).toBe("mkv");
  });

  it("uses only the file name of a Windows or POSIX path", () => {
    expect(facts(String.raw`D:\Library\VJ Emmy\Titanic.1997.VJ.Emmy.mp4`)).toMatchObject({ title: "Titanic", vjText: "Emmy", year: 1997 });
    expect(parse("/srv/library/Titanic.1997.VJ.Emmy.mp4").fileName).toBe("Titanic.1997.VJ.Emmy.mp4");
  });

  it("keeps a numeric title that is not a year, and takes the last year", () => {
    expect(facts("1917 VJ Junior.mp4")).toMatchObject({ title: "1917", year: null });
    expect(facts("2012.2009.VJ.Junior.mp4")).toMatchObject({ title: "2012", year: 2009 });
    expect(codes("2012.2009.VJ.Junior.mp4")).toEqual(["multiple_years"]);
    expect(facts("Blade Runner 2049 (2017) VJ Junior.mp4")).toMatchObject({ title: "Blade Runner 2049", year: 2017 });
  });

  it("strips 'translated by' and reads multi-word VJ names up to a boundary", () => {
    expect(facts("Avatar 2009 Translated by VJ Ice P.mp4")).toMatchObject({ title: "Avatar", vjText: "Ice P", year: 2009 });
  });

  it("reports a missing VJ instead of inventing one", () => {
    expect(facts("John Wick 2014.mp4")).toMatchObject({ title: "John Wick", vjText: null, year: 2014 });
    expect(parse("John Wick 2014.mp4").issues).toEqual([{ code: "missing_vj", blocking: true }]);
    expect(parse("John Wick 2014.mp4").confidence).toBe("low");
  });

  it("flags an unbounded VJ prefix and trusts only its first word", () => {
    expect(facts("VJ Junior John Wick 2014.mp4")).toMatchObject({ title: "John Wick", vjText: "Junior" });
    expect(parse("VJ Junior John Wick 2014.mp4").issues).toEqual([{ code: "vj_boundary_uncertain", blocking: false }]);
    expect(parse("VJ Junior John Wick 2014.mp4").confidence).toBe("medium");
  });

  it("flags two different VJs, not the same VJ written twice", () => {
    expect(codes("VJ Junior - John Wick - VJ Emmy.mp4")).toContain("multiple_vjs");
    expect(codes("VJ Junior - John Wick - vj.junior.mp4")).not.toContain("multiple_vjs");
  });

  it("handles malformed names without inventing metadata", () => {
    expect(parse("VJ Junior.mp4")).toMatchObject({ title: null, vjText: "Junior", confidence: "low" });
    expect(codes("VJ Junior.mp4")).toContain("empty_title");
    expect(codes("notes.txt")).toContain("unsupported_extension");
    expect(codes("John Wick VJ Junior")).toContain("unsupported_extension");
    expect(parse("...mp4")).toMatchObject({ title: null, vjText: null, confidence: "low" });
    expect(parse("")).toMatchObject({ title: null, confidence: "low" });
  });

  it("is deterministic", () => {
    expect(parse("John.Wick.2014.VJ.Junior.mp4")).toEqual(parse("John.Wick.2014.VJ.Junior.mp4"));
  });
});

describe("parseFilename: series", () => {
  it("reads SxxExx", () => {
    expect(facts("Prison Break S01E01 VJ Junior.mp4")).toEqual({ inferredKind: "series", title: "Prison Break", vjText: "Junior", year: null, season: 1, episode: 1 });
  });

  it("reads lower-case single-digit markers", () => {
    expect(facts("prison break s1e1 vj junior.mp4")).toMatchObject({ title: "prison break", season: 1, episode: 1 });
  });

  it("reads dotted names and other seasons", () => {
    expect(facts("Prison.Break.S02E05.VJ.Junior.mkv")).toMatchObject({ title: "Prison Break", season: 2, episode: 5 });
    expect(facts("VJ Junior - Prison Break - S03E02.mp4")).toMatchObject({ title: "Prison Break", vjText: "Junior", season: 3, episode: 2 });
  });

  it("reads multi-digit episodes and alternative notations", () => {
    expect(facts("Greys Anatomy S12E105 VJ Emmy.mp4")).toMatchObject({ season: 12, episode: 105 });
    expect(facts("One Piece S01E1052 VJ Junior.mp4")).toMatchObject({ season: 1, episode: 1052 });
    expect(facts("Prison Break S01 E12 VJ Junior.mp4")).toMatchObject({ season: 1, episode: 12 });
    expect(facts("Prison Break 2x07 VJ Junior.mp4")).toMatchObject({ season: 2, episode: 7 });
    expect(facts("Prison Break Season 4 Episode 22 VJ Junior.mp4")).toMatchObject({ season: 4, episode: 22 });
  });

  it("reports a missing episode or season", () => {
    expect(facts("Prison Break S01 VJ Junior.mp4")).toMatchObject({ inferredKind: "series", season: 1, episode: null });
    expect(codes("Prison Break S01 VJ Junior.mp4")).toEqual(["missing_episode"]);
    expect(facts("Prison Break E05 VJ Junior.mp4")).toMatchObject({ inferredKind: "series", season: null, episode: 5 });
    expect(codes("Prison Break Episode 5 VJ Junior.mp4")).toEqual(["missing_season"]);
  });

  it("blocks multi-episode files and conflicting markers", () => {
    expect(codes("Prison Break S01E01E02 VJ Junior.mp4")).toEqual(["multi_episode"]);
    expect(codes("Prison Break S01E01 S01E02 VJ Junior.mp4")).toEqual(["multiple_episode_markers"]);
  });

  it("reads a VJ prefix or suffix around the marker", () => {
    expect(facts("Prison Break S01E01 VJ Junior.mp4").vjText).toBe("Junior");
    expect(facts("VJ Junior Prison Break S01E01.mp4")).toMatchObject({ vjText: "Junior", title: "Prison Break" });
  });
});

describe("decideKind", () => {
  it("confirms a declared kind that agrees", () => {
    expect(decideKind("movie", parse("John Wick VJ Junior.mp4"))).toEqual({ status: "confirmed", kind: "movie" });
    expect(decideKind("series", parse("Prison Break S01E01 VJ Junior.mp4"))).toEqual({ status: "confirmed", kind: "series" });
  });

  it("keeps a declared series without markers a series (approval is then blocked)", () => {
    expect(decideKind("series", parse("Prison Break VJ Junior.mp4"))).toEqual({ status: "confirmed", kind: "series" });
  });

  it("never turns an episode file into a movie", () => {
    expect(decideKind("movie", parse("Prison Break S01E01 VJ Junior.mp4"))).toEqual({ status: "conflict", declared: "movie", inferred: "series" });
  });

  it("marks a kind without a declaration as inferred", () => {
    expect(decideKind(null, parse("Prison Break S01E01 VJ Junior.mp4"))).toEqual({ status: "inferred", kind: "series" });
  });
});
