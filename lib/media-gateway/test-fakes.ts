/**
 * Test doubles for the media gateway ports. Test-only: imported by *.test.ts
 * files, never by the gateway runtime.
 */
import { GatewayError } from "@/lib/media-gateway/errors";
import type { CatalogueMediaResolver, MediaLocator, MediaReader } from "@/lib/media-gateway/ports";

/** Deterministic content: the byte at position p. */
export const byteAt = (position: number) => (position * 31 + 7) & 0xff;
export const expectedBytes = (start: number, length: number) => Uint8Array.from({ length }, (_, i) => byteAt(start + i));

export const PUBLISHED_VERSION = 1;
export const FILE_SIZE = 1_004_462_878;

export const publishedLocator: MediaLocator = {
  mediaId: 1,
  chatId: "-1009999999999",
  messageId: 23,
  fileUniqueId: "AgADtestunique1",
  fileSize: FILE_SIZE,
  mimeType: "video/x-matroska",
};

export class FakeResolver implements CatalogueMediaResolver {
  calls = 0;
  failure: GatewayError | null = null;
  private readonly published: Map<number, MediaLocator>;
  constructor(published = new Map<number, MediaLocator>([[PUBLISHED_VERSION, publishedLocator]])) {
    this.published = published;
  }
  async resolveMovieVersion(movieVersionId: number) {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return this.published.get(movieVersionId) ?? null;
  }
}

export interface FakeReaderOptions {
  delayMs?: number;
  /** When false the read ignores its signal and completes (a client without cancellation). */
  honoursAbort?: boolean;
  ready?: boolean;
  failWith?: GatewayError | Error;
  /** Return this many bytes fewer than requested (a truncated reply). */
  shortBy?: number;
  /** Fail only this call (1-based) with `failWith`, immediately. */
  failOnCall?: number;
}

export class FakeReader implements MediaReader {
  calls = 0;
  completed = 0;
  cancelled = 0;
  inFlight = 0;
  maxInFlight = 0;
  bytesReturned = 0;
  readonly offsets: number[] = [];

  options: FakeReaderOptions;
  constructor(options: FakeReaderOptions = {}) {
    this.options = options;
  }

  readiness() {
    return this.options.ready === false ? { ready: false, state: "connecting" } : { ready: true, state: "ready" };
  }

  async readPart(locator: MediaLocator, offset: number, limit: number, signal: AbortSignal) {
    this.calls += 1;
    this.offsets.push(offset);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.options.failWith && (this.options.failOnCall === undefined || this.options.failOnCall === this.calls)) throw this.options.failWith;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs ?? 0);
        if (this.options.honoursAbort === false) return;
        const onAbort = () => {
          clearTimeout(timer);
          this.cancelled += 1;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const available = Math.max(0, Math.min(limit, locator.fileSize - offset) - (this.options.shortBy ?? 0));
      const bytes = expectedBytes(offset, available);
      this.completed += 1;
      this.bytesReturned += bytes.length;
      return { bytes, rpcCount: 1 };
    } finally {
      this.inFlight -= 1;
    }
  }
}
