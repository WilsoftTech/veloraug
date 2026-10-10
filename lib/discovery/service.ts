import { runReplay, type DiscoveryPersistence, type EventProvider } from "@/lib/discovery/worker";
import type { InspectionPorts } from "@/lib/discovery/pipeline";

/**
 * The persistent discovery worker loop (E3.8B). It repeats the existing replay
 * cycle (receive a batch durably, then inspect) for as long as the process
 * lives, and turns every failure into one of three outcomes:
 *
 * - retry: transient (database or Bot API unreachable, rate limited, a failed
 *   inspection). Exponential backoff with a ceiling; nothing is acknowledged
 *   that was not committed, so the same updates are delivered again.
 * - wait:  another worker holds the consumer lease, or the owner has not
 *   initialized the cursor. No polling happens; it checks again at a fixed pace.
 * - stop:  a condition an operator must look at (a competing Telegram consumer,
 *   a refused identity or channel, a delivery whose payload changed). The loop
 *   ends in `fatal`; the supervisor's restart will end the same way until fixed.
 *
 * Pure: time, sleeping, logging, persistence, updates and inspection ports are
 * injected. Nothing here names Telegram, Supabase or a credential, and every
 * log field is a fixed code or a count. Memory is constant: no batch, update
 * or candidate outlives its cycle.
 */

export type ServiceStateName = "starting" | "running" | "waiting" | "backing_off" | "stopped" | "fatal";

export interface ServiceState {
  state: ServiceStateName;
  startedAt: string;
  /** The last completed cycle (with or without work). */
  lastCycleAt: string | null;
  /** The last cycle that received an update or inspected a candidate. */
  lastProgressAt: string | null;
  cycles: number;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  /** Counts of the last completed cycle (the persistence summary). */
  lastMetrics: Record<string, number | string> | null;
}

export type ServiceLog = (entry: Record<string, string | number | boolean | null>) => void;

export interface ServiceOptions {
  signal: AbortSignal;
  now: () => Date;
  /** Resolves after `ms`, or immediately once `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: ServiceLog;
  /** Called after every state change, for the health endpoint. */
  onState?: (state: Readonly<ServiceState>) => void;
  concurrency?: number;
  /** Pause after a cycle without work (the long poll already waited; this bounds a non-blocking provider). */
  idleMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Pace while another worker holds the lease or the cursor is not initialized. */
  waitMs?: number;
  /** A cycle log line is written at most this often while nothing happens. */
  heartbeatMs?: number;
}

const CODE = /^[a-z][a-z0-9_]{2,80}$/;
/** Only a fixed code ever leaves an error: messages can carry URLs, tokens or row data. */
export function errorCode(error: unknown): string {
  const candidate = (error as { code?: unknown } | null)?.code ?? (error as { message?: unknown } | null)?.message;
  return typeof candidate === "string" && CODE.test(candidate) ? candidate : "unexpected_error";
}

const WAIT = new Set(["discovery_consumer_busy", "discovery_not_initialized"]);
const STOP = new Set([
  "telegram_update_consumer_conflict", "discovery_cursor_offset_required", "discovery_channel_not_allowed",
  "discovery_update_payload_conflict", "discovery_invalid_input", "review_not_authorized", "worker_bounds_invalid",
  "invalid_movies_channel", "bot_not_on_local_server", "bot_identity_mismatch", "telegram_unauthorized", "telegram_forbidden",
]);

export function classifyFailure(error: unknown): { code: string; action: "retry" | "wait" | "stop"; retryAfterMs: number | null } {
  const code = errorCode(error);
  const fatal = (error as { fatal?: unknown } | null)?.fatal === true;
  const retryAfter = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return {
    code,
    action: fatal || STOP.has(code) ? "stop" : WAIT.has(code) ? "wait" : "retry",
    retryAfterMs: typeof retryAfter === "number" && retryAfter > 0 ? Math.min(retryAfter, 3600) * 1000 : null,
  };
}

