/**
 * Velora UG ingestion domain types (Phase C). Framework-independent: no
 * Next.js, Supabase, Telegram or TMDB client types. Contract:
 * docs/PHASE_C_INGESTION_DESIGN.md.
 *
 * Three identities are kept apart on purpose:
 * - source identity: a local file, known only on the uploader machine;
 * - Telegram media identity: a delivered channel message (private.telegram_media);
 * - metadata identity: a TMDB candidate that only enriches a catalogue record.
 * None of them is a Velora catalogue identity (movies/series/versions ids).
 */
import type { CatalogueKind } from "@/types/catalogue";

// ---------------------------------------------------------------------------
// Source files (operator machine only)
// ---------------------------------------------------------------------------

/**
 * A discovered local media file. `absolutePath` and `relativePath` are
 * operational metadata for the uploader's local journal only: they are never
 * persisted to Supabase, sent to Telegram or shown to clients.
 */
export interface SourceFile {
  absolutePath: string;
  /** Relative to the library root, forward slashes. */
  relativePath: string;
  fileName: string;
  /** Lowercase, without the dot. */
  extension: string;
  sizeBytes: number;
  modifiedAtMs: number;
  /** Declared by the scan input (library directory or CLI flag), not inferred. */
  declaredKind: CatalogueKind | null;
  fingerprint: SourceFingerprint;
  discoveredAt: string;
}

/** Content fingerprint: `sf1-` + 64 hex chars. Path- and mtime-independent. */
export type SourceFingerprint = `sf1-${string}`;

/** What may leave the uploader machine about a source file. */
export interface SourceIdentity {
  fingerprint: SourceFingerprint;
  sizeBytes: number;
  fileName: string;
}

// ---------------------------------------------------------------------------
// Filename parsing (suggestions only)
// ---------------------------------------------------------------------------

export type ParseIssueCode =
  | "unsupported_extension"
  | "empty_title"
  | "missing_vj"
  | "multiple_vjs"
  | "vj_boundary_uncertain"
  | "missing_season"
  | "missing_episode"
  | "multi_episode"
  | "multiple_episode_markers"
  | "multiple_years";

export interface ParseIssue {
  code: ParseIssueCode;
  /** A blocking issue prevents automatic approval; the file goes to review. */
  blocking: boolean;
}

/**
 * `high`: no issues. `medium`: warnings only. `low`: at least one blocking
 * issue. A label, not a probability.
 */
export type ParseConfidence = "high" | "medium" | "low";

export interface ParsedFilename {
  fileName: string;
  extension: string;
  /** Separators unified, noise tokens removed, original case kept. */
  normalizedName: string;
  /** `series` when an episode/season marker is present, otherwise `movie`. */
  inferredKind: CatalogueKind;
  title: string | null;
  /** VJ text exactly as parsed (without the `VJ` prefix). Not an identity. */
  vjText: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  issues: ParseIssue[];
  confidence: ParseConfidence;
}

// ---------------------------------------------------------------------------
// Media kind decision
// ---------------------------------------------------------------------------

export type KindDecision =
  | { status: "confirmed"; kind: CatalogueKind }
  /** No declared kind: inferred from the filename. Never auto-approvable. */
  | { status: "inferred"; kind: CatalogueKind }
  | { status: "conflict"; declared: CatalogueKind; inferred: CatalogueKind };

// ---------------------------------------------------------------------------
// VJ resolution (parsed text -> existing Velora VJ)
// ---------------------------------------------------------------------------

/** An existing VJ row as the resolver needs it. Aliases are optional input. */
export interface KnownVj {
  id: number;
  slug: string;
  name: string;
  isActive: boolean;
  aliases?: readonly string[];
}

export type VjResolution =
  | { status: "resolved"; vjId: number; slug: string }
  | { status: "missing" }
  /** Matches only an inactive VJ. Blocks approval; never reactivates it. */
  | { status: "inactive"; vjId: number; slug: string }
  | { status: "ambiguous"; candidateIds: number[] }
  /** No match. `suggestionIds` are for a reviewer, never used automatically. */
  | { status: "unresolved"; suggestionIds: number[] };

// ---------------------------------------------------------------------------
// TMDB matching (metadata identity only)
// ---------------------------------------------------------------------------

