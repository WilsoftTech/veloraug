import { describe, expect, it } from "vitest";
import { MTPROTO_ALIGNMENT, MTPROTO_WINDOW } from "@/lib/telegram/mtproto-range";
import { contentRange, parseRangeHeader, unsatisfiedContentRange } from "@/lib/media-gateway/range";

const SIZE = 1_004_462_878; // On The Hunt
const MAX = 8 * 1024 * 1024;
const ok = (header: string | undefined, size = SIZE, max = MAX) => {
  const result = parseRangeHeader(header, size, max);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
};
const code = (header: string | string[] | undefined, size = SIZE, max = MAX) => {
  const result = parseRangeHeader(header, size, max);
  return result.ok ? "ok" : result.code;
};

describe("parseRangeHeader", () => {
  it("parses a closed, aligned range into one aligned read", () => {
    const { range, plan } = ok("bytes=0-1048575");
    expect(range).toEqual({ start: 0, end: 1_048_575, length: 1_048_576 });
    expect(plan.reads).toEqual([{ offset: 0, limit: 1_048_576, keepFrom: 0, keepLength: 1_048_576 }]);
  });

  it("maps an unaligned range crossing a 1 MiB window onto two legal reads", () => {
    const { range, plan } = ok("bytes=123456789-124505364");
    expect(range.length).toBe(1_048_576);
    expect(plan.reads).toHaveLength(2);
    for (const read of plan.reads) {
      expect(read.offset % MTPROTO_ALIGNMENT).toBe(0);
      expect(read.limit % MTPROTO_ALIGNMENT).toBe(0);
      expect(read.limit).toBeLessThanOrEqual(MTPROTO_WINDOW);
      expect(Math.floor(read.offset / MTPROTO_WINDOW)).toBe(Math.floor((read.offset + read.limit - 1) / MTPROTO_WINDOW));
    }
    expect(plan.reads.reduce((sum, read) => sum + read.keepLength, 0)).toBe(range.length);
  });

  it("serves a suffix range from the end of the file", () => {
    expect(ok("bytes=-65536").range).toEqual({ start: SIZE - 65_536, end: SIZE - 1, length: 65_536 });
  });

  it("treats a suffix longer than the file as the whole file, then bounds it", () => {
    expect(ok("bytes=-5000", 1000).range).toEqual({ start: 0, end: 999, length: 1000 });
    expect(ok(`bytes=-${SIZE * 2}`).range).toEqual({ start: 0, end: MAX - 1, length: MAX });
  });

  it("bounds an open-ended range to the per-response maximum instead of sending the movie", () => {
    expect(ok("bytes=0-").range).toEqual({ start: 0, end: MAX - 1, length: MAX });
    expect(ok("bytes=500000000-").range.length).toBe(MAX);
  });

  it("bounds a closed range longer than the maximum", () => {
    expect(ok(`bytes=10-${SIZE - 1}`).range).toEqual({ start: 10, end: 10 + MAX - 1, length: MAX });
  });

  it("clamps an end past EOF", () => {
    expect(ok(`bytes=${SIZE - 1000}-${SIZE + 4096}`).range).toEqual({ start: SIZE - 1000, end: SIZE - 1, length: 1000 });
    expect(ok(`bytes=${SIZE - 1}-`).range.length).toBe(1);
  });

  it("requires a Range header", () => {
    expect(code(undefined)).toBe("range_required");
  });

  it.each([
    "",
    "bytes",
    "bytes=",
    "bytes=-",
    "bytes=a-b",
    "bytes=10-5",
    "bytes=0-1,5-9",
    "bytes=0-1, 5-9",
    "items=0-1",
    "Bytes=0-1",
    "bytes=+1-2",
    "bytes=1.5-2",
    "bytes=0x10-20",
    "bytes=1e3-2000",
    "bytes=1234567890123456-",
    `bytes=0-${"9".repeat(80)}`,
  ])("rejects malformed %j as invalid", (header) => {
    expect(code(header)).toBe("invalid_range");
  });

  it("rejects a repeated header", () => {
    expect(code(["bytes=0-1", "bytes=2-3"])).toBe("invalid_range");
  });

  it.each([`bytes=${SIZE}-`, `bytes=${SIZE}-${SIZE + 10}`, "bytes=-0", `bytes=${SIZE + 1}-${SIZE + 2}`])("marks %s unsatisfiable", (header) => {
    expect(code(header)).toBe("range_not_satisfiable");
  });

  it("formats Content-Range for 206 and 416", () => {
    expect(contentRange({ start: 0, end: 99, length: 100 }, SIZE)).toBe(`bytes 0-99/${SIZE}`);
    expect(unsatisfiedContentRange(SIZE)).toBe("bytes */1004462878");
  });

  it("refuses to run without a valid size or maximum", () => {
    expect(() => parseRangeHeader("bytes=0-1", 0, MAX)).toThrow();
    expect(() => parseRangeHeader("bytes=0-1", SIZE, 0)).toThrow();
  });
});
