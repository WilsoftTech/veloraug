import { assembleRange, planRangeReads } from "@/lib/telegram/mtproto-range";
import type { MediaLocator, MediaReader } from "@/lib/media-gateway/ports";

/** Same shape as lib/ingestion/fingerprint.ts ReadRange (declared here: gateway core imports nothing else). */
export type RangeRead = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * A ReadRange over the gateway's MediaReader for one unpublished document. The
 * locator comes from the private discovery row (the gateway's published-only
 * resolver is not involved and not widened). Each range becomes the minimal
 * set of aligned `upload.getFile` reads (lib/telegram/mtproto-range.ts).
 */
export function mediaReaderRange(reader: MediaReader, locator: MediaLocator, signal: AbortSignal, maxRangeBytes = 16 * 1024 * 1024): RangeRead {
  return async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    const plan = planRangeReads(offset, offset + length - 1, locator.fileSize, maxRangeBytes);
    if (!plan.ok) throw new Error(`verification_${plan.code}`);
    const replies: Uint8Array[] = [];
    for (const part of plan.reads) replies.push((await reader.readPart(locator, part.offset, part.limit, signal)).bytes);
    return assembleRange(plan, replies);
  };
}
