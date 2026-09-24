import { classifyDuplicate, duplicateIsNoop, duplicateNeedsReview, titleKey } from "@/lib/ingestion/duplicates";
import { decideKind, SUPPORTED_EXTENSIONS } from "@/lib/ingestion/parser";
import { approvalBlockers, MAX_UPLOAD_ATTEMPTS } from "@/lib/ingestion/state";
import { TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { resolveVj } from "@/lib/ingestion/vj";
import type {
  DryRunEntry,
  DuplicateSubject,
  IngestionState,
  KnownVj,
  MatchOutcome,
  ParsedFilename,
  PlannedAction,
  SourceFile,
} from "@/types/ingestion";

/**
 * Dry-run planner: what the uploader would do with one source file, and why
 * automatic processing would stop. Pure: it uploads nothing and writes
 * nothing. The C2 CLI's `scan`/`inspect` print these entries; `upload` and
 * `resume` execute them.
 */
export interface PlanInput {
  source: Pick<SourceFile, "fileName" | "relativePath" | "fingerprint" | "sizeBytes" | "declaredKind">;
  parse: ParsedFilename;
  /** Existing VJs (public.vjs). */
  vjs: readonly KnownVj[];
  /** Offline dry runs pass `{ outcome: "error", code: "tmdb_not_configured" }`. */
  match: MatchOutcome;
  /** Already-known sources and deliveries (local journal + server records). */
  known: readonly DuplicateSubject[];
  /** This file's local journal entry, if a previous run recorded one. */
  journal: Pick<IngestionState, "upload" | "failure" | "uploadAttempts"> | null;
}

export function planSource({ source, parse, vjs, match, known, journal }: PlanInput): DryRunEntry {
  const kind = decideKind(source.declaredKind, parse);
  const vj = resolveVj(parse.vjText, vjs);
  const unitKind = kind.status === "conflict" ? kind.declared : kind.kind;
  const vjId = vj.status === "resolved" || vj.status === "inactive" ? vj.vjId : null;
  const subject: DuplicateSubject = {
    fingerprint: source.fingerprint,
    fileName: source.fileName,
    fileUniqueId: null,
    title: titleKey(unitKind, { tmdbId: match.outcome === "matched" ? match.best.candidate.tmdbId : null, title: parse.title, year: parse.year }),
    vjId,
    season: parse.season,
    episode: parse.episode,
  };
  const duplicate = classifyDuplicate(subject, known);

  const stopReasons: string[] = [];
  let action: PlannedAction;
  if (duplicateIsNoop(duplicate)) {
    action = "skip";
    stopReasons.push(duplicate.type === "renamed" ? "already_ingested_renamed" : "already_ingested");
  } else if (!SUPPORTED_EXTENSIONS.includes(parse.extension)) {
    action = "reject";
    stopReasons.push("unsupported_extension");
  } else if (source.sizeBytes > TELEGRAM_MAX_FILE_BYTES) {
    action = "reject";
    stopReasons.push("file_too_large");
  } else if (journal?.upload === "uploading") {
    action = "verify_upload";
    stopReasons.push("interrupted_upload");
  } else if (journal?.upload === "uploaded") {
    action = "skip";
    stopReasons.push("already_uploaded");
  } else if (journal?.upload === "upload_failed" && journal.uploadAttempts >= MAX_UPLOAD_ATTEMPTS) {
    action = "skip";
    stopReasons.push("upload_attempts_exhausted");
  } else {
    const blockers = [
      ...parse.issues.filter((issue) => issue.blocking).map((issue) => `parse_${issue.code}`),
      ...approvalBlockers({ kind, vj, match, season: parse.season, episode: parse.episode, duplicate }, "auto"),
    ];
    stopReasons.push(...new Set(blockers));
    action = duplicateNeedsReview(duplicate)
      ? "hold"
      : journal?.upload === "upload_failed"
        ? "retry_upload"
        : stopReasons.length > 0
          ? "upload_then_review"
          : "upload";
  }

  return {
    fileName: source.fileName,
    relativePath: source.relativePath,
    fingerprint: source.fingerprint,
    sizeBytes: source.sizeBytes,
    kind,
    title: parse.title,
    vjText: parse.vjText,
    vj,
    year: parse.year,
    season: parse.season,
    episode: parse.episode,
    match,
    duplicate,
    action,
    stopReasons,
  };
}
