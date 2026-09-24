import { describe, expect, it } from "vitest";
import { computeFingerprint, discoveryKey, fullContentHash, isFingerprint, SAMPLE_BYTES, sampleRanges, sourceIdentity } from "@/lib/ingestion/fingerprint";
import { fingerprintFromCaption, sourceCaptionToken, telegramMediaMessageSchema, toTelegramMediaRecord } from "@/lib/ingestion/telegram";
import { resolveVj } from "@/lib/ingestion/vj";
import type { KnownVj, SourceFile } from "@/types/ingestion";

const VJS: KnownVj[] = [
  { id: 1, slug: "vj-junior", name: "VJ Junior", isActive: true },
  { id: 2, slug: "vj-emmy", name: "VJ Emmy", isActive: true, aliases: ["Emmy K"] },
  { id: 3, slug: "vj-retired", name: "VJ Retired", isActive: false },
  { id: 4, slug: "vj-ice-p", name: "VJ Ice P", isActive: true },
];

describe("resolveVj: parsed text is not identity", () => {
  it("resolves spelling variants to one existing VJ", () => {
    for (const text of ["Junior", "junior", "JUNIOR", "VJ Junior", "vj-junior"]) {
      expect(resolveVj(text, VJS)).toEqual({ status: "resolved", vjId: 1, slug: "vj-junior" });
    }
    expect(resolveVj("IceP", VJS)).toEqual({ status: "resolved", vjId: 4, slug: "vj-ice-p" });
  });

  it("resolves known aliases", () => {
    expect(resolveVj("Emmy K", VJS)).toEqual({ status: "resolved", vjId: 2, slug: "vj-emmy" });
  });

  it("reports a missing VJ", () => {
    expect(resolveVj(null, VJS)).toEqual({ status: "missing" });
    expect(resolveVj("  ", VJS)).toEqual({ status: "missing" });
  });

  it("never resolves to an inactive VJ", () => {
    expect(resolveVj("Retired", VJS)).toEqual({ status: "inactive", vjId: 3, slug: "vj-retired" });
  });

  it("returns ambiguous when two VJs share a key", () => {
    const clash = [...VJS, { id: 5, slug: "junior", name: "Junior", isActive: true }];
    expect(resolveVj("Junior", clash)).toEqual({ status: "ambiguous", candidateIds: [1, 5] });
  });

  it("does not guess: near spellings are reviewer suggestions only", () => {
    expect(resolveVj("Ice", VJS)).toEqual({ status: "unresolved", suggestionIds: [4] });
    expect(resolveVj("Juniorr", VJS)).toEqual({ status: "unresolved", suggestionIds: [1] });
    expect(resolveVj("Kevo", VJS)).toEqual({ status: "unresolved", suggestionIds: [] });
  });

  it("does not mutate or extend the VJ list", () => {
    const before = structuredClone(VJS);
    resolveVj("Brand New VJ", VJS);
    expect(VJS).toEqual(before);
  });
});

/** In-memory ReadRange over a deterministic buffer. */
function memoryFile(size: number, seed = 1) {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) bytes[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  const reads: [number, number][] = [];
  return {
    bytes,
    reads,
    read: async (offset: number, length: number) => {
      reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    },
  };
}

