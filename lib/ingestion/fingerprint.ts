import { createHash } from "node:crypto";
import type { SourceFingerprint, SourceFile, SourceIdentity } from "@/types/ingestion";

/**
 * Source fingerprints (staged, see docs/PHASE_C_INGESTION_DESIGN.md):
 *
 * 1. `discoveryKey`: path + size + mtime. Local-journal cache key only; tells a
 *    rescan which files it has already sampled. Never leaves the machine.
 * 2. `sf1` fingerprint: size + SHA-256 of three 4 MiB samples (start, middle,
 *    end). About 12 MiB read per file, whatever its size. Independent of path,
 *    name and mtime, so a rename or move keeps the fingerprint. This is the
 *    idempotency key the uploader writes into the Telegram caption.
 * 3. `fullContentHash`: SHA-256 of every byte. Optional, for a suspected
 *    sampled collision or a replacement decision; never needed per scan.
 *
 * Reading is injected (`ReadRange`), so this module does no file-system I/O.
 */

export const SAMPLE_BYTES = 4 * 1024 * 1024;
const VERSION = "sf1";

/** Reads `length` bytes at `offset`. The C2 adapter wraps a file handle. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** Sample offsets: the whole file when it is small, else start, middle and end. */
export function sampleRanges(sizeBytes: number): { offset: number; length: number }[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("Invalid file size.");
  if (sizeBytes <= SAMPLE_BYTES * 3) return [{ offset: 0, length: sizeBytes }];
  return [
    { offset: 0, length: SAMPLE_BYTES },
    { offset: Math.floor((sizeBytes - SAMPLE_BYTES) / 2), length: SAMPLE_BYTES },
    { offset: sizeBytes - SAMPLE_BYTES, length: SAMPLE_BYTES },
  ];
}

export async function computeFingerprint(sizeBytes: number, read: ReadRange): Promise<SourceFingerprint> {
  const hash = createHash("sha256").update(`${VERSION}\0${sizeBytes}\0`);
  for (const { offset, length } of sampleRanges(sizeBytes)) {
    const bytes = await read(offset, length);
    if (bytes.byteLength !== length) throw new Error("Short read while fingerprinting.");
    hash.update(createHash("sha256").update(bytes).digest());
  }
  return `${VERSION}-${hash.digest("hex")}`;
}

export function isFingerprint(value: string): value is SourceFingerprint {
  return /^sf1-[0-9a-f]{64}$/.test(value);
}

/** Local cache key. Contains the path, so it must stay in the local journal. */
export function discoveryKey(relativePath: string, sizeBytes: number, modifiedAtMs: number): string {
  const path = relativePath.split("\\").join("/").normalize("NFC");
  return createHash("sha256").update(`${path}\0${sizeBytes}\0${Math.trunc(modifiedAtMs)}`).digest("hex");
}

/** Optional strong verification: SHA-256 of the whole file, read in chunks. */
export async function fullContentHash(sizeBytes: number, read: ReadRange, chunkBytes = 8 * 1024 * 1024): Promise<string> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < sizeBytes; offset += chunkBytes) {
    const length = Math.min(chunkBytes, sizeBytes - offset);
    const bytes = await read(offset, length);
    if (bytes.byteLength !== length) throw new Error("Short read while hashing.");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** The only source facts that may leave the uploader machine: no path, no mtime. */
export function sourceIdentity(source: SourceFile): SourceIdentity {
  return { fingerprint: source.fingerprint, sizeBytes: source.sizeBytes, fileName: source.fileName };
}
