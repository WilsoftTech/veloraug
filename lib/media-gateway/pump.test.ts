import { describe, expect, it } from "vitest";
import { planRangeReads } from "@/lib/telegram/mtproto-range";
import { GatewayError } from "@/lib/media-gateway/errors";
import { Semaphore } from "@/lib/media-gateway/limits";
import { pumpRange, type PumpSink } from "@/lib/media-gateway/pump";
import { FILE_SIZE, FakeReader, expectedBytes, publishedLocator } from "@/lib/media-gateway/test-fakes";

const MIB = 1024 * 1024;
const plan = (start: number, end: number) => {
  const result = planRangeReads(start, end, FILE_SIZE, 64 * MIB);
  if (!result.ok) throw new Error(result.code);
  return result;
};

/** A sink that accepts everything, or signals backpressure until drained by the test. */
class TestSink implements PumpSink {
  chunks: Uint8Array[] = [];
  pendingDrain: (() => void) | null = null;
  constructor(private readonly backpressure = false) {}
  write(chunk: Uint8Array) {
    this.chunks.push(chunk.slice());
    return !this.backpressure;
  }
  waitForDrain(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      this.pendingDrain = resolve;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  get bytes() {
    return Buffer.concat(this.chunks);
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pumpRange", () => {
  it("streams exactly the range, trimmed, in order", async () => {
    const reader = new FakeReader();
    const sink = new TestSink();
    const range = plan(123_456_789, 124_505_364);
    const result = await pumpRange({ plan: range, locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink, signal: new AbortController().signal });
    expect(result).toMatchObject({ outcome: "complete", bytesWritten: 1_048_576, readsIssued: 2, rpcCount: 2 });
    expect(Buffer.compare(sink.bytes, Buffer.from(expectedBytes(123_456_789, 1_048_576)))).toBe(0);
  });

  it("writes each reply as it arrives (no whole-range buffer)", async () => {
    const reader = new FakeReader();
    const sink = new TestSink();
    await pumpRange({ plan: plan(0, 5 * MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink, signal: new AbortController().signal });
    expect(sink.chunks).toHaveLength(5);
    expect(Math.max(...sink.chunks.map((c) => c.length))).toBeLessThanOrEqual(MIB);
  });

  it("serves the file tail and EOF", async () => {
    const reader = new FakeReader();
    const sink = new TestSink();
    await pumpRange({ plan: plan(FILE_SIZE - 65_536, FILE_SIZE - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink, signal: new AbortController().signal });
    expect(Buffer.compare(sink.bytes, Buffer.from(expectedBytes(FILE_SIZE - 65_536, 65_536)))).toBe(0);
  });

  it("keeps at most readAhead reads in flight per stream", async () => {
    const reader = new FakeReader({ delayMs: 3 });
    await pumpRange({ plan: plan(0, 10 * MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(64), readAhead: 2, readTimeoutMs: 1000, sink: new TestSink(), signal: new AbortController().signal });
    expect(reader.maxInFlight).toBe(2);
    expect(reader.calls).toBe(10);
  });

  it("respects the global read semaphore across streams", async () => {
    const reader = new FakeReader({ delayMs: 3 });
    const semaphore = new Semaphore(3);
    const run = () => pumpRange({ plan: plan(0, 6 * MIB - 1), locator: publishedLocator, reader, semaphore, readAhead: 4, readTimeoutMs: 1000, sink: new TestSink(), signal: new AbortController().signal });
    await Promise.all([run(), run(), run()]);
    expect(reader.maxInFlight).toBe(3);
    expect(semaphore.inUse).toBe(0);
  });

  it("stops scheduling reads under backpressure until the sink drains", async () => {
    const reader = new FakeReader();
    const sink = new TestSink(true);
    const done = pumpRange({ plan: plan(0, 8 * MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink, signal: new AbortController().signal });
    await tick(20);
    // One chunk written, one more read ahead: nothing else while the sink is full.
    expect(sink.chunks).toHaveLength(1);
    expect(reader.calls).toBe(2);
    sink.pendingDrain?.();
    await tick(20);
    expect(sink.chunks).toHaveLength(2);
    expect(reader.calls).toBe(3);
    for (let i = 0; i < 10 && sink.chunks.length < 8; i++) {
      sink.pendingDrain?.();
      await tick(5);
    }
    await expect(done).resolves.toMatchObject({ outcome: "complete", readsIssued: 8 });
  });

  it("on disconnect schedules no further reads and cancels the in-flight ones", async () => {
    const reader = new FakeReader({ delayMs: 50 });
    const controller = new AbortController();
    const semaphore = new Semaphore(8);
    const done = pumpRange({ plan: plan(0, 8 * MIB - 1), locator: publishedLocator, reader, semaphore, readAhead: 2, readTimeoutMs: 5000, sink: new TestSink(), signal: controller.signal });
    await tick(10);
    expect(reader.calls).toBe(2);
    controller.abort("client_closed");
    const result = await done;
    await tick(80);
    expect(result).toMatchObject({ outcome: "aborted", bytesWritten: 0, readsIssued: 2 });
    expect(reader.calls).toBe(2);
    expect(reader.cancelled).toBe(2);
    expect(semaphore.inUse).toBe(0);
  });

  it("schedules nothing after a disconnect observed while writing", async () => {
    const reader = new FakeReader();
    const controller = new AbortController();
    const sink = new TestSink();
    const write = sink.write.bind(sink);
    sink.write = (chunk) => {
      const accepted = write(chunk);
      controller.abort("client_closed"); // the close arrives during the first write
      return accepted;
    };
    const result = await pumpRange({ plan: plan(0, 8 * MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink, signal: controller.signal });
    await tick(20);
    expect(result).toMatchObject({ outcome: "aborted", bytesWritten: MIB, readsIssued: 2 });
    expect(reader.calls).toBe(2);
  });

  it("cancels the other in-flight reads when the head read fails", async () => {
    const reader = new FakeReader({ delayMs: 200, failWith: new GatewayError("flood_wait", { retryAfterSeconds: 3 }), failOnCall: 1 });
    const semaphore = new Semaphore(8);
    const started = Date.now();
    await expect(
      pumpRange({ plan: plan(0, 8 * MIB - 1), locator: publishedLocator, reader, semaphore, readAhead: 2, readTimeoutMs: 5000, sink: new TestSink(), signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "flood_wait" });
    expect(Date.now() - started).toBeLessThan(150);
    expect(reader.calls).toBe(2);
    expect(reader.cancelled).toBe(1);
    expect(semaphore.inUse).toBe(0);
  });

  it("with a reader that cannot cancel, lets only already-issued reads finish", async () => {
    const reader = new FakeReader({ delayMs: 30, honoursAbort: false });
    const controller = new AbortController();
    const sink = new TestSink();
    const done = pumpRange({ plan: plan(0, 8 * MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 5000, sink, signal: controller.signal });
    await tick(5);
    controller.abort("client_closed");
    const result = await done;
    await tick(60);
    expect(result.outcome).toBe("aborted");
    expect(reader.calls).toBe(2);
    expect(reader.completed).toBe(2); // bounded: ≤ readAhead × 1 MiB finished in the background
    expect(sink.chunks).toHaveLength(0);
  });

  it("stops after a disconnect during a drain wait", async () => {
    const reader = new FakeReader();
    const controller = new AbortController();
    const done = pumpRange({ plan: plan(0, 8 * MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 5000, sink: new TestSink(true), signal: controller.signal });
    await tick(10);
    controller.abort("client_closed");
    const result = await done;
    expect(result).toMatchObject({ outcome: "aborted", bytesWritten: MIB });
    expect(reader.calls).toBe(2);
  });

  it("turns a slow read into upstream_timeout and cancels it", async () => {
    const reader = new FakeReader({ delayMs: 1000 });
    const run = pumpRange({ plan: plan(0, MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 20, sink: new TestSink(), signal: new AbortController().signal });
    await expect(run).rejects.toMatchObject({ code: "upstream_timeout" });
    expect(reader.cancelled).toBe(1);
  });

  it("propagates a classified reader error", async () => {
    const reader = new FakeReader({ failWith: new GatewayError("flood_wait", { retryAfterSeconds: 7 }) });
    await expect(
      pumpRange({ plan: plan(0, MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink: new TestSink(), signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "flood_wait", retryAfterSeconds: 7 });
  });

  it("refuses a truncated reply instead of sending short output", async () => {
    const reader = new FakeReader({ shortBy: 1024 });
    const sink = new TestSink();
    await expect(
      pumpRange({ plan: plan(0, MIB - 1), locator: publishedLocator, reader, semaphore: new Semaphore(8), readAhead: 2, readTimeoutMs: 1000, sink, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "document_resolution_failed" });
    expect(sink.chunks).toHaveLength(0);
  });
});
