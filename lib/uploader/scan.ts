import "server-only";
import { open, opendir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { computeFingerprint, discoveryKey, fullContentHash, type ReadRange } from "@/lib/ingestion/fingerprint";
import { SUPPORTED_EXTENSIONS } from "@/lib/ingestion/parser";
import type { CatalogueKind } from "@/types/catalogue";
import type { SourceFile, SourceFingerprint } from "@/types/ingestion";

/**
 * File-system side of `scan` and `inspect`. Fingerprinting reads three 4 MiB
 * samples through a file handle (fingerprint.ts), so a 2 GB file costs about
 * 12 MiB of reads and never sits in memory whole. A file whose relative path,
 * size and mtime are unchanged reuses its journal fingerprint (discoveryKey).
 */

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  modifiedAtMs: number;
  discoveryKey: string;
}

/** Walks `root` for media files, skipping symlinks and anything not a regular file. */
export async function* walkMedia(root: string): AsyncGenerator<DiscoveredFile> {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for await (const dirent of await opendir(dir)) {
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!dirent.isFile()) continue;
      const extension = extname(dirent.name).slice(1).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(extension)) continue;
      const facts = await stat(path);
      const relativePath = relative(root, path).split("\\").join("/");
      yield {
        absolutePath: path,
        relativePath,
        fileName: basename(path),
        extension,
        sizeBytes: facts.size,
        modifiedAtMs: facts.mtimeMs,
        discoveryKey: discoveryKey(relativePath, facts.size, facts.mtimeMs),
      };
    }
  }
}

/** Runs `task` with a bounded-read ReadRange over the file. */
export async function withReadRange<T>(path: string, task: (read: ReadRange) => Promise<T>): Promise<T> {
  const handle = await open(path, "r");
  try {
    return await task(async (offset, length) => {
      const buffer = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    });
  } finally {
    await handle.close();
  }
}

export function fingerprintFile(path: string, sizeBytes: number): Promise<SourceFingerprint> {
  return withReadRange(path, (read) => computeFingerprint(sizeBytes, read));
}

export function hashFile(path: string, sizeBytes: number): Promise<string> {
  return withReadRange(path, (read) => fullContentHash(sizeBytes, read));
}

export function toSourceFile(file: DiscoveredFile, fingerprint: SourceFingerprint, declaredKind: CatalogueKind, now: Date): SourceFile {
  return {
    absolutePath: file.absolutePath,
    relativePath: file.relativePath,
    fileName: file.fileName,
    extension: file.extension,
    sizeBytes: file.sizeBytes,
    modifiedAtMs: file.modifiedAtMs,
    declaredKind,
    fingerprint,
    discoveredAt: now.toISOString(),
  };
}
