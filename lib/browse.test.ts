import { describe, expect, it } from "vitest";
import { browseHref, hasBrowseFilters, parseBrowseFilters } from "@/lib/browse";

describe("browse URL contract", () => {
  it("builds canonical URLs with a fixed parameter order and no empty values", () => {
    expect(browseHref("movie")).toBe("/movies");
    expect(browseHref("series", { vj: "vj-emmy", genre: "drama" })).toBe("/series?genre=drama&vj=vj-emmy");
    expect(browseHref("movie", { genre: null, vj: null, cursor: "abc_-1" })).toBe("/movies?cursor=abc_-1");
  });

  it("round-trips valid filters", () => {
    const filters = parseBrowseFilters({ genre: "action", vj: "vj-junior", cursor: "WyIyMDI2Il0" });
    expect(filters).toEqual({ genre: "action", vj: "vj-junior", cursor: "WyIyMDI2Il0" });
    expect(browseHref("movie", filters)).toBe("/movies?genre=action&vj=vj-junior&cursor=WyIyMDI2Il0");
    expect(hasBrowseFilters(filters)).toBe(true);
  });

  it("drops invalid slugs and cursors instead of querying them", () => {
    expect(parseBrowseFilters({ genre: "Action!", vj: "a,b", cursor: "not a cursor" })).toEqual({ genre: null, vj: null, cursor: null });
    expect(parseBrowseFilters({ genre: "28" })).toEqual({ genre: "28", vj: null, cursor: null }); // old TMDB id: valid shape, matches nothing
    expect(hasBrowseFilters(parseBrowseFilters({}))).toBe(false);
  });
});
