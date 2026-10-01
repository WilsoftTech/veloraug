import "server-only";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { discoveryKey } from "@/lib/ingestion/fingerprint";
import { classifyMedia, selectPlaybackStreams, verifyRemux, MEDIA_POLICY_VERSION, type PacketDigest, type PlaybackSelection, type RemuxVerification } from "@/lib/ingestion/media";
import { TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { newJournalEntry, type Journal, type JournalEntry, type JournalMedia } from "@/lib/uploader/journal";
import { remuxSpaceNeeded, type MediaTools, type ProbeResult } from "@/lib/uploader/media-tools";
import { verifySourceFingerprint } from "@/lib/uploader/upload";
import type { PlannedAction, SourceFingerprint } from "@/types/ingestion";

/**
 * Class 2 normalization (E3.5): repackage one source by stream copy into a
 * fast-start MP4 rendition, prove it, and record it as its own journal entry.
 * Local only: no Telegram call, no database write. Uploading the rendition is
 * the existing `upload` (with its authorization, exactly-once and recovery
 * rules), selected by the rendition's own fingerprint.
 *
 * Order, each step failing closed before the next:
 * source is Class 2 and has no upload history -> an earlier rendition is
 * reused if it is intact or already uploaded -> the film's video and audio
 * stream selected by meaning (E3.6; verified cover art is left out) -> source
 * bytes re-fingerprinted -> free space -> FFmpeg stream copy of exactly those
 * two streams into `<stem>.mp4.partial` -> output probed (must be canonical)
 * -> every packet of both selected streams compared ->
 * source re-fingerprinted (unchanged) -> rename to `<stem>.mp4` -> rendition
 * fingerprinted and journaled -> source linked to it.
 *
 * The source file is only ever read. Everything written lives in one
 * directory per source under the renditions root (inside the Bot API path
 * map, so the local Bot API can read it), named after the source fingerprint.
 */

export interface NormalizeDeps {
  journal: Journal;
  tools: MediaTools;
  /** Renditions root, e.g. G:\Movies\.velora-renditions. */
  renditionsRoot: string;
  probe(path: string): Promise<ProbeResult>;
  digest(path: string, selection: PlaybackSelection): Promise<PacketDigest | null>;
  remux(sourcePath: string, outputPath: string, selection: PlaybackSelection): Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
  freeBytes(dir: string): Promise<number>;
  fingerprint(path: string, sizeBytes: number): Promise<SourceFingerprint>;
  /** Size and mtime, or null when the path is not a regular file. */
  fileFacts(path: string): Promise<{ sizeBytes: number; modifiedAtMs: number } | null>;
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; a missing file is not an error. */
  remove(path: string): Promise<void>;
  /** The planner's decision for a journal entry (the CLI's planFile). */
  plan(entry: JournalEntry): Promise<{ action: PlannedAction; stopReasons: string[] }>;
  now(): Date;
}

export type NormalizeResult =
  | { result: "normalized"; rendition: JournalEntry; verification: RemuxVerification }
  | { result: "already_normalized"; rendition: JournalEntry; reason: "rendition_intact" | "rendition_has_upload_history" }
  | { result: "refused"; code: string; details?: string[] }
  | { result: "failed"; code: string; details: string[] };

export interface RenditionTarget {
  dir: string;
  path: string;
  partialPath: string;
  fileName: string;
}

/**
 * Where a source's rendition goes. The directory comes from the fingerprint
 * (hex only), the file name from the source's own base name with `.mp4`, so
 * the uploaded document keeps the title, year and VJ the parser reads. Null
 * when the name cannot be used safely.
 */
export function renditionTarget(source: Pick<JournalEntry, "fingerprint" | "fileName">, renditionsRoot: string): RenditionTarget | null {
  const stem = basename(source.fileName, extname(source.fileName));
  if (!stem || stem === "." || stem === ".." || /[\\/\0]/.test(stem) || basename(source.fileName) !== source.fileName) return null;
  const dir = join(resolve(renditionsRoot), source.fingerprint.slice(0, 20));
  const fileName = `${stem}.mp4`;
  const path = join(dir, fileName);
  if (dirname(path) !== dir) return null;
  return { dir, path, partialPath: `${path}.partial`, fileName };
}

const hasUploadHistory = (entry: JournalEntry) => entry.state.upload !== "not_uploaded" || entry.attempts.length > 0;

async function recordFailure(deps: NormalizeDeps, source: JournalEntry, code: string, details: string[]): Promise<NormalizeResult> {
  const now = deps.now().toISOString();
  await deps.journal.put({ ...source, media: { ...source.media!, normalizationFailure: { code, details, at: now } }, updatedAt: now });
  return { result: "failed", code, details };
}

/** An earlier rendition that can stand: already uploaded (never redone), or intact on disk. */
async function existingRendition(source: JournalEntry, deps: NormalizeDeps): Promise<NormalizeResult | null> {
  const recorded = source.media?.rendition;
  if (!recorded) return null;
  const entry = await deps.journal.get(recorded.fingerprint);
  if (entry === null) return null;
  if (hasUploadHistory(entry)) return { result: "already_normalized", rendition: entry, reason: "rendition_has_upload_history" };
  // Made under an older policy and never sent: regenerated and re-verified under this one.
  if (recorded.removedAt !== null || entry.media?.classification.policyVersion !== MEDIA_POLICY_VERSION) return null;
  const facts = await deps.fileFacts(entry.absolutePath);
  if (facts === null || facts.sizeBytes !== entry.sizeBytes) return null;
  return (await deps.fingerprint(entry.absolutePath, entry.sizeBytes)) === entry.fingerprint ? { result: "already_normalized", rendition: entry, reason: "rendition_intact" } : null;
}

export async function normalizeEntry(source: JournalEntry, deps: NormalizeDeps): Promise<NormalizeResult> {
  const media = source.media;
  if (media === null || media.role !== "source" || media.inspection === null) return { result: "refused", code: "media_not_inspected" };
  if (media.classification.policyVersion !== MEDIA_POLICY_VERSION) return { result: "refused", code: "media_policy_outdated" };
  if (media.classification.class !== "remux") return { result: "refused", code: `media_${media.classification.class}`, details: media.classification.reasons };
  // A source that was itself uploaded is a replacement decision (E3.3), not routine normalization.
  if (hasUploadHistory(source)) return { result: "refused", code: "source_has_upload_history" };

  const earlier = await existingRendition(source, deps);
  if (earlier !== null) return earlier;

  const selection = selectPlaybackStreams(media.inspection);
  if (selection === null) return { result: "refused", code: "stream_selection_ambiguous" };
  const target = renditionTarget(source, deps.renditionsRoot);
  if (target === null) return { result: "refused", code: "rendition_name_unsafe" };

  const before = await deps.fileFacts(source.absolutePath);
  const sourceCheck = await verifySourceFingerprint(source, deps.fingerprint);
  if (before === null || !sourceCheck.ok) return { result: "refused", code: sourceCheck.ok ? "source_fingerprint_unreadable" : sourceCheck.code };

  await deps.mkdir(target.dir);
  const needed = remuxSpaceNeeded(source.sizeBytes);
  const free = await deps.freeBytes(target.dir);
  if (free < needed) return { result: "refused", code: "insufficient_disk_space", details: [`free ${free} bytes, needed ${needed}`] };

  // Only our own temporary file is ever removed here.
  await deps.remove(target.partialPath);
  const discard = async (code: string, details: string[]) => {
    await deps.remove(target.partialPath);
    return recordFailure(deps, source, code, details);
  };

  const made = await deps.remux(source.absolutePath, target.partialPath, selection);
  if (!made.ok) return discard(made.code, made.detail ? [made.detail] : []);

  const probed = await deps.probe(target.partialPath);
  if (!probed.ok) return discard("output_probe_failed", [probed.code]);
  if (probed.inspection.sizeBytes > TELEGRAM_MAX_FILE_BYTES) return discard("rendition_too_large", [`${probed.inspection.sizeBytes} bytes`]);

  const outputSelection = selectPlaybackStreams(probed.inspection);
  if (outputSelection === null) return discard("output_streams_unselectable", []);
  const [sourcePackets, outputPackets] = [await deps.digest(source.absolutePath, selection), await deps.digest(target.partialPath, outputSelection)];
  if (sourcePackets === null || outputPackets === null) return discard("packet_digest_failed", [sourcePackets === null ? "source" : "output"]);
  const verification = verifyRemux(media.inspection, probed.inspection, sourcePackets, outputPackets);
  if (!verification.passed) return discard("verification_failed", verification.failures);

  // The source must be exactly as it was: normalization only ever reads it.
  const after = await deps.fileFacts(source.absolutePath);
  const sourceAfter = await verifySourceFingerprint(source, deps.fingerprint);
  if (after === null || !sourceAfter.ok || after.sizeBytes !== before.sizeBytes || after.modifiedAtMs !== before.modifiedAtMs) {
    return discard("source_changed_during_normalization", []);
  }

  await deps.rename(target.partialPath, target.path);
  const facts = await deps.fileFacts(target.path);
  if (facts === null || facts.sizeBytes !== probed.inspection.sizeBytes) return discard("rendition_missing_after_rename", []);
  const fingerprint = await deps.fingerprint(target.path, facts.sizeBytes);
  const now = deps.now();

  const known = await deps.journal.get(fingerprint);
  let rendition: JournalEntry;
  if (known !== null && hasUploadHistory(known)) {
    // These exact bytes were already uploaded (a lost source link): adopt that entry, never a second upload.
    rendition = known;
  } else {
    const relativePath = join(basename(resolve(deps.renditionsRoot)), relative(resolve(deps.renditionsRoot), target.path)).split("\\").join("/");
    const renditionMedia: JournalMedia = {
      role: "rendition",
      inspectedAt: now.toISOString(),
      tools: { ffprobe: deps.tools.ffprobe.version, ffmpeg: deps.tools.ffmpeg.version },
      inspection: probed.inspection,
      classification: classifyMedia(probed.inspection),
      rendition: null,
      derivedFrom: { fingerprint: source.fingerprint, sizeBytes: source.sizeBytes, verification },
      normalizationFailure: null,
    };
    const base = known ?? newJournalEntry({ fingerprint, kind: source.kind, intendedChannelId: source.intendedChannelId, fileName: target.fileName, relativePath, absolutePath: target.path, sizeBytes: facts.sizeBytes, modifiedAtMs: facts.modifiedAtMs, discoveryKey: discoveryKey(relativePath, facts.sizeBytes, facts.modifiedAtMs) }, now);
    const draft: JournalEntry = { ...base, absolutePath: target.path, relativePath, fileName: target.fileName, modifiedAtMs: facts.modifiedAtMs, media: renditionMedia, updatedAt: now.toISOString() };
    rendition = { ...draft, plan: await deps.plan(draft) };
    await deps.journal.put(rendition);
  }

  const linked: JournalEntry = {
    ...source,
    media: { ...media, rendition: { fingerprint: rendition.fingerprint, absolutePath: rendition.absolutePath, sizeBytes: rendition.sizeBytes, createdAt: now.toISOString(), removedAt: null }, normalizationFailure: null },
    updatedAt: now.toISOString(),
  };
  await deps.journal.put({ ...linked, plan: await deps.plan(linked) });
  return rendition === known ? { result: "already_normalized", rendition, reason: "rendition_has_upload_history" } : { result: "normalized", rendition, verification };
}

export type CleanupResult = { result: "removed"; reason: "uploaded" | "never_uploaded" } | { result: "refused"; code: string };

/**
 * Removes a rendition file. Allowed only when that is safe and final: the
 * rendition is uploaded and the server acknowledged it (playback uses the
 * Telegram copy), or it never had an upload attempt (it can be regenerated).
 * Anything in between, above all an uncertain upload, keeps the file: recovery
 * may still need to match it.
 */
export async function cleanupRendition(rendition: JournalEntry, deps: Pick<NormalizeDeps, "journal" | "remove" | "plan" | "now">): Promise<CleanupResult> {
  if (rendition.media?.role !== "rendition" || rendition.media.derivedFrom === null) return { result: "refused", code: "not_a_rendition" };
  const uploaded = rendition.state.upload === "uploaded" && rendition.dbAcknowledgedAt !== null;
  const untouched = !hasUploadHistory(rendition);
  if (!uploaded && !untouched) return { result: "refused", code: "rendition_upload_unsettled" };

  await deps.remove(rendition.absolutePath);
  const now = deps.now().toISOString();
  if (untouched) {
    // The journal must not keep offering a file that no longer exists for upload.
    await deps.journal.put({ ...rendition, plan: { action: "hold", stopReasons: ["rendition_removed"] }, updatedAt: now });
  }
  const source = await deps.journal.get(rendition.media.derivedFrom.fingerprint);
  if (source?.media?.rendition?.fingerprint === rendition.fingerprint) {
    const updated: JournalEntry = { ...source, media: { ...source.media, rendition: { ...source.media.rendition, removedAt: now } }, updatedAt: now };
    await deps.journal.put({ ...updated, plan: await deps.plan(updated) });
  }
  return { result: "removed", reason: uploaded ? "uploaded" : "never_uploaded" };
}
