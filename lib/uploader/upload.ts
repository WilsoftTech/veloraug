import "server-only";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { decideAfterReconcile, decideResume, reconcileUpload, resolveRecoveryFloor, type RecoveryPacing } from "@/lib/ingestion/recovery";
import { MAX_UPLOAD_ATTEMPTS, transition } from "@/lib/ingestion/state";
import type { LocalBotApiClient } from "@/lib/telegram/local-bot-api";
import { mediaAllowsUpload, type Journal, type JournalEntry, type UploadAttempt } from "@/lib/uploader/journal";
import type { IngestionStore } from "@/lib/uploader/store";
import type { CatalogueKind } from "@/types/catalogue";
import type { IngestionEvent, ReconcileDecision, ReconciliationResult, ResumeAction, ServerUploadStatus, SourceFingerprint, TelegramMediaRecord, UploadFailureOutcome } from "@/types/ingestion";

/**
 * Upload and resume for one journal entry (C2). Order of evidence for an
 * upload: journal "uploading" -> server ingest_upload_start -> sendDocument ->
 * journal keeps the reply -> server ingest_upload_record -> journal notes the
 * acknowledgement. A crash at any point leaves enough to resume without a
 * blind second upload, and the server independently refuses a new start
 * while an attempt is uploading or uncertain. Nothing here approves or
 * publishes: uploaded is not approved, and approved is not published.
 */

/**
 * Operational kill switch for real Telegram traffic (C2B.2C.4). A server/CLI
 * environment variable, never NEXT_PUBLIC_ and never committed enabled.
 */
export const REAL_UPLOADS_ENV = "REAL_TELEGRAM_UPLOADS_AUTHORIZED";

/**
 * Whether this process may make real Telegram calls. Only the exact string
 * "true" enables; unset, empty and every other value (TRUE, 1, yes, " true ")
 * deny. Read from the environment on every call, never cached at import, so
 * the operator can set it for one command only. uploadEntry and resumeEntry
 * check it themselves: no caller can enable Telegram by passing a flag.
 */
export function isRealTelegramUploadAuthorized(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[REAL_UPLOADS_ENV] === "true";
}

export interface UploaderDeps {
  journal: Journal;
  store: IngestionStore;
  telegram: Pick<LocalBotApiClient, "preflight" | "sendDocument" | "checkRecoveryAccess" | "postRecoveryMarker" | "probeChannelMessage">;
  /**
   * Recomputes a file's sf1 fingerprint from its current bytes: the same
   * computeFingerprint scan and inspect use (lib/uploader/scan.ts,
   * fingerprintFile). Tests inject a fake.
   */
  fingerprintSource(absolutePath: string, sizeBytes: number): Promise<SourceFingerprint>;
  /** Highest message id the journal knows in this kind's channel; 0 when none. */
  channelHighWater(kind: CatalogueKind): Promise<number>;
  now(): Date;
  /** Recovery pacing and backoff; tests inject a fake. */
  sleep(ms: number): Promise<void>;
  graceMs?: number;
  recoveryPacing?: Partial<RecoveryPacing>;
}

export type StepResult =
  | { result: "uploaded"; acknowledged: boolean }
  | { result: "failed"; code: string; retryable: boolean }
  | { result: "uncertain"; code: string }
  | { result: "refused"; code: string }
  /** Not uploaded now: what recovery decided instead. */
  | { result: "resume"; action: ResumeAction | ReconcileDecision };

const UPLOADABLE = new Set(["upload", "upload_then_review", "retry_upload"]);

/**
 * The journal's fingerprint describes the bytes seen at scan time; preflight
 * only rechecks the size. So the current bytes are fingerprinted again, with
 * the one sf1 algorithm, and must equal the journal's value exactly. A
 * changed file is never re-journaled here: the operator rescans it.
 */
export async function verifySourceFingerprint(entry: Pick<JournalEntry, "absolutePath" | "sizeBytes" | "fingerprint">, fingerprintSource: UploaderDeps["fingerprintSource"]): Promise<{ ok: true } | { ok: false; code: "source_fingerprint_unreadable" | "source_fingerprint_changed" }> {
  let current: SourceFingerprint;
  try {
    current = await fingerprintSource(entry.absolutePath, entry.sizeBytes);
  } catch {
    // Missing, locked, or shorter than the scanned size: never a path in the code.
    return { ok: false, code: "source_fingerprint_unreadable" };
  }
  return current === entry.fingerprint ? { ok: true } : { ok: false, code: "source_fingerprint_changed" };
}

