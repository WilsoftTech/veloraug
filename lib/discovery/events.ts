import { createHash } from "node:crypto";
import { z } from "zod";
import { telegramMediaMessageSchema, fingerprintFromCaption } from "@/lib/ingestion/telegram";
import { parseFilename } from "@/lib/ingestion/parser";
import { normalizeTitle, vjKey } from "@/lib/ingestion/normalize";
import { RECOVERY_MARKER_PREFIX } from "@/lib/ingestion/recovery";
import type { DiscoveryEvent, Inbox, ReviewCandidate } from "@/lib/discovery/model";

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const mediaKey = (event: DiscoveryEvent): string => digest([event.channelId, event.messageId, event.media.uniqueId, event.media.size]);
const updateSchema = z.object({ update_id: z.number().int().nonnegative(), channel_post: z.unknown().optional(), edited_channel_post: z.unknown().optional() });
const messageSchema = telegramMediaMessageSchema.extend({ edit_date: z.number().int().positive().optional() });
const safeCaption = (caption: string | undefined) => caption?.replace(/https?:\/\/\S+/gi, "[link omitted]").replace(/\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g, "[credential omitted]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[credential omitted]") ?? null;

/** Only selected fields are retained; file_id and raw payloads never enter the inbox. */
export function detectDocument(raw: unknown, channelId: number, reconciliation = false): { updateId: number; digest: string; event: DiscoveryEvent | null; withdrawnMessageKey?: string } {
  const update = reconciliation ? updateSchema.partial({ update_id: true }).parse(raw) : updateSchema.parse(raw);
  // A history page has no Bot API update ID; zero is only an internal ignored-delivery digest salt.
  const updateId = update.update_id ?? 0;
  const edited = update.edited_channel_post !== undefined;
  const value = edited ? update.edited_channel_post : update.channel_post;
  if (value === undefined) return { updateId, digest: digest([updateId, "unrelated"]), event: null };
  // Unrelated message types may lack the media fields; validate their envelope first.
  const envelope = z.object({ chat: z.object({ id: z.number().int().safe() }), message_id: z.number().int().positive() }).parse(value);
  if (envelope.chat.id !== channelId) return { updateId, digest: digest([updateId, "other_channel"]), event: null };
  const message = messageSchema.parse(value);
  const doc = message.document;
  if (!doc || message.video || message.caption?.includes(RECOVERY_MARKER_PREFIX)) return { updateId, digest: digest([updateId, "not_document"]), event: null, ...(edited ? { withdrawnMessageKey: digest([channelId, message.message_id]) } : {}) };
  const media = { uniqueId: doc.file_unique_id, size: doc.file_size ?? null, name: doc.file_name ?? null, mime: doc.mime_type ?? null, caption: safeCaption(message.caption) };
  const timestamp = message.edit_date ?? message.date;
  const payloadDigest = digest([message.chat.id, message.message_id, timestamp, media]);
  const messageKey = digest([message.chat.id, message.message_id]);
  const kind = reconciliation ? "reconciliation" : edited ? "edited_channel_post" : "channel_post";
  const event: DiscoveryEvent = { id: digest([messageKey, timestamp, payloadDigest]), messageKey, updateId: reconciliation ? null : updateId, channelId, messageId: message.message_id, kind, timestamp, digest: payloadDigest, media };
  return { updateId, digest: payloadDigest, event };
}

export function parseDocument(event: DiscoveryEvent) {
  const file = parseFilename(event.media.name ?? "");
  const lines = (event.media.caption ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(?:Movie$|velora-src:|tmdb:)/i.test(line));
  const captionText = lines.join(" - ").replace(/\|/g, " - ");
  const caption = captionText ? parseFilename(`${captionText}.mp4`) : null;
  const warnings = file.issues.map((issue) => issue.code as string);
  if (caption && file.title && caption.title && normalizeTitle(file.title) !== normalizeTitle(caption.title)) warnings.push("caption_title_conflict");
  if (caption?.year && file.year && caption.year !== file.year) warnings.push("caption_year_conflict");
  if (caption?.vjText && file.vjText && vjKey(caption.vjText) !== vjKey(file.vjText)) warnings.push("caption_vj_conflict");
  if (caption) warnings.push(...caption.issues.filter((issue) => issue.code !== "unsupported_extension").map((issue) => issue.code));
  return { title: file.title ?? caption?.title ?? null, year: file.year ?? caption?.year ?? null, vjText: file.vjText ?? caption?.vjText ?? null,
    kind: file.inferredKind === "series" || caption?.inferredKind === "series" ? "series" : "movie",
    warnings: [...new Set(warnings)], confidence: file.confidence,
    // A claim is evidence for lookup only; it never becomes uploaderSource.
    claimedFingerprint: fingerprintFromCaption(event.media.caption),
    externalId: /(?:^|\s)tmdb:movie:(\d+)(?=\s|$)/.exec(event.media.caption ?? "")?.[1] ?? null,
    references: ["document.file_name", ...(caption ? ["message.caption"] : [])] };
}

