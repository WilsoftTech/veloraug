import { audioStreams, inspectionFromProbe, matroskaDocType, completeMatroskaTracks, playableVideo, readMp4Layout, type MediaClass } from "@/lib/ingestion/media";
import { assessOriginalMedia, classifyOriginalMovie, ORIGINAL_MEDIA_POLICY_VERSION } from "@/lib/ingestion/original-media";
import type { ReadRange } from "@/lib/ingestion/fingerprint";
import { channelIdentity } from "@/lib/discovery/events";
import type { InspectionPorts } from "@/lib/discovery/pipeline";

// The reader fails with the gateway's closed error model (lib/media-gateway/errors.ts). It is recognised by
// shape, because this module imports nothing of the gateway, and only these codes ever become a reason:
// never an exception's text.
const READ_FAILURES = new Set(["not_ready", "telegram_unavailable", "flood_wait", "mtproto_disconnected", "upstream_timeout", "document_resolution_failed", "range_not_satisfiable"]);
function readFailure(error: unknown): string {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  return name === "GatewayError" && typeof code === "string" && READ_FAILURES.has(code) ? `media_read_${code}` : "media_unreadable";
}
// Conditions of the reader or the probe that pass by themselves. A document
// that does not resolve or is outside the policy needs another file, not a retry.
const TRANSIENT_REASONS = new Set(["media_read_not_ready", "media_read_telegram_unavailable", "media_read_flood_wait", "media_read_mtproto_disconnected", "media_read_upstream_timeout", "probe_timeout"]);

/**
 * Read-only inspection of original MP4/MKV documents through the gateway reader.
 * MP4 box headers bound the layout; the index and initial sample stay within
 * maxHeadBytes. A tail index is handed to ffprobe at its original offset in a
 * disposable sparse file. MKV needs an explicit Matroska DocType and complete
 * Tracks within the bounded head. A tail read checks end accessibility.
 * No claim of full-file integrity, browser verification, download availability,
 * rights clearance or publication approval follows from these samples.
 * Policy 3 evidence requires the separately approved Checkpoint 4 database work.
 */

export const VERIFICATION_METHOD = "bounded_original_v2";
export const DEFAULT_VERIFICATION_BUDGET = { maxHeadBytes: 16 * 1024 * 1024, tailBytes: 4096 } as const;

/** Local policy 3 evidence; persistence requires Checkpoint 4 schema/RPC support. */
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
  assessment?: ReturnType<typeof assessOriginalMedia>;
  inspection_scope?: "bounded";
}

/**
 * The reason a verification should be tried again by itself, or null when its
 * result stands (verified, or a property of the document). Such a result says
 * nothing about the document, so it is scheduled as a failed inspection and is
 * never recorded as evidence.
 */
export const transientMediaFailure = (evidence: ChannelMediaEvidence): string | null =>
  evidence.media_class === "unverified" ? evidence.reasons.find((reason) => TRANSIENT_REASONS.has(reason)) ?? null : null;

