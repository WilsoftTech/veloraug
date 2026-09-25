import "server-only";
import { decideAfterReconcile, decideResume, reconcileUpload } from "@/lib/ingestion/recovery";
import { MAX_UPLOAD_ATTEMPTS, transition } from "@/lib/ingestion/state";
import type { LocalBotApiClient } from "@/lib/telegram/local-bot-api";
import type { Journal, JournalEntry, UploadAttempt } from "@/lib/uploader/journal";
import type { IngestionStore } from "@/lib/uploader/store";
import type { CatalogueKind } from "@/types/catalogue";
import type { IngestionEvent, ReconcileDecision, ResumeAction, ServerUploadStatus, TelegramMediaRecord, UploadFailureOutcome } from "@/types/ingestion";

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
 * Hard gate for real Telegram traffic (C2A.1). While false, the CLI refuses
 * `upload --execute` and `resume --execute`, and uploadEntry/resumeEntry refuse
 * whenever the caller has not explicitly enabled Telegram (tests do, against
 * fakes). C2B flips this only after the first real upload is authorized.
 */
export const REAL_TELEGRAM_UPLOADS_AUTHORIZED = false;

export interface UploaderDeps {
  journal: Journal;
  store: IngestionStore;
  telegram: Pick<LocalBotApiClient, "preflight" | "sendDocument" | "probeChannelMessage">;
  /** Must be true for any Telegram call; see REAL_TELEGRAM_UPLOADS_AUTHORIZED. */
  telegramEnabled: boolean;
  /** Highest message id the journal knows in this kind's channel. */
  channelHighWater(kind: CatalogueKind): Promise<number>;
  now(): Date;
  graceMs?: number;
}

export type StepResult =
  | { result: "uploaded"; acknowledged: boolean }
  | { result: "failed"; code: string; retryable: boolean }
  | { result: "uncertain"; code: string }
  | { result: "refused"; code: string }
  /** Not uploaded now: what recovery decided instead. */
  | { result: "resume"; action: ResumeAction | ReconcileDecision };

const UPLOADABLE = new Set(["upload", "upload_then_review", "retry_upload"]);

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

/** What `resume` would do for one entry. Reads server status only; no Telegram call. */
export async function planResume(entry: JournalEntry, store: IngestionStore): Promise<ResumeAction> {
  let server: ServerUploadStatus;
  try {
    server = await store.getUploadStatus(entry.fingerprint, entry.kind);
  } catch {
    server = { status: "unknown" };
  }
  return resumeDecision(entry, server);
}

export async function uploadEntry(entry: JournalEntry, caption: string, deps: UploaderDeps): Promise<StepResult> {
  if (!deps.telegramEnabled) return { result: "refused", code: "telegram_uploads_not_authorized" };
  if (entry.plan === null || !UPLOADABLE.has(entry.plan.action)) return { result: "refused", code: `plan_${entry.plan?.action ?? "missing"}` };
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

  const startedAt = deps.now();
  let current = apply(entry, { type: "upload_started" });
  current = {
    ...current,
    attempts: [...current.attempts, { number: current.state.uploadAttempts, startedAt: startedAt.toISOString(), channelHighWater: await deps.channelHighWater(entry.kind), outcome: "pending", code: null, finishedAt: null }],
    updatedAt: startedAt.toISOString(),
  };
  await deps.journal.put(current);

  try {
    await deps.store.markUploadStarted({ source: { fingerprint: entry.fingerprint, sizeBytes: entry.sizeBytes, fileName: entry.fileName }, kind: entry.kind, channelId: entry.intendedChannelId });
  } catch (error) {
    // Nothing was sent: this attempt definitely failed. The server refused
    // or never answered, so it holds no attempt to record the failure on.
    const code = (error as { code?: unknown }).code;
    const reason = typeof code === "string" && /^ingest_/.test(code) ? `server_${code}` : "server_refused_start";
    current = finishAttempt(apply(current, { type: "upload_failed", failure: { code: reason, retryable: true } }), "failed", reason, deps.now());
    await deps.journal.put(current);
    return { result: "failed", code: reason, retryable: true };
  }

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
  if (!deps.telegramEnabled) return { result: "refused", code: "telegram_uploads_not_authorized" };
  const decision = await planResume(entry, deps.store);

  switch (decision.action) {
    case "record_in_db": {
      const acked = await acknowledge(entry, decision.record, deps);
      return acked.acknowledged ? { result: "uploaded", acknowledged: true } : { result: "resume", action: acked.conflict ? { action: "review", reason: "telegram_identity_conflict" } : { action: "retry_later", code: "server_unavailable" } };
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
        : { result: "resume", action: { action: "retry_later", code: "server_unavailable" } };
    case "reconcile":
      return reconcileEntry(entry, deps);
    default:
      return { result: "resume", action: decision };
  }
}

async function reconcileEntry(entry: JournalEntry, deps: UploaderDeps): Promise<StepResult> {
  const last = entry.state.upload === "uploading" ? entry.attempts.at(-1) : undefined;
  const result = await reconcileUpload({
    fingerprint: entry.fingerprint,
    sizeBytes: entry.sizeBytes,
    afterMessageId: last?.channelHighWater ?? 0,
    probe: (messageId) => deps.telegram.probeChannelMessage(entry.kind, messageId),
  });
  const age = last ? deps.now().getTime() - Date.parse(last.startedAt) : null;
  const decision = decideAfterReconcile(result, age, deps.graceMs);

  if (decision.action === "record_confirmed") {
    const { record } = decision;
    const base = entry.state.upload === "uploading"
      ? apply(entry, { type: "upload_confirmed", chatId: record.chatId, messageId: record.messageId })
      : { ...entry, state: { ...entry.state, upload: "uploaded" as const, telegram: { chatId: record.chatId, messageId: record.messageId } } };
    const acked = await acknowledge({ ...finishAttempt(base, "confirmed", null, deps.now()), telegram: record }, record, deps);
    return acked.conflict ? { result: "resume", action: { action: "review", reason: "telegram_identity_conflict" } } : { result: "uploaded", acknowledged: acked.acknowledged };
  }
  if (decision.action === "abandon") {
    const abandoned = entry.state.upload === "uploading" ? apply(entry, { type: "upload_abandoned" }) : entry;
    await deps.journal.put(finishAttempt(abandoned, "abandoned", "verified_absent", deps.now()));
    await tellServer(deps, entry, "abandoned", "verified_absent");
    return { result: "resume", action: decision };
  }
  if (decision.action === "review") {
    // Persist the block so no later start can bypass the reviewer.
    await tellServer(deps, entry, "permanent", decision.reason);
  }
  return { result: "resume", action: decision };
}