describe("source fingerprint", () => {
  it("reads three samples of a large file, the whole of a small one", () => {
    expect(sampleRanges(100)).toEqual([{ offset: 0, length: 100 }]);
    const size = 2 * 1024 * 1024 * 1024 - 1;
    expect(sampleRanges(size)).toEqual([
      { offset: 0, length: SAMPLE_BYTES },
      { offset: Math.floor((size - SAMPLE_BYTES) / 2), length: SAMPLE_BYTES },
      { offset: size - SAMPLE_BYTES, length: SAMPLE_BYTES },
    ]);
    expect(() => sampleRanges(-1)).toThrow();
  });

  it("is deterministic and well-formed", async () => {
    const file = memoryFile(SAMPLE_BYTES * 4);
    const a = await computeFingerprint(file.bytes.length, file.read);
    const b = await computeFingerprint(file.bytes.length, file.read);
    expect(a).toBe(b);
    expect(isFingerprint(a)).toBe(true);
    expect(file.reads.reduce((total, [, length]) => total + length, 0)).toBe(2 * 3 * SAMPLE_BYTES);
  });

  it("changes when sampled content or size changes", async () => {
    const file = memoryFile(SAMPLE_BYTES * 4);
    const base = await computeFingerprint(file.bytes.length, file.read);
    const edited = memoryFile(SAMPLE_BYTES * 4);
    edited.bytes[edited.bytes.length - 1] ^= 0xff;
    expect(await computeFingerprint(edited.bytes.length, edited.read)).not.toBe(base);
    const truncated = memoryFile(SAMPLE_BYTES * 4 - 1);
    expect(await computeFingerprint(truncated.bytes.length, truncated.read)).not.toBe(base);
    expect(await computeFingerprint(file.bytes.length, memoryFile(SAMPLE_BYTES * 4, 2).read)).not.toBe(base);
  });

  it("does not depend on the path, name or mtime", async () => {
    const file = memoryFile(1000);
    const fingerprint = await computeFingerprint(1000, file.read);
    expect(fingerprint).not.toMatch(/movies|john|wick/i);
    expect(discoveryKey("Movies/John Wick.mp4", 1000, 1)).not.toBe(discoveryKey("Movies/John Wick (2014).mp4", 1000, 1));
    expect(discoveryKey("Movies/John Wick.mp4", 1000, 1)).not.toBe(discoveryKey("Movies/John Wick.mp4", 1000, 2));
    expect(discoveryKey("Movies\\John Wick.mp4", 1000, 1)).toBe(discoveryKey("Movies/John Wick.mp4", 1000, 1));
  });

  it("rejects a short read instead of fingerprinting partial data", async () => {
    await expect(computeFingerprint(100, async () => new Uint8Array(10))).rejects.toThrow("Short read");
  });

  it("offers an optional full-content hash for strong verification", async () => {
    const file = memoryFile(SAMPLE_BYTES * 4);
    const full = await fullContentHash(file.bytes.length, file.read, SAMPLE_BYTES);
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    const middle = memoryFile(SAMPLE_BYTES * 4);
    middle.bytes[SAMPLE_BYTES + 10] ^= 0xff; // outside every sample
    expect(await computeFingerprint(middle.bytes.length, middle.read)).toBe(await computeFingerprint(file.bytes.length, file.read));
    expect(await fullContentHash(middle.bytes.length, middle.read)).not.toBe(full);
  });

  it("exposes no path or mtime in the shareable identity", () => {
    const source: SourceFile = {
      absolutePath: String.raw`C:\Users\op\Library\John Wick.mp4`,
      relativePath: "Library/John Wick.mp4",
      fileName: "John Wick.mp4",
      extension: "mp4",
      sizeBytes: 10,
      modifiedAtMs: 5,
      declaredKind: "movie",
      fingerprint: `sf1-${"a".repeat(64)}`,
      discoveredAt: "2026-09-25T00:00:00.000Z",
    };
    const identity = sourceIdentity(source);
    expect(identity).toEqual({ fingerprint: source.fingerprint, sizeBytes: 10, fileName: "John Wick.mp4" });
    expect(JSON.stringify(identity)).not.toMatch(/Users|Library|op\\/);
  });
});

describe("Telegram identity contract", () => {
  const fingerprint = `sf1-${"b".repeat(64)}` as const;
  const message = {
    message_id: 42,
    date: 1_790_000_000,
    chat: { id: -1001234567890, type: "channel" },
    caption: `John Wick VJ Junior\n${sourceCaptionToken(fingerprint)}`,
    video: { file_id: "BAAC-file", file_unique_id: "AgAD-unique", duration: 6000, width: 1280, height: 720, file_name: "John Wick VJ Junior.mp4", mime_type: "video/mp4", file_size: 1_500_000_000 },
    from: { id: 1, is_bot: false },
  };

  it("round-trips the caption token and ignores missing or conflicting tokens", () => {
    expect(fingerprintFromCaption(sourceCaptionToken(fingerprint))).toBe(fingerprint);
    expect(fingerprintFromCaption("no token")).toBeNull();
    expect(fingerprintFromCaption(null)).toBeNull();
    expect(fingerprintFromCaption(`velora-src:sf1-${"c".repeat(63)}`)).toBeNull();
    expect(fingerprintFromCaption(`${sourceCaptionToken(fingerprint)} ${sourceCaptionToken(`sf1-${"c".repeat(64)}`)}`)).toBeNull();
    expect(sourceCaptionToken(fingerprint)).not.toMatch(/[\\/]/);
  });

  it("maps a validated channel video to the telegram_media row shape", () => {
    const parsed = telegramMediaMessageSchema.parse(message);
    expect(toTelegramMediaRecord("movie", parsed)).toEqual({
      botType: "movie",
      chatId: -1001234567890,
      messageId: 42,
      fileId: "BAAC-file",
      fileUniqueId: "AgAD-unique",
      mediaKind: "video",
      fileName: "John Wick VJ Junior.mp4",
      mimeType: "video/mp4",
      caption: message.caption,
      fileSizeBytes: 1_500_000_000,
      durationSeconds: 6000,
      width: 1280,
      height: 720,
      telegramDate: new Date(1_790_000_000 * 1000).toISOString(),
      sourceFingerprint: fingerprint,
    });
    expect(parsed).not.toHaveProperty("from");
  });

  it("maps documents and ignores messages without media", () => {
    const { video, ...rest } = message;
    const document = telegramMediaMessageSchema.parse({ ...rest, document: { file_id: video.file_id, file_unique_id: video.file_unique_id } });
    expect(toTelegramMediaRecord("series", document)).toMatchObject({ botType: "series", mediaKind: "document", durationSeconds: null, width: null });
    expect(toTelegramMediaRecord("movie", telegramMediaMessageSchema.parse(rest))).toBeNull();
  });

  it("rejects non-channel chats and malformed media", () => {
    expect(telegramMediaMessageSchema.safeParse({ ...message, chat: { id: 1, type: "private" } }).success).toBe(false);
    expect(telegramMediaMessageSchema.safeParse({ ...message, video: { ...message.video, file_id: "" } }).success).toBe(false);
    expect(telegramMediaMessageSchema.safeParse({ ...message, message_id: 0 }).success).toBe(false);
  });
});
