/**
 * Structured gateway logging (E1.2). Redaction is by allow-list: only the named
 * fields below, with their expected primitive types, are ever written. Tokens,
 * Telegram ids, hashes, file references, session material, credentials and raw
 * error messages have no field, so they cannot reach a log line even by mistake.
 */
import type { GatewayErrorCode } from "@/lib/media-gateway/errors";

export interface GatewayLogFields {
  event: string;
  requestId?: string;
  /** Internal Velora movie-version id (not a Telegram identifier). */
  movieVersionId?: number;
  route?: "stream" | "download" | "healthz" | "readyz" | "other";
  requestedBytes?: number;
  servedBytes?: number;
  status?: number;
  latencyMs?: number;
  firstByteMs?: number;
  rpcCount?: number;
  /** Upstream reads started for this response (each ≤ 1 MiB). */
  readsIssued?: number;
  /** Upstream reads the full range would need. */
  readsPlanned?: number;
  code?: GatewayErrorCode | string;
  outcome?: "complete" | "client_closed" | "failed" | "denied" | "timeout";
  activeStreams?: number;
  state?: string;
}

const NUMBER_FIELDS = ["movieVersionId", "requestedBytes", "servedBytes", "status", "latencyMs", "firstByteMs", "rpcCount", "readsIssued", "readsPlanned", "activeStreams"] as const;
const STRING_FIELDS = ["event", "requestId", "route", "code", "outcome", "state"] as const;
/** Only short, identifier-like strings are logged; anything else is dropped. */
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export function formatLogLine(level: LogLevel, fields: GatewayLogFields, now: Date): string {
  const record: Record<string, string | number> = { ts: now.toISOString(), level };
  const source = fields as unknown as Record<string, unknown>;
  for (const key of STRING_FIELDS) {
    const value = source[key];
    if (typeof value === "string" && SAFE_STRING.test(value)) record[key] = value;
  }
  for (const key of NUMBER_FIELDS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) record[key] = Math.round(value);
  }
  return JSON.stringify(record);
}

export interface GatewayLogger {
  info(fields: GatewayLogFields): void;
  warn(fields: GatewayLogFields): void;
  error(fields: GatewayLogFields): void;
}

export function createLogger(sink: LogSink = (line) => process.stdout.write(`${line}\n`), clock: () => Date = () => new Date()): GatewayLogger {
  const write = (level: LogLevel) => (fields: GatewayLogFields) => sink(formatLogLine(level, fields, clock()));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}