/** TMDB media type, in TMDB's vocabulary (adapter boundary). */
export type TmdbMediaType = "movie" | "tv";

/** A TMDB search result, already mapped out of the raw payload by an adapter. */
export interface TmdbCandidate {
  tmdbId: number;
  mediaType: TmdbMediaType;
  title: string;
  originalTitle: string | null;
  year: number | null;
}

export interface MatchQuery {
  kind: CatalogueKind;
  title: string;
  year: number | null;
}

/**
 * Ordinal evidence tiers, best first. Stored as `score` in
 * private.metadata_match_candidates through MATCH_TIER_SCORE.
 */
export type MatchTier =
  | "exact_title_year"
  | "exact_title_near_year"
  | "exact_title_no_year"
  | "exact_title_year_conflict"
  | "title_mismatch";

export interface ScoredCandidate {
  candidate: TmdbCandidate;
  tier: MatchTier;
  score: number;
  reasons: { title: "exact" | "mismatch"; titleField: "title" | "original_title" | null; year: "match" | "near" | "conflict" | "unknown" };
}

export type MatchOutcome =
  | { outcome: "matched"; best: ScoredCandidate; confidence: "high" | "medium"; candidates: ScoredCandidate[] }
  | { outcome: "ambiguous"; reason: "multiple_exact" | "year_conflict" | "no_exact_title"; candidates: ScoredCandidate[] }
  | { outcome: "not_found"; reason: "no_results" | "wrong_media_type" }
  /** Search failed: retryable, carries a safe code only. */
  | { outcome: "error"; code: string };

export type TmdbSearch = (query: MatchQuery) => Promise<TmdbCandidate[]>;

// ---------------------------------------------------------------------------
// Telegram media identity
// ---------------------------------------------------------------------------

/** Mirrors private.telegram_media. Server/worker only; never in a public shape. */
export interface TelegramMediaRecord {
  botType: CatalogueKind;
  chatId: number;
  messageId: number;
  fileId: string;
  fileUniqueId: string;
  mediaKind: "video" | "document";
  fileName: string | null;
  mimeType: string | null;
  caption: string | null;
  fileSizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  telegramDate: string;
  /** Parsed from the caption token, when the uploader wrote one. */
  sourceFingerprint: SourceFingerprint | null;
}

// ---------------------------------------------------------------------------
// Upload outcome and crash recovery (C2)
// ---------------------------------------------------------------------------

/**
 * Result of one sendDocument call. `failed` means Telegram definitely did not
 * post the file (the request was refused or never reached the server), so a
 * retry cannot duplicate it. `uncertain` means it may have been posted
 * (timeout, dropped connection, server error, unreadable reply): a retry must
 * reconcile against the channel first.
 */
export type UploadOutcome =
  | { status: "succeeded"; record: TelegramMediaRecord }
  | { status: "failed"; code: string; retryable: boolean; retryAfterSeconds: number | null }
  | { status: "uncertain"; code: string };

/**
 * A recovery call to Telegram that produced no usable answer. None of these
 * is ever read as "the message does not exist".
 */
export type RecoveryCallFailure =
  /** 429. `retryAfterSeconds` is Telegram's `retry_after`, when given. */
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  /** Timeout, network error, 5xx, unreadable reply: ask again later. */
  | { status: "transient"; code: string }
  /** Permission or configuration problem: an operator must act. */
  | { status: "blocked"; code: string };

/** One channel message looked up during reconciliation. */
export type ChannelProbeResult =
  | { status: "found"; record: TelegramMediaRecord }
  /** A forwardable message with no video or document (text, a recovery marker). */
  | { status: "not_media" }
  /** Telegram reports no message at this id: deleted, or never used. */
  | { status: "missing" }
  /**
   * Something is, or may be, at this id, but it could not be read: a service
   * message, protected content, or a refusal the probe cannot classify. It is
   * never treated as missing.
   */
  | { status: "uninspectable"; code: string }
  | RecoveryCallFailure;

/** Read-only check that recovery can run for one kind's channel. */
export type RecoveryAccessResult = { status: "ok" } | RecoveryCallFailure;

/** Posting a recovery marker (a short text message, never media). */
/** `chatId` is the channel the reply came from (validated to be the bound channel). */
export type MarkerPostResult = { status: "posted"; chatId: number; messageId: number } | RecoveryCallFailure;

