import { fingerprintFromCaption } from "@/lib/ingestion/telegram";
import type {
  ReconcileDecision,
  ReconciliationResult,
  RecoveryCallFailure,
  RecoveryMarker,
  RecoveryTransport,
  ResumeAction,
  ServerUploadStatus,
  SourceFingerprint,
  TelegramMediaRecord,
  UploadStage,
} from "@/types/ingestion";

/**
 * Crash recovery for uploads (C2). Pure: Telegram is reached through an
 * injected transport, so nothing here touches the network, disk or database.
 *
 * The crash window: the journal and server know an upload started, Telegram
 * accepts the file, then the process dies before the success is recorded.
 * The file carries the `velora-src:` caption token, so recovery looks for it
 * in the channel instead of uploading again. "Timeout, so upload again" is
 * never a decision here: an uncertain attempt is reconciled first, and an
 * ambiguous or unfinished reconciliation never leads to a new upload.
 *
 * Bounded marker protocol (C2B.1A). The Bot API has no channel-history
 * method, and deleted messages leave gaps of any length, so the end of the
 * channel can never be inferred from missing ids. Instead:
 *
 * 1. floor: the highest message id known to exist before the attempt started.
 *    Unknown means `incomplete`: the scan never starts blindly at id 1.
 * 2. upper bound: post a short text marker to the same channel with the same
 *    bot. Channel ids increase, so every message posted before the marker has
 *    a smaller id.
 * 3. inspect every id strictly between floor and marker. Only `missing`,
 *    `not_media` and `found` count as inspected; anything else ends the scan
 *    as `incomplete`, `rate_limited`, `transient` or `permission_blocked`.
 * 4. `not_found_confirmed` only when the whole interval was inspected.
 *
 * Nothing here depends on deleting the marker.
 */

export interface RecoveryPacing {
  /** Wait between probes. Each probe forwards into the recovery group (~20 posts/min per group). */
  probeIntervalMs: number;
  /** A 429 whose `retry_after` is at most this is waited out in place; longer ones end the scan. */
  maxInlineRetryAfterSeconds: number;
  /** 429s waited out per scan before it ends as `rate_limited`. */
  maxRateLimitWaits: number;
  /** Transient failures retried per message id, backing off exponentially from `transientBackoffMs`. */
  maxTransientRetries: number;
  transientBackoffMs: number;
  /** Largest interval scanned; a larger one is `incomplete` and needs an operator. */
  maxIntervalIds: number;
}

export const DEFAULT_RECOVERY_PACING: RecoveryPacing = {
  probeIntervalMs: 3_000,
  maxInlineRetryAfterSeconds: 120,
  maxRateLimitWaits: 5,
  maxTransientRetries: 3,
  transientBackoffMs: 5_000,
  maxIntervalIds: 2_000,
};

export interface ReconcileOptions {
  fingerprint: SourceFingerprint;
  sizeBytes: number;
  attemptNumber: number | null;
  /**
   * Highest message id proven to exist in the channel before the attempt
   * started, or null when unknown. The file, if posted, has a larger id.
   */
  floorMessageId: number | null;
  /** Already bound to the entry's bot and channel. */
  transport: RecoveryTransport;
  sleep(ms: number): Promise<void>;
  now(): Date;
  pacing?: Partial<RecoveryPacing>;
}

export const RECOVERY_MARKER_PREFIX = "velora-recovery:v1";

/**
 * The marker text: recognisable, short, and tied to the source and attempt.
 * It never carries the caption token, so it cannot match a fingerprint, and
 * it holds no path, token or credential.
 */
export function buildRecoveryMarker(fingerprint: SourceFingerprint, attemptNumber: number | null, at: Date): string {
  return `${RECOVERY_MARKER_PREFIX} src=${fingerprint} attempt=${attemptNumber ?? "unknown"} at=${at.toISOString()}`;
}

