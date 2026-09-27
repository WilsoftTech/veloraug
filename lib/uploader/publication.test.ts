import { describe, expect, it } from "vitest";
import { toMovieSnapshot, type MovieSnapshot } from "@/lib/tmdb/ingestion-search";
import { publicationScript } from "@/lib/uploader/publication";
import type { SourceFingerprint } from "@/types/ingestion";

const FP = `sf1-${"a".repeat(64)}` as SourceFingerprint;
const SNAPSHOT: MovieSnapshot = {
  tmdb_id: 1428857, title: "On the Hunt", original_title: null, overview: "A hunt.", release_date: "2026-03-06", runtime_minutes: 101,
  poster_path: "/p.jpg", backdrop_path: "/b.jpg", vote_average: 6.5, vote_count: 12, genres: [{ tmdb_id: 28, name: "Action" }],
};

describe("TMDB movie snapshot", () => {
  it("maps details to the stored shape, dropping a redundant original title and blank fields", () => {
    expect(toMovieSnapshot({
      id: 1428857, title: "On the Hunt", original_title: "On the Hunt", overview: " ", release_date: "2026-03-06", runtime: 0,
      poster_path: "/p.jpg", backdrop_path: null, vote_average: 6.5, vote_count: 12, genres: [{ id: 28, name: "Action" }],
    })).toEqual({ ...SNAPSHOT, overview: null, runtime_minutes: null, backdrop_path: null });
  });

  it("refuses payloads that cannot be a catalogue record", () => {
    expect(toMovieSnapshot({ id: 1, title: "" })).toBeNull();
    expect(toMovieSnapshot({ id: 1, title: "X", poster_path: "https://evil.example/x.jpg" })).toBeNull();
    expect(toMovieSnapshot({ id: 1, title: "X", release_date: "soon" })).toBeNull();
  });
});

describe("owner publication script", () => {
  const script = (overrides: Partial<Parameters<typeof publicationScript>[0]> = {}) =>
    publicationScript({ fingerprint: FP, tmdbId: 1428857, snapshot: SNAPSHOT, rightsCleared: true, ...overrides });

  it("approves then publishes this one source in one transaction, and reads the result back", () => {
    const sql = script();
    const order = ["begin;", `catalogue_approve_movie_match('${FP}', 1428857)`, `catalogue_publish_movie('${FP}'`, "from private.ingestion_events e", "commit;"];
    const positions = order.map((part) => sql.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sql).toContain("\\set ON_ERROR_STOP on");
    expect(sql).toMatch(/::jsonb, true\);/);
  });

  it("attests rights only when the operator said so", () => {
    expect(script({ rightsCleared: false })).toMatch(/::jsonb, false\);/);
  });

  it("keeps hostile TMDB text inside one literal and out of comments", () => {
    const hostile = { ...SNAPSHOT, title: "X\n; drop table public.movies; --", overview: "$$ '; select 1; $velora_" };
    const sql = script({ snapshot: hostile });
    const tag = /(\$velora_[0-9a-f]{16}\$)/.exec(sql)![1];
    const literal = sql.slice(sql.indexOf(tag) + tag.length, sql.lastIndexOf(tag));
    expect(JSON.parse(literal)).toEqual(hostile);
    // Outside the literal, the title appears only JSON-escaped, inside one comment line.
    const outside = sql.replace(`${tag}${literal}${tag}`, "");
    const mentions = outside.split("\n").filter((line) => line.includes("drop table"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].startsWith("-- ")).toBe(true);
  });

  it("refuses a mismatched snapshot, a bad fingerprint or id", () => {
    expect(() => script({ tmdbId: 1 })).toThrow(/another TMDB id/);
    expect(() => script({ fingerprint: "sf1-xyz" as SourceFingerprint })).toThrow(/fingerprint/);
    expect(() => script({ tmdbId: 0 })).toThrow(/TMDB id/);
    expect(() => script({ snapshot: { ...SNAPSHOT, poster_path: "http://x/y.jpg" } })).toThrow();
  });
});