/** The Telegram operations recovery uses, already bound to one bot and channel. */
export interface RecoveryTransport {
  checkAccess(): Promise<RecoveryAccessResult>;
  postMarker(text: string): Promise<MarkerPostResult>;
  probe(messageId: number): Promise<ChannelProbeResult>;
}

/** The marker that bounded a scan from above, and when it was posted (local clock). */
export interface RecoveryMarker {
  chatId: number;
  messageId: number;
  postedAt: string;
}

export type ReconciliationResult =
  /** Exactly one match with equal size, and every id in the interval inspected. */
  | { status: "found"; record: TelegramMediaRecord; marker: RecoveryMarker }
  /** Every id strictly between the floor and the marker was inspected; no match. */
  | { status: "not_found_confirmed"; floorMessageId: number; marker: RecoveryMarker }
  | { status: "ambiguous"; reason: "multiple_matches" | "size_mismatch"; messageIds: number[] }
  /** Part of the interval could not be inspected, or no interval could be set. */
  | { status: "incomplete"; reason: "floor_unknown" | "floor_not_below_marker" | "interval_too_large" | "uninspectable_message"; messageIds: number[] }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "transient"; code: string }
  | { status: "permission_blocked"; code: string };

/**
 * What the server (Supabase, through the worker boundary) knows about a source.
 * Mirrors ingestion_events.upload_state; `absent` is "no ingestion yet" and
 * `unknown` means the server could not be asked.
 */
/**
 * The server's record of the current attempt (migration 10). `floorMessageId`
 * is the recovery floor the server fixed when the attempt started; null only
 * for rows that predate migration 10 (recovery then holds). `ageSeconds` is
 * measured on the database clock when the status was read.
 */
export interface ServerAttempt {
  floorMessageId: number | null;
  startedAt: string;
  ageSeconds: number;
}

export type ServerUploadStatus =
  | { status: "unknown" }
  | { status: "absent" }
  | { status: "uploading"; attempt: ServerAttempt }
  /** May have been posted: reconcile before anything else. */
  | { status: "uncertain"; attempt: ServerAttempt }
  | { status: "uploaded"; record: TelegramMediaRecord }
  | { status: "failed" }
  /** Permanently blocked, waiting for a reviewer. */
  | { status: "blocked"; code: string | null };

/** How a failed or unresolved attempt is recorded (ingest_upload_fail). */
export type UploadFailureOutcome = "retryable" | "uncertain" | "abandoned" | "permanent";

export type ResumeAction =
  /** Journal and server agree the upload is recorded. */
  | { action: "none" }
  /** Telegram accepted the file and the journal has its identity; the server was never told. */
  | { action: "record_in_db"; record: TelegramMediaRecord }
  /** The server recorded the upload; only the local journal is behind. */
  | { action: "adopt_server"; record: TelegramMediaRecord }
  /** An upload may have been posted: look in the channel before anything else. */
  | { action: "reconcile" }
  /** Nothing was posted; a new upload is allowed when the operator asks for it. */
  | { action: "upload_allowed" }
  /** The journal holds a definite failure the server never received. */
  | { action: "sync_failure"; code: string }
  | { action: "review"; reason: string }
  | { action: "stop"; reason: string };

export type ReconcileDecision =
  | { action: "record_confirmed"; record: TelegramMediaRecord }
  /** Verified absent after the grace period: the attempt is abandoned. */
  | { action: "abandon" }
  /** Not found yet, but the server may still be uploading: check again later. */
  | { action: "wait"; reason: string }
  /** Conflicting evidence: blocked until a reviewer decides. */
  | { action: "review"; reason: string }
  /** The scan could not finish: stays uncertain until an operator acts. Never uploads. */
  | { action: "hold"; reason: string }
  | { action: "retry_later"; code: string; retryAfterSeconds: number | null };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Metadata/review track. `published` needs `approved` AND an uploaded file. */
export type ReviewStage =
  | "discovered"
  | "parsed"
  | "matched"
  | "review_pending"
  | "approved"
  | "rejected"
  | "published";

/** Upload track, independent of review: an upload never implies approval. */
export type UploadStage = "not_uploaded" | "uploading" | "uploaded" | "upload_failed";

