/**
 * Streams one planned range from the media reader to a downstream sink (E1.2).
 *
 * Memory and upstream work stay bounded:
 * - reads are issued in plan order, at most `readAhead` ahead of the write
 *   position, and each also holds a slot of the gateway-wide semaphore;
 * - each reply (≤ 1 MiB) is trimmed to the bytes the range needs and written
 *   at once, so no response is ever assembled in memory;
 * - when the sink reports backpressure, nothing new is scheduled until it drains;
 * - when `signal` aborts (the client went away, or a timeout), nothing new is
 *   scheduled, in-flight reads are cancelled through their own signals, and the
 *   pump waits for them to settle so their semaphore slots are returned.
 */
import type { RangePlan } from "@/lib/telegram/mtproto-range";
import { GatewayError } from "@/lib/media-gateway/errors";
import type { Semaphore } from "@/lib/media-gateway/limits";
import type { MediaLocator, MediaReader } from "@/lib/media-gateway/ports";

export interface PumpSink {
  /** Writes a chunk; returns false when the downstream buffer is full (Node `write` semantics). */
  write(chunk: Uint8Array): boolean;
  /** Resolves when the sink can accept more; rejects when `signal` aborts first. */
  waitForDrain(signal: AbortSignal): Promise<void>;
}

export interface PumpOptions {
  plan: Extract<RangePlan, { ok: true }>;
  locator: MediaLocator;
  reader: MediaReader;
  semaphore: Semaphore;
  readAhead: number;
  readTimeoutMs: number;
  sink: PumpSink;
  /** Aborted when the response must stop: client disconnect, request or idle timeout. */
  signal: AbortSignal;
  /** Called once, just before the first byte is written (the caller sends headers here). */
  beforeFirstWrite?: () => void;
  /** Called after every successful write (the caller's idle timer uses it). */
  onProgress?: (bytesWritten: number) => void;
}

export interface PumpResult {
  outcome: "complete" | "aborted";
  bytesWritten: number;
  /** Reads started (each ≤ 1 MiB); never more than were needed when the pump stopped. */
  readsIssued: number;
  rpcCount: number;
}

interface InFlight {
  index: number;
  controller: AbortController;
  settled: Promise<unknown>;
  result: Promise<{ bytes: Uint8Array; rpcCount: number }>;
}

export async function pumpRange(options: PumpOptions): Promise<PumpResult> {
  const { plan, reader, semaphore, sink, signal } = options;
  if (!Number.isSafeInteger(options.readAhead) || options.readAhead < 1) throw new Error("readAhead");
  const inFlight: InFlight[] = [];
  let next = 0;
  let bytesWritten = 0;
  let rpcCount = 0;
  let started = false;

  const issue = () => {
    const index = next++;
    const read = plan.reads[index];
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    // An abort listener added to an already-aborted signal never fires, so check first.
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new GatewayError("upstream_timeout")), options.readTimeoutMs);
    const result = (async () => {
      await semaphore.acquire(controller.signal);
      try {
        const reply = await reader.readPart(options.locator, read.offset, read.limit, controller.signal);
        rpcCount += reply.rpcCount;
        return reply;
      } finally {
        semaphore.release();
      }
    })().finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
    // Observed here so an abandoned read never becomes an unhandled rejection;
    // its outcome is still awaited (and its error surfaced) in plan order below.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    inFlight.push({ index, controller, settled, result });
  };

  const stop = async () => {
    for (const read of inFlight) read.controller.abort(signal.reason ?? new GatewayError("internal_error"));
    await Promise.all(inFlight.map((read) => read.settled));
    inFlight.length = 0;
  };

  try {
    for (let index = 0; index < plan.reads.length; index++) {
      if (signal.aborted) break;
      while (inFlight.length < options.readAhead && next < plan.reads.length) issue();

      const head = inFlight[0];
      let reply: { bytes: Uint8Array; rpcCount: number };
      try {
        reply = await head.result;
      } catch (error) {
        if (signal.aborted) break;
        throw error instanceof GatewayError ? error : head.controller.signal.reason instanceof GatewayError ? head.controller.signal.reason : error;
      }
      inFlight.shift();
      if (signal.aborted) break;

      const read = plan.reads[head.index];
      if (reply.bytes.length < read.keepFrom + read.keepLength) throw new GatewayError("document_resolution_failed");
      const chunk = reply.bytes.subarray(read.keepFrom, read.keepFrom + read.keepLength);
      if (!started) {
        started = true;
        options.beforeFirstWrite?.();
      }
      const accepted = sink.write(chunk);
      bytesWritten += chunk.length;
      options.onProgress?.(bytesWritten);
      if (!accepted && index + 1 < plan.reads.length) {
        try {
          await sink.waitForDrain(signal);
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
      }
    }
  } finally {
    await stop();
  }
  const outcome = bytesWritten === plan.length ? "complete" : "aborted";
  return { outcome, bytesWritten, readsIssued: next, rpcCount };
}
