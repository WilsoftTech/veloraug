import { normalizeTitle } from "@/lib/ingestion/normalize";
import type { CatalogueKind } from "@/types/catalogue";
import type { DuplicateClass, DuplicateSubject, TitleKey } from "@/types/ingestion";

/**
 * Duplicate classification against what is already known (local journal and
 * server records). Checks run from the strongest identity to the weakest, and
 * the first hit wins:
 *
 * 1. same content (fingerprint): no new work, whatever the file is now called;
 * 2. same Telegram file (file_unique_id, D3): review, never merged silently;
 * 3. same title/episode + same VJ with different content: review (a repeat,
 *    or a replacement a reviewer must choose);
 * 4. same title/episode + another VJ: a valid new version
 *    (movie_versions / episode_versions are unique per title and VJ).
 */

/** Best title key available: catalogue id, then TMDB id, then parsed text. */
export function titleKey(
  kind: CatalogueKind,
  ids: { catalogueId?: number | null; tmdbId?: number | null; title?: string | null; year?: number | null },
): TitleKey | null {
  if (ids.catalogueId) return { kind, key: `catalogue:${kind}:${ids.catalogueId}`, source: "catalogue" };
  if (ids.tmdbId) return { kind, key: `tmdb:${kind === "movie" ? "movie" : "tv"}:${ids.tmdbId}`, source: "tmdb" };
  const title = ids.title ? normalizeTitle(ids.title) : "";
  if (!title) return null;
  // Series episodes are identified by season/episode; the series key has no year.
  const year = kind === "movie" ? `:${ids.year ?? "?"}` : "";
  return { kind, key: `parsed:${kind}:${title}${year}`, source: "parsed" };
}

const sameTitle = (a: TitleKey | null, b: TitleKey | null) => a !== null && b !== null && a.kind === b.kind && a.key === b.key;

export function classifyDuplicate(subject: DuplicateSubject, known: readonly DuplicateSubject[]): DuplicateClass {
  const sameContent = known.find((other) => other.fingerprint === subject.fingerprint);
  if (sameContent) {
    return sameContent.fileName === subject.fileName ? { type: "same_source" } : { type: "renamed", previousFileName: sameContent.fileName };
  }

  if (subject.fileUniqueId !== null && known.some((other) => other.fileUniqueId === subject.fileUniqueId)) {
    return { type: "same_telegram_file" };
  }

  const title = subject.title;
  if (title === null) return { type: "none" };
  const sameUnit = known.filter(
    (other) =>
      sameTitle(title, other.title) &&
      (title.kind === "movie" || (subject.season !== null && subject.episode !== null && other.season === subject.season && other.episode === subject.episode)),
  );
  if (sameUnit.length === 0) return { type: "none" };

  // An unresolved VJ cannot prove "another VJ", so it is treated as a possible repeat.
  const confidence = title.source === "parsed" || subject.vjId === null ? "possible" : "certain";
  const sameVj = subject.vjId === null || sameUnit.some((other) => other.vjId === subject.vjId);
  if (title.kind === "movie") return sameVj ? { type: "same_title_same_vj", confidence } : { type: "same_title_other_vj" };
  return sameVj ? { type: "same_episode_same_vj", confidence } : { type: "same_episode_other_vj" };
}

/** Classes that stop automatic processing and require a reviewer. */
export function duplicateNeedsReview(duplicate: DuplicateClass): boolean {
  return duplicate.type === "same_telegram_file" || duplicate.type === "same_title_same_vj" || duplicate.type === "same_episode_same_vj";
}

/** Classes that mean "already ingested: do no new work". */
export function duplicateIsNoop(duplicate: DuplicateClass): boolean {
  return duplicate.type === "same_source" || duplicate.type === "renamed";
}
