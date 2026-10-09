import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_BYTES } from "@/lib/ingestion/fingerprint";
import { decideResume, DEFAULT_RECONCILE_GRACE_MS } from "@/lib/ingestion/recovery";
import { buildUploadCaption } from "@/lib/ingestion/telegram";
import { createLocalBotApiClient, loadLocalBotApiConfig, type LocalBotApiClient } from "@/lib/telegram/local-bot-api";
import { newJournalEntry, openJournal, resolveJournalDir, type Journal, type JournalEntry } from "@/lib/uploader/journal";
import { fingerprintFile, hashFile } from "@/lib/uploader/scan";
import { offlineStore, type IngestionStore } from "@/lib/uploader/store";
import { canonicalInspection, COVER_ART, H264_HIGH_1080P, matroskaInspection, MP3_STEREO, sourceMedia } from "@/lib/uploader/test-media";
import { MEDIA_POLICY_VERSION } from "@/lib/ingestion/media";
import { isRealTelegramUploadAuthorized, planResume, REAL_UPLOADS_ENV, resumeEntry, selectUploadEntries, uploadEntry, verifySourceFingerprint, type UploaderDeps } from "@/lib/uploader/upload";
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
  const ATTEMPT = { floorMessageId: 40, startedAt: T0.toISOString(), ageSeconds: 0 };
  const base = { upload: "not_uploaded" as const, telegram: null, dbAcknowledged: false, rejected: false, attemptsExhausted: false, lastFailureCode: null, server: { status: "absent" } as ServerUploadStatus };

  it("prefers evidence in hand over asking Telegram", () => {
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), dbAcknowledged: true, server: { status: "uploaded", record: media(5) } })).toEqual({ action: "none" });
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), server: { status: "uploading", attempt: ATTEMPT } })).toEqual({ action: "record_in_db", record: media(5) });
    expect(decideResume({ ...base, upload: "uploading", server: { status: "uploaded", record: media(5) } })).toEqual({ action: "adopt_server", record: media(5) });
  });

  it("never overwrites conflicting Telegram identity", () => {
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), server: { status: "uploaded", record: media(6) } })).toEqual({ action: "review", reason: "telegram_identity_conflict" });
    expect(decideResume({ ...base, upload: "uploaded", telegram: media(5), dbAcknowledged: true, server: { status: "absent" } })).toEqual({ action: "review", reason: "server_lost_acknowledged_upload" });
  });

  it("an interrupted upload is reconciled, whichever side remembers it", () => {
    expect(decideResume({ ...base, upload: "uploading" })).toEqual({ action: "reconcile" });
    expect(decideResume({ ...base, server: { status: "uploading", attempt: ATTEMPT } })).toEqual({ action: "reconcile" });
    expect(decideResume({ ...base, server: { status: "uncertain", attempt: ATTEMPT } })).toEqual({ action: "reconcile" });
    expect(decideResume({ ...base, upload: "upload_failed", server: { status: "uncertain", attempt: ATTEMPT } })).toEqual({ action: "reconcile" });
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
    expect(decideResume({ ...base, upload: "upload_failed", lastFailureCode: "telegram_forbidden", server: { status: "uploading", attempt: ATTEMPT } })).toEqual({ action: "sync_failure", code: "telegram_forbidden" });
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

// Fakes only: every test runs with real-upload authorization unless it sets
// otherwise, and the real process environment is restored after each one.
const ORIGINAL_AUTHORIZATION = process.env[REAL_UPLOADS_ENV];
beforeEach(() => {
  vi.stubEnv(REAL_UPLOADS_ENV, "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(process.env[REAL_UPLOADS_ENV]).toBe(ORIGINAL_AUTHORIZATION);
});

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const fresh = newJournalEntry({
    fingerprint: FP, kind: "movie", intendedChannelId: MOVIES, fileName: "John.Wick.2014.VJ.Junior.mkv", relativePath: "John.Wick.2014.VJ.Junior.mkv",
    absolutePath: "C:\\Media\\Movies\\John.Wick.2014.VJ.Junior.mkv", sizeBytes: SIZE, modifiedAtMs: 1, discoveryKey: "e".repeat(64),
  }, T0);
  // Canonical media unless a test says otherwise: the E3.5 gate is tested on its own below.
  return { ...fresh, plan: { action: "upload", stopReasons: [] }, media: sourceMedia(canonicalInspection(SIZE)), ...overrides };
}

describe("synthetic file hashing", () => {
  it("full hashing refuses a synthetic file that disappears before opening", async () => {
    const path = join(dir, "synthetic.bin");
    writeFileSync(path, Buffer.alloc(32, 7));
    unlinkSync(path);
    await expect(hashFile(path, 32)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("full hashing refuses a truncated synthetic file instead of accepting a partial digest", async () => {
    const path = join(dir, "synthetic.bin");
    writeFileSync(path, Buffer.alloc(32, 7));
    truncateSync(path, 12);
    await expect(hashFile(path, 32)).rejects.toThrow("Short read while hashing");
  });
});

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
/** The fake server's state; getUploadStatus derives the attempt (floor, start, age) like ingest_upload_status. */
type FakeStatus =
  | { status: "absent" }
  | { status: "uploading" }
  | { status: "uncertain" }
  | { status: "failed" }
  | { status: "uploaded"; record: TelegramMediaRecord }
  | { status: "blocked"; code: string | null };

class FakeStore implements IngestionStore {
  readonly available = true;
  status: FakeStatus = { status: "absent" };
  attempts = 0;
  calls: string[] = [];
  failNext: string | null = null;
  /** The floor ingest_upload_start assigns to the next attempt (the server computes it; tests choose it). */
  nextFloor = 40;
  /** The current attempt's persisted floor and start, as migration 10 stores them. */
  floor: number | null = null;
  startedAt: Date | null = null;
  /** The database clock. */
  clock: () => Date = () => T0;
  checkpoints: Array<{ kind: string; chatId: number; messageId: number }> = [];

  private check(name: string) {
    this.calls.push(name);
    if (this.failNext === name) {
      this.failNext = null;
      throw new Error("database unavailable");
    }
  }
  async getUploadStatus(): Promise<ServerUploadStatus> {
    const current = this.status;
    if (current.status !== "uploading" && current.status !== "uncertain") return current;
    const startedAt = this.startedAt ?? T0;
    return { status: current.status, attempt: { floorMessageId: this.floor, startedAt: startedAt.toISOString(), ageSeconds: Math.floor((this.clock().getTime() - startedAt.getTime()) / 1000) } };
  }
  async markUploadStarted({ channelId }: { channelId: number }) {
    this.check("markUploadStarted");
    if (channelId !== MOVIES) throw Object.assign(new Error("ingest_channel_not_allowed"), { code: "ingest_channel_not_allowed" });
    if (this.status.status !== "absent" && this.status.status !== "failed") throw Object.assign(new Error("ingest_illegal_transition"), { code: "ingest_illegal_transition" });
    this.status = { status: "uploading" };
    this.attempts += 1;
    this.floor = this.nextFloor;
    this.startedAt = this.clock();
    return { attempt: this.attempts, floorMessageId: this.floor };
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
  async advanceCheckpoint(kind: string, chatId: number, messageId: number) {
    this.checkpoints.push({ kind, chatId, messageId });
    if (this.status.status === "uploading" || this.status.status === "uncertain") throw Object.assign(new Error("ingest_recovery_unresolved"), { code: "ingest_recovery_unresolved" });
    return messageId;
  }
  // The upload and recovery paths never evaluate.
  async recordEvaluation(): Promise<never> {
    throw new Error("upload paths must not record an evaluation");
  }
}

/** The recovery marker lands here unless a test says otherwise; the journal's floor is 40. */
const MARKER_ID = 60;

function telegram(send: () => Promise<UploadOutcome>, probe = channel({}), markerId = MARKER_ID) {
  return {
    preflight: vi.fn<LocalBotApiClient["preflight"]>(async () => ({ ok: true, channelId: MOVIES })),
    sendDocument: vi.fn<LocalBotApiClient["sendDocument"]>(send),
    checkRecoveryAccess: vi.fn<LocalBotApiClient["checkRecoveryAccess"]>(async () => ({ status: "ok" })),
    postRecoveryMarker: vi.fn<LocalBotApiClient["postRecoveryMarker"]>(async () => ({ status: "posted", chatId: MOVIES, messageId: markerId })),
    probeChannelMessage: vi.fn<LocalBotApiClient["probeChannelMessage"]>(async (_kind, id) => probe(id)),
  };
}

/** What the fake file system fingerprints the source as; reset to the journal's FP before each test. */
let sourceFingerprint: SourceFingerprint = FP;
beforeEach(() => {
  sourceFingerprint = FP;
});

function deps(store: IngestionStore, api: ReturnType<typeof telegram>, now = T0): UploaderDeps {
  // The fake database and the uploader share one clock here; skew is tested separately.
  if (store instanceof FakeStore) store.clock = () => now;
  // The source still has the scanned bytes unless a test says otherwise (see sourceFingerprint).
  return { journal, store, telegram: api, fingerprintSource: async () => sourceFingerprint, channelHighWater: async () => 40, now: () => now, sleep: async () => {} };
}

describe("staged upload selection", () => {
  const staging = { root: "C:\\Staging", serverRoot: "/media/staging", fileName: "verified.mp4", sha256: "a".repeat(64), phase: "verified" as const, verifiedAt: T0.toISOString() };

  it("uses verified staged bytes with the original fingerprint, caption and upload track", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const staged = entry({ staging });
    const d = deps(store, api);
    const path = "C:\\Staging\\verified.mp4";
    d.stagedSource = vi.fn(async () => ({ ok: true as const, absolutePath: path }));
    d.fingerprintSource = vi.fn(async () => FP);
    expect(await uploadEntry(staged, CAPTION, d)).toEqual({ result: "uploaded", acknowledged: true });
    expect(api.sendDocument.mock.calls[0][0]).toMatchObject({ absolutePath: path, fingerprint: FP, caption: CAPTION });
    expect(d.fingerprintSource).toHaveBeenCalledWith(path, SIZE);
    expect((await journal.get(FP))?.absolutePath).toBe(staged.absolutePath);
    expect((await journal.get(FP))?.state.uploadAttempts).toBe(1);
  });

  it("refuses unavailable or failed staged verification before any attempt, with no origin fallback", async () => {
    for (const verifier of [undefined, vi.fn(async () => ({ ok: false as const, code: "stage_integrity_mismatch" }))]) {
      const store = new FakeStore();
      const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
      const d = { ...deps(store, api), stagedSource: verifier };
      expect((await uploadEntry(entry({ staging }), CAPTION, d)).result).toBe("refused");
      expect(api.sendDocument).not.toHaveBeenCalled();
      expect(store.calls).not.toContain("markUploadStarted");
    }
  });
});

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
    expect(saved?.attempts).toEqual([{ number: 1, startedAt: T0.toISOString(), channelHighWater: 40, recoveryFloorMessageId: 40, outcome: "succeeded", code: null, finishedAt: T0.toISOString() }]);
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

  it("authorized, but with no server boundary, nothing is sent", async () => {
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry(), CAPTION, deps(offlineStore, api))).toEqual({ result: "refused", code: "server_boundary_unavailable" });
    expect(api.preflight).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Media gate (E3.5): only verified playback media reaches the upload path
// ---------------------------------------------------------------------------

describe("media gate (E3.5)", () => {
  const digest = { video: { packets: 10, bytes: 1000, sha256: "a".repeat(64) }, audio: { packets: 20, bytes: 500, sha256: "b".repeat(64) } };
  const rendition = (passed: boolean) => ({
    ...sourceMedia(canonicalInspection(SIZE)),
    role: "rendition" as const,
    derivedFrom: { fingerprint: OTHER, sizeBytes: SIZE - 1000, verification: { passed, failures: passed ? [] : ["video_packets_changed"], source: digest, output: digest } },
  });

  it("refuses anything but canonical bytes or a verified rendition, before the server, preflight or Telegram", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const stale = sourceMedia(canonicalInspection(SIZE));
    const refused = [
      null,
      sourceMedia(matroskaInspection(SIZE)),
      { ...stale, classification: { ...stale.classification, policyVersion: 0 } },
      rendition(false),
      { ...rendition(true), derivedFrom: null },
      // E3.6: a source with cover art is Class 2 (only its verified rendition uploads), an ambiguous film is
      // manual review, HEVC beside a cover stays video_transcode_required, and an E3.5 (v1) record is outdated.
      sourceMedia(canonicalInspection(SIZE, { streams: [{ ...COVER_ART, index: 0 }, { ...H264_HIGH_1080P, index: 1 }, { ...MP3_STEREO, index: 2 }] })),
      sourceMedia(canonicalInspection(SIZE, { streams: [H264_HIGH_1080P, { ...H264_HIGH_1080P, index: 1 }, { ...MP3_STEREO, index: 2 }] })),
      sourceMedia(canonicalInspection(SIZE, { streams: [{ ...H264_HIGH_1080P, codec: "hevc", codecTag: "hev1", profile: "Main 10", pixelFormat: "yuv420p10le" }, MP3_STEREO, COVER_ART] })),
      { ...stale, classification: { ...stale.classification, policyVersion: MEDIA_POLICY_VERSION - 1 } },
    ];
    expect(refused.slice(-4, -1).map((m) => m?.classification.class)).toEqual(["remux", "manual_review", "video_transcode_required"]);
    for (const value of refused) {
      expect(await uploadEntry(entry({ media: value }), CAPTION, deps(store, api))).toEqual({ result: "refused", code: "media_not_verified" });
    }
    expect(store.calls).toEqual([]);
    expect(api.preflight).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(await journal.list()).toEqual([]);
  });

  it("the authorization gate still comes first: an unauthorized process is refused for that, whatever the media", async () => {
    vi.stubEnv(REAL_UPLOADS_ENV, "false");
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry({ media: null }), CAPTION, deps(new FakeStore(), api))).toEqual({ result: "refused", code: "telegram_uploads_not_authorized" });
  });

  it("a verified rendition goes through the unchanged upload path: one start, one send, recorded", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    expect(await uploadEntry(entry({ media: rendition(true) }), CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(store.calls).toEqual(["markUploadStarted", "recordUploadSucceeded"]);
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("an uncertain rendition upload is never repeated: the next upload reconciles instead of sending", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "network_error" }));
    expect(await uploadEntry(entry({ media: rendition(true) }), CAPTION, deps(store, api))).toEqual({ result: "uncertain", code: "network_error" });
    const after = (await journal.get(FP))!;
    expect(after.state.upload).toBe("uploading");
    const second = await uploadEntry(after, CAPTION, deps(store, api));
    expect(second).toMatchObject({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// upload --fingerprint (C2B.2C.2): selection only; everything after it is uploadEntry
// ---------------------------------------------------------------------------

describe("upload selection by fingerprint", () => {
  const A = `sf1-${"a".repeat(64)}` as SourceFingerprint;
  const B = `sf1-${"b".repeat(64)}` as SourceFingerprint;
  const C = `sf1-${"f".repeat(64)}` as SourceFingerprint;
  const named = (fingerprint: SourceFingerprint, overrides: Partial<JournalEntry> = {}) =>
    entry({ fingerprint, fileName: `${fingerprint.slice(4, 8)}.mkv`, relativePath: `${fingerprint.slice(4, 8)}.mkv`, ...overrides });
  const journalOrder = [named(A), named(B), named(C)];
  const pick = (entries: JournalEntry[], options: Parameters<typeof selectUploadEntries>[1]) => {
    const selected = selectUploadEntries(entries, options);
    return selected.ok ? selected.entries.map((item) => item.fingerprint) : selected.code;
  };
  const only = (entries: JournalEntry[], options: Parameters<typeof selectUploadEntries>[1]) => {
    const selected = selectUploadEntries(entries, options);
    if (!selected.ok || selected.entries.length !== 1) throw new Error("expected exactly one selected entry");
    return selected.entries[0];
  };

  it("selects exactly the entry with that fingerprint, whatever the journal order", () => {
    expect(pick(journalOrder, { fingerprints: [B] })).toEqual([B]);
    expect(pick([...journalOrder].reverse(), { fingerprints: [B] })).toEqual([B]);
    expect(pick([named(C), named(B), named(A)], { fingerprints: [C] })).toEqual([C]);
    // Contrast: without a selector, --limit 1 takes whatever sorts first.
    expect(pick(journalOrder, { limit: "1" })).toEqual([A]);
  });

  it("matches the whole fingerprint: neighbours differing only in the last hex digit are never confused", () => {
    const low = `sf1-${"9".repeat(63)}0` as SourceFingerprint;
    const high = `sf1-${"9".repeat(63)}1` as SourceFingerprint;
    const shared = `sf1-${"9".repeat(63)}2` as SourceFingerprint;
    expect(pick([named(low), named(high)], { fingerprints: [high] })).toEqual([high]);
    expect(pick([named(high), named(low)], { fingerprints: [low] })).toEqual([low]);
    expect(pick([named(low), named(high)], { fingerprints: [shared] })).toBe("fingerprint_not_found");
  });

  it("without --fingerprint, selection is unchanged: planned uploads in journal order, cut by --limit", () => {
    const mixed = [named(A, { plan: { action: "skip", stopReasons: ["already_uploaded"] } }), named(B), named(C, { plan: { action: "upload_then_review", stopReasons: ["vj_unresolved"] } })];
    expect(pick(mixed, {})).toEqual([B, C]);
    expect(pick(mixed, { limit: "1" })).toEqual([B]);
  });

  it("refuses a value that is not a complete canonical fingerprint, without normalizing it", () => {
    const bad = ["", "sf1-", `sf1-${"b".repeat(63)}`, `sf1-${"b".repeat(65)}`, `SF1-${"b".repeat(64)}`, `sf1-${"B".repeat(64)}`, `sf2-${"b".repeat(64)}`,
      ` ${B}`, `${B} `, `${B.slice(0, -1)}g`, "G:\\Movies\\On The Hunt.mkv", "/media/movies/x.mkv", "bbbb"];
    for (const value of bad) expect(pick(journalOrder, { fingerprints: [value] })).toBe("fingerprint_invalid");
  });

  it("refuses an unknown fingerprint, a repeated option and a damaged journal with two matches", () => {
    expect(pick(journalOrder, { fingerprints: [`sf1-${"e".repeat(64)}`] })).toBe("fingerprint_not_found");
    expect(pick([], { fingerprints: [B] })).toBe("fingerprint_not_found");
    expect(pick(journalOrder, { fingerprints: [B, B] })).toBe("fingerprint_repeated");
    expect(pick(journalOrder, { fingerprints: [B, C] })).toBe("fingerprint_repeated");
    expect(pick(journalOrder, { fingerprints: [] })).toBe("fingerprint_repeated");
    expect(pick([named(A), named(B), named(B, { relativePath: "copy.mkv" })], { fingerprints: [B] })).toBe("fingerprint_ambiguous");
  });

  it("--limit can only be the redundant 1, so it never changes what is selected", () => {
    expect(pick(journalOrder, { fingerprints: [C], limit: "1" })).toEqual([C]);
    for (const limit of ["0", "2", "10", "01", "1.0", "abc", ""]) expect(pick(journalOrder, { fingerprints: [C], limit })).toBe("limit_conflicts_with_fingerprint");
  });

  it("a --kind given with the fingerprint must be the entry's kind; the fingerprint never changes routing", () => {
    const episode = named(B, { kind: "series" });
    expect(pick([named(A), episode], { fingerprints: [B], kind: "movie" })).toBe("fingerprint_kind_mismatch");
    expect(pick([named(A), episode], { fingerprints: [B], kind: "films" })).toBe("fingerprint_kind_mismatch");
    expect(only([named(A), episode], { fingerprints: [B], kind: "series" })).toBe(episode);
  });

  it("selection is not permission: a selected entry whose plan is not an upload is refused by uploadEntry, and nothing is sent", async () => {
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const plans = [["hold", "duplicate_same_title_same_vj"], ["reject", "file_too_large"], ["skip", "already_uploaded"], ["verify_upload", "interrupted_upload"]] as const;
    for (const [action, reason] of plans) {
      const store = new FakeStore();
      const selected = only([named(A), entry({ plan: { action, stopReasons: [reason] } })], { fingerprints: [FP] });
      expect(await uploadEntry(selected, CAPTION, deps(store, api))).toEqual({ result: "refused", code: `plan_${action}` });
      expect(store.calls).toEqual([]);
    }
    expect(api.preflight).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("a selected entry already uploaded is not uploaded again, even with a stale upload plan", async () => {
    const store = new FakeStore();
    store.status = { status: "uploaded", record: media(41) };
    const api = telegram(async () => ({ status: "succeeded", record: media(42) }));
    const uploaded = entry({ state: { ...entry().state, upload: "uploaded", uploadAttempts: 1, telegram: { chatId: MOVIES, messageId: 41 } }, telegram: media(41), dbAcknowledgedAt: T0.toISOString() });
    expect(await uploadEntry(only([uploaded], { fingerprints: [FP] }), CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "none" } });
    // A lost journal: the server's record still wins.
    expect(await uploadEntry(only([entry()], { fingerprints: [FP] }), CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "adopt_server", record: media(41) } });
    expect(store.calls).toEqual([]);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("a selected entry with an unresolved attempt goes to reconciliation, never to a second send", async () => {
    const store = new FakeStore();
    store.status = { status: "uncertain" };
    store.floor = 40;
    const api = telegram(async () => ({ status: "succeeded", record: media(42) }));
    expect(await uploadEntry(only([entry()], { fingerprints: [FP] }), CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    const interrupted = entry({ state: { ...entry().state, upload: "uploading", uploadAttempts: 1 } });
    expect(await uploadEntry(only([interrupted], { fingerprints: [FP] }), CAPTION, deps(new FakeStore(), api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("with the gate off, a selected, valid, planned entry is refused before the server or Telegram", async () => {
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const store = new FakeStore();
    const selected = only([named(A), entry()], { fingerprints: [FP] });
    vi.stubEnv(REAL_UPLOADS_ENV, undefined);
    expect(await uploadEntry(selected, CAPTION, deps(store, api))).toEqual({ result: "refused", code: "telegram_uploads_not_authorized" });
    expect(store.calls).toEqual([]);
    expect(api.preflight).not.toHaveBeenCalled();
  });

  it("a selected episode keeps series routing through the real adapter: refused offline, never sent to Movies", async () => {
    const SERIES_CHANNEL = -1002222222222;
    const env = {
      TELEGRAM_BOT_API_URL: "http://127.0.0.1:8081",
      TELEGRAM_MOVIES_BOT_TOKEN: "1111111:AAAAmovieFAKEtokenFAKEtokenFAKEtok",
      TELEGRAM_SERIES_BOT_TOKEN: "2222222:BBBBseriesFAKEtokenFAKEtokenFAKEto",
      TELEGRAM_MOVIES_CHANNEL_ID: String(MOVIES),
      TELEGRAM_SERIES_CHANNEL_ID: String(SERIES_CHANNEL),
      TELEGRAM_MOVIES_BOT_ID: "1111111",
      TELEGRAM_MOVIES_BOT_USERNAME: "fake_movies_bot",
      TELEGRAM_SERIES_BOT_ID: "2222222",
      TELEGRAM_SERIES_BOT_USERNAME: "fake_series_bot",
    };
    const network = vi.fn(() => Promise.reject(new Error("no network in tests")));
    const episodeCaption = buildUploadCaption({ kind: "series", title: "Show", year: null, vjName: "Junior", season: 1, episode: 2, fingerprint: FP });
    const run = async (candidate: JournalEntry, localBots: string) => {
      const loaded = loadLocalBotApiConfig({ ...env, TELEGRAM_BOT_API_LOCAL_BOTS: localBots });
      if (!loaded.ok) throw new Error(loaded.errors.join("; "));
      const api = createLocalBotApiClient(loaded.config, { fetch: network as unknown as typeof globalThis.fetch, mediaFetch: network as unknown as typeof globalThis.fetch, stat: async () => ({ isFile: true, size: SIZE }), uploadTimeoutMs: 1, requestTimeoutMs: 1 });
      const store = new FakeStore();
      const result = await uploadEntry(only([candidate], { fingerprints: [FP] }), episodeCaption, { journal, store, telegram: api, fingerprintSource: async () => FP, channelHighWater: async () => 0, now: () => T0, sleep: async () => {} });
      return { result, calls: store.calls };
    };
    // Series is still on the cloud: refused before any request or server start.
    expect(await run(entry({ kind: "series", intendedChannelId: SERIES_CHANNEL }), "movie")).toEqual({ result: { result: "refused", code: "bot_not_on_local_server" }, calls: [] });
    // An episode planned for the Movies channel is refused even with both bots local.
    expect(await run(entry({ kind: "series", intendedChannelId: MOVIES }), "movie,series")).toEqual({ result: { result: "refused", code: "channel_changed_since_plan" }, calls: [] });
    expect(network).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Upload-time source revalidation (C2B.2C.3): real files, the real sf1 algorithm
// ---------------------------------------------------------------------------

describe("upload-time source fingerprint revalidation", () => {
  // Just over three 4 MiB samples, so start, middle and end are separate sampled regions.
  const BYTES = 3 * SAMPLE_BYTES + 1024 * 1024;
  let folder: string;
  let path: string;
  let scanned: SourceFingerprint;

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "velora-source-"));
    path = join(folder, "Revalidate.2026.VJ.Junior.mkv");
    const bytes = new Uint8Array(BYTES);
    for (let i = 0; i < BYTES; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    writeFileSync(path, bytes);
    scanned = await fingerprintFile(path, BYTES);
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  /** Flips one byte in place; the file keeps its size. */
  function mutateAt(offset: number) {
    const bytes = readFileSync(path);
    bytes[offset] ^= 0xff;
    writeFileSync(path, bytes);
    expect(statSync(path).size).toBe(BYTES);
  }

  const source = (overrides: Partial<JournalEntry> = {}) => entry({ fingerprint: scanned, absolutePath: path, fileName: "Revalidate.2026.VJ.Junior.mkv", relativePath: "Revalidate.2026.VJ.Junior.mkv", sizeBytes: BYTES, ...overrides });
  const caption = () => buildUploadCaption({ kind: "movie", title: "Revalidate", year: 2026, vjName: "Junior", season: null, episode: null, fingerprint: scanned });
  const sent = (messageId: number) => media(messageId, scanned);
  /** The real sf1 revalidation, wrapped only to count calls. */
  const realFingerprint = () => vi.fn<UploaderDeps["fingerprintSource"]>((file, size) => fingerprintFile(file, size));

  it("the unchanged file fingerprints to the journal's value, and the upload proceeds in order", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: sent(41) }));
    const fingerprintSource = realFingerprint();
    expect(await verifySourceFingerprint(source(), fingerprintFile)).toEqual({ ok: true });
    expect(await uploadEntry(source(), caption(), { ...deps(store, api), fingerprintSource })).toEqual({ result: "uploaded", acknowledged: true });
    expect(fingerprintSource).toHaveBeenCalledExactlyOnceWith(path, BYTES);
    expect(store.calls).toEqual(["markUploadStarted", "recordUploadSucceeded"]);
    // Revalidation ran after preflight and before the server start and the send.
    expect(fingerprintSource.mock.invocationCallOrder[0]).toBeGreaterThan(api.preflight.mock.invocationCallOrder[0]);
    expect(fingerprintSource.mock.invocationCallOrder[0]).toBeLessThan(api.sendDocument.mock.invocationCallOrder[0]);
  });

  it("same name, same size, one byte changed in any sampled region: refused before the journal, the server and Telegram", async () => {
    for (const offset of [0, Math.floor((BYTES - SAMPLE_BYTES) / 2) + 17, BYTES - 1]) {
      const pristine = readFileSync(path);
      mutateAt(offset);
      const store = new FakeStore();
      const api = telegram(async () => ({ status: "succeeded", record: sent(41) }));
      expect(await uploadEntry(source(), caption(), { ...deps(store, api), fingerprintSource: fingerprintFile })).toEqual({ result: "refused", code: "source_fingerprint_changed" });
      expect(store.calls).toEqual([]);
      expect(api.preflight).toHaveBeenCalledTimes(1);
      expect(api.sendDocument).not.toHaveBeenCalled();
      // No attempt was journaled and the journal's fingerprint was not replaced.
      expect(await journal.get(scanned)).toBeNull();
      expect(await journal.list()).toEqual([]);
      writeFileSync(path, pristine);
    }
  });

  it("a journaled entry is left exactly as it was: no attempt, no new fingerprint, no rescan", async () => {
    await journal.put(source());
    const before = await journal.get(scanned);
    mutateAt(BYTES - 1);
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: sent(41) }));
    expect(await uploadEntry(source(), caption(), { ...deps(store, api), fingerprintSource: fingerprintFile })).toEqual({ result: "refused", code: "source_fingerprint_changed" });
    expect(await journal.list()).toEqual([before]);
    expect(store.calls).toEqual([]);
  });

  it("the check is on sampled content: a change outside the samples is not visible to sf1 (documented limit)", async () => {
    mutateAt(SAMPLE_BYTES + 10);
    expect(await verifySourceFingerprint(source(), fingerprintFile)).toEqual({ ok: true });
  });

  it("a size change and a missing file are refused by the real preflight, before revalidation", async () => {
    const network = vi.fn(() => Promise.reject(new Error("no network in tests")));
    const loaded = loadLocalBotApiConfig({
      TELEGRAM_BOT_API_URL: "http://127.0.0.1:8081",
      TELEGRAM_MOVIES_BOT_TOKEN: "1111111:AAAAmovieFAKEtokenFAKEtokenFAKEtok",
      TELEGRAM_SERIES_BOT_TOKEN: "2222222:BBBBseriesFAKEtokenFAKEtokenFAKEto",
      TELEGRAM_MOVIES_CHANNEL_ID: String(MOVIES),
      TELEGRAM_SERIES_CHANNEL_ID: "-1002222222222",
      TELEGRAM_BOT_API_LOCAL_BOTS: "movie",
      TELEGRAM_MOVIES_BOT_ID: "1111111",
      TELEGRAM_MOVIES_BOT_USERNAME: "fake_movies_bot",
    });
    if (!loaded.ok) throw new Error(loaded.errors.join("; "));
    const api = createLocalBotApiClient(loaded.config, {
      fetch: network as unknown as typeof globalThis.fetch,
      mediaFetch: network as unknown as typeof globalThis.fetch,
      stat: async (file) => {
        const facts = statSync(file);
        return { isFile: facts.isFile(), size: facts.size };
      },
      uploadTimeoutMs: 1,
      requestTimeoutMs: 1,
    });
    const attempt = async () => {
      const store = new FakeStore();
      const fingerprintSource = realFingerprint();
      const result = await uploadEntry(source(), caption(), { journal, store, telegram: api, fingerprintSource, channelHighWater: async () => 0, now: () => T0, sleep: async () => {} });
      return { result, calls: store.calls, fingerprinted: fingerprintSource.mock.calls.length };
    };

    writeFileSync(path, new Uint8Array(BYTES + 1));
    expect(await attempt()).toEqual({ result: { result: "refused", code: "source_changed_since_scan" }, calls: [], fingerprinted: 0 });
    rmSync(path);
    expect(await attempt()).toEqual({ result: { result: "refused", code: "source_unreadable" }, calls: [], fingerprinted: 0 });
    expect(network).not.toHaveBeenCalled();
  });

  it("a fingerprint read failure refuses with its own code: no attempt, no send", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: sent(41) }));
    const failing = vi.fn<UploaderDeps["fingerprintSource"]>(async () => {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: "EBUSY" });
    });
    expect(await uploadEntry(source(), caption(), { ...deps(store, api), fingerprintSource: failing })).toEqual({ result: "refused", code: "source_fingerprint_unreadable" });
    // A file that shrank after preflight is a short read: the same refusal, never a partial fingerprint.
    writeFileSync(path, new Uint8Array(BYTES - 1));
    expect(await verifySourceFingerprint(source(), fingerprintFile)).toEqual({ ok: false, code: "source_fingerprint_unreadable" });
    rmSync(path);
    expect(await verifySourceFingerprint(source(), fingerprintFile)).toEqual({ ok: false, code: "source_fingerprint_unreadable" });
    expect(store.calls).toEqual([]);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("the comparison is exact: a fingerprint differing only in its last hex digit is a change", async () => {
    const last = scanned.at(-1) === "0" ? "1" : "0";
    const neighbour = `${scanned.slice(0, -1)}${last}` as SourceFingerprint;
    expect(await verifySourceFingerprint(source(), async () => neighbour)).toEqual({ ok: false, code: "source_fingerprint_changed" });
    expect(await verifySourceFingerprint(source(), async () => scanned.toUpperCase() as SourceFingerprint)).toEqual({ ok: false, code: "source_fingerprint_changed" });
  });

  it("ordinary, --limit and --fingerprint selections all reach the same check", async () => {
    mutateAt(0);
    const other = `sf1-${"9".repeat(64)}` as SourceFingerprint;
    const entries = [source(), entry({ fingerprint: other, plan: { action: "hold", stopReasons: ["duplicate_same_title_same_vj"] } })];
    for (const options of [{}, { limit: "1" }, { fingerprints: [scanned] }]) {
      const selected = selectUploadEntries(entries, options);
      if (!selected.ok) throw new Error(selected.code);
      expect(selected.entries.map((item) => item.fingerprint)).toEqual([scanned]);
      const store = new FakeStore();
      const api = telegram(async () => ({ status: "succeeded", record: sent(41) }));
      expect(await uploadEntry(selected.entries[0], caption(), { ...deps(store, api), fingerprintSource: fingerprintFile })).toEqual({ result: "refused", code: "source_fingerprint_changed" });
      expect(store.calls).toEqual([]);
      expect(api.sendDocument).not.toHaveBeenCalled();
    }
  });

  it("an unresolved attempt is reconciled, never revalidated into a resend; resume never reads the source", async () => {
    mutateAt(0);
    const fingerprintSource = realFingerprint();
    const api = telegram(async () => ({ status: "succeeded", record: sent(42) }));
    const uncertain = new FakeStore();
    uncertain.status = { status: "uncertain" };
    uncertain.floor = 40;
    expect(await uploadEntry(source(), caption(), { ...deps(uncertain, api), fingerprintSource })).toEqual({ result: "resume", action: { action: "reconcile" } });
    const interrupted = source({ state: { ...entry().state, upload: "uploading", uploadAttempts: 1 } });
    expect(await uploadEntry(interrupted, caption(), { ...deps(new FakeStore(), api), fingerprintSource })).toEqual({ result: "resume", action: { action: "reconcile" } });
    // Replaying a journaled reply sends nothing, so it needs no source read.
    const unacknowledged = source({ state: { ...entry().state, upload: "uploaded", uploadAttempts: 1, telegram: { chatId: MOVIES, messageId: 41 } }, telegram: sent(41) });
    const pending = new FakeStore();
    pending.status = { status: "uploading" };
    pending.floor = 40;
    expect(await resumeEntry(unacknowledged, { ...deps(pending, api), fingerprintSource })).toEqual({ result: "uploaded", acknowledged: true });
    expect(fingerprintSource).not.toHaveBeenCalled();
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("with the code gate off, nothing runs at all, the revalidation included", async () => {
    const fingerprintSource = realFingerprint();
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "succeeded", record: sent(41) }));
    vi.stubEnv(REAL_UPLOADS_ENV, undefined);
    expect(await uploadEntry(source(), caption(), { ...deps(store, api), fingerprintSource })).toEqual({ result: "refused", code: "telegram_uploads_not_authorized" });
    expect(fingerprintSource).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Runtime real-upload authorization (C2B.2C.4): the real environment gate
// ---------------------------------------------------------------------------

describe("runtime real-upload authorization", () => {
  const DENIED: Array<string | undefined> = [undefined, "", "false", "FALSE", "0", "1", "yes", "TRUE", "True", " true ", "true ", " true", "true\n", "on", "enabled", "'true'", "\"true\""];
  const REFUSED = { result: "refused", code: "telegram_uploads_not_authorized" };

  it("only the exact string \"true\" authorizes; unset and every other value deny", () => {
    for (const value of DENIED) expect(isRealTelegramUploadAuthorized({ [REAL_UPLOADS_ENV]: value })).toBe(false);
    expect(isRealTelegramUploadAuthorized({})).toBe(false);
    expect(isRealTelegramUploadAuthorized({ REAL_TELEGRAM_UPLOADS: "true", NEXT_PUBLIC_REAL_TELEGRAM_UPLOADS_AUTHORIZED: "true" })).toBe(false);
    expect(isRealTelegramUploadAuthorized({ [REAL_UPLOADS_ENV]: "true" })).toBe(true);
  });

  it("every denied value refuses upload and resume before the server, the journal, the source and Telegram", async () => {
    for (const value of DENIED) {
      vi.stubEnv(REAL_UPLOADS_ENV, value);
      const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
      const store = new FakeStore();
      const fingerprintSource = vi.fn<UploaderDeps["fingerprintSource"]>(async () => FP);
      const denied = { ...deps(store, api), fingerprintSource };
      expect(await uploadEntry(entry(), CAPTION, denied)).toEqual(REFUSED);
      expect(await resumeEntry(entry({ state: { ...entry().state, upload: "uploading", uploadAttempts: 1 } }), denied)).toEqual(REFUSED);
      expect(store.calls).toEqual([]);
      expect(store.attempts).toBe(0);
      expect(fingerprintSource).not.toHaveBeenCalled();
      expect(await journal.list()).toEqual([]);
      for (const call of [api.preflight, api.sendDocument, api.checkRecoveryAccess, api.postRecoveryMarker, api.probeChannelMessage]) expect(call).not.toHaveBeenCalled();
    }
  });

  it("exact \"true\" lets the same path reach its next boundaries: the (fake) server start, then the (fake) sendDocument", async () => {
    vi.stubEnv(REAL_UPLOADS_ENV, "true");
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const store = new FakeStore();
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(store.calls).toEqual(["markUploadStarted", "recordUploadSucceeded"]);
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(store.calls.indexOf("markUploadStarted")).toBe(0);
  });

  it("is read on every call, not at import: the same deps are refused, then allowed, then refused again", async () => {
    const api = telegram(async () => ({ status: "succeeded", record: media(41) }));
    const store = new FakeStore();
    vi.stubEnv(REAL_UPLOADS_ENV, "false");
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual(REFUSED);
    expect(store.calls).toEqual([]);
    vi.stubEnv(REAL_UPLOADS_ENV, "true");
    expect(await uploadEntry(entry(), CAPTION, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    vi.stubEnv(REAL_UPLOADS_ENV, undefined);
    expect(await resumeEntry((await journal.get(FP))!, deps(store, api))).toEqual(REFUSED);
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("a stubbed value never leaks into the next test (checked after every test in this file)", () => {
    // beforeEach set "true"; this test changes it, and the file's afterEach
    // asserts the original process value is back once it ends.
    vi.stubEnv(REAL_UPLOADS_ENV, "1");
    expect(isRealTelegramUploadAuthorized()).toBe(false);
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

  it("fresh machine, journal lost: recovery runs from the server's floor alone, never from id 1", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 1: { status: "found", record: media(1, OTHER) }, 45: { status: "found", record: media(45) } }));
    await uncertainUpload(api, store);
    // The whole journal is gone; a rescan on another machine recreates the entry with no attempts.
    const fresh = entry();
    await journal.put(fresh);
    expect(fresh.attempts).toEqual([]);
    expect(await uploadEntry(fresh, CAPTION, deps(store, api))).toEqual({ result: "resume", action: { action: "reconcile" } });
    expect(await resumeEntry(fresh, deps(store, api, new Date(T0.getTime() + 60_000)))).toEqual({ result: "uploaded", acknowledged: true });
    const probed = api.probeChannelMessage.mock.calls.map(([, id]) => id);
    expect(probed[0]).toBe(41);
    expect(Math.min(...probed)).toBe(41);
    expect(store.status).toEqual({ status: "uploaded", record: media(45) });
    expect(await journal.get(FP)).toMatchObject({ state: { upload: "uploaded" }, telegram: media(45) });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("fresh machine, file absent: the grace period runs on the server's attempt age, then abandons", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    await uncertainUpload(api, store);
    const fresh = entry();
    await journal.put(fresh);
    expect(await resumeEntry(fresh, deps(store, api, new Date(T0.getTime() + 60_000)))).toEqual({ result: "resume", action: { action: "wait", reason: "within_upload_grace_period" } });
    expect(await resumeEntry(fresh, deps(store, api, new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS)))).toEqual({ result: "resume", action: { action: "abandon" } });
    expect(store.status).toEqual({ status: "failed" });
    expect(api.probeChannelMessage.mock.calls.every(([, id]) => id > 40)).toBe(true);
  });

  it("an uploader clock running ahead cannot shorten the grace period: the database age decides", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    const pending = await uncertainUpload(api, store);
    // The uploader believes 5 hours passed; the database measured 10 minutes.
    const skewed = deps(store, api, new Date(T0.getTime() + 5 * 3_600_000));
    store.clock = () => new Date(T0.getTime() + 600_000);
    expect(await resumeEntry(pending, skewed)).toEqual({ result: "resume", action: { action: "wait", reason: "within_upload_grace_period" } });
    expect(store.status).toEqual({ status: "uncertain" });
  });

  it("a server attempt without a floor (a pre-migration-10 row) holds: no marker, no scan, no upload", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    const pending = await uncertainUpload(api, store);
    store.floor = null;
    expect(await resumeEntry(pending, deps(store, api, new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS)))).toEqual({ result: "resume", action: { action: "hold", reason: "reconcile_floor_unknown" } });
    expect(api.checkRecoveryAccess).not.toHaveBeenCalled();
    expect(api.postRecoveryMarker).not.toHaveBeenCalled();
    expect(api.probeChannelMessage).not.toHaveBeenCalled();
    expect(store.status).toEqual({ status: "uncertain" });
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });

  it("the journal's floor corroborates when it agrees, and blocks when it is lower or higher than the server's", async () => {
    const later = new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS);
    for (const journalFloor of [39, 41, 1, 500]) {
      const store = new FakeStore();
      const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
      const pending = await uncertainUpload(api, store);
      expect(pending.attempts.at(-1)?.recoveryFloorMessageId).toBe(40);
      const disagreeing = { ...pending, attempts: pending.attempts.map((attempt) => ({ ...attempt, recoveryFloorMessageId: journalFloor })) };
      expect(await resumeEntry(disagreeing, deps(store, api, later))).toEqual({ result: "resume", action: { action: "hold", reason: "reconcile_floor_conflict" } });
      expect(api.postRecoveryMarker).not.toHaveBeenCalled();
      expect(api.probeChannelMessage).not.toHaveBeenCalled();
      expect(store.status).toEqual({ status: "uncertain" });
    }
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }));
    const agreeing = await uncertainUpload(api, store);
    expect(await resumeEntry(agreeing, deps(store, api, later))).toEqual({ result: "resume", action: { action: "abandon" } });
  });

  it("the journal's own high-water is never a floor: a stale or empty journal changes nothing", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 45: { status: "found", record: media(45) } }));
    await uploadEntry(entry(), CAPTION, { ...deps(store, api), channelHighWater: async () => 0 });
    const pending = (await journal.get(FP))!;
    expect(pending.attempts.at(-1)).toMatchObject({ channelHighWater: 0, recoveryFloorMessageId: 40 });
    expect(await resumeEntry(pending, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
    expect(Math.min(...api.probeChannelMessage.mock.calls.map(([, id]) => id))).toBe(41);
  });

  it("a corrupt journal is refused, and a rebuilt entry recovers from the server", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 45: { status: "found", record: media(45) } }));
    await uncertainUpload(api, store);
    writeFileSync(join(dir, `${FP}.json`), "{ corrupt");
    await expect(journal.get(FP)).rejects.toThrow();
    const rebuilt = entry();
    await journal.put(rebuilt);
    expect(await resumeEntry(rebuilt, deps(store, api))).toEqual({ result: "uploaded", acknowledged: true });
  });

  it("a legitimate retry gets the new floor the server assigns; the abandoned attempt's floor is not reused", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({}), 120);
    const pending = await uncertainUpload(api, store);
    expect(await resumeEntry(pending, deps(store, api, new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS)))).toEqual({ result: "resume", action: { action: "abandon" } });
    store.nextFloor = 90;
    const retry = { ...(await journal.get(FP))!, plan: { action: "retry_upload" as const, stopReasons: [] } };
    const later = new Date(T0.getTime() + DEFAULT_RECONCILE_GRACE_MS + 1);
    expect(await uploadEntry(retry, CAPTION, deps(store, api, later))).toEqual({ result: "uncertain", code: "timeout" });
    const second = (await journal.get(FP))!;
    expect(second.attempts.map((attempt) => attempt.recoveryFloorMessageId)).toEqual([40, 90]);
    api.probeChannelMessage.mockClear();
    await resumeEntry(second, deps(store, api, later));
    expect(Math.min(...api.probeChannelMessage.mock.calls.map(([, id]) => id))).toBe(91);
  });

  it("after a resolution the server recorded, the marker is offered as the channel checkpoint", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 45: { status: "found", record: media(45) } }));
    const pending = await uncertainUpload(api, store);
    await resumeEntry(pending, deps(store, api));
    expect(store.checkpoints).toEqual([{ kind: "movie", chatId: MOVIES, messageId: MARKER_ID }]);
  });

  it("no checkpoint is offered while the resolution is unrecorded or held", async () => {
    const store = new FakeStore();
    const api = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 45: { status: "found", record: media(45) } }));
    const pending = await uncertainUpload(api, store);
    store.failNext = "recordUploadSucceeded";
    expect(await resumeEntry(pending, deps(store, api))).toEqual({ result: "uploaded", acknowledged: false });
    expect(store.checkpoints).toEqual([]);
    const held = new FakeStore();
    const heldApi = telegram(async () => ({ status: "uncertain", code: "timeout" }), channel({ 45: { status: "uninspectable", code: "telegram_rejected_400" } }));
    await resumeEntry(await uncertainUpload(heldApi, held), deps(held, heldApi));
    expect(held.checkpoints).toEqual([]);
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
      const pending = { ...entry({ kind }), state: { ...entry().state, upload: "uploading" as const, uploadAttempts: 1 }, attempts: [{ number: 1, startedAt: T0.toISOString(), channelHighWater: 40, recoveryFloorMessageId: 40, outcome: "uncertain" as const, code: "timeout", finishedAt: null }] };
      store.status = { status: "uncertain" };
      store.floor = 40;
      await resumeEntry(pending, deps(store, api));
      expect(api.checkRecoveryAccess.mock.calls).toEqual([[kind]]);
      expect(api.postRecoveryMarker.mock.calls.map(([markerKind]) => markerKind)).toEqual([kind]);
      expect(new Set(api.probeChannelMessage.mock.calls.map(([probeKind]) => probeKind))).toEqual(new Set([kind]));
      // The marker operation is text only: nothing was uploaded.
      expect(api.sendDocument).not.toHaveBeenCalled();
    }
  });
});
