/**
 * Maps an HTTP byte range onto legal MTProto `upload.getFile` reads (E1.1).
 * Pure: no network, no Telegram client.
 *
 * Telegram's rules with `precise` (https://core.telegram.org/api/files):
 * offset and limit are multiples of 1 KiB, limit ≤ 1 MiB, and one request stays
 * inside one 1 MiB window from the start of the file. So a range is read as one
 * aligned request per 1 MiB window it touches (the minimum possible), and each
 * reply is trimmed to the bytes the range actually needs.
 *
 * HTTP semantics (RFC 9110 §14.1.2): the range is inclusive; an end past EOF is
 * clamped to the last byte; a start at or past EOF is unsatisfiable.
 */

export const MTPROTO_ALIGNMENT = 1024;
export const MTPROTO_WINDOW = 1024 * 1024;

export interface PlannedRead {
  /** upload.getFile offset: a multiple of 1 KiB. */
  offset: number;
  /** upload.getFile limit: a multiple of 1 KiB, ≤ 1 MiB, inside offset's 1 MiB window. */
  limit: number;
  /** Index in this read's reply of the first byte the range needs. */
  keepFrom: number;
  /** How many bytes of this read's reply the range needs. */
  keepLength: number;
}

export type RangePlan =
  | { ok: true; start: number; end: number; length: number; reads: PlannedRead[] }
  | { ok: false; code: "invalid_range" | "range_not_satisfiable" | "range_too_large" };

const isByteIndex = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * @param start first byte (inclusive)
 * @param end last byte (inclusive); may exceed the file, and is then clamped
 * @param fileSize total bytes of the file
 * @param maxLength refuse ranges longer than this after clamping (a spike or gateway bound)
 */
export function planRangeReads(start: number, end: number, fileSize: number, maxLength: number): RangePlan {
  if (!isByteIndex(start) || !isByteIndex(end) || !isByteIndex(fileSize) || !isByteIndex(maxLength) || end < start) {
    return { ok: false, code: "invalid_range" };
  }
  if (start >= fileSize) return { ok: false, code: "range_not_satisfiable" };
  const last = Math.min(end, fileSize - 1);
  const length = last - start + 1;
  if (length > maxLength) return { ok: false, code: "range_too_large" };

  const reads: PlannedRead[] = [];
  let position = start;
  while (position <= last) {
    const windowStart = Math.floor(position / MTPROTO_WINDOW) * MTPROTO_WINDOW;
    const neededLast = Math.min(last, windowStart + MTPROTO_WINDOW - 1);
    const offset = Math.floor(position / MTPROTO_ALIGNMENT) * MTPROTO_ALIGNMENT;
    // The window end is 1 KiB-aligned, so rounding up never leaves the window.
    const limit = Math.ceil((neededLast + 1 - offset) / MTPROTO_ALIGNMENT) * MTPROTO_ALIGNMENT;
    reads.push({ offset, limit, keepFrom: position - offset, keepLength: neededLast - position + 1 });
    position = neededLast + 1;
  }
  return { ok: true, start, end: last, length, reads };
}

/**
 * Joins the replies of a plan's reads into exactly the planned range. A reply
 * shorter than the bytes it must supply (a truncated read) is an error, never
 * silently shortened output.
 */
export function assembleRange(plan: Extract<RangePlan, { ok: true }>, replies: readonly Uint8Array[]): Uint8Array {
  if (replies.length !== plan.reads.length) throw new Error("range_reply_count_mismatch");
  const out = new Uint8Array(plan.length);
  let written = 0;
  plan.reads.forEach((read, index) => {
    const reply = replies[index];
    if (reply.length < read.keepFrom + read.keepLength) throw new Error("range_reply_truncated");
    out.set(reply.subarray(read.keepFrom, read.keepFrom + read.keepLength), written);
    written += read.keepLength;
  });
  return out;
}
