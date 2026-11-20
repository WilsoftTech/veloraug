import { describe, expect, it } from "vitest";
import { adminCatalogueHref, parseAdminCatalogueFilters, browseHref, hasBrowseFilters, parseBrowseFilters } from "@/lib/browse";

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


describe("admin catalogue URL contract", () => {
  it("normalizes filters and builds a shareable cursor URL", () => {
    const filters = parseAdminCatalogueFilters({ q: "  VJ Test & Film  ", status: "archived", cursor: "9007199254740993" });
    expect(filters).toEqual({ q: "VJ Test & Film", status: "archived", cursor: "9007199254740993" });
    expect(adminCatalogueHref(filters)).toBe("/admin/catalogue?q=VJ+Test+%26+Film&status=archived&cursor=9007199254740993");
    expect(adminCatalogueHref({ ...filters, cursor: null })).toBe("/admin/catalogue?q=VJ+Test+%26+Film&status=archived");
    expect(adminCatalogueHref(parseAdminCatalogueFilters({}))).toBe("/admin/catalogue");
  });
  it("drops malformed, repeated and out-of-range cursors without rounding bigint ids", () => {
    for (const cursor of ["0", "-1", "1.5", "1e2", "Infinity", "9223372036854775808", "9".repeat(100), ["1", "2"]]) {
      expect(parseAdminCatalogueFilters({ cursor }).cursor).toBeNull();
    }
    expect(parseAdminCatalogueFilters({ q: ["a", "b"], status: "__proto__" })).toEqual({ q: "", status: "", cursor: null });
    expect(parseAdminCatalogueFilters({ q: "x".repeat(400) }).q).toHaveLength(300);
  });
});
