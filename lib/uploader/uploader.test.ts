import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideResume, DEFAULT_RECONCILE_GRACE_MS } from "@/lib/ingestion/recovery";
import { buildUploadCaption } from "@/lib/ingestion/telegram";
import type { LocalBotApiClient } from "@/lib/telegram/local-bot-api";
import { newJournalEntry, openJournal, resolveJournalDir, type Journal, type JournalEntry } from "@/lib/uploader/journal";
import { offlineStore, type IngestionStore } from "@/lib/uploader/store";
import { planResume, REAL_TELEGRAM_UPLOADS_AUTHORIZED, resumeEntry, uploadEntry, type UploaderDeps } from "@/lib/uploader/upload";
import type { ChannelProbeResult, ServerUploadStatus, SourceFingerprint, TelegramMediaRecord, UploadFailureOutcome, UploadOutcome } from "@/types/ingestion";

const FP = `sf1-${"c".repeat(64)}` as SourceFingerprint;
const OTHER = `sf1-${"d".repeat(64)}` as SourceFingerprint;
const MOVIES = -1001111111111;
const SIZE = 1_800_000_000;
const T0 = new Date("2026-09-25T10:00:00Z");
const CAPTION = buildUploadCaption({ kind: "movie", title: "John Wick", year: 2014, vjName: "Junior", season: null, episode: null, fingerprint: FP });

function media(messageId: number, fingerprint: SourceFingerprint | null = FP, overrides: Partial<TelegramMediaRecord> = {}): TelegramMediaRecord {
  return {
    botType: "movie", chatId: MOVIES, messageId, fileId: `file-${messageId}`, fileUniqueId: `uniq-${messageId}`, mediaKind: "document",
    fileName: "John.Wick.2014.VJ.Junior.mkv", mimeType: "video/x-matroska", caption: fingerprint ? `x\nvelora-src:${fingerprint}` : "x",
    fileSizeBytes: SIZE, durationSeconds: null, width: null, height: null, telegramDate: T0.toISOString(), sourceFingerprint: fingerprint, ...overrides,
  };
}

/** A fake channel: message id -> contents. Everything else is missing. */
function channel(messages: Record<number, ChannelProbeResult>) {
  return vi.fn(async (messageId: number): Promise<ChannelProbeResult> => messages[messageId] ?? { status: "missing" });
}

// ---------------------------------------------------------------------------
// Pure resume rules (the bounded scan is tested in lib/ingestion/recovery.test.ts)
// ---------------------------------------------------------------------------

describe("decideResume", () => {
  const base = { upload: "not_uploaded" as const, telegram: null, dbAcknowledged: false, rejected: false, attemptsExhausted: false, lastFailureCode: null, server: { status: "absent" } as ServerUploadStatus };

  it("prefers evidence in hand over asking Telegram", () => {
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), dbAcknowledged: true, server: { status: "uploaded", record: media(5) } })).toEqual({ action: "none" });
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), server: { status: "uploading" } })).toEqual({ action: "record_in_db", record: media(5) });
    expect(decideResume({ ...base, upload: "uploading", server: { status: "uploaded", record: media(5) } })).toEqual({ action: "adopt_server", record: media(5) });
  });

  it("never overwrites conflicting Telegram identity", () => {
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), server: { status: "uploaded", record: media(6) } })).toEqual({ action: "review", reason: "telegram_identity_conflict" });
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), dbAcknowledged: true, server: { status: "absent" } })).toEqual({ action: "review", reason: "server_lost_acknowledged_upload" });
  });

  it("an interrupted upload is reconciled, whichever side remembers it", () => {
    expect(decideResume({ ...base, upload: "uploading" })).toEqual({ action: "reconcile" });
    expect(decideResume({ ...base, server: { status: "uploading" } })).toEqual({ action: "reconcile" });
    expect(decideResume({ ...base, server: { status: "uncertain" } })).toEqual({ action: "reconcile" });
    expect(decideResume({ ...base, upload: "upload_failed", server: { status: "uncertain" } })).toEqual({ action: "reconcile" });
  });

  it("without server status, or with a blocked source, nothing proceeds", () => {
    expect(decideResume({ ...base, server: { status: "unknown" } })).toEqual({ action: "stop", reason: "server_status_unavailable" });
    expect(decideResume({ ...base, server: { status: "blocked", code: "reconcile_multiple_matches" } })).toEqual({ action: "review", reason: "reconcile_multiple_matches" });
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), server: { status: "blocked", code: null } })).toEqual({ action: "review", reason: "server_blocked" });
  });

  it("a definite failure or a fresh file may be uploaded; exhausted or rejected may not", () => {
    expect(decideResume(base)).toEqual({ action: "upload_allowed" });
    expect(decideResume({ ...base, upload: "upload_failed", server: { status: "failed" } })).toEqual({ action: "upload_allowed" });
    // The journal's definite failure never reached the server: send it first.
    expect(decideResume({ ...base, upload: "upload_failed", lastFailureCode: "telegram_forbidden", server: { status: "uploading" } })).toEqual({ action: "sync_failure", code: "telegram_forbidden" });
    expect(decideResume({ ...base, upload: "upload_failed", attemptsExhausted: true })).toEqual({ action: "stop", reason: "upload_attempts_exhausted" });
    expect(decideResume({ ...base, rejected: true })).toEqual({ action: "stop", reason: "rejected" });
  });
});

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

