import { normalizeTitle } from "@/lib/ingestion/normalize";
import type { MatchOutcome, MatchQuery, MatchTier, ScoredCandidate, TmdbCandidate, TmdbSearch } from "@/types/ingestion";

/**
 * TMDB matching for ingestion. Isolated from parsing and from TMDB transport:
 * the search function is injected (a C4 adapter over lib/tmdb/client.ts maps
 * raw results to TmdbCandidate). A match supplies metadata identity only; it
 * never publishes, and it is not approval (see state.ts).
 *
 * Signals, and nothing else: media type (hard filter), normalized title
 * equality with `title` or `original_title`, and year agreement (exact, off by
 * one, conflicting, or unknown). Popularity and result order are ignored, so
 * "first search result" can never decide a match.
 */

/**
 * Ordinal tier -> stored score (private.metadata_match_candidates.score).
 * These are fixed labels for sorting and audit, not probabilities.
 */
export const MATCH_TIER_SCORE: Record<MatchTier, number> = {
  exact_title_year: 1,
  exact_title_near_year: 0.8,
  exact_title_no_year: 0.6,
  exact_title_year_conflict: 0.3,
  title_mismatch: 0,
};

export function scoreCandidate(query: MatchQuery, candidate: TmdbCandidate): ScoredCandidate {
  const wanted = normalizeTitle(query.title);
  const titleField =
    normalizeTitle(candidate.title) === wanted
      ? "title"
      : candidate.originalTitle !== null && normalizeTitle(candidate.originalTitle) === wanted
        ? "original_title"
        : null;
  const year =
    query.year === null || candidate.year === null
      ? "unknown"
      : query.year === candidate.year
        ? "match"
        : Math.abs(query.year - candidate.year) === 1
          ? "near"
          : "conflict";
  const tier: MatchTier =
    titleField === null
      ? "title_mismatch"
      : year === "match"
        ? "exact_title_year"
        : year === "near"
          ? "exact_title_near_year"
          : year === "unknown"
            ? "exact_title_no_year"
            : "exact_title_year_conflict";
  return { candidate, tier, score: MATCH_TIER_SCORE[tier], reasons: { title: titleField ? "exact" : "mismatch", titleField, year } };
}

/** Pure decision over already-fetched candidates. */
export function decideMatch(query: MatchQuery, results: readonly TmdbCandidate[]): MatchOutcome {
  if (results.length === 0) return { outcome: "not_found", reason: "no_results" };
  const mediaType = query.kind === "movie" ? "movie" : "tv";
  const sameKind = results.filter((candidate) => candidate.mediaType === mediaType);
  if (sameKind.length === 0) return { outcome: "not_found", reason: "wrong_media_type" };

  const candidates = sameKind
    .map((candidate) => scoreCandidate(query, candidate))
    .sort((a, b) => b.score - a.score || a.candidate.tmdbId - b.candidate.tmdbId);
  const exact = candidates.filter((scored) => scored.reasons.title === "exact");
  if (exact.length === 0) return { outcome: "ambiguous", reason: "no_exact_title", candidates };

  const agreeing = exact.filter((scored) => scored.reasons.year !== "conflict");
  if (agreeing.length === 0) return { outcome: "ambiguous", reason: "year_conflict", candidates };

  const best = agreeing[0];
  // A remake or namesake at the same evidence level makes the match ambiguous.
  // Without a year, every exact title counts: "The Mummy" alone is not unique.
  const rivals = query.year === null ? exact.length - 1 : agreeing.filter((scored) => scored.tier === best.tier).length - 1;
  if (rivals > 0) return { outcome: "ambiguous", reason: "multiple_exact", candidates };

  return { outcome: "matched", best, confidence: best.tier === "exact_title_year" ? "high" : "medium", candidates };
}

/** Search + decision. A search failure is a retryable `error`, never a match. */
export async function matchTitle(query: MatchQuery, search: TmdbSearch): Promise<MatchOutcome> {
  let results: TmdbCandidate[];
  try {
    results = await search(query);
  } catch {
    // The adapter logs its own diagnostics; only a safe code crosses here.
    return { outcome: "error", code: "tmdb_search_failed" };
  }
  return decideMatch(query, results);
}