/** Whether an entry's scan plan lets `upload` hand it to uploadEntry (which checks again). */
export const isUploadPlanned = (entry: JournalEntry) => entry.plan !== null && UPLOADABLE.has(entry.plan.action);

export type UploadSelectionError =
  | "fingerprint_invalid"
  | "fingerprint_repeated"
  | "fingerprint_not_found"
  | "fingerprint_ambiguous"
  | "fingerprint_kind_mismatch"
  | "limit_conflicts_with_fingerprint";

export interface UploadSelectionOptions {
  /** Every `--fingerprint` value given, in order. Undefined when the option is absent. */
  fingerprints?: readonly string[];
  /** Raw `--limit`. */
  limit?: string;
  /** Raw `--kind`; with a fingerprint it must name the selected entry's kind. */
  kind?: string;
}

/**
 * Chooses the journal entries `upload` hands to uploadEntry. Selection is the
 * only thing `--fingerprint` changes: the entry then goes through the same
 * uploadEntry as any other, with every plan, state, server, preflight and
 * authorization check.
 *
 * - Without a fingerprint: planned uploads in journal order, cut by `--limit`
 *   (unchanged).
 * - With one: exactly the journal entry whose fingerprint is equal to it,
 *   whatever its plan or state. A plan that is not an upload is then refused
 *   by uploadEntry explicitly, instead of being filtered out silently. The
 *   value must already be canonical (`sf1-` + 64 lowercase hex): nothing is
 *   normalized, and a path is never read or turned into an entry. `--limit`
 *   may only be the redundant `1`, so it can never change what is selected.
 */
export function selectUploadEntries(entries: readonly JournalEntry[], options: UploadSelectionOptions): { ok: true; entries: JournalEntry[] } | { ok: false; code: UploadSelectionError } {
  if (options.fingerprints === undefined) {
    const limit = options.limit ? Number.parseInt(options.limit, 10) : Number.POSITIVE_INFINITY;
    return { ok: true, entries: entries.filter(isUploadPlanned).slice(0, limit) };
  }
  if (options.fingerprints.length !== 1) return { ok: false, code: "fingerprint_repeated" };
  const [wanted] = options.fingerprints;
  if (!isFingerprint(wanted)) return { ok: false, code: "fingerprint_invalid" };
  if (options.limit !== undefined && options.limit !== "1") return { ok: false, code: "limit_conflicts_with_fingerprint" };
  const matches = entries.filter((entry) => entry.fingerprint === wanted);
  if (matches.length === 0) return { ok: false, code: "fingerprint_not_found" };
  // The journal keys files by fingerprint, so this means a damaged journal: never pick one.
  if (matches.length > 1) return { ok: false, code: "fingerprint_ambiguous" };
  if (options.kind !== undefined && options.kind !== matches[0].kind) return { ok: false, code: "fingerprint_kind_mismatch" };
  return { ok: true, entries: matches };
}

function apply(entry: JournalEntry, event: IngestionEvent): JournalEntry {
  const next = transition(entry.state, event);
  if (!next.ok) throw new Error(`Illegal ingestion transition: ${next.error}`);
  return { ...entry, state: next.state };
}

function finishAttempt(entry: JournalEntry, outcome: UploadAttempt["outcome"], code: string | null, now: Date): JournalEntry {
  const attempts = entry.attempts.slice();
  const last = attempts.at(-1);
  if (last && (last.outcome === "pending" || last.outcome === "uncertain")) attempts[attempts.length - 1] = { ...last, outcome, code, finishedAt: now.toISOString() };
  return { ...entry, attempts, updatedAt: now.toISOString() };
}

/** Best effort: the journal already holds the outcome, and resume re-syncs it. */
async function tellServer(deps: UploaderDeps, entry: JournalEntry, outcome: UploadFailureOutcome, code: string): Promise<boolean> {
  try {
    await deps.store.recordUploadFailed(entry.fingerprint, entry.kind, { outcome, code });
    return true;
  } catch {
    return false;
  }
}