let dir: string;
let journal: Journal;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "velora-journal-"));
  journal = await openJournal(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const fresh = newJournalEntry({
    fingerprint: FP, kind: "movie", intendedChannelId: MOVIES, fileName: "John.Wick.2014.VJ.Junior.mkv", relativePath: "John.Wick.2014.VJ.Junior.mkv",
    absolutePath: "C:\\Media\\Movies\\John.Wick.2014.VJ.Junior.mkv", sizeBytes: SIZE, modifiedAtMs: 1, discoveryKey: "e".repeat(64),
  }, T0);
  return { ...fresh, plan: { action: "upload", stopReasons: [] }, ...overrides };
}

describe("local journal", () => {
  it("round-trips an entry and lists it", async () => {
    await journal.put(entry());
    expect(await journal.get(FP)).toEqual(entry());
    expect(await journal.list()).toHaveLength(1);
    expect(await journal.get(OTHER)).toBeNull();
  });

  it("replaces atomically and leaves no temp files", async () => {
    await journal.put(entry());
    await journal.put({ ...entry(), updatedAt: "2026-09-25T11:00:00.000Z" });
    expect(readdirSync(dir)).toEqual([`${FP}.json`]);
    expect((await journal.get(FP))?.updatedAt).toBe("2026-09-25T11:00:00.000Z");
  });

  it("ignores a temp file left by a crash mid-write", async () => {
    await journal.put(entry());
    writeFileSync(join(dir, `${FP}.json.123.456.tmp`), "{ torn");
    expect(await journal.list()).toEqual([entry()]);
  });

  it("refuses a corrupted entry instead of guessing", async () => {
    writeFileSync(join(dir, `${FP}.json`), JSON.stringify({ ...entry(), state: { review: "published" } }));
    await expect(journal.get(FP)).rejects.toThrow(/invalid/);
  });

  it("stores no bot token or secret, only operational state", async () => {
    await journal.put({ ...entry(), telegram: media(9) });
    const text = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
    expect(text).not.toMatch(/\d{5,}:[A-Za-z0-9_-]{30,}|token|secret|password/i);
  });

  it("allows one writer at a time", async () => {
    const release = await journal.lock();
    await expect(journal.lock()).rejects.toThrow(/Another uploader/);
    await release();
    await (await journal.lock())();
  });

  it("lives outside the repository or in its ignored folder only", () => {
    const repo = join(tmpdir(), "repo");
    expect(() => resolveJournalDir(join(repo, "journal"), repo)).toThrow(/outside the repository/);
    expect(() => resolveJournalDir(repo, repo)).toThrow(/outside the repository/);
    expect(resolveJournalDir(join(repo, ".velora-ingest", "journal"), repo)).toBe(join(repo, ".velora-ingest", "journal"));
    expect(resolveJournalDir(join(tmpdir(), "elsewhere"), repo)).toBe(join(tmpdir(), "elsewhere"));
  });
});

// ---------------------------------------------------------------------------
// Crash window scenarios (brief section 26), end to end over fakes
// ---------------------------------------------------------------------------

/** Mirrors the ingest_upload_* state machine of migration 20260925004059. */
class FakeStore implements IngestionStore {
  readonly available = true;
  status: ServerUploadStatus = { status: "absent" };
  attempts = 0;
  calls: string[] = [];
  failNext: string | null = null;