export interface IngestionFailure {
  code: string;
  retryable: boolean;
}

export interface IngestionState {
  review: ReviewStage;
  upload: UploadStage;
  /** How `matched` was reached; automatic approval requires "auto". */
  matchedBy: "auto" | "reviewer" | null;
  /** Why the record is in review, or why it was rejected. */
  reasons: string[];
  /** Latest retryable failure; cleared by a successful retry. */
  failure: IngestionFailure | null;
  uploadAttempts: number;
  telegram: { chatId: number; messageId: number } | null;
}

/** The facts approval depends on. All must hold for an automatic approval. */
export interface ApprovalEvidence {
  kind: KindDecision;
  vj: VjResolution;
  match: MatchOutcome;
  /** Required for series: both season and episode parsed or corrected. */
  season: number | null;
  episode: number | null;
  duplicate: DuplicateClass;
}

export type IngestionEvent =
  | { type: "parsed"; parse: ParsedFilename }
  | { type: "evaluated"; evidence: ApprovalEvidence }
  /** A reviewer supplied the missing facts; evidence must now be complete. */
  | { type: "review_resolved"; evidence: ApprovalEvidence }
  | { type: "approve"; by: "auto" | "reviewer" }
  | { type: "reject"; reason: string }
  | { type: "processing_failed"; failure: IngestionFailure }
  | { type: "retry" }
  | { type: "upload_started" }
  | { type: "upload_succeeded"; chatId: number; messageId: number }
  | { type: "upload_failed"; failure: IngestionFailure }
  /** Crash recovery: an interrupted upload was found in the channel. */
  | { type: "upload_confirmed"; chatId: number; messageId: number }
  /** Crash recovery: an interrupted upload was verified absent. */
  | { type: "upload_abandoned" }
  | { type: "publish" };

export type TransitionResult =
  | { ok: true; state: IngestionState }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/**
 * Title identity used only for duplicate detection. Prefer a catalogue or TMDB
 * key; a parsed key (`parsed:movie:john wick:2014`) only yields a "possible"
 * duplicate.
 */
export interface TitleKey {
  kind: CatalogueKind;
  key: string;
  source: "catalogue" | "tmdb" | "parsed";
}

export interface DuplicateSubject {
  fingerprint: SourceFingerprint;
  fileName: string;
  fileUniqueId: string | null;
  title: TitleKey | null;
  vjId: number | null;
  season: number | null;
  episode: number | null;
}

export type DuplicateClass =
  | { type: "none" }
  /** Same content scanned again under the same name: no new work. */
  | { type: "same_source" }
  /** Same content under a new name or folder: no new work, journal path updated. */
  | { type: "renamed"; previousFileName: string }
  /** Same Telegram file (file_unique_id) delivered again (D3): review. */
  | { type: "same_telegram_file" }
  /** Different content for a movie + VJ that already has a file: review. */
  | { type: "same_title_same_vj"; confidence: "certain" | "possible" }
  /** Same movie from another VJ: a valid new version. */
  | { type: "same_title_other_vj" }
  /** Different content for an episode + VJ that already has a file: review. */
  | { type: "same_episode_same_vj"; confidence: "certain" | "possible" }
  /** Same episode from another VJ: a valid new episode version. */
  | { type: "same_episode_other_vj" };

// ---------------------------------------------------------------------------
// Dry-run plan (C2 uploader contract)
// ---------------------------------------------------------------------------

export type PlannedAction =
  /** Nothing to do: already ingested (same content). */
  | "skip"
  | "upload"
  /** An earlier upload was interrupted: look for it before any new upload. */
  | "verify_upload"
  | "retry_upload"
  /** Upload may proceed, but the record will wait for review. */
  | "upload_then_review"
  /** Likely duplicate: no upload until a reviewer decides. */
  | "hold"
  | "reject";

export interface DryRunEntry {
  fileName: string;
  relativePath: string;
  fingerprint: SourceFingerprint;
  sizeBytes: number;
  kind: KindDecision;
  title: string | null;
  vjText: string | null;
  vj: VjResolution;
  year: number | null;
  season: number | null;
  episode: number | null;
  match: MatchOutcome | null;
  duplicate: DuplicateClass;
  action: PlannedAction;
  /** Why automatic processing would stop. Empty when it would not. */
  stopReasons: string[];
}
