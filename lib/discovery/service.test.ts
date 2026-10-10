import { describe, expect, it, vi } from "vitest";
import { classifyFailure, errorCode, runDiscoveryService, serviceHealth } from "./service";
import type { DiscoveryPersistence } from "./worker";
import type { InspectionPorts } from "./pipeline";

const now = () => new Date("2026-10-10T12:00:00Z");
function target(): DiscoveryPersistence & { release: ReturnType<typeof vi.fn<() => Promise<void>>> } {
  return { checkpoint: async () => 10, receive: async () => ({ detected: 0, duplicates: 0, ignored: 0 }),
    reconciliation: async () => ({ cursor: null, checkedAt: null, incomplete: true }), receiveHistory: async () => {},
    inspectNext: async () => false, summary: async () => ({ candidates: 0, awaitingReview: 0, metadataFailures: 0, mediaBlocked: 0, rightsBlocked: 0, approved: 0, published: 0, reconciliationIncomplete: 1, reconciliationLagSeconds: -1 }), release: vi.fn(async () => {}) };
}
describe("persistent discovery recovery", () => {
  it("backs off database faults with a ceiling then releases on shutdown, logging no exception text", async () => {
    const abort = new AbortController(); const delays: number[] = []; const entries: unknown[] = [];
    const db = target(); db.checkpoint = async () => { throw new Error("postgres://secret:private@host/database"); };
    const state = await runDiscoveryService(db, { batch: async () => [], acknowledge: async () => {} }, {} as InspectionPorts,
      { signal: abort.signal, now, log: (entry) => entries.push(entry), minBackoffMs: 10, maxBackoffMs: 20,
        sleep: async (ms) => { delays.push(ms); if (delays.length === 4) abort.abort(); } });
    expect(delays).toEqual([10, 20, 20, 20]); expect(state.state).toBe("stopped"); expect(db.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(entries)).not.toContain("private"); expect(state.lastErrorCode).toBe("unexpected_error");
  });
  it("lease conflicts and uninitialized cursors never poll", async () => {
    for (const code of ["discovery_consumer_busy", "discovery_not_initialized"]) {
      const abort = new AbortController(); const db = target(); const batch = vi.fn();
      db.checkpoint = async () => { throw new Error(code); };
      const state = await runDiscoveryService(db, { batch, acknowledge: async () => {} }, {} as InspectionPorts,
        { signal: abort.signal, now, log: () => {}, sleep: async () => { abort.abort(); } });
      expect(batch).not.toHaveBeenCalled(); expect(state.consecutiveFailures).toBe(0);
    }
  });
  it("stops on competing Telegram ownership and releases the lease", async () => {
    const db = target(); const sleep = vi.fn();
    const state = await runDiscoveryService(db, { batch: async () => { throw new Error("telegram_update_consumer_conflict"); }, acknowledge: async () => {} }, {} as InspectionPorts,
      { signal: new AbortController().signal, now, log: () => {}, sleep });
    expect(state.state).toBe("fatal"); expect(sleep).not.toHaveBeenCalled(); expect(db.release).toHaveBeenCalledOnce();
    expect(serviceHealth(state, now())).toMatchObject({ alive: false, ready: false });
  });
  it("classifies rate limits and refuses secret-bearing errors", () => {
    expect(classifyFailure({ code: "telegram_rate_limited", retryAfterSeconds: 9999 })).toMatchObject({ action: "retry", retryAfterMs: 3600000 });
    expect(errorCode(new Error("https://host/token?secret=value"))).toBe("unexpected_error");
  });
});