const MARKER = /^velora-recovery:v1 src=sf1-[0-9a-f]{64} attempt=(\d{1,3}|unknown) at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** The transport posts only text that passes this: it cannot be used to post anything else. */
export function isRecoveryMarker(text: string): boolean {
  return MARKER.test(text) && fingerprintFromCaption(text) === null;
}

function fromCallFailure(result: RecoveryCallFailure): ReconciliationResult {
  return result.status === "blocked" ? { status: "permission_blocked", code: result.code } : result;
}

export async function reconcileUpload(options: ReconcileOptions): Promise<ReconciliationResult> {
  const pacing = { ...DEFAULT_RECOVERY_PACING, ...options.pacing };
  const floor = options.floorMessageId;
  if (floor === null || !Number.isSafeInteger(floor) || floor <= 0) return { status: "incomplete", reason: "floor_unknown", messageIds: [] };

  const access = await options.transport.checkAccess();
  if (access.status !== "ok") return fromCallFailure(access);

  const postedAt = options.now();
  const posted = await options.transport.postMarker(buildRecoveryMarker(options.fingerprint, options.attemptNumber, postedAt));
  if (posted.status !== "posted") return fromCallFailure(posted);
  const marker: RecoveryMarker = { messageId: posted.messageId, postedAt: postedAt.toISOString() };
  // The floor is wrong if the marker lands at or below it: never guess.
  if (marker.messageId <= floor) return { status: "incomplete", reason: "floor_not_below_marker", messageIds: [] };
  if (marker.messageId - floor - 1 > pacing.maxIntervalIds) return { status: "incomplete", reason: "interval_too_large", messageIds: [] };

  const matches: TelegramMediaRecord[] = [];
  const matchIds = () => matches.map((record) => record.messageId);
  let rateLimitWaits = 0;
  let transientRetries = 0;
  let probes = 0;
  // The id advances only after it was inspected: no id is ever skipped.
  for (let messageId = floor + 1; messageId < marker.messageId; ) {
    if (probes > 0) await options.sleep(pacing.probeIntervalMs);
    probes += 1;
    const result = await options.transport.probe(messageId);

    switch (result.status) {
      case "rate_limited": {
        const wait = result.retryAfterSeconds;
        if (wait === null || wait > pacing.maxInlineRetryAfterSeconds || rateLimitWaits >= pacing.maxRateLimitWaits) return result;
        rateLimitWaits += 1;
        await options.sleep((wait + 1) * 1000);
        continue;
      }
      case "transient":
        if (transientRetries >= pacing.maxTransientRetries) return result;
        await options.sleep(pacing.transientBackoffMs * 2 ** transientRetries);
        transientRetries += 1;
        continue;
      case "blocked":
        return { status: "permission_blocked", code: result.code };
      case "uninspectable":
        return { status: "incomplete", reason: "uninspectable_message", messageIds: [...matchIds(), messageId] };
      case "found":
        if (result.record.sourceFingerprint === options.fingerprint) {
          matches.push(result.record);
          // Same token but a different size is not our file: never adopt it.
          if (result.record.fileSizeBytes !== null && result.record.fileSizeBytes !== options.sizeBytes) {
            return { status: "ambiguous", reason: "size_mismatch", messageIds: matchIds() };
          }
          if (matches.length > 1) return { status: "ambiguous", reason: "multiple_matches", messageIds: matchIds() };
        }
        break;
      case "missing":
      case "not_media":
        break;
    }
    transientRetries = 0;
    messageId += 1;
  }

  return matches.length === 1 ? { status: "found", record: matches[0], marker } : { status: "not_found_confirmed", floorMessageId: floor, marker };
}

/** The journal facts resume needs. */
export interface ResumeInput {
  upload: UploadStage;
  /** Telegram identity the journal recorded from a successful sendDocument. */
  telegram: TelegramMediaRecord | null;
  dbAcknowledged: boolean;
  rejected: boolean;
  attemptsExhausted: boolean;
  /** Code of the journal's last definite failure, if the last attempt failed. */
  lastFailureCode: string | null;
  server: ServerUploadStatus;
}

