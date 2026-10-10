import { MEDIA_POLICY_VERSION, audioStreams, classifyMedia, inspectionFromProbe, playableVideo, readMp4Layout, type MediaClass } from "@/lib/ingestion/media";
import type { ReadRange } from "@/lib/ingestion/fingerprint";
import { channelIdentity } from "@/lib/discovery/events";
import type { InspectionPorts } from "@/lib/discovery/pipeline";

/**
 * Bounded verification of a document posted directly to the Movies channel
 * (E3.8A). It applies the existing browser-playback policy (lib/ingestion/media.ts,
 * the same rules that admit uploader files) to the document as Telegram holds
 * it, reading only:
 *
 * - one 16-byte header per top-level MP4 box (readMp4Layout), which also proves
 *   the boxes cover exactly the size Telegram reports;
 * - ftyp..moov plus at most 64 KiB of initial media samples, together capped
 *   at `maxHeadBytes`, handed to ffprobe (index alone omits codec profiles);
 * - the last bytes of the file, to prove the document is readable to its end.
 *
 * It never reads the media data in between, so it never claims full-file
 * integrity: the evidence says `bounded`, and the database refuses any other
 * scope. A document whose index is missing, too large, unreadable or outside
 * the policy is recorded as such, and publication stays blocked.
 *
 * In production `read` is lib/media-gateway/range-reader.ts over the gateway's
 * own MediaReader (the dedicated MTProto reader), so a document that verifies
 * here is one the gateway can serve. This module imports nothing of the gateway.
 * Detection never calls this; inspection does, once per document identity.
 */

export const VERIFICATION_METHOD = "bounded_mtproto_v1";
export const DEFAULT_VERIFICATION_BUDGET = { maxHeadBytes: 16 * 1024 * 1024, tailBytes: 4096 } as const;

/** The evidence payload the database records (snake_case, as discovery_complete expects). */
export interface ChannelMediaEvidence {
  identity: string;
  method: string;
  policy_version: number;
  media_class: MediaClass | "unverified";
  reasons: string[];
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  accessible: boolean;
  gateway_compatible: boolean;
  playback_ready: boolean;
  bytes_read: number;
}

export interface VerificationPorts {
  /** Bounded reads of this exact document. */
  read: ReadRange;
  /** ffprobe JSON (`-show_format -show_streams`) of bounded index/sample bytes. */
  probe(head: Uint8Array): Promise<unknown>;
  /** True when `read` is the gateway's MediaReader: what verifies is what the gateway serves. */
  gatewayCompatible: boolean;
}

const token = (value: string | null | undefined, max = 40) => {
  const cleaned = (value ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max);
  return cleaned || null;
};

