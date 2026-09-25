import { describe, expect, it, vi } from "vitest";
import {
  buildRecoveryMarker,
  decideAfterReconcile,
  DEFAULT_RECONCILE_GRACE_MS,
  DEFAULT_RECOVERY_PACING,
  isRecoveryMarker,
  reconcileUpload,
  resolveRecoveryFloor,
  type ReconcileOptions,
} from "@/lib/ingestion/recovery";
import { fingerprintFromCaption } from "@/lib/ingestion/telegram";
import type { ChannelProbeResult, MarkerPostResult, RecoveryAccessResult, ReconciliationResult, SourceFingerprint, TelegramMediaRecord } from "@/types/ingestion";

const FP = `sf1-${"c".repeat(64)}` as SourceFingerprint;
const OTHER = `sf1-${"d".repeat(64)}` as SourceFingerprint;
const MOVIES = -1001111111111;
const SIZE = 1_800_000_000;
const T0 = new Date("2026-09-25T10:00:00Z");
const FLOOR = 10;

function media(messageId: number, fingerprint: SourceFingerprint | null = FP, overrides: Partial<TelegramMediaRecord> = {}): TelegramMediaRecord {
  return {
    botType: "movie", chatId: MOVIES, messageId, fileId: `file-${messageId}`, fileUniqueId: `uniq-${messageId}`, mediaKind: "document",
    fileName: "John.Wick.2014.VJ.Junior.mkv", mimeType: "video/x-matroska", caption: fingerprint ? `x\nvelora-src:${fingerprint}` : "x",
    fileSizeBytes: SIZE, durationSeconds: null, width: null, height: null, telegramDate: T0.toISOString(), sourceFingerprint: fingerprint, ...overrides,
  };
}

const found = (messageId: number, fingerprint: SourceFingerprint | null = FP): ChannelProbeResult => ({ status: "found", record: media(messageId, fingerprint) });

/**
 * A fake channel and recovery transport. `messages` answers each id; ids not
 * listed are deleted (missing). `script` answers the first calls for an id in
 * order (a rate limit, then the real answer), then falls back to `messages`.
 */