/** Records the Telegram identity in the journal first, then on the server. */
async function acknowledge(entry: JournalEntry, record: TelegramMediaRecord, deps: UploaderDeps): Promise<{ entry: JournalEntry; acknowledged: boolean; conflict: boolean }> {
  await deps.journal.put(entry);
  let outcome: Awaited<ReturnType<IngestionStore["recordUploadSucceeded"]>>;
  try {
    outcome = await deps.store.recordUploadSucceeded(entry.fingerprint, record);
  } catch {
    // The journal holds the reply; `resume` replays it (record_in_db).
    return { entry, acknowledged: false, conflict: false };
  }
  if (outcome === "conflict") return { entry, acknowledged: false, conflict: true };
  const acked = { ...entry, dbAcknowledgedAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() };
  await deps.journal.put(acked);
  return { entry: acked, acknowledged: true, conflict: false };
}

function lastFailureCode(entry: JournalEntry): string | null {
  const last = entry.attempts.at(-1);
  return entry.state.upload === "upload_failed" && last?.outcome === "failed" ? last.code : null;
}

function resumeDecision(entry: JournalEntry, server: ServerUploadStatus): ResumeAction {
  return decideResume({
    upload: entry.state.upload,
    telegram: entry.telegram,
    dbAcknowledged: entry.dbAcknowledgedAt !== null,
    rejected: entry.state.review === "rejected",
    attemptsExhausted: entry.state.upload === "upload_failed" && entry.state.uploadAttempts >= MAX_UPLOAD_ATTEMPTS,
    lastFailureCode: lastFailureCode(entry),
    server,
  });
}

async function readServerStatus(entry: JournalEntry, store: IngestionStore): Promise<ServerUploadStatus> {
  try {
    return await store.getUploadStatus(entry.fingerprint, entry.kind);
  } catch {
    return { status: "unknown" };
  }
}

/** What `resume` would do for one entry. Reads server status only; no Telegram call. */
export async function planResume(entry: JournalEntry, store: IngestionStore): Promise<ResumeAction> {
  return resumeDecision(entry, await readServerStatus(entry, store));
}

