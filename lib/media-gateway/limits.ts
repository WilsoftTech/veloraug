/**
 * Resource limits for the media gateway (E1.2): configuration with conservative
 * defaults, and the small primitives that enforce them. Pure; no timers except
 * the caller's clock.
 */
import { GatewayError } from "@/lib/media-gateway/errors";

const MIB = 1024 * 1024;

export interface GatewayLimits {
  /** Streams (in-progress range responses) across the whole gateway. */
  maxActiveStreams: number;
  /** Streams per authorization subject (token `sub`). */
  maxStreamsPerSubject: number;
  /** Streams per client IP. */
  maxStreamsPerIp: number;
  /** MTProto `upload.getFile` reads in flight across the whole gateway. */
  maxReadsInFlight: number;
  /** Reads one stream may have in flight ahead of what it has written (≤ 1 MiB each). */
  readAheadPerStream: number;
  /** Longest single 206 body; longer or open-ended requests are shortened to it. */
  maxResponseBytes: number;
  /** Whole-response deadline. */
  requestTimeoutMs: number;
  /** A response that makes no downstream progress for this long is ended. */
  idleTimeoutMs: number;
  /** Deadline for one MTProto read. */
  readTimeoutMs: number;
  /** Longest token lifetime (`exp - iat`) the gateway accepts. */
  maxTokenLifetimeSeconds: number;
  /** Range requests per subject per window (repeated-range abuse). */
  requestsPerSubjectPerWindow: number;
  /** Range requests per IP per window. */
  requestsPerIpPerWindow: number;
  rateWindowMs: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  maxActiveStreams: 32,
  maxStreamsPerSubject: 3,
  maxStreamsPerIp: 6,
  maxReadsInFlight: 8,
  readAheadPerStream: 2,
  maxResponseBytes: 8 * MIB,
  requestTimeoutMs: 120_000,
  idleTimeoutMs: 30_000,
  readTimeoutMs: 30_000,
  maxTokenLifetimeSeconds: 3_600,
  requestsPerSubjectPerWindow: 120,
  requestsPerIpPerWindow: 240,
  rateWindowMs: 60_000,
};

/** Hard ceilings: configuration can tighten the defaults, and loosen them only this far. */
const BOUNDS: Record<keyof GatewayLimits, [min: number, max: number]> = {
  maxActiveStreams: [1, 512],
  maxStreamsPerSubject: [1, 32],
  maxStreamsPerIp: [1, 64],
  maxReadsInFlight: [1, 64],
  readAheadPerStream: [1, 4],
  maxResponseBytes: [64 * 1024, 64 * MIB],
  requestTimeoutMs: [1_000, 900_000],
  idleTimeoutMs: [1_000, 300_000],
  readTimeoutMs: [1_000, 120_000],
  maxTokenLifetimeSeconds: [30, 21_600],
  requestsPerSubjectPerWindow: [1, 10_000],
  requestsPerIpPerWindow: [1, 10_000],
  rateWindowMs: [1_000, 3_600_000],
};

const ENV_NAMES: Record<keyof GatewayLimits, string> = {
  maxActiveStreams: "MEDIA_GATEWAY_MAX_ACTIVE_STREAMS",
  maxStreamsPerSubject: "MEDIA_GATEWAY_MAX_STREAMS_PER_SUBJECT",
  maxStreamsPerIp: "MEDIA_GATEWAY_MAX_STREAMS_PER_IP",
  maxReadsInFlight: "MEDIA_GATEWAY_MAX_READS_IN_FLIGHT",
  readAheadPerStream: "MEDIA_GATEWAY_READ_AHEAD_PER_STREAM",
  maxResponseBytes: "MEDIA_GATEWAY_MAX_RESPONSE_BYTES",
  requestTimeoutMs: "MEDIA_GATEWAY_REQUEST_TIMEOUT_MS",
  idleTimeoutMs: "MEDIA_GATEWAY_IDLE_TIMEOUT_MS",
  readTimeoutMs: "MEDIA_GATEWAY_READ_TIMEOUT_MS",
  maxTokenLifetimeSeconds: "MEDIA_GATEWAY_MAX_TOKEN_LIFETIME_SECONDS",
  requestsPerSubjectPerWindow: "MEDIA_GATEWAY_REQUESTS_PER_SUBJECT_PER_WINDOW",
  requestsPerIpPerWindow: "MEDIA_GATEWAY_REQUESTS_PER_IP_PER_WINDOW",
  rateWindowMs: "MEDIA_GATEWAY_RATE_WINDOW_MS",
};

/** Reads limits from the environment. An unparsable or out-of-bounds value fails closed (throws). */
export function limitsFromEnv(env: Record<string, string | undefined>): GatewayLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof GatewayLimits)[]) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined || raw === "") continue;
    const [min, max] = BOUNDS[key];
    const value = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= min && value <= max)) throw new Error(`${ENV_NAMES[key]} must be an integer in [${min}, ${max}]`);
    limits[key] = value;
  }
  return limits;
}

/** Counting semaphore with abortable waits, used for global MTProto reads in flight. */
export class Semaphore {
  readonly capacity: number;
  private available: number;
  private readonly waiters: { resolve: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("semaphore capacity");
    this.capacity = capacity;
    this.available = capacity;
  }

  get inUse() {
    return this.capacity - this.available;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      next.resolve(); // the slot passes straight to the next waiter
      return;
    }
    if (this.available >= this.capacity) throw new Error("semaphore released more than acquired");
    this.available += 1;
  }
}

/** Active-stream admission: global, per subject and per IP. */
export class StreamAdmission {
  private active = 0;
  private readonly bySubject = new Map<string, number>();
  private readonly byIp = new Map<string, number>();
  private readonly limits: Pick<GatewayLimits, "maxActiveStreams" | "maxStreamsPerSubject" | "maxStreamsPerIp">;

  constructor(limits: Pick<GatewayLimits, "maxActiveStreams" | "maxStreamsPerSubject" | "maxStreamsPerIp">) {
    this.limits = limits;
  }

  get activeStreams() {
    return this.active;
  }

  /** Returns a release function, or throws `too_many_streams`. */
  admit(subject: string, ip: string): () => void {
    if (
      this.active >= this.limits.maxActiveStreams ||
      (this.bySubject.get(subject) ?? 0) >= this.limits.maxStreamsPerSubject ||
      (this.byIp.get(ip) ?? 0) >= this.limits.maxStreamsPerIp
    ) {
      throw new GatewayError("too_many_streams");
    }
    this.active += 1;
    bump(this.bySubject, subject, 1);
    bump(this.byIp, ip, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      bump(this.bySubject, subject, -1);
      bump(this.byIp, ip, -1);
    };
  }
}

function bump(map: Map<string, number>, key: string, delta: number) {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Fixed-window request counter per key, bounded in memory: when it tracks too
 * many keys it drops the oldest windows first. Protects against repeated,
 * abusive range requests (for example, a client re-requesting tiny ranges).
 */
export class WindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(maxPerWindow: number, windowMs: number, maxKeys = 10_000) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Counts one request; returns false when the key is over its limit. */
  hit(key: string, nowMs: number): boolean {
    let window = this.windows.get(key);
    if (!window || nowMs - window.startedAt >= this.windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) {
        // Map iteration is insertion order, so the first key is the oldest window.
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      window = { startedAt: nowMs, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.maxPerWindow;
  }

  get trackedKeys() {
    return this.windows.size;
  }
}
