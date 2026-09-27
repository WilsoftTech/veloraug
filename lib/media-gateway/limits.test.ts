import { describe, expect, it } from "vitest";
import { GatewayError } from "@/lib/media-gateway/errors";
import { DEFAULT_LIMITS, Semaphore, StreamAdmission, WindowRateLimiter, limitsFromEnv } from "@/lib/media-gateway/limits";

describe("limitsFromEnv", () => {
  it("uses conservative defaults", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.readAheadPerStream * 1024 * 1024).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxResponseBytes).toBeLessThan(1_004_462_878);
  });

  it("accepts in-bounds overrides", () => {
    expect(limitsFromEnv({ MEDIA_GATEWAY_MAX_READS_IN_FLIGHT: "4" }).maxReadsInFlight).toBe(4);
  });

  it.each([
    ["MEDIA_GATEWAY_MAX_READS_IN_FLIGHT", "0"],
    ["MEDIA_GATEWAY_MAX_READS_IN_FLIGHT", "65"],
    ["MEDIA_GATEWAY_READ_AHEAD_PER_STREAM", "5"],
    ["MEDIA_GATEWAY_MAX_RESPONSE_BYTES", String(1024 ** 3)],
    ["MEDIA_GATEWAY_MAX_TOKEN_LIFETIME_SECONDS", "86400"],
    ["MEDIA_GATEWAY_MAX_ACTIVE_STREAMS", "abc"],
    ["MEDIA_GATEWAY_MAX_ACTIVE_STREAMS", "-1"],
    ["MEDIA_GATEWAY_MAX_ACTIVE_STREAMS", "1.5"],
  ])("fails closed on %s=%s", (name, value) => {
    expect(() => limitsFromEnv({ [name]: value })).toThrow();
  });
});

describe("Semaphore", () => {
  it("never lets more than capacity through, and hands slots to waiters in order", async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();
    const order: number[] = [];
    const third = semaphore.acquire().then(() => order.push(3));
    const fourth = semaphore.acquire().then(() => order.push(4));
    await Promise.resolve();
    expect(semaphore.inUse).toBe(2);
    expect(order).toEqual([]);
    semaphore.release();
    await third;
    expect(order).toEqual([3]);
    semaphore.release();
    await fourth;
    expect(order).toEqual([3, 4]);
  });

  it("drops an aborted waiter without consuming a slot", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort(new Error("gone"));
    await expect(waiting).rejects.toThrow("gone");
    semaphore.release();
    expect(semaphore.inUse).toBe(0);
  });

  it("detects over-release", () => {
    expect(() => new Semaphore(1).release()).toThrow();
  });
});

describe("StreamAdmission", () => {
  const limits = { maxActiveStreams: 3, maxStreamsPerSubject: 2, maxStreamsPerIp: 2 };

  it("enforces per-subject, per-IP and global stream limits", () => {
    const admission = new StreamAdmission(limits);
    const a = admission.admit("s1", "ip1");
    admission.admit("s1", "ip2");
    expect(() => admission.admit("s1", "ip3")).toThrow(GatewayError);
    admission.admit("s2", "ip1");
    expect(() => admission.admit("s3", "ip1")).toThrow(GatewayError); // ip1 and global both full
    a();
    a(); // idempotent
    expect(admission.activeStreams).toBe(2);
    admission.admit("s3", "ip3");
    expect(() => admission.admit("s4", "ip4")).toThrow(GatewayError);
  });
});

describe("WindowRateLimiter", () => {
  it("limits hits per key per window and resets after it", () => {
    const limiter = new WindowRateLimiter(2, 1000);
    expect([limiter.hit("k", 0), limiter.hit("k", 10), limiter.hit("k", 20)]).toEqual([true, true, false]);
    expect(limiter.hit("other", 20)).toBe(true);
    expect(limiter.hit("k", 1000)).toBe(true);
  });

  it("keeps a bounded number of keys", () => {
    const limiter = new WindowRateLimiter(1, 1000, 3);
    for (let i = 0; i < 50; i++) limiter.hit(`k${i}`, i);
    expect(limiter.trackedKeys).toBe(3);
  });
});