export function initialInbox(channelId: number): Inbox {
  if (!Number.isSafeInteger(channelId) || channelId >= 0) throw new Error("invalid_movies_channel");
  return { version: 1, channelId, checkpoint: null, reconciliation: { cursor: null, checkedAt: null, incomplete: true }, deliveries: {}, events: {}, candidates: {} };
}
function newCandidate(event: DiscoveryEvent, now: string): ReviewCandidate {
  return { id: event.messageKey, revision: 1, event, firstSeen: now, lastSeen: now, status: "detected", attempts: 0, lease: null, retryAt: 0, error: null,
    title: null, year: null, vjText: null, vjId: null, tmdbId: null, movieId: null, identity: "unknown", relation: "unknown", choices: [], snapshot: null, warnings: [], evidence: null,
    rights: null, approval: null, uploaderSource: null, duplicateOf: null, publication: null, audit: [{ at: now, actor: "discovery", action: "detected", revision: 1 }] };
}

/** Transaction includes all events and the delivery checkpoint: acknowledge only after commit. */
export function receive(inbox: Inbox, updates: readonly unknown[], now: string, reconciliation = false): { detected: number; duplicates: number; ignored: number } {
  if (updates.length > 100) throw new Error("batch_limit");
  const counts = { detected: 0, duplicates: 0, ignored: 0 };
  for (const raw of updates) {
    const item = detectDocument(raw, inbox.channelId, reconciliation);
    const deliveryKey = reconciliation ? `reconcile:${item.event?.id ?? item.digest}` : String(item.updateId);
    const delivery = inbox.deliveries[deliveryKey];
    if (delivery) {
      if (delivery.digest !== item.digest) throw new Error("update_payload_conflict");
      delivery.lastSeen = now; delivery.count++; counts.duplicates++; continue;
    }
    inbox.deliveries[deliveryKey] = { digest: item.digest, eventId: item.event?.id ?? null, firstSeen: now, lastSeen: now, count: 1 };
    if (!reconciliation) inbox.checkpoint = Math.max(inbox.checkpoint ?? 0, item.updateId);
    const event = item.event;
    if (!event) {
      const withdrawn = item.withdrawnMessageKey ? inbox.candidates[item.withdrawnMessageKey] : null;
      if (withdrawn) {
        withdrawn.revision++; withdrawn.approval = null; withdrawn.rights = null; withdrawn.evidence = null; withdrawn.lease = null;
        withdrawn.status = "blocked"; withdrawn.error = "edited_media_unavailable";
        withdrawn.audit.push({ at: now, actor: "discovery", action: "edited_media_unavailable", revision: withdrawn.revision });
        withdrawn.audit = withdrawn.audit.slice(-500);
      }
      counts.ignored++; continue;
    }
    const priorEvent = inbox.events[event.id];
    if (priorEvent) { priorEvent.lastSeen = now; priorEvent.count++; counts.duplicates++; continue; }
    const candidate = inbox.candidates[event.messageKey];
    const newer = !candidate || event.timestamp > candidate.event.timestamp || (event.timestamp === candidate.event.timestamp && (event.updateId ?? -1) > (candidate.event.updateId ?? -1));
    inbox.events[event.id] = { event, firstSeen: now, lastSeen: now, count: 1, status: newer ? "pending" : "superseded" };
    if (!newer) continue;
    if (!candidate) {
      const next = newCandidate(event, now);
      const sameDocument = Object.values(inbox.candidates).find((item) => item.event.media.uniqueId === event.media.uniqueId);
      if (sameDocument) {
        next.duplicateOf = sameDocument.id;
        next.status = sameDocument.event.media.size === event.media.size ? "duplicate" : "blocked";
        next.error = next.status === "blocked" ? "document_identity_conflict" : null;
      }
      inbox.candidates[event.messageKey] = next; counts.detected++; continue;
    }
    const next = newCandidate(event, candidate.firstSeen);
    next.revision = candidate.revision + 1; next.lastSeen = now; next.audit = [...candidate.audit, { at: now, actor: "discovery", action: "message_changed_approval_invalidated", revision: next.revision }].slice(-500);
    if (candidate.publication || candidate.status === "rejected") {
      next.status = "blocked"; next.error = candidate.publication ? "published_message_changed" : "rejected_message_changed"; next.publication = candidate.publication;
    }
    const repost = Object.values(inbox.candidates).find((item) => item.id !== candidate.id && item.event.media.uniqueId === event.media.uniqueId);
    if (repost && !candidate.publication && candidate.status !== "rejected") {
      next.duplicateOf = repost.id; next.status = "duplicate";
    }
    inbox.candidates[event.messageKey] = next;
  }
  if (Object.keys(inbox.events).length > 10000 || Object.keys(inbox.deliveries).length > 20000) throw new Error("inbox_capacity_operator_required");
  return counts;
}
