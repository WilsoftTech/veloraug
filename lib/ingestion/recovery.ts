import type {
  ChannelProbe,
  ReconcileDecision,
  ReconciliationResult,
  ResumeAction,
  ServerUploadStatus,
  SourceFingerprint,
  TelegramMediaRecord,
  UploadStage,
} from "@/types/ingestion";

/**
 * Crash recovery for uploads (C2). Pure: the channel is read through an
 * injected probe, so nothing here touches the network, disk or database.
 *
 * The crash window: the journal and server know an upload started, Telegram
 * accepts the file, then the process dies before the success is recorded.
 * The file carries the `velora-src:` caption token, so recovery looks for it
 * in the channel instead of uploading again. "Timeout, so upload again" is
 * never a decision here: an uncertain attempt is reconciled first, and an
 * ambiguous reconciliation goes to review, never to a new upload.
 */

export interface ReconcileOptions {
  fingerprint: SourceFingerprint;
  sizeBytes: number;
  /**
   * Highest message id known in the channel before the attempt started.
   * Uploads are sequential and channel message ids increase, so the file,
   * if posted, has a larger id.
   */
  afterMessageId: number;
  probe: ChannelProbe;
  /** Stop after this many consecutive missing ids: the end of the channel. */
  missingStreak?: number;
  /** Hard bound on probes; reaching it without the end is `scan_incomplete`. */
  maxProbes?: number;
}

export const DEFAULT_MISSING_STREAK = 20;
export const DEFAULT_MAX_PROBES = 500;

/**
 * Bot API has no channel-history method, so the probe looks at message ids one
 * at a time, upward from the high-water mark. Deleted messages leave gaps; the
 * streak of consecutive missing ids is what marks the end of the channel.
 */
export async function reconcileUpload(options: ReconcileOptions): Promise<ReconciliationResult> {
  const missingStreak = options.missingStreak ?? DEFAULT_MISSING_STREAK;
  const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;
  const matches: TelegramMediaRecord[] = [];
  let streak = 0;
  let messageId = options.afterMessageId;

  for (let probes = 0; probes < maxProbes; probes += 1) {
    messageId += 1;
    const result = await options.probe(messageId);
    if (result.status === "error") return { status: "unavailable", code: result.code };
    if (result.status === "missing") {
      streak += 1;
      if (streak >= missingStreak) return settle(matches, options.sizeBytes, messageId);
      continue;
    }
    streak = 0;
    if (result.status === "found" && result.record.sourceFingerprint === options.fingerprint) matches.push(result.record);
  }
  return { status: "ambiguous", reason: "scan_incomplete", messageIds: matches.map((record) => record.messageId) };
}

function settle(matches: TelegramMediaRecord[], sizeBytes: number, scannedThrough: number): ReconciliationResult {
  const messageIds = matches.map((record) => record.messageId);
  if (matches.length === 0) return { status: "not_found", scannedThrough };
  if (matches.length > 1) return { status: "ambiguous", reason: "multiple_matches", messageIds };
  const [record] = matches;
  // Same token but a different size is not our file: never adopt it.
  if (record.fileSizeBytes !== null && record.fileSizeBytes !== sizeBytes) return { status: "ambiguous", reason: "size_mismatch", messageIds };
  return { status: "confirmed", record };
}

/** The journal facts resume needs. */
export interface ResumeInput {
  upload: UploadStage;
  /** Telegram identity the journal recorded from a successful sendDocument. */
  telegram: TelegramMediaRecord | null;
  dbAcknowledged: boolean;
  rejected: boolean;
  attemptsExhausted: boolean;
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
  if (input.telegram !== null) {
    if (server.status === "uploaded") {
      return sameDelivery(server.record, input.telegram) ? { action: "none" } : { action: "review", reason: "telegram_identity_conflict" };
    }
    if (server.status === "unknown") return { action: "stop", reason: "server_status_unavailable" };
    return input.dbAcknowledged ? { action: "review", reason: "server_lost_acknowledged_upload" } : { action: "record_in_db", record: input.telegram };
  }
  if (server.status === "uploaded") return { action: "adopt_server", record: server.record };
  if (input.upload === "uploading") return { action: "reconcile" };
  if (input.upload === "uploaded") return { action: "review", reason: "journal_uploaded_without_identity" };
  if (input.rejected) return { action: "stop", reason: "rejected" };
  if (input.attemptsExhausted) return { action: "stop", reason: "upload_attempts_exhausted" };
  // A server record left in "uploading" with no journal attempt (the journal
  // was lost or reset) is the same crash window seen from the other side. A
  // journal `upload_failed` is the definite outcome and needs no lookup.
  if (server.status === "uploading" && input.upload === "not_uploaded") return { action: "reconcile" };
  return { action: "upload_allowed" };
}

/**
 * The self-hosted Bot API server keeps uploading after the HTTP request that
 * started it times out, so "not found" soon after an attempt proves nothing.
 * Only after this grace period may an attempt be abandoned. Abandoning only
 * permits a new upload; it never starts one.
 */
export const DEFAULT_RECONCILE_GRACE_MS = 3 * 60 * 60 * 1000;

export function decideAfterReconcile(result: ReconciliationResult, attemptAgeMs: number | null, graceMs = DEFAULT_RECONCILE_GRACE_MS): ReconcileDecision {
  switch (result.status) {
    case "confirmed":
      return { action: "record_confirmed", record: result.record };
    case "ambiguous":
      return { action: "review", reason: `reconcile_${result.reason}` };
    case "unavailable":
      return { action: "retry_later", code: result.code };
    case "not_found":
      // With no journal attempt there is no start time, so absence cannot be trusted.
      if (attemptAgeMs === null) return { action: "review", reason: "reconcile_attempt_time_unknown" };
      return attemptAgeMs >= graceMs ? { action: "abandon" } : { action: "wait", reason: "within_upload_grace_period" };
  }
}