export async function uploadEntry(entry: JournalEntry, caption: string, deps: UploaderDeps): Promise<StepResult> {
  // First, before any server read, journal write, upload start or Telegram call.
  if (!isRealTelegramUploadAuthorized()) return { result: "refused", code: "telegram_uploads_not_authorized" };
  if (!isUploadPlanned(entry)) return { result: "refused", code: `plan_${entry.plan?.action ?? "missing"}` };
  // Playback media only (E3.5): canonical bytes, or a verified stream-copy rendition.
  if (!mediaAllowsUpload(entry.media)) return { result: "refused", code: "media_not_verified" };
  if (entry.intendedChannelId === null) return { result: "refused", code: "channel_not_planned" };
  if (!deps.store.available) return { result: "refused", code: "server_boundary_unavailable" };

  // Any earlier attempt that may have been posted is reconciled first.
  let decision = await planResume(entry, deps.store);
  if (decision.action === "sync_failure") {
    if (!(await tellServer(deps, entry, "retryable", decision.code))) return { result: "refused", code: "server_unavailable" };
    decision = await planResume(entry, deps.store);
  }
  if (decision.action !== "upload_allowed") return { result: "resume", action: decision };

  const request = {
    transport: entry.kind,
    kind: entry.kind,
    intendedChannelId: entry.intendedChannelId,
    absolutePath: entry.absolutePath,
    sizeBytes: entry.sizeBytes,
    fingerprint: entry.fingerprint,
    caption,
  };
  const preflight = await deps.telegram.preflight(request);
  if (!preflight.ok) return { result: "refused", code: preflight.code };
  // Last check before anything irreversible: no journal attempt, server start or Telegram call yet.
  const source = await verifySourceFingerprint(entry, deps.fingerprintSource);
  if (!source.ok) return { result: "refused", code: source.code };

  const startedAt = deps.now();
  let current = apply(entry, { type: "upload_started" });
  current = {
    ...current,
    attempts: [...current.attempts, { number: current.state.uploadAttempts, startedAt: startedAt.toISOString(), channelHighWater: await deps.channelHighWater(entry.kind), recoveryFloorMessageId: null, outcome: "pending", code: null, finishedAt: null }],
    updatedAt: startedAt.toISOString(),
  };
  await deps.journal.put(current);

  let started: Awaited<ReturnType<IngestionStore["markUploadStarted"]>>;
  try {
    started = await deps.store.markUploadStarted({ source: { fingerprint: entry.fingerprint, sizeBytes: entry.sizeBytes, fileName: entry.fileName }, kind: entry.kind, channelId: entry.intendedChannelId });
  } catch (error) {
    // Nothing was sent: this attempt definitely failed. The server refused
    // or never answered, so it holds no attempt to record the failure on.
    const code = (error as { code?: unknown }).code;
    const reason = typeof code === "string" && /^ingest_/.test(code) ? `server_${code}` : "server_refused_start";
    current = finishAttempt(apply(current, { type: "upload_failed", failure: { code: reason, retryable: true } }), "failed", reason, deps.now());
    await deps.journal.put(current);
    return { result: "failed", code: reason, retryable: true };
  }
  // The server fixed and persisted this attempt's recovery floor; the journal keeps a copy to corroborate it.
  current = { ...current, attempts: current.attempts.map((attempt, index) => (index === current.attempts.length - 1 ? { ...attempt, recoveryFloorMessageId: started.floorMessageId } : attempt)) };
  await deps.journal.put(current);

  const outcome = await deps.telegram.sendDocument(request);
  const now = deps.now();

  if (outcome.status === "succeeded") {
    current = finishAttempt(apply(current, { type: "upload_succeeded", chatId: outcome.record.chatId, messageId: outcome.record.messageId }), "succeeded", null, now);
    const acked = await acknowledge({ ...current, telegram: outcome.record }, outcome.record, deps);
    return acked.conflict ? { result: "resume", action: { action: "review", reason: "telegram_identity_conflict" } } : { result: "uploaded", acknowledged: acked.acknowledged };
  }

  if (outcome.status === "uncertain") {
    // Stays "uploading" locally; the server records "uncertain", which refuses
    // any new start until reconciliation settles it.
    current = { ...current, attempts: current.attempts.map((attempt, index) => (index === current.attempts.length - 1 ? { ...attempt, outcome: "uncertain" as const, code: outcome.code } : attempt)), updatedAt: now.toISOString() };
    await deps.journal.put(current);
    await tellServer(deps, current, "uncertain", outcome.code);
    return { result: "uncertain", code: outcome.code };
  }

  const failure = { code: outcome.code, retryable: outcome.status === "rejected" ? !outcome.permanent : outcome.retryable };
  current = finishAttempt(apply(current, { type: "upload_failed", failure }), "failed", outcome.code, now);
  await deps.journal.put(current);
  await tellServer(deps, current, failure.retryable ? "retryable" : "permanent", outcome.code);
  return { result: "failed", ...failure };
}

/** Settles one entry without uploading: it never sends a file. */
export async function resumeEntry(entry: JournalEntry, deps: UploaderDeps): Promise<StepResult> {
  // Recovery posts markers and forwards messages, so it needs the same authorization.
  if (!isRealTelegramUploadAuthorized()) return { result: "refused", code: "telegram_uploads_not_authorized" };
  const server = await readServerStatus(entry, deps.store);
  // Read after the reply: a later instant makes the derived attempt start later, never earlier.
  const statusReadAt = deps.now();
  const decision = resumeDecision(entry, server);

  switch (decision.action) {
    case "record_in_db": {
      const acked = await acknowledge(entry, decision.record, deps);
      return acked.acknowledged ? { result: "uploaded", acknowledged: true } : { result: "resume", action: acked.conflict ? { action: "review", reason: "telegram_identity_conflict" } : { action: "retry_later", code: "server_unavailable", retryAfterSeconds: null } };
    }
    case "adopt_server": {
      const now = deps.now().toISOString();
      const state = entry.state.upload === "uploading"
        ? apply(entry, { type: "upload_confirmed", chatId: decision.record.chatId, messageId: decision.record.messageId }).state
        : { ...entry.state, upload: "uploaded" as const, telegram: { chatId: decision.record.chatId, messageId: decision.record.messageId }, failure: null };
      await deps.journal.put({ ...finishAttempt(entry, "confirmed", "server_record", deps.now()), state, telegram: decision.record, dbAcknowledgedAt: now, updatedAt: now });
      return { result: "uploaded", acknowledged: true };
    }
    case "sync_failure":
      return (await tellServer(deps, entry, "retryable", decision.code))
        ? { result: "resume", action: { action: "upload_allowed" } }
        : { result: "resume", action: { action: "retry_later", code: "server_unavailable", retryAfterSeconds: null } };
    case "reconcile":
      return reconcileEntry(entry, deps, server, statusReadAt);
    default:
      return { result: "resume", action: decision };
  }
}

