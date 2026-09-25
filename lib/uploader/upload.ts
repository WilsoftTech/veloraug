import "server-only";
import { decideAfterReconcile, decideResume, reconcileUpload } from "@/lib/ingestion/recovery";
import { MAX_UPLOAD_ATTEMPTS, transition } from "@/lib/ingestion/state";
import type { LocalBotApiClient } from "@/lib/telegram/local-bot-api";
import type { Journal, JournalEntry, UploadAttempt } from "@/lib/uploader/journal";
import type { IngestionStore } from "@/lib/uploader/store";
import type { CatalogueKind } from "@/types/catalogue";
import type { IngestionEvent, ReconcileDecision, ResumeAction, TelegramMediaRecord } from "@/types/ingestion";

/**
 * Upload and resume for one journal entry (C2). Order of evidence for an
 * upload: journal "uploading" -> server "upload started" -> sendDocument ->
 * journal keeps the reply -> server records it -> journal notes the
 * acknowledgement. A crash at any point leaves enough to resume without a
 * blind second upload. Nothing here approves or publishes: uploaded is not
 * approved, and approved is not published.
 */

export interface UploaderDeps {
  journal: Journal;
  store: IngestionStore;
  telegram: Pick<LocalBotApiClient, "preflight" | "sendDocument" | "probeChannelMessage">;
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

export async function uploadEntry(entry: JournalEntry, caption: string, deps: UploaderDeps): Promise<StepResult> {
  if (entry.plan === null || !UPLOADABLE.has(entry.plan.action)) return { result: "refused", code: `plan_${entry.plan?.action ?? "missing"}` };
  if (entry.intendedChannelId === null) return { result: "refused", code: "channel_not_planned" };
  if (!deps.store.available) return { result: "refused", code: "server_boundary_unavailable" };

  // Any earlier attempt that may have been posted is reconciled first.
  const server = await deps.store.getUploadStatus(entry.fingerprint, entry.kind);
  const decision = resumeDecision(entry, server);
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
    await deps.store.markUploadStarted({ source: { fingerprint: entry.fingerprint, sizeBytes: entry.sizeBytes, fileName: entry.fileName }, kind: entry.kind, attempt: current.state.uploadAttempts });
  } catch {
    // Nothing was sent: this attempt definitely failed and may be retried.
    current = finishAttempt(apply(current, { type: "upload_failed", failure: { code: "server_refused_start", retryable: true } }), "failed", "server_refused_start", deps.now());
    await deps.journal.put(current);
    return { result: "failed", code: "server_refused_start", retryable: true };
  }

  const outcome = await deps.telegram.sendDocument(request);
  const now = deps.now();

  if (outcome.status === "succeeded") {
    current = finishAttempt(apply(current, { type: "upload_succeeded", chatId: outcome.record.chatId, messageId: outcome.record.messageId }), "succeeded", null, now);
    const acked = await acknowledge({ ...current, telegram: outcome.record }, outcome.record, deps);
    return acked.conflict ? { result: "resume", action: { action: "review", reason: "telegram_identity_conflict" } } : { result: "uploaded", acknowledged: acked.acknowledged };
  }

  if (outcome.status === "uncertain") {
    // Stays "uploading": only reconciliation may settle it.
    current = { ...current, attempts: current.attempts.map((attempt, index) => (index === current.attempts.length - 1 ? { ...attempt, outcome: "uncertain" as const, code: outcome.code } : attempt)), updatedAt: now.toISOString() };
    await deps.journal.put(current);
    return { result: "uncertain", code: outcome.code };
  }

  const failure = { code: outcome.code, retryable: outcome.status === "rejected" ? !outcome.permanent : outcome.retryable };
  current = finishAttempt(apply(current, { type: "upload_failed", failure }), "failed", outcome.code, now);
  await deps.journal.put(current);
  try {
    await deps.store.recordUploadFailed(entry.fingerprint, failure);
  } catch {
    // The journal holds the definite failure; the server keeps "uploading" until resume.
  }
  return { result: "failed", ...failure };
}

function resumeDecision(entry: JournalEntry, server: Awaited<ReturnType<IngestionStore["getUploadStatus"]>>): ResumeAction {
  return decideResume({
    upload: entry.state.upload,
    telegram: entry.telegram,
    dbAcknowledged: entry.dbAcknowledgedAt !== null,
    rejected: entry.state.review === "rejected",
    attemptsExhausted: entry.state.upload === "upload_failed" && entry.state.uploadAttempts >= MAX_UPLOAD_ATTEMPTS,
    server,
  });
}

/** What `resume` would do for one entry. Reads server status only; no Telegram call. */
export async function planResume(entry: JournalEntry, store: IngestionStore): Promise<ResumeAction> {
  return resumeDecision(entry, await store.getUploadStatus(entry.fingerprint, entry.kind));
}

/** Settles one entry without uploading: it never sends a file. */
export async function resumeEntry(entry: JournalEntry, deps: UploaderDeps): Promise<StepResult> {
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
    await deps.journal.put(finishAttempt(apply(entry, { type: "upload_abandoned" }), "abandoned", "verified_absent", deps.now()));
    try {
      await deps.store.recordUploadFailed(entry.fingerprint, { code: "upload_abandoned", retryable: true });
    } catch {
      // The journal is enough to allow a later explicit upload; the server catches up on the next attempt.
    }
    return { result: "resume", action: decision };
  }
  return { result: "resume", action: decision };
}
