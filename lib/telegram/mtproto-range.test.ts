import { describe, expect, it } from "vitest";
import { assembleRange, MTPROTO_ALIGNMENT, MTPROTO_WINDOW, planRangeReads, type PlannedRead } from "@/lib/telegram/mtproto-range";

const MIB = MTPROTO_WINDOW;
const SIZE = 1_004_462_878; // On The Hunt
const LIMIT = 64 * MIB;

function plan(start: number, end: number, size = SIZE, max = LIMIT) {
  const result = planRangeReads(start, end, size, max);
  if (!result.ok) throw new Error(result.code);
  return result;
}

/** Every read obeys Telegram's `precise` rules. */
function legal(read: PlannedRead) {
  return read.offset % MTPROTO_ALIGNMENT === 0
    && read.limit % MTPROTO_ALIGNMENT === 0
    && read.limit > 0 && read.limit <= MIB
    && Math.floor(read.offset / MIB) === Math.floor((read.offset + read.limit - 1) / MIB);
}

/** A fake "Telegram": answers a read from a synthetic file, truncating at EOF. */
function serve(size: number, read: PlannedRead) {
  const bytes = new Uint8Array(Math.max(0, Math.min(read.limit, size - read.offset)));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (read.offset + i) * 2654435761 >>> 24;
  return bytes;
}
function expected(start: number, end: number) {
  const bytes = new Uint8Array(end - start + 1);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (start + i) * 2654435761 >>> 24;
  return bytes;
}
function roundTrip(start: number, end: number, size = SIZE) {
  const p = plan(start, end, size);
  expect(p.reads.every(legal)).toBe(true);
  const out = assembleRange(p, p.reads.map((read) => serve(size, read)));
  expect(out.length).toBe(p.length);
  expect(Buffer.from(out).equals(Buffer.from(expected(p.start, p.end)))).toBe(true);
  return p;
}

describe("planRangeReads: Telegram precise rules", () => {
  it("an aligned range inside one window is one exact read", () => {
    const p = roundTrip(4 * MIB, 4 * MIB + 262_143);
    expect(p.reads).toEqual([{ offset: 4 * MIB, limit: 262_144, keepFrom: 0, keepLength: 262_144 }]);
  });

  it("an unaligned start rounds the offset down to 1 KiB and trims the prefix", () => {
    const p = roundTrip(1_500, 5_000);
    expect(p.reads).toEqual([{ offset: 1024, limit: 4096, keepFrom: 476, keepLength: 3_501 }]);
  });

  it("an unaligned end rounds the limit up to 1 KiB and trims the suffix", () => {
    const p = roundTrip(2048, 2048 + 1_000);
    expect(p.reads[0]).toEqual({ offset: 2048, limit: 1024, keepFrom: 0, keepLength: 1_001 });
  });

  it("a range crossing one 1 MiB boundary becomes two reads, one per window", () => {
    const p = roundTrip(MIB - 10, MIB + 10);
    expect(p.reads).toEqual([
      { offset: MIB - 1024, limit: 1024, keepFrom: 1014, keepLength: 10 },
      { offset: MIB, limit: 1024, keepFrom: 0, keepLength: 11 },
    ]);
  });

  it("a range crossing several boundaries uses exactly one read per touched window", () => {
    const p = roundTrip(123_456_789, 124_505_364); // the brief's example
    expect(p.length).toBe(1_048_576);
    expect(p.reads.length).toBe(2);
    const long = roundTrip(3 * MIB + 7, 7 * MIB + 3);
    expect(long.reads.length).toBe(5);
    expect(long.reads.every((read) => read.limit <= MIB)).toBe(true);
  });

  it("the beginning of the file", () => {
    const p = roundTrip(0, 0);
    expect(p.reads).toEqual([{ offset: 0, limit: 1024, keepFrom: 0, keepLength: 1 }]);
    roundTrip(0, MIB - 1);
  });

  it("exactly the last byte, and a final partial window (Telegram returns fewer bytes at EOF)", () => {
    const last = roundTrip(SIZE - 1, SIZE - 1);
    expect(last.length).toBe(1);
    const tail = roundTrip(SIZE - 29_252, SIZE - 1);
    expect(tail.end).toBe(SIZE - 1);
    // The limit may reach past EOF (still legal); only real bytes are kept.
    expect(tail.reads.at(-1)!.offset + tail.reads.at(-1)!.limit).toBeGreaterThanOrEqual(SIZE);
  });

  it("an end beyond EOF is clamped to the last byte (RFC 9110)", () => {
    const p = roundTrip(SIZE - 100, SIZE + 5 * MIB);
    expect(p.end).toBe(SIZE - 1);
    expect(p.length).toBe(100);
  });

  it("a small file", () => {
    roundTrip(0, 9, 10);
    roundTrip(3, 3, 10);
  });

  it("refuses invalid, unsatisfiable and oversized ranges", () => {
    expect(planRangeReads(-1, 10, SIZE, LIMIT)).toEqual({ ok: false, code: "invalid_range" });
    expect(planRangeReads(10, 9, SIZE, LIMIT)).toEqual({ ok: false, code: "invalid_range" });
    expect(planRangeReads(0.5, 10, SIZE, LIMIT)).toEqual({ ok: false, code: "invalid_range" });
    expect(planRangeReads(0, Number.NaN, SIZE, LIMIT)).toEqual({ ok: false, code: "invalid_range" });
    expect(planRangeReads(SIZE, SIZE + 10, SIZE, LIMIT)).toEqual({ ok: false, code: "range_not_satisfiable" });
    expect(planRangeReads(0, 0, 0, LIMIT)).toEqual({ ok: false, code: "range_not_satisfiable" });
    expect(planRangeReads(0, 2 * MIB, SIZE, 2 * MIB)).toEqual({ ok: false, code: "range_too_large" });
  });

  it("every read is legal across many arbitrary ranges", () => {
    let seed = 42;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i += 1) {
      const start = Math.floor(next() * (SIZE - 1));
      const end = start + Math.floor(next() * 5 * MIB);
      const p = plan(start, end);
      expect(p.reads.every(legal)).toBe(true);
      expect(p.reads.reduce((sum, read) => sum + read.keepLength, 0)).toBe(p.length);
      expect(p.reads.length).toBe(Math.floor(p.end / MIB) - Math.floor(p.start / MIB) + 1);
    }
  });
});

describe("assembleRange", () => {
  it("refuses a truncated reply or a reply count mismatch instead of returning short output", () => {
    const p = plan(MIB - 10, MIB + 10);
    const replies = p.reads.map((read) => serve(SIZE, read));
    expect(() => assembleRange(p, [replies[0]])).toThrow("range_reply_count_mismatch");
    expect(() => assembleRange(p, [replies[0], replies[1].subarray(0, 5)])).toThrow("range_reply_truncated");
  });
});
