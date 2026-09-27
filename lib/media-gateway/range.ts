/**
 * HTTP `Range` handling for the media gateway (E1.2). Pure.
 *
 * Accepts exactly one `bytes` range in the three RFC 9110 §14.1.2 forms:
 * `a-b`, `a-` (open-ended) and `-n` (suffix). The result is always a bounded
 * range: an end past EOF is clamped to the last byte, and any range longer than
 * the gateway's per-response maximum is shortened to that maximum from its
 * first byte. A 206 whose `Content-Range` is shorter than the request is valid
 * HTTP, and media clients simply request the next range. The whole movie is
 * therefore never one response, and a missing Range header is refused instead
 * of being treated as "send everything".
 */
import { planRangeReads, type RangePlan } from "@/lib/telegram/mtproto-range";

export type ByteRange = { start: number; end: number; length: number };

export type RangeResult =
  | { ok: true; range: ByteRange; plan: Extract<RangePlan, { ok: true }> }
  | { ok: false; code: "range_required" | "invalid_range" | "range_not_satisfiable" };

// A byte position has at most 15 digits, so it is always a safe integer.
const RANGE = /^bytes=(?:(\d{1,15})-(\d{0,15})|-(\d{1,15}))$/;
const MAX_HEADER_LENGTH = 64;

export function parseRangeHeader(header: string | string[] | undefined, fileSize: number, maxResponseBytes: number): RangeResult {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("parseRangeHeader: invalid file size or maximum");
  }
  if (header === undefined) return { ok: false, code: "range_required" };
  // Node joins repeated headers for most fields; an array or a list is never accepted.
  if (typeof header !== "string" || header.length > MAX_HEADER_LENGTH) return { ok: false, code: "invalid_range" };
  const match = RANGE.exec(header.trim());
  if (!match) return { ok: false, code: "invalid_range" };

  let start: number;
  let end: number;
  if (match[3] !== undefined) {
    // A zero-length suffix (`bytes=-0`) starts at EOF, so it is unsatisfiable below.
    start = Math.max(0, fileSize - Number(match[3]));
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    // An explicit last byte before the first is malformed; an open end is judged by its start alone.
    if (match[2] !== "" && Number(match[2]) < start) return { ok: false, code: "invalid_range" };
    end = match[2] === "" ? Math.max(start, fileSize - 1) : Number(match[2]);
  }
  if (start >= fileSize) return { ok: false, code: "range_not_satisfiable" };

  const last = Math.min(end, fileSize - 1, start + maxResponseBytes - 1);
  const plan = planRangeReads(start, last, fileSize, maxResponseBytes);
  // Unreachable after the checks above; kept so a planner change cannot widen a response.
  if (!plan.ok) return { ok: false, code: plan.code === "range_not_satisfiable" ? "range_not_satisfiable" : "invalid_range" };
  return { ok: true, range: { start: plan.start, end: plan.end, length: plan.length }, plan };
}

export const contentRange = (range: ByteRange, fileSize: number) => `bytes ${range.start}-${range.end}/${fileSize}`;
export const unsatisfiedContentRange = (fileSize: number) => `bytes */${fileSize}`;
