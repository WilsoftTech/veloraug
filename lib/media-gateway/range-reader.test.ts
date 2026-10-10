import { describe, expect, it } from "vitest";
import { mediaReaderRange } from "./range-reader";
import type { MediaLocator, MediaReader } from "./ports";

const locator: MediaLocator = { movieVersionId: 0, chatId: "-1001111111111", messageId: 30, fileUniqueId: "AgADsynthetic", fileSize: 3 * 1024 * 1024 + 500, mimeType: "video/mp4" };
const byte = (position: number) => (position * 31 + 7) % 251;

function fakeReader() {
  const calls: { offset: number; limit: number }[] = [];
  const reader: MediaReader = {
    readiness: () => ({ ready: true, state: "ready" }),
    async readPart(target, offset, limit) {
      expect(target).toBe(locator);
      // The MTProto rules the E1.1 planner guarantees.
      expect(offset % 1024).toBe(0); expect(limit % 1024).toBe(0); expect(limit).toBeLessThanOrEqual(1024 * 1024);
      expect(Math.floor(offset / (1024 * 1024))).toBe(Math.floor((offset + limit - 1) / (1024 * 1024)));
      calls.push({ offset, limit });
      const end = Math.min(offset + limit, locator.fileSize);
      return { bytes: Uint8Array.from({ length: end - offset }, (_, i) => byte(offset + i)), rpcCount: 1 };
    },
  };
  return { reader, calls };
}

describe("MediaReader range adapter for bounded verification", () => {
  it("reads an unaligned range across windows with the minimal aligned reads", async () => {
    const { reader, calls } = fakeReader();
    const bytes = await mediaReaderRange(reader, locator, new AbortController().signal)(1024 * 1024 - 10, 30);
    expect(Array.from(bytes)).toEqual(Array.from({ length: 30 }, (_, i) => byte(1024 * 1024 - 10 + i)));
    expect(calls).toHaveLength(2);
  });
  it("reads the tail clamped to the document", async () => {
    const { reader } = fakeReader();
    const bytes = await mediaReaderRange(reader, locator, new AbortController().signal)(locator.fileSize - 16, 16);
    expect(bytes.length).toBe(16);
  });
  it("refuses ranges over its budget and past the end", async () => {
    const { reader, calls } = fakeReader();
    const read = mediaReaderRange(reader, locator, new AbortController().signal, 4096);
    await expect(read(0, 8192)).rejects.toThrow("verification_range_too_large");
    await expect(read(locator.fileSize, 1)).rejects.toThrow("verification_range_not_satisfiable");
    expect(calls).toHaveLength(0);
  });
});