export async function verifyChannelMedia(
  document: { identity: string; sizeBytes: number },
  ports: VerificationPorts,
  budget: { maxHeadBytes: number; tailBytes: number } = DEFAULT_VERIFICATION_BUDGET,
): Promise<ChannelMediaEvidence> {
  if (!/^tg1-[0-9a-f]{64}$/.test(document.identity) || !Number.isSafeInteger(document.sizeBytes) || document.sizeBytes <= 0) {
    throw new Error("verification_identity_invalid");
  }
  let bytesRead = 0;
  const headerOffsets: number[] = [];
  const counted: ReadRange = async (offset, length) => {
    const bytes = await ports.read(offset, length);
    bytesRead += bytes.byteLength;
    if (bytesRead > budget.maxHeadBytes + budget.tailBytes + 64 * 1024) throw new Error("verification_budget_exceeded");
    return bytes;
  };
  const unverified = (reasons: string[], extra: Partial<ChannelMediaEvidence> = {}): ChannelMediaEvidence => ({
    identity: document.identity, method: VERIFICATION_METHOD, policy_version: MEDIA_POLICY_VERSION,
    media_class: "unverified", reasons, container: null, video_codec: null, audio_codec: null,
    accessible: false, gateway_compatible: ports.gatewayCompatible, playback_ready: false, bytes_read: bytesRead, ...extra,
  });

  // 1. Top-level layout from box headers; each header read starts one box.
  let layout: Awaited<ReturnType<typeof readMp4Layout>>;
  try {
    layout = await readMp4Layout(document.sizeBytes, async (offset, length) => {
      headerOffsets.push(offset);
      return counted(offset, length);
    });
  } catch {
    return unverified(["media_unreadable"]);
  }
  if (!layout) return unverified(["container_not_mp4"]);
  if (!layout.complete) return unverified(["mp4_layout_incomplete"], { container: "mp4" });
  const moov = layout.boxes.indexOf("moov");
  if (moov === -1 || !layout.fastStart || layout.fragmented) {
    return unverified([...(layout.fragmented ? ["mp4_fragmented"] : []), ...(!layout.fastStart ? ["mp4_not_fast_start"] : [])], { container: "mp4" });
  }
  // fastStart: ftyp first, moov before mdat. The index ends where the next box starts.
  const headEnd = headerOffsets[moov + 1] ?? document.sizeBytes;
  if (headEnd > budget.maxHeadBytes) return unverified(["moov_over_budget"], { container: "mp4" });

  // 2. Include a small sample after the index: real ffprobe needs packets to
  // identify H.264 pixel format/profile and AAC profile. Unknown stays blocked.
  const probeEnd = Math.min(document.sizeBytes, budget.maxHeadBytes, headEnd + 64 * 1024);
  let head: Uint8Array;
  let tail: Uint8Array;
  const tailLength = Math.min(budget.tailBytes, document.sizeBytes);
  try {
    head = await counted(0, probeEnd);
    tail = await counted(document.sizeBytes - tailLength, tailLength);
  } catch {
    return unverified(["media_unreadable"], { container: "mp4" });
  }
  const accessible = head.byteLength === probeEnd && tail.byteLength === tailLength;
  if (!accessible) return unverified(["media_unreadable"], { container: "mp4" });

  // 3. The existing policy on the probed index. The probe saw only the head, so
  // its own size field is meaningless; size agreement is proven by the layout.
  let inspection: ReturnType<typeof inspectionFromProbe>;
  try {
    const probe = (await ports.probe(head)) as { format?: Record<string, unknown> } | null;
    const format = { ...(probe?.format ?? {}) };
    delete format.size;
    inspection = inspectionFromProbe({ ...probe, format }, document.sizeBytes, layout);
  } catch {
    return unverified(["probe_failed"], { container: "mp4", accessible });
  }
  const verdict = classifyMedia(inspection);
  const video = playableVideo(inspection)[0]?.codec ?? null;
  const audio = audioStreams(inspection)[0]?.codec ?? null;
  const iso = inspection.formatName.split(",").includes("mp4");
  return {
    identity: document.identity, method: VERIFICATION_METHOD, policy_version: verdict.policyVersion,
    media_class: verdict.class,
    reasons: verdict.reasons.map((reason) => token(reason, 100) ?? "unknown").slice(0, 50),
    container: iso ? "mp4" : token(inspection.formatName.split(",")[0]),
    video_codec: token(video), audio_codec: token(audio),
    accessible, gateway_compatible: ports.gatewayCompatible,
    playback_ready: verdict.class === "canonical" && accessible && ports.gatewayCompatible,
    bytes_read: bytesRead,
  };
}

/** The exact document a verification reads: its private Telegram location and declared size. Never logged. */
export interface ChannelDocument { chatId: number; messageId: number; fileUniqueId: string; sizeBytes: number; mimeType: string | null }

/**
 * The inspection `media` port for the discovery worker: bounded verification of
 * the claimed document through `open` (in production, lib/media-gateway/range-reader.ts
 * over the gateway's MediaReader) and `probe` (ffprobe on the head).
 *
 * It never throws for the document's sake: an unreachable reader, a missing or
 * replaced document and a failed probe are all recorded as unverified evidence
 * for that identity. The candidate then waits at the media gate, and a later
 * re-inspection supersedes the record. Duplicates and provenance are decided by
 * the database, never here.
 */
export function channelMediaPort(open: (document: ChannelDocument) => ReadRange, probe: VerificationPorts["probe"], options: { gatewayCompatible?: boolean; budget?: { maxHeadBytes: number; tailBytes: number } } = {}): InspectionPorts["media"] {
  return async (event) => {
    const identity = channelIdentity(event);
    const sizeBytes = event.media.size;
    if (!identity || !sizeBytes) return { duplicateOf: null, source: null, evidence: null, verification: null };
    const read = open({ chatId: event.channelId, messageId: event.messageId, fileUniqueId: event.media.uniqueId, sizeBytes, mimeType: event.media.mime });
    const verification = await verifyChannelMedia({ identity, sizeBytes }, { read, probe, gatewayCompatible: options.gatewayCompatible ?? true }, options.budget ?? DEFAULT_VERIFICATION_BUDGET);
    return { duplicateOf: null, source: null, evidence: null, verification };
  };
}