export async function runDiscoveryService(persistence: DiscoveryPersistence & { release?: () => Promise<void> }, provider: EventProvider, ports: InspectionPorts, options: ServiceOptions): Promise<ServiceState> {
  const idleMs = options.idleMs ?? 1000;
  const minBackoff = options.minBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const waitMs = options.waitMs ?? 15_000;
  const heartbeatMs = options.heartbeatMs ?? 60_000;
  if (![idleMs, minBackoff, maxBackoff, waitMs, heartbeatMs].every((value) => Number.isFinite(value) && value >= 0) || minBackoff > maxBackoff || maxBackoff > 3_600_000) {
    throw new Error("service_bounds_invalid");
  }
  const state: ServiceState = { state: "starting", startedAt: options.now().toISOString(), lastCycleAt: null, lastProgressAt: null, cycles: 0, consecutiveFailures: 0, lastErrorCode: null, lastMetrics: null };
  const publish = (next: ServiceStateName) => {
    state.state = next;
    options.onState?.({ ...state });
  };
  let lastLogAt = 0;
  options.log({ event: "discovery_service_started" });

  while (!options.signal.aborted) {
    try {
      const metrics = await runReplay(persistence, provider, ports, { signal: options.signal, now: options.now, concurrency: options.concurrency, paceMs: 0 });
      const at = options.now();
      const progressed = metrics.updates > 0 || metrics.processed > 0;
      state.cycles++;
      state.consecutiveFailures = 0;
      state.lastErrorCode = null;
      state.lastCycleAt = at.toISOString();
      if (progressed) state.lastProgressAt = state.lastCycleAt;
      state.lastMetrics = metrics;
      publish("running");
      // Bounded log volume: every cycle that did something, otherwise a heartbeat.
      if (progressed || at.getTime() - lastLogAt >= heartbeatMs) {
        lastLogAt = at.getTime();
        options.log({ ...metrics, event: "discovery_cycle" });
      }
      if (!progressed) await options.sleep(idleMs, options.signal);
    } catch (error) {
      if (options.signal.aborted) break;
      const failure = classifyFailure(error);
      state.lastErrorCode = failure.code;
      if (failure.action === "stop") {
        publish("fatal");
        options.log({ event: "discovery_service_fatal", code: failure.code });
        break;
      }
      if (failure.action === "wait") {
        publish("waiting");
        options.log({ event: "discovery_service_waiting", code: failure.code });
        await options.sleep(waitMs, options.signal);
        continue;
      }
      state.consecutiveFailures++;
      publish("backing_off");
      const delay = failure.retryAfterMs ?? Math.min(maxBackoff, minBackoff * 2 ** Math.min(state.consecutiveFailures - 1, 20));
      options.log({ event: "discovery_service_retry", code: failure.code, failures: state.consecutiveFailures, delayMs: delay });
      await options.sleep(delay, options.signal);
    }
  }

  // Give the lease back so a restart does not wait for it to expire. Failing to
  // is harmless: the lease expires on its own.
  if (persistence.release) {
    try {
      await persistence.release();
    } catch {
      options.log({ event: "discovery_lease_release_failed" });
    }
  }
  if (state.state !== "fatal") publish("stopped");
  options.log({ event: "discovery_service_stopped", state: state.state, cycles: state.cycles });
  return { ...state };
}

/**
 * Liveness and readiness from the loop's own state. Alive: the process is
 * running the loop. Ready: it completed a cycle recently, or is deliberately
 * waiting for a lease or the cursor. `fatal` and a stale loop are not ready.
 */
export function serviceHealth(state: Readonly<ServiceState>, now: Date, staleMs = 180_000): { alive: boolean; ready: boolean; state: ServiceStateName; cycleAgeSeconds: number | null; progressAgeSeconds: number | null; consecutiveFailures: number; lastErrorCode: string | null } {
  const age = (value: string | null) => (value === null ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 1000)));
  const cycleAge = age(state.lastCycleAt);
  const fresh = cycleAge !== null && cycleAge * 1000 <= staleMs;
  return {
    alive: state.state !== "fatal" && state.state !== "stopped",
    ready: (state.state === "running" && fresh) || state.state === "waiting",
    state: state.state,
    cycleAgeSeconds: cycleAge,
    progressAgeSeconds: age(state.lastProgressAt),
    consecutiveFailures: state.consecutiveFailures,
    lastErrorCode: state.lastErrorCode,
  };
}
