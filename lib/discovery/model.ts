import { z } from "zod";
import { movieSnapshotSchema } from "@/lib/tmdb/ingestion-search";
export type { KnownVj as ReviewVj } from "@/types/ingestion";

export const reviewStates = ["detected", "inspecting", "awaiting_metadata", "awaiting_identity", "awaiting_vj", "awaiting_media", "awaiting_rights", "awaiting_review", "approved", "publishing", "published", "duplicate", "rejected", "failed", "blocked"] as const;
const instant = z.iso.datetime();
const key = z.string().regex(/^[a-f0-9]{64}$/);
export const eventSchema = z.strictObject({
  id: key, messageKey: key, updateId: z.number().int().nonnegative().nullable(),
  channelId: z.number().int().safe(), messageId: z.number().int().positive(),
  kind: z.enum(["channel_post", "edited_channel_post", "reconciliation"]),
  timestamp: z.number().int().positive(), digest: key,
  media: z.strictObject({ uniqueId: z.string().min(1).max(128), size: z.number().int().nonnegative().safe().nullable(), name: z.string().max(1024).nullable(), mime: z.string().max(255).nullable(), caption: z.string().max(4096).nullable() }),
});
export type DiscoveryEvent = z.infer<typeof eventSchema>;
export const evidenceSchema = z.strictObject({
  mediaKey: key, container: z.boolean(), gateway: z.boolean(), browser: z.boolean(),
  accessible: z.boolean(), checkedAt: instant, reference: z.string().min(1).max(200),
});
export type MediaEvidence = z.infer<typeof evidenceSchema>;
const auditSchema = z.strictObject({ at: instant, actor: z.string().min(1).max(128), action: z.string().max(100), revision: z.number().int().positive() });
export const candidateSchema = z.strictObject({
  id: key, revision: z.number().int().positive(), event: eventSchema,
  firstSeen: instant, lastSeen: instant, status: z.enum(reviewStates), attempts: z.number().int().nonnegative(),
  lease: z.strictObject({ token: z.string(), until: z.number().int().nonnegative() }).nullable(),
  retryAt: z.number().int().nonnegative(), error: z.string().max(100).nullable(),
  title: z.string().max(300).nullable(), year: z.number().int().nullable(), vjText: z.string().max(100).nullable(),
  vjId: z.number().int().positive().nullable(), tmdbId: z.number().int().positive().nullable(), movieId: z.number().int().positive().nullable(),
  identity: z.enum(["unknown", "ambiguous", "proposed", "confirmed"]),
  relation: z.enum(["new_movie", "new_vj", "replacement", "unknown"]),
  choices: z.array(movieSnapshotSchema).max(20), snapshot: movieSnapshotSchema.nullable(),
  warnings: z.array(z.string().max(100)).max(50), evidence: evidenceSchema.nullable(),
  rights: z.strictObject({ actor: z.string().max(128), at: instant, reference: z.string().min(1).max(200), revision: z.number().int().positive() }).nullable(),
  approval: z.strictObject({ actor: z.string().max(128), at: instant, revision: z.number().int().positive() }).nullable(),
  // Only supplied by a trusted catalogue lookup, never copied from a caption.
  uploaderSource: z.strictObject({ fingerprint: z.string().regex(/^sf1-[0-9a-f]{64}$/), mediaKey: key, evaluatedTmdbId: z.number().int().positive(), evaluatedVjId: z.number().int().positive() }).nullable(),
  duplicateOf: key.nullable(), publication: z.strictObject({ movieSlug: z.string().max(300), versionId: z.number().int().positive() }).nullable(),
  audit: z.array(auditSchema).max(500),
});
export type ReviewCandidate = z.infer<typeof candidateSchema>;
export const inboxSchema = z.strictObject({
  version: z.literal(1), channelId: z.number().int().safe(),
  checkpoint: z.number().int().nonnegative().nullable(),
  reconciliation: z.strictObject({ cursor: z.string().max(200).nullable(), checkedAt: instant.nullable(), incomplete: z.boolean() }),
  deliveries: z.record(z.string(), z.strictObject({ digest: key, eventId: key.nullable(), firstSeen: instant, lastSeen: instant, count: z.number().int().positive() })),
  events: z.record(key, z.strictObject({ event: eventSchema, firstSeen: instant, lastSeen: instant, count: z.number().int().positive(), status: z.enum(["pending", "processed", "superseded"]) })),
  candidates: z.record(key, candidateSchema),
});
export type Inbox = z.infer<typeof inboxSchema>;
export interface InboxStore {
  read(): Promise<Inbox>;
  transaction<T>(change: (inbox: Inbox) => T): Promise<T>;
}
export interface Reviewer { id: string; admin: boolean }
export function requireAdmin(actor: Reviewer): void {
  if (!actor.admin || !actor.id) throw new Error("admin_required");
}