  private check(name: string) {
    this.calls.push(name);
    if (this.failNext === name) {
      this.failNext = null;
      throw new Error("database unavailable");
    }
  }
  async getUploadStatus() {
    return this.status;
  }
  async markUploadStarted({ channelId }: { channelId: number }) {
    this.check("markUploadStarted");
    if (channelId !== MOVIES) throw Object.assign(new Error("ingest_channel_not_allowed"), { code: "ingest_channel_not_allowed" });
    if (this.status.status !== "absent" && this.status.status !== "failed") throw Object.assign(new Error("ingest_illegal_transition"), { code: "ingest_illegal_transition" });
    this.status = { status: "uploading" };
    this.attempts += 1;
    return { attempt: this.attempts };
  }
  async recordUploadSucceeded(_fingerprint: SourceFingerprint, record: TelegramMediaRecord) {
    this.check("recordUploadSucceeded");
    if (this.status.status === "uploaded") return this.status.record.messageId === record.messageId ? ("already_recorded" as const) : ("conflict" as const);
    this.status = { status: "uploaded", record };
    return "recorded" as const;
  }
  async recordUploadFailed(_fingerprint: SourceFingerprint, _kind: string, failure: { outcome: UploadFailureOutcome; code: string }) {
    this.check(`recordUploadFailed:${failure.outcome}`);
    if (this.status.status === "uploaded") throw new Error("ingest_illegal_transition");
    this.status = failure.outcome === "uncertain" ? { status: "uncertain" } : failure.outcome === "permanent" ? { status: "blocked", code: failure.code } : { status: "failed" };
  }
}

/** The recovery marker lands here unless a test says otherwise; the journal's floor is 40. */
const MARKER_ID = 60;

function telegram(send: () => Promise<UploadOutcome>, probe = channel({}), markerId = MARKER_ID) {
  return {
    preflight: vi.fn<LocalBotApiClient["preflight"]>(async () => ({ ok: true, channelId: MOVIES })),
    sendDocument: vi.fn<LocalBotApiClient["sendDocument"]>(send),
    checkRecoveryAccess: vi.fn<LocalBotApiClient["checkRecoveryAccess"]>(async () => ({ status: "ok" })),
    postRecoveryMarker: vi.fn<LocalBotApiClient["postRecoveryMarker"]>(async () => ({ status: "posted", messageId: markerId })),
    probeChannelMessage: vi.fn<LocalBotApiClient["probeChannelMessage"]>(async (_kind, id) => probe(id)),
  };
}

function deps(store: IngestionStore, api: ReturnType<typeof telegram>, now = T0): UploaderDeps {
  return { journal, store, telegram: api, telegramEnabled: true, channelHighWater: async () => 40, now: () => now, sleep: async () => {} };
}