const sameDelivery = (a: TelegramMediaRecord, b: TelegramMediaRecord) =>
  a.botType === b.botType && a.chatId === b.chatId && a.messageId === b.messageId && a.fileUniqueId === b.fileUniqueId;

/**
 * What `resume` does for one journal entry, before any network call. Evidence
 * already in hand (the journal's own copy of the sendDocument result, or the
 * server's record) always wins over asking Telegram again.
 */
export function decideResume(input: ResumeInput): ResumeAction {
  const { server } = input;
  if (server.status === "unknown") return { action: "stop", reason: "server_status_unavailable" };
  if (input.telegram !== null) {
    if (server.status === "uploaded") {
      return sameDelivery(server.record, input.telegram) ? { action: "none" } : { action: "review", reason: "telegram_identity_conflict" };
    }
    if (server.status === "blocked") return { action: "review", reason: "server_blocked" };
    return input.dbAcknowledged ? { action: "review", reason: "server_lost_acknowledged_upload" } : { action: "record_in_db", record: input.telegram };
  }
  if (server.status === "uploaded") return { action: "adopt_server", record: server.record };
  if (server.status === "blocked") return { action: "review", reason: server.code ?? "server_blocked" };
  if (input.upload === "uploading") return { action: "reconcile" };
  if (input.upload === "uploaded") return { action: "review", reason: "journal_uploaded_without_identity" };
  if (input.rejected) return { action: "stop", reason: "rejected" };
  // The server may know of a post the journal lost (journal reset, or it
  // recorded "uncertain"): the same crash window seen from the other side.
  if (server.status === "uncertain") return { action: "reconcile" };
  if (server.status === "uploading") {
    // A journal failure is the definite outcome of that attempt: the server
    // just never heard it. Without one, the attempt must be reconciled.
    return input.upload === "upload_failed" && input.lastFailureCode !== null
      ? { action: "sync_failure", code: input.lastFailureCode }
      : { action: "reconcile" };
  }
  if (input.attemptsExhausted) return { action: "stop", reason: "upload_attempts_exhausted" };
  return { action: "upload_allowed" };
}

/**
 * The self-hosted Bot API server keeps uploading after the HTTP request that
 * started it times out, so the file may be posted after a marker placed soon
 * after the attempt. Absence proves something only when the marker itself was
 * posted at least this long after the attempt started. Abandoning only
 * permits a new upload; it never starts one.
 */
export const DEFAULT_RECONCILE_GRACE_MS = 3 * 60 * 60 * 1000;

/**
 * `attemptStartedAt` is the attempt's start on the same clock that dated the
 * marker (the uploader's), or null when no attempt record survives.
 */
export function decideAfterReconcile(result: ReconciliationResult, attemptStartedAt: Date | null, graceMs = DEFAULT_RECONCILE_GRACE_MS): ReconcileDecision {
  switch (result.status) {
    case "found":
      return { action: "record_confirmed", record: result.record };
    case "ambiguous":
      return { action: "review", reason: `reconcile_${result.reason}` };
    case "incomplete":
      return { action: "hold", reason: `reconcile_incomplete_${result.reason}` };
    case "permission_blocked":
      return { action: "hold", reason: `reconcile_blocked_${result.code}` };
    case "rate_limited":
      return { action: "retry_later", code: "telegram_rate_limited", retryAfterSeconds: result.retryAfterSeconds };
    case "transient":
      return { action: "retry_later", code: result.code, retryAfterSeconds: null };
    case "not_found_confirmed": {
      if (attemptStartedAt === null) return { action: "hold", reason: "reconcile_attempt_time_unknown" };
      const markerAfterStartMs = Date.parse(result.marker.postedAt) - attemptStartedAt.getTime();
      return markerAfterStartMs >= graceMs ? { action: "abandon" } : { action: "wait", reason: "within_upload_grace_period" };
    }
  }
}