/**
 * Once the server has recorded the resolution, the marker is a message id
 * observed in that channel: offer it as the channel checkpoint. Optional by
 * design, so a refusal or an outage is deliberately not an error here: the
 * server refuses while any other upload there is unresolved, and a missed
 * advance only leaves later floors lower (a longer scan, never a skipped id).
 */
async function offerCheckpoint(deps: UploaderDeps, kind: CatalogueKind, result: ReconciliationResult): Promise<void> {
  if (result.status !== "found" && result.status !== "not_found_confirmed") return;
  try {
    await deps.store.advanceCheckpoint(kind, result.marker.chatId, result.marker.messageId);
  } catch {
    // See above: advancing is an optimisation, never required for safety.
  }
}

async function reconcileEntry(entry: JournalEntry, deps: UploaderDeps, server: ServerUploadStatus, statusReadAt: Date): Promise<StepResult> {
  const last = entry.state.upload === "uploading" ? entry.attempts.at(-1) : undefined;
  // The server's floor is authoritative; the journal can only corroborate it.
  const floor = resolveRecoveryFloor(
    server.status === "uploading" || server.status === "uncertain" ? server.attempt : null,
    last?.recoveryFloorMessageId ?? null,
    statusReadAt,
  );
  if (!floor.ok) {
    const hold: ReconcileDecision = { action: "hold", reason: `reconcile_${floor.reason}` };
    await tellServer(deps, entry, "uncertain", hold.reason);
    return { result: "resume", action: hold };
  }
  // Bound to the entry's kind: the movie bot and Movies channel, or the series bot and Series channel.
  const kind = entry.kind;
  const result = await reconcileUpload({
    fingerprint: entry.fingerprint,
    sizeBytes: entry.sizeBytes,
    attemptNumber: last?.number ?? null,
    floorMessageId: floor.floorMessageId,
    transport: {
      checkAccess: () => deps.telegram.checkRecoveryAccess(kind),
      postMarker: (text) => deps.telegram.postRecoveryMarker(kind, text),
      probe: (messageId) => deps.telegram.probeChannelMessage(kind, messageId),
    },
    sleep: deps.sleep,
    now: deps.now,
    pacing: deps.recoveryPacing,
  });
  const decision = decideAfterReconcile(result, floor.attemptStartedAt, deps.graceMs);

  if (decision.action === "record_confirmed") {
    const { record } = decision;
    const base = entry.state.upload === "uploading"
      ? apply(entry, { type: "upload_confirmed", chatId: record.chatId, messageId: record.messageId })
      : { ...entry, state: { ...entry.state, upload: "uploaded" as const, telegram: { chatId: record.chatId, messageId: record.messageId } } };
    const acked = await acknowledge({ ...finishAttempt(base, "confirmed", null, deps.now()), telegram: record }, record, deps);
    if (acked.acknowledged) await offerCheckpoint(deps, kind, result);
    return acked.conflict ? { result: "resume", action: { action: "review", reason: "telegram_identity_conflict" } } : { result: "uploaded", acknowledged: acked.acknowledged };
  }
  if (decision.action === "abandon") {
    const abandoned = entry.state.upload === "uploading" ? apply(entry, { type: "upload_abandoned" }) : entry;
    await deps.journal.put(finishAttempt(abandoned, "abandoned", "verified_absent", deps.now()));
    if (await tellServer(deps, entry, "abandoned", "verified_absent")) await offerCheckpoint(deps, kind, result);
    return { result: "resume", action: decision };
  }
  if (decision.action === "review") {
    // Persist the block so no later start can bypass the reviewer.
    await tellServer(deps, entry, "permanent", decision.reason);
  }
  if (decision.action === "hold") {
    // Stays uncertain, which already refuses a new start; the code tells the operator why.
    await tellServer(deps, entry, "uncertain", decision.reason);
  }
  return { result: "resume", action: decision };
}
