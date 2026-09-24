import { describe, expect, it } from "vitest";
import { classifyDuplicate, titleKey } from "@/lib/ingestion/duplicates";
import { decideMatch, MATCH_TIER_SCORE, matchTitle } from "@/lib/ingestion/match";
import { parseFilename } from "@/lib/ingestion/parser";
import { planSource, type PlanInput } from "@/lib/ingestion/plan";
import { approvalBlockers, initialState, MAX_UPLOAD_ATTEMPTS, transition } from "@/lib/ingestion/state";
import type { ApprovalEvidence, DuplicateSubject, IngestionEvent, IngestionState, MatchOutcome, TmdbCandidate } from "@/types/ingestion";

const movie = (tmdbId: number, title: string, year: number | null, originalTitle: string | null = null): TmdbCandidate => ({ tmdbId, mediaType: "movie", title, originalTitle, year });
const tv = (tmdbId: number, title: string, year: number | null): TmdbCandidate => ({ tmdbId, mediaType: "tv", title, originalTitle: null, year });

describe("TMDB matching", () => {
  const johnWick = movie(245891, "John Wick", 2014);

  it("matches an exact title and year with high confidence", () => {
    const result = decideMatch({ kind: "movie", title: "John Wick", year: 2014 }, [movie(1, "John Wick: Chapter 2", 2017), johnWick]);
    expect(result).toMatchObject({ outcome: "matched", confidence: "high", best: { candidate: { tmdbId: 245891 }, tier: "exact_title_year", score: 1 } });
  });

  it("matches on the original title too", () => {
    expect(decideMatch({ kind: "movie", title: "Amelie", year: 2001 }, [movie(194, "Amélie", 2001, "Le Fabuleux Destin d'Amélie Poulain")])).toMatchObject({ outcome: "matched" });
    expect(decideMatch({ kind: "movie", title: "Le Fabuleux Destin d'Amelie Poulain", year: 2001 }, [movie(194, "Amélie", 2001, "Le Fabuleux Destin d'Amélie Poulain")])).toMatchObject({
      outcome: "matched",
      best: { reasons: { titleField: "original_title" } },
    });
  });

  it("matches a unique exact title without a year only with medium confidence", () => {
    expect(decideMatch({ kind: "movie", title: "John Wick", year: null }, [johnWick, movie(2, "John Wick: Chapter 2", 2017)])).toMatchObject({ outcome: "matched", confidence: "medium", best: { tier: "exact_title_no_year" } });
  });

  it("treats a year off by one as medium, and a conflicting year as ambiguous", () => {
    expect(decideMatch({ kind: "movie", title: "John Wick", year: 2015 }, [johnWick])).toMatchObject({ outcome: "matched", confidence: "medium" });
    expect(decideMatch({ kind: "movie", title: "John Wick", year: 2019 }, [johnWick])).toMatchObject({ outcome: "ambiguous", reason: "year_conflict" });
  });

  it("never matches across media types", () => {
    expect(decideMatch({ kind: "series", title: "John Wick", year: 2014 }, [johnWick])).toEqual({ outcome: "not_found", reason: "wrong_media_type" });
    expect(decideMatch({ kind: "series", title: "Prison Break", year: null }, [movie(9, "Prison Break", 2005), tv(2288, "Prison Break", 2005)])).toMatchObject({ outcome: "matched", best: { candidate: { tmdbId: 2288 } } });
  });

  it("returns ambiguous for several plausible results, regardless of order or popularity", () => {
    const mummies = [movie(564, "The Mummy", 1999), movie(282035, "The Mummy", 2017), movie(18990, "The Mummy", 1932)];
    expect(decideMatch({ kind: "movie", title: "The Mummy", year: null }, mummies)).toMatchObject({ outcome: "ambiguous", reason: "multiple_exact" });
    expect(decideMatch({ kind: "movie", title: "The Mummy", year: 2017 }, mummies)).toMatchObject({ outcome: "matched", best: { candidate: { tmdbId: 282035 } } });
    expect(decideMatch({ kind: "movie", title: "Twins", year: 2000 }, [movie(1, "Twins", 2000), movie(2, "Twins", 2000)])).toMatchObject({ outcome: "ambiguous", reason: "multiple_exact" });
  });

  it("does not accept the first result when no title is exact", () => {
    expect(decideMatch({ kind: "movie", title: "John Wik", year: 2014 }, [johnWick])).toMatchObject({ outcome: "ambiguous", reason: "no_exact_title" });
  });

  it("reports no results and search errors distinctly", async () => {
    expect(decideMatch({ kind: "movie", title: "Nothing", year: null }, [])).toEqual({ outcome: "not_found", reason: "no_results" });
    await expect(matchTitle({ kind: "movie", title: "John Wick", year: 2014 }, async () => { throw new Error("HTTP 503 with token abc"); })).resolves.toEqual({ outcome: "error", code: "tmdb_search_failed" });
    await expect(matchTitle({ kind: "movie", title: "John Wick", year: 2014 }, async () => [johnWick])).resolves.toMatchObject({ outcome: "matched" });
  });

  it("stores ordinal tier scores inside the database range", () => {
    for (const score of Object.values(MATCH_TIER_SCORE)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------

const matched = decideMatch({ kind: "movie", title: "John Wick", year: 2014 }, [movie(245891, "John Wick", 2014)]);
const mediumMatch = decideMatch({ kind: "movie", title: "John Wick", year: null }, [movie(245891, "John Wick", 2014)]);
const ambiguous = decideMatch({ kind: "movie", title: "The Mummy", year: null }, [movie(1, "The Mummy", 1999), movie(2, "The Mummy", 2017)]);
const complete: ApprovalEvidence = {
  kind: { status: "confirmed", kind: "movie" },
  vj: { status: "resolved", vjId: 1, slug: "vj-junior" },
  match: matched,
  season: null,
  episode: null,
  duplicate: { type: "none" },
};

function run(events: IngestionEvent[], from: IngestionState = initialState()): IngestionState {
  return events.reduce((state, event) => {
    const result = transition(state, event);
    if (!result.ok) throw new Error(`${event.type}: ${result.error}`);
    return result.state;
  }, from);
}
const errorOf = (state: IngestionState, event: IngestionEvent) => {
  const result = transition(state, event);
  return result.ok ? null : result.error;
};
const parsed = run([{ type: "parsed", parse: parseFilename("John.Wick.2014.VJ.Junior.mp4") }]);

describe("ingestion state machine", () => {
  it("follows the happy path to publication", () => {
    const state = run([
      { type: "evaluated", evidence: complete },
      { type: "upload_started" },
      { type: "upload_succeeded", chatId: -100, messageId: 7 },
      { type: "approve", by: "auto" },
      { type: "publish" },
    ], parsed);
    expect(state).toMatchObject({ review: "published", upload: "uploaded", matchedBy: "auto", telegram: { chatId: -100, messageId: 7 }, uploadAttempts: 1 });
  });

  it("keeps upload success separate from review and publication", () => {
    const inReview = run([{ type: "evaluated", evidence: { ...complete, match: ambiguous } }, { type: "upload_started" }, { type: "upload_succeeded", chatId: -100, messageId: 8 }], parsed);
    expect(inReview).toMatchObject({ review: "review_pending", upload: "uploaded" });
    expect(errorOf(inReview, { type: "publish" })).toMatch(/cannot publish from review_pending/);
    const approvedNotUploaded = run([{ type: "evaluated", evidence: complete }, { type: "approve", by: "auto" }], parsed);
    expect(errorOf(approvedNotUploaded, { type: "publish" })).toBe("cannot publish without an uploaded file");
  });

  it("routes incomplete evidence to review with explicit reasons", () => {
    const state = run([{ type: "evaluated", evidence: { ...complete, vj: { status: "unresolved", suggestionIds: [] }, match: ambiguous } }], parsed);
    expect(state).toMatchObject({ review: "review_pending", reasons: ["vj_unresolved", "match_ambiguous"] });
  });

  it("never approves an unresolved ambiguous record", () => {
    const pending = run([{ type: "evaluated", evidence: { ...complete, match: ambiguous } }], parsed);
    expect(errorOf(pending, { type: "approve", by: "auto" })).toMatch(/cannot approve from review_pending/);
    expect(errorOf(pending, { type: "approve", by: "reviewer" })).toMatch(/cannot approve from review_pending/);
    expect(errorOf(pending, { type: "review_resolved", evidence: { ...complete, match: ambiguous } })).toMatch(/match_ambiguous/);
  });

  it("lets a reviewer confirm a medium match, but only the reviewer can approve it", () => {
    const pending = run([{ type: "evaluated", evidence: { ...complete, match: mediumMatch } }], parsed);
    expect(pending.reasons).toEqual(["match_needs_confirmation"]);
    const resolved = run([{ type: "review_resolved", evidence: { ...complete, match: mediumMatch } }], pending);
    expect(resolved).toMatchObject({ review: "matched", matchedBy: "reviewer" });
    expect(errorOf(resolved, { type: "approve", by: "auto" })).toMatch(/reviewer approval/);
    expect(run([{ type: "approve", by: "reviewer" }], resolved).review).toBe("approved");
  });

  it("blocks series approval without season and episode, and kind conflicts", () => {
    const series: ApprovalEvidence = { ...complete, kind: { status: "confirmed", kind: "series" } };
    expect(approvalBlockers({ ...series, season: 1, episode: null }, "reviewer")).toEqual(["missing_episode"]);
    expect(approvalBlockers({ ...series, season: null, episode: null }, "reviewer")).toEqual(["missing_season", "missing_episode"]);
    expect(approvalBlockers({ ...series, season: 1, episode: 2 }, "auto")).toEqual([]);
    expect(approvalBlockers({ ...complete, kind: { status: "conflict", declared: "movie", inferred: "series" } }, "reviewer")).toEqual(["kind_conflict"]);
    expect(approvalBlockers({ ...complete, kind: { status: "inferred", kind: "movie" } }, "auto")).toEqual(["kind_not_declared"]);
    expect(approvalBlockers({ ...complete, vj: { status: "inactive", vjId: 3, slug: "vj-retired" } }, "reviewer")).toEqual(["vj_inactive"]);
  });

  it("treats a search error as retryable, not as review or rejection", () => {
    const failed = run([{ type: "evaluated", evidence: { ...complete, match: { outcome: "error", code: "tmdb_search_failed" } } }], parsed);
    expect(failed).toMatchObject({ review: "parsed", failure: { code: "tmdb_search_failed", retryable: true } });
    const retried = run([{ type: "retry" }, { type: "evaluated", evidence: complete }], failed);
    expect(retried).toMatchObject({ review: "matched", failure: null });
  });

  it("distinguishes retryable failures from permanent rejection", () => {
    const retryable = run([{ type: "processing_failed", failure: { code: "db_unavailable", retryable: true } }], parsed);
    expect(retryable).toMatchObject({ review: "parsed", failure: { retryable: true } });
    const permanent = run([{ type: "processing_failed", failure: { code: "not_a_video", retryable: false } }], parsed);
    expect(permanent).toMatchObject({ review: "rejected", reasons: ["not_a_video"], failure: null });
    expect(errorOf(permanent, { type: "retry" })).toBe("nothing to retry");
    expect(errorOf(permanent, { type: "upload_started" })).toMatch(/rejected/);
  });

  it("makes rejection and publication final", () => {
    const rejected = run([{ type: "reject", reason: "wrong_file" }], parsed);
    expect(errorOf(rejected, { type: "evaluated", evidence: complete })).toMatch(/cannot evaluate/);
    expect(errorOf(rejected, { type: "reject", reason: "again" })).toMatch(/cannot reject/);
    const published = run([{ type: "evaluated", evidence: complete }, { type: "upload_started" }, { type: "upload_succeeded", chatId: 1, messageId: 1 }, { type: "approve", by: "auto" }, { type: "publish" }], parsed);
    expect(errorOf(published, { type: "reject", reason: "late" })).toMatch(/cannot reject/);
  });

  it("rejects illegal transitions", () => {
    expect(errorOf(initialState(), { type: "evaluated", evidence: complete })).toMatch(/cannot evaluate from discovered/);
    expect(errorOf(parsed, { type: "parsed", parse: parseFilename("x.mp4") })).toMatch(/cannot parse/);
    expect(errorOf(parsed, { type: "approve", by: "auto" })).toMatch(/cannot approve from parsed/);
    expect(errorOf(parsed, { type: "upload_succeeded", chatId: 1, messageId: 1 })).toMatch(/no upload in progress/);
    expect(errorOf(parsed, { type: "review_resolved", evidence: complete })).toMatch(/nothing to resolve/);
  });

  it("retries a failed upload, and a permanent upload failure rejects", () => {
    const failed = run([{ type: "upload_started" }, { type: "upload_failed", failure: { code: "network", retryable: true } }], parsed);
    expect(failed).toMatchObject({ upload: "upload_failed", review: "parsed", uploadAttempts: 1 });
    expect(errorOf(failed, { type: "retry" })).toMatch(/upload_started/);
    expect(run([{ type: "upload_started" }, { type: "upload_succeeded", chatId: 1, messageId: 2 }], failed)).toMatchObject({ upload: "uploaded", uploadAttempts: 2 });
    const tooLarge = run([{ type: "upload_started" }, { type: "upload_failed", failure: { code: "file_too_large", retryable: false } }], parsed);
    expect(tooLarge).toMatchObject({ upload: "upload_failed", review: "rejected", reasons: ["file_too_large"] });
  });

  it("caps upload attempts", () => {
    let state = parsed;
    for (let i = 0; i < MAX_UPLOAD_ATTEMPTS; i++) state = run([{ type: "upload_started" }, { type: "upload_failed", failure: { code: "network", retryable: true } }], state);
    expect(errorOf(state, { type: "upload_started" })).toBe("upload attempts exhausted");
  });

  it("recovers an interrupted upload without a blind second upload", () => {
    const interrupted = run([{ type: "upload_started" }], parsed);
    expect(errorOf(interrupted, { type: "upload_started" })).toMatch(/confirmed or abandoned/);
    expect(run([{ type: "upload_confirmed", chatId: -100, messageId: 9 }], interrupted)).toMatchObject({ upload: "uploaded", uploadAttempts: 1 });
    const abandoned = run([{ type: "upload_abandoned" }], interrupted);
    expect(abandoned.upload).toBe("not_uploaded");
    expect(run([{ type: "upload_started" }], abandoned).uploadAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------

const fp = (char: string) => `sf1-${char.repeat(64)}` as const;
const johnWickKey = titleKey("movie", { tmdbId: 245891 });
const prisonBreakKey = titleKey("series", { tmdbId: 2288 });
const known: DuplicateSubject[] = [
  { fingerprint: fp("a"), fileName: "John Wick VJ Junior.mp4", fileUniqueId: "u-a", title: johnWickKey, vjId: 1, season: null, episode: null },
  { fingerprint: fp("b"), fileName: "Prison Break S01E01 VJ Junior.mp4", fileUniqueId: "u-b", title: prisonBreakKey, vjId: 1, season: 1, episode: 1 },
];
const subject = (overrides: Partial<DuplicateSubject>): DuplicateSubject => ({ fingerprint: fp("z"), fileName: "new.mp4", fileUniqueId: null, title: null, vjId: 1, season: null, episode: null, ...overrides });

describe("duplicate classification", () => {
  it("same file scanned twice: no new work", () => {
    expect(classifyDuplicate(subject({ fingerprint: fp("a"), fileName: "John Wick VJ Junior.mp4" }), known)).toEqual({ type: "same_source" });
  });

  it("file renamed after ingestion: same content, no new upload", () => {
    expect(classifyDuplicate(subject({ fingerprint: fp("a"), fileName: "John.Wick.2014.VJ.Junior.mp4" }), known)).toEqual({ type: "renamed", previousFileName: "John Wick VJ Junior.mp4" });
  });

  it("same Telegram file delivered twice: review", () => {
    expect(classifyDuplicate(subject({ fileUniqueId: "u-a" }), known)).toEqual({ type: "same_telegram_file" });
  });

  it("same movie + same VJ, different file: review", () => {
    expect(classifyDuplicate(subject({ title: johnWickKey }), known)).toEqual({ type: "same_title_same_vj", confidence: "certain" });
    const parsedKey = titleKey("movie", { title: "John Wick", year: 2014 });
    expect(classifyDuplicate(subject({ title: parsedKey }), [{ ...known[0], title: parsedKey }])).toEqual({ type: "same_title_same_vj", confidence: "possible" });
  });

  it("same movie + different VJ: a valid new version", () => {
    expect(classifyDuplicate(subject({ title: johnWickKey, vjId: 2 }), known)).toEqual({ type: "same_title_other_vj" });
  });

  it("an unresolved VJ is never assumed to be another VJ", () => {
    expect(classifyDuplicate(subject({ title: johnWickKey, vjId: null }), known)).toEqual({ type: "same_title_same_vj", confidence: "possible" });
  });

  it("same episode + same VJ: review; different VJ: valid; other episode: none", () => {
    expect(classifyDuplicate(subject({ title: prisonBreakKey, season: 1, episode: 1 }), known)).toEqual({ type: "same_episode_same_vj", confidence: "certain" });
    expect(classifyDuplicate(subject({ title: prisonBreakKey, season: 1, episode: 1, vjId: 2 }), known)).toEqual({ type: "same_episode_other_vj" });
    expect(classifyDuplicate(subject({ title: prisonBreakKey, season: 1, episode: 2 }), known)).toEqual({ type: "none" });
    expect(classifyDuplicate(subject({ title: prisonBreakKey, season: null, episode: null }), known)).toEqual({ type: "none" });
  });

  it("movies and series never collide on the same key", () => {
    expect(classifyDuplicate(subject({ title: titleKey("series", { tmdbId: 245891 }) }), known)).toEqual({ type: "none" });
  });

  it("builds keys from the strongest identity available", () => {
    expect(titleKey("movie", { catalogueId: 5, tmdbId: 9 })?.source).toBe("catalogue");
    expect(titleKey("movie", { tmdbId: 9, title: "x" })?.key).toBe("tmdb:movie:9");
    expect(titleKey("movie", { title: "John  Wick!", year: 2014 })?.key).toBe("parsed:movie:john wick:2014");
    expect(titleKey("series", { title: "Prison Break", year: 2005 })?.key).toBe("parsed:series:prison break");
    expect(titleKey("movie", { title: "  " })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("dry-run plan", () => {
  const vjs = [{ id: 1, slug: "vj-junior", name: "VJ Junior", isActive: true }];
  const input = (fileName: string, overrides: Partial<PlanInput> = {}): PlanInput => ({
    source: { fileName, relativePath: `Movies/${fileName}`, fingerprint: fp("c"), sizeBytes: 1_000_000_000, declaredKind: "movie" },
    parse: parseFilename(fileName, { maxYear: 2027 }),
    vjs,
    match: matched,
    known: [],
    journal: null,
    ...overrides,
  });

  it("plans a clean upload with no stop reasons", () => {
    const entry = planSource(input("John.Wick.2014.VJ.Junior.mp4"));
    expect(entry).toMatchObject({ action: "upload", stopReasons: [], title: "John Wick", vjText: "Junior", year: 2014, vj: { status: "resolved", vjId: 1 }, kind: { status: "confirmed", kind: "movie" } });
  });

  it("explains why automatic processing would stop", () => {
    const offline: MatchOutcome = { outcome: "error", code: "tmdb_not_configured" };
    expect(planSource(input("John Wick 2014.mp4", { match: offline }))).toMatchObject({ action: "upload_then_review", stopReasons: ["parse_missing_vj", "vj_missing", "match_error"] });
    const series = input("Prison Break S01 VJ Junior.mp4", { source: { ...input("").source, fileName: "Prison Break S01 VJ Junior.mp4", declaredKind: "series" }, match: decideMatch({ kind: "series", title: "Prison Break", year: null }, [tv(2288, "Prison Break", 2005)]) });
    expect(planSource(series).stopReasons).toEqual(["parse_missing_episode", "match_needs_confirmation", "missing_episode"]);
  });

  it("never plans a series file as a movie", () => {
    const entry = planSource(input("Prison Break S01E01 VJ Junior.mp4"));
    expect(entry.kind).toEqual({ status: "conflict", declared: "movie", inferred: "series" });
    expect(entry.stopReasons).toContain("kind_conflict");
    expect(entry.action).toBe("upload_then_review");
  });

  it("skips files already ingested, including renamed ones", () => {
    const knownSource = { fingerprint: fp("c"), fileName: "old name.mp4", fileUniqueId: null, title: null, vjId: 1, season: null, episode: null };
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { known: [knownSource] }))).toMatchObject({ action: "skip", stopReasons: ["already_ingested_renamed"] });
  });

  it("holds likely duplicates instead of uploading another copy", () => {
    const other = { fingerprint: fp("d"), fileName: "John Wick VJ Junior.mp4", fileUniqueId: null, title: johnWickKey, vjId: 1, season: null, episode: null };
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { known: [other] }))).toMatchObject({ action: "hold", stopReasons: ["duplicate_same_title_same_vj"] });
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { known: [{ ...other, vjId: 2 }] }))).toMatchObject({ action: "upload", duplicate: { type: "same_title_other_vj" } });
  });

  it("verifies an interrupted upload and retries a failed one", () => {
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { journal: { upload: "uploading", failure: null, uploadAttempts: 1 } }))).toMatchObject({ action: "verify_upload", stopReasons: ["interrupted_upload"] });
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { journal: { upload: "upload_failed", failure: { code: "network", retryable: true }, uploadAttempts: 1 } })).action).toBe("retry_upload");
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { journal: { upload: "upload_failed", failure: { code: "network", retryable: true }, uploadAttempts: MAX_UPLOAD_ATTEMPTS } }))).toMatchObject({ action: "skip", stopReasons: ["upload_attempts_exhausted"] });
  });

  it("rejects unsupported and oversized files before any upload", () => {
    expect(planSource(input("John Wick VJ Junior.avi.txt"))).toMatchObject({ action: "reject", stopReasons: ["unsupported_extension"] });
    expect(planSource(input("John.Wick.2014.VJ.Junior.mp4", { source: { ...input("").source, fileName: "John.Wick.2014.VJ.Junior.mp4", sizeBytes: 2100 * 1024 * 1024 } }))).toMatchObject({ action: "reject", stopReasons: ["file_too_large"] });
  });

  it("is pure: the same input gives the same plan and inputs are untouched", () => {
    const value = input("John.Wick.2014.VJ.Junior.mp4");
    const before = structuredClone(value);
    expect(planSource(value)).toEqual(planSource(value));
    expect(value).toEqual(before);
  });
});