export interface VerificationPorts {
  /** Bounded reads of this exact document. */
  read: ReadRange;
  /** ffprobe JSON (`-show_format -show_streams`) of bounded index/sample bytes. */
  probe(head: Uint8Array, segments?: { offset: number; bytes: Uint8Array }[]): Promise<unknown>;
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
    identity: document.identity, method: VERIFICATION_METHOD, policy_version: ORIGINAL_MEDIA_POLICY_VERSION,
    media_class: "unverified", reasons, container: null, video_codec: null, audio_codec: null,
    accessible: false, gateway_compatible: ports.gatewayCompatible, playback_ready: false, bytes_read: bytesRead, inspection_scope: "bounded", ...extra,
  });

  // 1. Top-level layout from box headers; each header read starts one box.
  let layout: Awaited<ReturnType<typeof readMp4Layout>>;
  try {
    layout = await readMp4Layout(document.sizeBytes, async (offset, length) => {
      headerOffsets.push(offset);
      return counted(offset, length);
    });
  } catch (error) {
    return unverified([readFailure(error)]);
  }
  let container: "mp4" | "mkv" = "mp4";
  let segments: { offset: number; bytes: Uint8Array }[] | undefined;
  let headEnd: number;
  if (!layout) {
    let header: Uint8Array;
    try { header = await counted(0, Math.min(4096, document.sizeBytes)); }
    catch (error) { return unverified([readFailure(error)]); }
    // EBML DocType must explicitly be Matroska; WebM and arbitrary bytes are not MKV.
    if (matroskaDocType(header) !== "matroska") return unverified(["container_not_mp4_or_mkv"]);
    container = "mkv";
    headEnd = Math.min(document.sizeBytes, budget.maxHeadBytes);
  } else {
    if (!layout.complete) return unverified(["mp4_layout_incomplete"], { container });
    const moov = layout.boxes.indexOf("moov");
    if (moov === -1) return unverified(["mp4_index_missing"], { container });
    const indexStart = headerOffsets[moov];
    const indexEnd = headerOffsets[moov + 1] ?? document.sizeBytes;
    if (layout.fastStart) headEnd = indexEnd;
    else {
      const indexBytes = indexEnd - indexStart;
      const prefixBytes = Math.min(indexStart, 64 * 1024);
      if (indexBytes + prefixBytes > budget.maxHeadBytes) return unverified(["moov_over_budget"], { container });
      try {
        const bytes = await counted(indexStart, indexBytes);
        if (bytes.length !== indexBytes) return unverified(["media_unreadable"], { container });
        segments = [{ offset: indexStart, bytes }];
      } catch (error) { return unverified([readFailure(error)], { container }); }
      headEnd = prefixBytes;
    }
    if (headEnd > budget.maxHeadBytes) return unverified(["moov_over_budget"], { container });
  }

  // 2. Include a small sample after the index: real ffprobe needs packets to
  // identify H.264 pixel format/profile and AAC profile. Unknown stays blocked.
  const probeEnd = Math.min(document.sizeBytes, budget.maxHeadBytes - (segments?.[0].bytes.length ?? 0), headEnd + (segments || container === "mkv" ? 0 : 64 * 1024));
  let head: Uint8Array;
  let tail: Uint8Array;
  const tailLength = Math.min(budget.tailBytes, document.sizeBytes);
  try {
    head = await counted(0, probeEnd);
    tail = await counted(document.sizeBytes - tailLength, tailLength);
  } catch (error) {
    return unverified([readFailure(error)], { container });
  }
  const accessible = head.byteLength === probeEnd && tail.byteLength === tailLength;
  if (!accessible) return unverified(["media_unreadable"], { container });

  if (container === "mkv" && !completeMatroskaTracks(head, document.sizeBytes)) return unverified(["mkv_tracks_incomplete"], { container, accessible });

  // 3. The original-file policy on the probed index. The probe saw only the head, so
  // its own size field is meaningless; size agreement is proven by the layout.
  let inspection: ReturnType<typeof inspectionFromProbe>;
  try {
    const probe = (await ports.probe(head, segments)) as { format?: Record<string, unknown> } | null;
    const format = { ...(probe?.format ?? {}) };
    delete format.size;
    inspection = inspectionFromProbe({ ...probe, format }, document.sizeBytes, layout);
    if (container === "mkv") inspection.matroskaDocType = matroskaDocType(head);
  } catch (error) {
    return unverified([error instanceof Error && error.message === "probe_timeout" ? "probe_timeout" : "probe_failed"], { container, accessible });
  }
  const assessment = assessOriginalMedia(inspection);
  const verdict = classifyOriginalMovie(inspection);
  const video = playableVideo(inspection)[0]?.codec ?? null;
  const audio = audioStreams(inspection)[0]?.codec ?? null;
  const iso = inspection.formatName.split(",").includes("mp4");
  return {
    identity: document.identity, method: VERIFICATION_METHOD, policy_version: verdict.policyVersion,
    media_class: assessment.accepted ? verdict.class : "unverified",
    reasons: verdict.reasons.map((reason) => token(reason, 100) ?? "unknown").slice(0, 50),
    container: iso ? "mp4" : assessment.container,
    video_codec: token(video), audio_codec: token(audio),
    accessible, gateway_compatible: ports.gatewayCompatible,
    // Browser readiness and publication approval are never asserted by inspection.
    playback_ready: false,
    assessment, inspection_scope: "bounded",
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