function fake(options: {
  messages?: Record<number, ChannelProbeResult>;
  script?: Record<number, ChannelProbeResult[]>;
  marker?: number;
  access?: RecoveryAccessResult;
  markerResult?: MarkerPostResult;
} = {}) {
  const script = Object.fromEntries(Object.entries(options.script ?? {}).map(([id, results]) => [id, results.slice()]));
  const transport = {
    checkAccess: vi.fn(async (): Promise<RecoveryAccessResult> => options.access ?? { status: "ok" }),
    postMarker: vi.fn<(text: string) => Promise<MarkerPostResult>>(async () => options.markerResult ?? { status: "posted", chatId: MOVIES, messageId: options.marker ?? 50 }),
    probe: vi.fn(async (messageId: number): Promise<ChannelProbeResult> => script[messageId]?.shift() ?? options.messages?.[messageId] ?? { status: "missing" }),
  };
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const run = (overrides: Partial<ReconcileOptions> = {}) =>
    reconcileUpload({ fingerprint: FP, sizeBytes: SIZE, attemptNumber: 1, floorMessageId: FLOOR, transport, sleep, now: () => T0, ...overrides });
  const probed = () => transport.probe.mock.calls.map(([id]) => id);
  return { transport, sleep, run, probed };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const MARKER = { chatId: MOVIES, messageId: 50, postedAt: T0.toISOString() };

describe("reconcileUpload: bounded marker protocol", () => {
  it("finds the target immediately before the marker, inspecting every id in the interval and nothing outside it", async () => {
    const { run, probed, transport } = fake({ messages: { 49: found(49) } });
    expect(await run()).toEqual({ status: "found", record: media(49), marker: MARKER });
    expect(probed()).toEqual(range(11, 49));
    expect(transport.checkAccess).toHaveBeenCalledOnce();
    expect(transport.postMarker).toHaveBeenCalledOnce();
  });

  it("finds a target far before the marker and still inspects the rest of the interval", async () => {
    const { run, probed } = fake({ marker: 1500, messages: { 11: found(11) } });
    expect(await run()).toMatchObject({ status: "found", record: { messageId: 11 } });
    expect(probed()).toEqual(range(11, 1499));
  });

  it("steps over more than 20 deleted ids before the target", async () => {
    const { run, probed } = fake({ marker: 45, messages: { 40: found(40) } });
    expect(await run()).toMatchObject({ status: "found", record: { messageId: 40 } });
    expect(probed()).toEqual(range(11, 44));
  });

  it("steps over more than 100 deleted ids before the target", async () => {
    const { run } = fake({ marker: 170, messages: { 160: found(160) } });
    expect(await run()).toMatchObject({ status: "found", record: { messageId: 160 } });
  });

  it("a long run of deleted ids never ends the scan early: absence is confirmed only at the marker", async () => {
    const { run, probed } = fake({ marker: 400 });
    expect(await run()).toEqual({ status: "not_found_confirmed", floorMessageId: FLOOR, marker: { chatId: MOVIES, messageId: 400, postedAt: T0.toISOString() } });
    expect(probed()).toEqual(range(11, 399));
  });

  it("ignores other files and text messages (earlier markers included)", async () => {
    const { run } = fake({ messages: { 11: found(11, OTHER), 12: { status: "not_media" }, 13: found(13), 14: found(14, null) } });
    expect(await run()).toMatchObject({ status: "found", record: { messageId: 13 } });
  });

  it("confirms absence only after the complete interval was inspected", async () => {
    const { run, probed } = fake({ messages: { 11: found(11, OTHER), 30: { status: "not_media" } } });
    expect(await run()).toEqual({ status: "not_found_confirmed", floorMessageId: FLOOR, marker: MARKER });
    expect(probed()).toEqual(range(11, 49));
  });

  it("two messages with the fingerprint are ambiguous", async () => {
    const { run } = fake({ messages: { 12: found(12), 30: found(30) } });
    expect(await run()).toEqual({ status: "ambiguous", reason: "multiple_matches", messageIds: [12, 30] });
  });

  it("a same-token message with another size is never adopted", async () => {
    const { run } = fake({ messages: { 12: { status: "found", record: media(12, FP, { fileSizeBytes: SIZE - 5 }) } } });
    expect(await run()).toEqual({ status: "ambiguous", reason: "size_mismatch", messageIds: [12] });
  });

  it("a service or non-forwardable message in the interval makes the scan incomplete, even after a match", async () => {
    const { run, probed } = fake({ messages: { 12: found(12), 20: { status: "uninspectable", code: "telegram_rejected_400" } } });
    expect(await run()).toEqual({ status: "incomplete", reason: "uninspectable_message", messageIds: [12, 20] });
    expect(probed().at(-1)).toBe(20);
    const alone = fake({ messages: { 20: { status: "uninspectable", code: "unexpected_forward" } } });
    expect(await alone.run()).toEqual({ status: "incomplete", reason: "uninspectable_message", messageIds: [20] });
  });

  it("waits out a short rate limit halfway through, then carries on from the same id", async () => {
    const { run, probed, sleep } = fake({ messages: { 45: found(45) }, script: { 30: [{ status: "rate_limited", retryAfterSeconds: 7 }] } });
    expect(await run()).toMatchObject({ status: "found", record: { messageId: 45 } });
    expect(probed().filter((id) => id === 30)).toHaveLength(2);
    expect(probed().filter((id) => id !== 30)).toEqual(range(11, 49).filter((id) => id !== 30));
    expect(sleep).toHaveBeenCalledWith(8_000);
  });

  it("a long, unspecified or repeated rate limit ends the scan as rate_limited, never as absent", async () => {
    expect(await fake({ script: { 30: [{ status: "rate_limited", retryAfterSeconds: 600 }] } }).run()).toEqual({ status: "rate_limited", retryAfterSeconds: 600 });
    expect(await fake({ script: { 30: [{ status: "rate_limited", retryAfterSeconds: null }] } }).run()).toEqual({ status: "rate_limited", retryAfterSeconds: null });
    const always = fake({ script: { 30: Array.from({ length: 10 }, () => ({ status: "rate_limited" as const, retryAfterSeconds: 1 })) } });
    expect(await always.run()).toEqual({ status: "rate_limited", retryAfterSeconds: 1 });
    expect(always.sleep.mock.calls.filter(([ms]) => ms === 2_000)).toHaveLength(DEFAULT_RECOVERY_PACING.maxRateLimitWaits);
  });

  it("retries a transient failure halfway through with backoff, and gives up as transient", async () => {
    const recovers = fake({ script: { 30: [{ status: "transient", code: "timeout" }, { status: "transient", code: "timeout" }] } });
    expect(await recovers.run()).toMatchObject({ status: "not_found_confirmed" });
    expect(recovers.sleep).toHaveBeenCalledWith(5_000);
    expect(recovers.sleep).toHaveBeenCalledWith(10_000);

    const persists = fake({ messages: { 45: found(45) }, script: { 30: Array.from({ length: 10 }, () => ({ status: "transient" as const, code: "telegram_server_502" })) } });
    expect(await persists.run()).toEqual({ status: "transient", code: "telegram_server_502" });
    expect(persists.probed().at(-1)).toBe(30);
  });

  it("a permission failure stops for the operator, at any stage", async () => {
    const probe = fake({ script: { 25: [{ status: "blocked", code: "telegram_forbidden" }] } });
    expect(await probe.run()).toEqual({ status: "permission_blocked", code: "telegram_forbidden" });

    const access = fake({ access: { status: "blocked", code: "channel_content_protected" } });
    expect(await access.run()).toEqual({ status: "permission_blocked", code: "channel_content_protected" });
    expect(access.transport.postMarker).not.toHaveBeenCalled();

    const marker = fake({ markerResult: { status: "blocked", code: "telegram_forbidden" } });
    expect(await marker.run()).toEqual({ status: "permission_blocked", code: "telegram_forbidden" });
    expect(marker.transport.probe).not.toHaveBeenCalled();
  });

  it("a marker that could not be posted means no upper bound and no scan", async () => {
    const limited = fake({ markerResult: { status: "rate_limited", retryAfterSeconds: 30 } });
    expect(await limited.run()).toEqual({ status: "rate_limited", retryAfterSeconds: 30 });
    const timedOut = fake({ markerResult: { status: "transient", code: "marker_timeout" } });
    expect(await timedOut.run()).toEqual({ status: "transient", code: "marker_timeout" });
    expect(limited.transport.probe).not.toHaveBeenCalled();
    expect(timedOut.transport.probe).not.toHaveBeenCalled();
  });

  it("without a floor (fresh machine, lost journal) it never scans from id 1 and makes no Telegram call", async () => {
    for (const floorMessageId of [null, 0, -3, 1.5]) {
      const { run, transport } = fake({ messages: { 1: found(1) } });
      expect(await run({ floorMessageId })).toEqual({ status: "incomplete", reason: "floor_unknown", messageIds: [] });
      expect(transport.checkAccess).not.toHaveBeenCalled();
      expect(transport.postMarker).not.toHaveBeenCalled();
      expect(transport.probe).not.toHaveBeenCalled();
    }
  });

  it("a marker at or below the floor, or an oversized interval, is incomplete without probing", async () => {
    const below = fake({ marker: FLOOR });
    expect(await below.run()).toEqual({ status: "incomplete", reason: "floor_not_below_marker", messageIds: [] });
    const huge = fake({ marker: FLOOR + DEFAULT_RECOVERY_PACING.maxIntervalIds + 2 });
    expect(await huge.run()).toEqual({ status: "incomplete", reason: "interval_too_large", messageIds: [] });
    expect(below.transport.probe).not.toHaveBeenCalled();
    expect(huge.transport.probe).not.toHaveBeenCalled();
    // The limit itself is still scanned.
    expect(await fake({ marker: FLOOR + DEFAULT_RECOVERY_PACING.maxIntervalIds + 1 }).run()).toMatchObject({ status: "not_found_confirmed" });
  });

  it("an empty interval (marker right above the floor) is complete", async () => {
    const { run, probed } = fake({ marker: FLOOR + 1 });
    expect(await run()).toMatchObject({ status: "not_found_confirmed" });
    expect(probed()).toEqual([]);
  });

  it("paces probes and never sleeps before the first", async () => {
    const { run, sleep } = fake({ marker: 15 });
    await run();
    expect(sleep.mock.calls).toEqual([[3_000], [3_000], [3_000]]);
  });

  it("an interval with any uninspected id never returns confirmed absence (every position, every failure)", async () => {
    const failures: ChannelProbeResult[][] = [
      [{ status: "uninspectable", code: "telegram_rejected_400" }],
      Array.from({ length: 10 }, () => ({ status: "rate_limited" as const, retryAfterSeconds: 1 })),
      [{ status: "rate_limited", retryAfterSeconds: 3_600 }],
      Array.from({ length: 10 }, () => ({ status: "transient" as const, code: "timeout" })),
      [{ status: "blocked", code: "telegram_forbidden" }],
    ];
    for (const failure of failures) {
      for (const position of range(11, 29)) {
        const result: ReconciliationResult = await fake({ marker: 30, script: { [position]: failure } }).run();
        expect(result.status, `${failure[0].status} at ${position}`).not.toBe("not_found_confirmed");
        expect(result.status).not.toBe("found");
      }
    }
  });
});

describe("recovery marker", () => {
  const text = buildRecoveryMarker(FP, 2, T0);

  it("is short, recognisable and tied to the source and attempt", () => {
    expect(text).toBe(`velora-recovery:v1 src=${FP} attempt=2 at=2026-09-25T10:00:00.000Z`);
    expect(text.length).toBeLessThan(160);
    expect(isRecoveryMarker(text)).toBe(true);
    expect(isRecoveryMarker(buildRecoveryMarker(FP, null, T0))).toBe(true);
  });

  it("never carries the caption token, a path or a secret", () => {
    expect(fingerprintFromCaption(text)).toBeNull();
    expect(text).not.toContain("velora-src:");
    expect(text).not.toMatch(/[\\/]|\d{5,}:[A-Za-z0-9_-]{30,}|token|key|password/i);
  });

  it("recognises only marker text", () => {
    expect(isRecoveryMarker(`${text}\nvelora-src:${FP}`)).toBe(false);
    expect(isRecoveryMarker(`velora-src:${FP}`)).toBe(false);
    expect(isRecoveryMarker("C:\\Media\\Movies\\John.Wick.mkv")).toBe(false);
    expect(isRecoveryMarker(`${text} extra`)).toBe(false);
  });
});

describe("decideAfterReconcile", () => {
  const within = new Date(T0.getTime() - 60_000);
  const after = new Date(T0.getTime() - DEFAULT_RECONCILE_GRACE_MS);
  const absent: ReconciliationResult = { status: "not_found_confirmed", floorMessageId: FLOOR, marker: MARKER };

  it("a match is recorded, even during the grace period", () => {
    expect(decideAfterReconcile({ status: "found", record: media(12), marker: MARKER }, within)).toEqual({ action: "record_confirmed", record: media(12) });
  });

  it("confirmed absence waits while the marker is inside the grace period, and abandons only after it", () => {
    expect(decideAfterReconcile(absent, within)).toEqual({ action: "wait", reason: "within_upload_grace_period" });
    expect(decideAfterReconcile(absent, new Date(after.getTime() + 1))).toEqual({ action: "wait", reason: "within_upload_grace_period" });
    expect(decideAfterReconcile(absent, after)).toEqual({ action: "abandon" });
    expect(decideAfterReconcile(absent, null)).toEqual({ action: "hold", reason: "reconcile_attempt_time_unknown" });
  });

  it("nothing but confirmed absence can abandon, whatever the attempt's age", () => {
    const old = new Date(0);
    const others: ReconciliationResult[] = [
      { status: "ambiguous", reason: "multiple_matches", messageIds: [1, 2] },
      { status: "incomplete", reason: "uninspectable_message", messageIds: [3] },
      { status: "incomplete", reason: "floor_unknown", messageIds: [] },
      { status: "rate_limited", retryAfterSeconds: 5 },
      { status: "transient", code: "timeout" },
      { status: "permission_blocked", code: "telegram_forbidden" },
    ];
    expect(others.map((result) => decideAfterReconcile(result, old))).toEqual([
      { action: "review", reason: "reconcile_multiple_matches" },
      { action: "hold", reason: "reconcile_incomplete_uninspectable_message" },
      { action: "hold", reason: "reconcile_incomplete_floor_unknown" },
      { action: "retry_later", code: "telegram_rate_limited", retryAfterSeconds: 5 },
      { action: "retry_later", code: "timeout", retryAfterSeconds: null },
      { action: "hold", reason: "reconcile_blocked_telegram_forbidden" },
    ]);
  });

  it("hold and review reasons fit the database failure-code format", () => {
    for (const reason of ["reconcile_incomplete_uninspectable_message", "reconcile_blocked_channel_content_protected", "reconcile_incomplete_interval_too_large"]) {
      expect(reason).toMatch(/^[a-z0-9_]{1,100}$/);
    }
  });
});

describe("resolveRecoveryFloor (migration 10: the server floor is authoritative)", () => {
  const readAt = new Date("2026-09-25T12:00:00Z");
  const server = { floorMessageId: 320, startedAt: "2026-09-25T09:00:00.000Z", ageSeconds: 3_600 };

  it("uses the server floor and places the server-measured start on the local clock", () => {
    expect(resolveRecoveryFloor(server, null, readAt)).toEqual({ ok: true, floorMessageId: 320, attemptStartedAt: new Date("2026-09-25T11:00:00Z") });
  });

  it("a journal floor that agrees only corroborates", () => {
    expect(resolveRecoveryFloor(server, 320, readAt)).toMatchObject({ ok: true, floorMessageId: 320 });
  });

  it("a journal floor lower or higher than the server's is a conflict, never a choice", () => {
    expect(resolveRecoveryFloor(server, 319, readAt)).toEqual({ ok: false, reason: "floor_conflict" });
    expect(resolveRecoveryFloor(server, 321, readAt)).toEqual({ ok: false, reason: "floor_conflict" });
  });

  it("without a server floor the floor is unknown, whatever the journal says", () => {
    expect(resolveRecoveryFloor(null, 320, readAt)).toEqual({ ok: false, reason: "floor_unknown" });
    expect(resolveRecoveryFloor({ ...server, floorMessageId: null }, 320, readAt)).toEqual({ ok: false, reason: "floor_unknown" });
    expect(resolveRecoveryFloor({ ...server, floorMessageId: 0 }, null, readAt)).toEqual({ ok: false, reason: "floor_unknown" });
  });

  it("the grace period follows the database clock: a skewed uploader clock cannot shorten it", () => {
    // Uploader clock 2 h fast: the journal would claim a 5 h old attempt; the server says 1 h.
    const floor = resolveRecoveryFloor(server, null, readAt);
    if (!floor.ok) throw new Error("expected a floor");
    const absent: ReconciliationResult = { status: "not_found_confirmed", floorMessageId: 320, marker: { chatId: MOVIES, messageId: 400, postedAt: readAt.toISOString() } };
    expect(decideAfterReconcile(absent, floor.attemptStartedAt)).toEqual({ action: "wait", reason: "within_upload_grace_period" });
    const old = resolveRecoveryFloor({ ...server, ageSeconds: 3 * 3_600 }, null, readAt);
    if (!old.ok) throw new Error("expected a floor");
    expect(decideAfterReconcile(absent, old.attemptStartedAt)).toEqual({ action: "abandon" });
  });
});