describe("crash and recovery", () => {
  it("before upload: no message exists, and an explicit upload records everything in order", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    await journal.put(entry());
    expect(await planResume(entry(), store)).toEqual({ action: "upload_allowed" });

    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(store.calls).toEqual(["markUploadStarted", "recordUploadSucceeded"]);
    const saved = await journal.get(FP);
    expect(saved).toMatchObject({ state: { upload: "uploaded", review: "discovered" }, telegram: media(41), dbAcknowledgedAt: T0.toISOString() });
    expect(saved?.attempts).toEqual([{ number: 1, startedAt: T0.toISOString(), channelHighWater: 40, outcome: "succeeded", code: null, finishedAt: T0.toISOString() }]);
  });

  it("upload succeeded and DB acknowledged: resume does nothing and uploads nothing", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    await uploadEntry(entry(), CAPTION, deps(store, api));
    const saved = (await journal.get(FP))!;
    expect(await resumeEntry(saved, deps(store, api))).toEqual({ result: "resume", action: { action: "none" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(api.probeChannelMessage).not.toHaveBeenCalled();
    // A second explicit upload is refused too.
    expect(await uploadEntry(saved, CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "none" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("upload succeeded, DB not acknowledged: the journal's reply is replayed, no Telegram call", async () => {
    const store = new FakeStore();
    store.failNext = "recordUploadSucceeded";
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: false });
    const saved = (await journal.get(FP))!;
    expect(saved.telegram).toEqual(media(41));
    expect(saved.dbAcknowledgedAt).toBeNull();

    expect(await resumeEntry(saved, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(store.status).toEqual({ status: "uploaded", record: media(41) });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(api.probeChannelMessage).not.toHaveBeenCalled();
  });

  it("crash after Telegram accepted, before the journal recorded it: reconciliation finds the message and records it, no reupload", async () => {
    const store = new FakeStore();
    // Simulate the crash: the send "succeeds" at Telegram but the process dies before any write after it.
    const api = telegram(async () => {
      throw new Error("process killed");
    }, channel({ 41: { status: "found", record: media(41) } }));
    await expect(uploadEntry(entry(), CAPTION, deps(store, api))).rejects.toThrow("process killed");
    const crashed = (await journal.get(FP))!;
    expect(crashed.state.upload).toBe("uploading");
    expect(store.status).toEqual({ status: "uploading" });

    // A new explicit upload must not send: it is routed to reconciliation.
    expect(await uploadEntry(crashed, CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);

    expect(await resumeEntry(crashed, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(api.probeChannelMessage.mock.calls[0]).toEqual(["movie", 41]);
    expect(store.status).toEqual({ status: "uploaded", record: media(41) });
    expect(await journal.get(FP)).toMatchObject({ state: { upload: "uploaded" }, telegram: media(41), attempts: [{ outcome: "confirmed" }] });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("unknown timeout: nothing is retried until reconciliation runs; early absence waits, late absence abandons", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "uncertain", code: "timeout" });
    const pending = (await journal.get(FP))!;
    expect(pending.state.upload).toBe("uploading");
    expect(pending.attempts.at(-1)).toMatchObject({ outcome: "uncertain", code: "timeout" });

    expect(await uploadEntry(pending, CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);

    // Soon after: the local server may still be uploading, so absence proves nothing.
    expect(await resumeEntry(pending, deps(store, api, new Date(T0.getTime() + 60_000)))).toEqual({ result: "resume", action: { action: "wait", reason: "within_upload_grace_period" } });
    expect((await journal.get(FP))!.state.upload).toBe("uploading");

    // After the grace period: verified absent, abandoned, and only then may an explicit upload retry.
    const later = new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS);
    expect(await resumeEntry(pending, deps(store, api, later))).toEqual({ result: "resume", action: { action: "abandon" } });
    const abandoned = (await journal.get(FP))!;
    expect(abandoned.state.upload).toBe("not_uploaded");
    expect(abandoned.attempts.at(-1)).toMatchObject({ outcome: "abandoned", code: "verified_absent" });
    expect(store.status).toEqual({ status: "failed" });
    expect(await planResume(abandoned, store)).toEqual({ action: "upload_allowed" });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("multiple matching Telegram messages: stop for review, never upload", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "network_error" }), channel({ 41: { status: "found", record: media(41) }, 42: { status: "found", record: media(42) } }));
    await uploadEntry(entry(), CAPTION, deps(store, api));
    const pending = (await journal.get(FP))!;
    expect(await resumeEntry(pending, deps(store, api, new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS)))).toEqual({ result: "resume", action: { action: "review", reason: "reconcile_multiple_matches" } });
    expect((await journal.get(FP))!.state.upload).toBe("uploading");
    // The block is persisted on the server, so no later start can bypass review.
    expect(store.status).toEqual({ status: "blocked", code: "reconcile_multiple_matches" });
    expect(await uploadEntry((await journal.get(FP))!, CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "review", reason: "reconcile_multiple_matches" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("DB prepared, Telegram definitely failed: retry remains possible", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "failed", code: "telegram_forbidden", retryable: true, retryAfterSeconds: null }));
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "failed", code: "telegram_forbidden", retryable: true });
    const failed = (await journal.get(FP))!;
    expect(failed.state).toMatchObject({ upload: "upload_failed", review: "discovered", uploadAttempts: 1 });
    expect(store.status).toEqual({ status: "failed" });
    expect(await planResume(failed, store)).toEqual({ action: "upload_allowed" });

    api.sendDocument.mockImplementationOnce(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry({ ...failed, plan: { action: "retry_upload", stopReasons: [] } }, CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect((await journal.get(FP))!.state.uploadAttempts).toBe(2);
  });

  it("a server that refuses to record the start blocks the send entirely", async () => {
    const store = new FakeStore();
    store.failNext = "markUploadStarted";
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "failed", code: "server_refused_start", retryable: true });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("a conflicting server identity goes to review, not an overwrite", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    store.recordUploadSucceeded = async () => "conflict";
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "review", reason: "telegram_identity_conflict" } });
    expect((await journal.get(FP))!.dbAcknowledgedAt).toBeNull();
  });

  it("uploads never approve or publish: the review track is untouched", async () => {
    const store = new FakeStore();
    await uploadEntry(entry(), CAPTION, deps(store, telegram(async () => ({ status: "succeeded", record: media(41) }))));
    expect((await journal.get(FP))!.state.review).toBe("discovered");
  });

  it("C2A.1 gate: real uploads are not authorized in code, and nothing is sent without it", async () => {
    expect(REAL_TELEGRAM_UPLOADS_AUTHORIZED).toBe(false);
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const store = new FakeStore();
    const disabled = { ...deps(store, api), telegramEnabled: false };
    expect(await uploadEntry(entry(), CAPTION, disabled)).toEqual({ result: "refused", code: "telegram_uploads_not_authorized" });
    expect(await resumeEntry(entry({ state: { ...entry().state, upload: "uploading", uploadAttempts: 1 } }), disabled)).toEqual({ result: "refused", code: "telegram_uploads_not_authorized" });
    expect(await uploadEntry(entry(), CAPTION, deps(offlineStore, api))).toEqual({ result: "refused", code: "server_boundary_unavailable" });
    expect(store.calls).toEqual([]);
    expect(api.preflight).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(api.checkRecoveryAccess).not.toHaveBeenCalled();
    expect(api.postRecoveryMarker).not.toHaveBeenCalled();
    expect(api.probeChannelMessage).not.toHaveBeenCalled();
  });

  it("an uncertain upload is recorded on the server, which then refuses a blind start even if the journal is lost", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    await uploadEntry(entry(), CAPTION, deps(store, api));
    expect(store.status).toEqual({ status: "uncertain" });
    expect(store.calls).toEqual(["markUploadStarted", "recordUploadFailed:uncertain"]);
    // A fresh journal (lost or reset) knows nothing, but the server does.
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("a definite failure the server never heard is synced before the retry starts", async () => {
    const store = new FakeStore();
    store.failNext = "recordUploadFailed:retryable";
    const api = telegram(async () => ({ status: "failed", code: "telegram_forbidden", retryable: true, retryAfterSeconds: null }));
    await uploadEntry(entry(), CAPTION, deps(store, api));
    expect(store.status).toEqual({ status: "uploading" });
    const failed = (await journal.get(FP))!;
    expect(await planResume(failed, store)).toEqual({ action: "sync_failure", code: "telegram_forbidden" });

    api.sendDocument.mockImplementationOnce(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry({ ...failed, plan: { action: "retry_upload", stopReasons: [] } }, CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(store.calls).toEqual(["markUploadStarted", "recordUploadFailed:retryable", "recordUploadFailed:retryable", "markUploadStarted", "recordUploadSucceeded"]);
  });

  it("a server refusal (wrong channel) sends nothing and keeps its code", async () => {
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry({ intendedChannelId: -1009999999999 }), CAPTION, deps(new FakeStore(), api))).toEqual({ result: "failed", code: "server_ingest_channel_not_allowed", retryable: true });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("refuses entries whose plan is not an upload, or that have no planned channel", async () => {
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry({ plan: { action: "hold", stopReasons: ["duplicate_same_title_same_vj"] } }), CAPTION, deps(new FakeStore(), api))).toEqual({ result: "refused", code: "plan_hold" });
    expect(await uploadEntry(entry({ intendedChannelId: null }), CAPTION, deps(new FakeStore(), api))).toEqual({ result: "refused", code: "channel_not_planned" });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
});

describe("bounded marker recovery, end to end (C2B.1A)", () => {
  /** An attempt left `uploading` by a timeout, with the journal's floor of 40. */
  async function uncertainUpload(api: ReturnType<typeof telegram>, store: FakeStore) {
    await uploadEntry(entry(), CAPTION, deps(store, api));
    return (await journal.get(FP))!;
  }

  it("finds the file after a deleted gap far longer than 20 ids, and records it without a reupload", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 95: { status: "found", record: media(95) } }), 100);
    const pending = await uncertainUpload(api, store);
    expect(await resumeEntry(pending, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(api.probeChannelMessage.mock.calls.map(([, id]) => id)).toEqual(Array.from({ length: 59 }, (_, index) => 41 + index));
    expect(store.status).toEqual({ status: "uploaded", record: media(95) });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("a lost journal on a fresh machine: the server's uncertain state holds, no scan from id 1, no marker, no upload", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 1: { status: "found", record: media(1) } }));
    await uncertainUpload(api, store);
    // A fresh journal: the entry exists again after a rescan, with no attempts.
    const fresh = entry();
    await journal.put(fresh);
    expect(await uploadEntry(fresh, CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    const later = new Date(T0.getTime() + 2 * DEFAULT_RECONCILE_GRACE_MS);
    expect(await resumeEntry(fresh, deps(store, api, later))).toEqual({ result: "resume", action: { action: "hold", reason: "reconcile_incomplete_floor_unknown" } });
    expect(api.checkRecoveryAccess).not.toHaveBeenCalled();
    expect(api.postRecoveryMarker).not.toHaveBeenCalled();
    expect(api.probeChannelMessage).not.toHaveBeenCalled();
    expect(store.status).toEqual({ status: "uncertain" });
    expect(await uploadEntry(fresh, CAPTION, deps(store, api, later))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("a journal that knew no earlier message (floor 0) is not trusted as a floor either", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    await uploadEntry(entry(), CAPTION, { ...deps(store, api), channelHighWater: async () => 0 });
    const pending = (await journal.get(FP))!;
    expect(pending.attempts.at(-1)?.channelHighWater).toBe(0);
    expect(await resumeEntry(pending, deps(store, api, new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS)))).toEqual({ result: "resume", action: { action: "hold", reason: "reconcile_incomplete_floor_unknown" } });
    expect(api.postRecoveryMarker).not.toHaveBeenCalled();
    expect(api.probeChannelMessage).not.toHaveBeenCalled();
  });

  it("an uninspectable message holds the source as uncertain: never abandoned, never reuploaded", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 45: { status: "uninspectable", code: "telegram_rejected_400" } }));
    const pending = await uncertainUpload(api, store);
    const later = new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS);
    expect(await resumeEntry(pending, deps(store, api, later))).toEqual({ result: "resume", action: { action: "hold", reason: "reconcile_incomplete_uninspectable_message" } });
    expect(store.calls.at(-1)).toBe("recordUploadFailed:uncertain");
    expect(store.status).toEqual({ status: "uncertain" });
    expect((await journal.get(FP))!.state.upload).toBe("uploading");
    expect(await uploadEntry((await journal.get(FP))!, CAPTION, deps(store, api, later))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("a rate limit or permission failure during recovery changes nothing and uploads nothing", async () => {
    const store = new FakeStore();
    const limited = vi.fn(async (): Promise<ChannelProbeResult> => ({ status: "rate_limited", retryAfterSeconds: 900 }));
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), limited);
    const pending = await uncertainUpload(api, store);
    const later = new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS);
    expect(await resumeEntry(pending, deps(store, api, later))).toEqual({ result: "resume", action: { action: "retry_later", code: "telegram_rate_limited", retryAfterSeconds: 900 } });
    expect(store.status).toEqual({ status: "uncertain" });

    api.checkRecoveryAccess.mockImplementation(async () => ({ status: "blocked", code: "channel_content_protected" }));
    expect(await resumeEntry(pending, deps(store, api, later))).toEqual({ result: "resume", action: { action: "hold", reason: "reconcile_blocked_channel_content_protected" } });
    expect(store.status).toEqual({ status: "uncertain" });
    expect((await journal.get(FP))!.state.upload).toBe("uploading");
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("marker deletion is never needed: recovery completes with no delete capability at all", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    const pending = await uncertainUpload(api, store);
    expect(Object.keys(api)).not.toContain("deleteMessage");
    expect(await resumeEntry(pending, deps(store, api, new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS)))).toEqual({ result: "resume", action: { action: "abandon" } });
  });

  it("recovery uses the entry's own bot and channel: movie -> movie, series -> series", async () => {
    for (const kind of ["movie", "series"] as const) {
      const store = new FakeStore();
      const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
      await journal.put(entry({ kind }));
      const pending = { ...entry({ kind }), state: { ...entry().state, upload: "uploading" as const, uploadAttempts: 1 }, attempts: [{ number: 1, startedAt: T0.toISOString(), channelHighWater: 40, outcome: "uncertain" as const, code: "timeout", finishedAt: null }] };
      store.status = { status: "uncertain" };
      await resumeEntry(pending, deps(store, api));
      expect(api.checkRecoveryAccess.mock.calls).toEqual([[kind]]);
      expect(api.postRecoveryMarker.mock.calls.map(([markerKind]) => markerKind)).toEqual([kind]);
      expect(new Set(api.probeChannelMessage.mock.calls.map(([probeKind]) => probeKind))).toEqual(new Set([kind]));
      // The marker operation is text only: nothing was uploaded.
      expect(api.sendDocument).not.toHaveBeenCalled();
    }
  });
});
