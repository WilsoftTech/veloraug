import { randomUUID } from "node:crypto";
import { z } from "zod";
import { detectDocument, newCandidate } from "@/lib/discovery/events";
import { inspectCandidate, type CatalogueMatch, type InspectionPorts } from "@/lib/discovery/pipeline";
import { candidateSchema, eventSchema, type ReviewCandidate, type ReviewVj } from "@/lib/discovery/model";
import type { ChannelMediaEvidence } from "@/lib/discovery/media-verification";
import type { DiscoveryPersistence } from "@/lib/discovery/worker";
import { scoreCandidate } from "@/lib/ingestion/match";
import type { KnownVj } from "@/types/ingestion";

/**
 * Database adapters for channel discovery (E3.8A), over the Supabase RPC
 * transport. Two identities, never mixed:
 *
 * - databasePersistence: the discovery worker (service_role, operator machine
 *   only). Records deliveries, inspections and bounded evidence; it has no
 *   review, rights, approval or publication command to call.
 * - createReviewClient: a signed-in reviewer's own session. The database checks
 *   the account's capability on every call (private.catalogue_reviewers).
 *
 * Approval and publication are not reachable from either: they run through
 * psql (lib/discovery/owner-commands.ts). Errors carry fixed database codes only.
 */

export type DiscoveryRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string; code?: string; details?: string | null } | null }>;

export class DiscoveryStoreError extends Error {
  constructor(readonly code: string, readonly detail: string | null = null) {
    super(code);
    this.name = "DiscoveryStoreError";
  }
}

const DB_CODE = /^[a-z][a-z0-9_]{2,80}$/;
const DB_DETAIL = /^[a-z0-9_,:]{1,300}$/;

/** Maps a database refusal to its fixed code; anything else is a transport failure. */
export function storeError(error: { message?: string; code?: string; details?: string | null }): DiscoveryStoreError {
  const message = error.message ?? "";
  const code = DB_CODE.test(message) ? message : error.code === "42501" ? "review_not_authorized" : "store_error";
  return new DiscoveryStoreError(code, typeof error.details === "string" && DB_DETAIL.test(error.details) ? error.details : null);
}

async function call(rpc: DiscoveryRpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let reply: Awaited<ReturnType<DiscoveryRpc>>;
  try {
    reply = await rpc(fn, args);
  } catch {
    throw new DiscoveryStoreError("store_unavailable");
  }
  if (reply.error) throw storeError(reply.error);
  return reply.data;
}

// ---------------------------------------------------------------------------
// Worker persistence
// ---------------------------------------------------------------------------

const cursorRow = z.array(z.object({
  update_offset: z.number().int().nonnegative().nullable(),
  reconciliation_cursor: z.string().nullable(),
  reconciliation_checked_at: z.string().nullable(),
  reconciliation_incomplete: z.boolean(),
})).length(1);
const counts = z.object({ detected: z.number().int(), duplicates: z.number().int(), ignored: z.number().int() });
const claimSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), lease: z.uuid(), attempts: z.number().int(),
  event_id: z.string().regex(/^[a-f0-9]{64}$/), payload_digest: z.string().regex(/^[a-f0-9]{64}$/), observed_at: z.number().int().positive(),
  update_id: z.number().int().nonnegative().nullable(), kind: z.enum(["channel_post", "edited_channel_post"]).nullable(),
  chat_id: z.number().int().safe(), message_id: z.number().int().positive(), file_unique_id: z.string().min(1).max(128),
  size: z.number().int().nonnegative().nullable(), name: z.string().max(1024).nullable(), mime: z.string().max(255).nullable(),
  caption: z.string().max(4096).nullable(), identity: z.string().regex(/^tg1-[a-f0-9]{64}$/).nullable(),
});
const health = z.object({
  candidates: z.number(), pending: z.number(), awaiting_review: z.number(), approved: z.number(), published: z.number(),
  blocked: z.number(), duplicates: z.number(), failed: z.number(), media_blocked: z.number(), rights_blocked: z.number(),
  reconciliation_incomplete: z.boolean(), reconciliation_checked_at: z.string().nullable(),
  // E3.8B (migration 14): lag and liveness. Absent on a database that has only migration 13.
  oldest_pending_at: z.string().nullable().optional(), cursor_initialized: z.boolean().optional(),
  consumer_heartbeat_at: z.string().nullable().optional(), consumer_active: z.boolean().optional(), last_delivery_at: z.string().nullable().optional(),
});

/** Counts and ages only: what a monitor needs, with no channel, message, title or account identifier. */
export interface DiscoveryHealth {
  candidates: number; pending: number; awaitingReview: number; approved: number; published: number; blocked: number; duplicates: number; failed: number;
  mediaBlocked: number; rightsBlocked: number; cursorInitialized: boolean; consumerActive: boolean;
  /** Seconds since the last recorded delivery, the consumer's last lease renewal, the oldest uninspected candidate, the last reconciliation. Null: never. */
  lastDeliveryAgeSeconds: number | null; heartbeatAgeSeconds: number | null; oldestPendingAgeSeconds: number | null; reconciliationAgeSeconds: number | null;
  reconciliationIncomplete: boolean;
}
const CODE_TOKEN = /^[a-z0-9_]{1,100}$/;

/** One Bot API update (or enumerated history entry) as the delivery discovery_receive records. */
export function toDelivery(raw: unknown, channelId: number, reconciliation: boolean) {
  const item = detectDocument(raw, channelId, reconciliation);
  const event = item.event;
  return {
    key: reconciliation ? `r:${event?.id ?? item.digest}` : `u:${item.updateId}`,
    digest: item.digest,
    update_id: reconciliation ? null : item.updateId,
    withdrawn_message_id: item.withdrawnMessageId ?? null,
    event: event ? {
      event_id: event.id, payload_digest: event.digest, kind: event.kind, message_id: event.messageId,
      observed_at: event.timestamp, date: item.date ?? event.timestamp, file_id: item.fileId,
      file_unique_id: event.media.uniqueId, size: event.media.size, name: event.media.name, mime: event.media.mime, caption: event.media.caption,
    } : null,
  };
}

/** The completion payload discovery_complete validates; never a reviewer decision. */
export function completionPayload(result: ReviewCandidate, verification: ChannelMediaEvidence | null, identity: string | null) {
  const evidence = verification && identity && verification.identity === identity ? verification : null;
  if (result.status === "blocked") {
    return { outcome: "blocked", error_code: CODE_TOKEN.test(result.error ?? "") ? result.error : "inspection_blocked", title: null, year: null, vj_text: null, vj_id: null,
      warnings: [], identity_state: "unknown", proposed_tmdb_id: null, candidates: [], evidence };
  }
  const title = result.title && result.title.length <= 300 ? result.title : null;
  const year = result.year !== null && result.year >= 1870 && result.year <= 2199 ? result.year : null;
  const candidates = result.choices.slice(0, 20).map((snapshot) => {
    const scored = title ? scoreCandidate({ kind: "movie", title, year }, toTmdb(snapshot)) : null;
    return { tmdb_id: snapshot.tmdb_id, score: scored?.score ?? 0, reasons: scored ? { tier: scored.tier, ...scored.reasons } : {}, snapshot };
  });
  const proposed = result.identity === "proposed" && result.tmdbId && candidates.some((item) => item.tmdb_id === result.tmdbId) ? result.tmdbId : null;
  return {
    outcome: "review", error_code: null, title, year, vj_text: result.vjText, vj_id: result.vjId,
    warnings: result.warnings.filter((warning) => CODE_TOKEN.test(warning)).slice(0, 50),
    identity_state: proposed ? "proposed" : result.identity === "ambiguous" ? "ambiguous" : "unknown",
    proposed_tmdb_id: proposed, candidates, evidence,
  };
}
const toTmdb = (snapshot: ReviewCandidate["choices"][number]) => ({ tmdbId: snapshot.tmdb_id, mediaType: "movie" as const, title: snapshot.title, originalTitle: snapshot.original_title, year: snapshot.release_date ? Number(snapshot.release_date.slice(0, 4)) : null });

/**
 * The worker's persistence in Supabase. `consumer` identifies this process's
 * single-consumer lease; every checkpoint read renews it, and a batch is
 * recorded only while it is held (a second worker fails with
 * discovery_consumer_busy instead of consuming the same updates).
 */
export function databasePersistence(rpc: DiscoveryRpc, options: { channelId: number; consumer?: string; leaseSeconds?: number; inspectionLeaseSeconds?: number }): DiscoveryPersistence & { consumer: string; release(): Promise<void>; health(now: Date): Promise<DiscoveryHealth> } {
  const consumer = options.consumer ?? randomUUID();
  const leaseSeconds = options.leaseSeconds ?? 120;
  const inspectionLease = options.inspectionLeaseSeconds ?? 120;
  if (!Number.isSafeInteger(options.channelId) || options.channelId >= 0) throw new Error("invalid_movies_channel");
  const cursor = async () => cursorRow.parse(await call(rpc, "discovery_acquire_consumer", { p_token: consumer, p_lease_seconds: leaseSeconds }))[0];
  const record = async (updates: readonly unknown[], reconciliation: { cursor: string | null; incomplete: boolean } | null) => {
    if (updates.length > 100) throw new Error("batch_limit");
    const deliveries = updates.map((raw) => toDelivery(raw, options.channelId, reconciliation !== null));
    return counts.parse(await call(rpc, "discovery_receive", { p_token: consumer, p_chat_id: options.channelId, p_deliveries: deliveries, p_reconciliation: reconciliation }));
  };
  const age = (value: string | null | undefined, now: Date) => (value ? Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 1000)) : null);
  return {
    consumer,
    /** Gives the consumer lease back (graceful shutdown). Another consumer's lease is never touched. */
    async release() { await call(rpc, "discovery_release_consumer", { p_token: consumer }); },
    async health(now) {
      const h = health.parse(await call(rpc, "discovery_health", {}));
      return { candidates: h.candidates, pending: h.pending, awaitingReview: h.awaiting_review, approved: h.approved, published: h.published, blocked: h.blocked,
        duplicates: h.duplicates, failed: h.failed, mediaBlocked: h.media_blocked, rightsBlocked: h.rights_blocked,
        cursorInitialized: h.cursor_initialized ?? false, consumerActive: h.consumer_active ?? false,
        lastDeliveryAgeSeconds: age(h.last_delivery_at, now), heartbeatAgeSeconds: age(h.consumer_heartbeat_at, now),
        oldestPendingAgeSeconds: age(h.oldest_pending_at, now), reconciliationAgeSeconds: age(h.reconciliation_checked_at, now),
        reconciliationIncomplete: h.reconciliation_incomplete };
    },
    async checkpoint() { return (await cursor()).update_offset; },
    async receive(updates) { return record(updates, null); },
    async reconciliation() {
      const row = await cursor();
      return { cursor: row.reconciliation_cursor, checkedAt: row.reconciliation_checked_at ? new Date(row.reconciliation_checked_at).toISOString() : null, incomplete: row.reconciliation_incomplete };
    },
    async receiveHistory(updates, position) { await record(updates, position); },
    async inspectNext(ports, now) {
      const claim = claimSchema.nullable().parse(await call(rpc, "discovery_claim", { p_lease_seconds: inspectionLease }));
      if (!claim) return false;
      const event = eventSchema.parse({ id: claim.event_id, messageKey: claim.key, updateId: claim.update_id, channelId: claim.chat_id, messageId: claim.message_id,
        kind: claim.kind ?? "reconciliation", timestamp: claim.observed_at, digest: claim.payload_digest,
        media: { uniqueId: claim.file_unique_id, size: claim.size, name: claim.name, mime: claim.mime, caption: claim.caption } });
      const candidate = { ...newCandidate(event, now().toISOString()), revision: claim.revision, attempts: claim.attempts };
      let verification: ChannelMediaEvidence | null = null;
      // Duplicates and provenance are decided by the database, never by a port.
      const scoped: InspectionPorts = { ...ports, async media(item) {
        const media = await ports.media(item);
        verification = media.verification ?? null;
        return { duplicateOf: null, source: null, evidence: media.evidence };
      } };
      let result: ReviewCandidate;
      try {
        result = await inspectCandidate(candidate, scoped);
      } catch {
        // Never persist provider exception text (tokens/URLs can appear there).
        await call(rpc, "discovery_fail", { p_key: claim.key, p_lease: claim.lease, p_revision: claim.revision, p_code: "inspection_provider_failed" });
        return true;
      }
      await call(rpc, "discovery_complete", { p_key: claim.key, p_lease: claim.lease, p_revision: claim.revision, p_result: completionPayload(result, verification, claim.identity) });
      return true;
    },
    async summary(now) {
      const h = health.parse(await call(rpc, "discovery_health", {}));
      return { candidates: h.candidates, awaitingReview: h.awaiting_review, metadataFailures: h.failed, mediaBlocked: h.media_blocked, rightsBlocked: h.rights_blocked,
        approved: h.approved, published: h.published, reconciliationIncomplete: Number(h.reconciliation_incomplete),
        reconciliationLagSeconds: h.reconciliation_checked_at ? Math.max(0, Math.floor((now.getTime() - Date.parse(h.reconciliation_checked_at)) / 1000)) : -1 };
    },
  };
}

/** Restricted catalogue/VJ reads for the inspection ports (catalogue-first matching). */
export function databaseCataloguePorts(rpc: DiscoveryRpc): Pick<InspectionPorts, "catalogue" | "vjs"> {
  const rows = z.array(z.object({ movie_id: z.number().int(), tmdb_id: z.number().int().positive(), title: z.string(), original_title: z.string().nullable(), year: z.number().int().nullable(), vj_ids: z.array(z.number().int()) })).max(20);
  const vjRows = z.array(z.object({ id: z.number().int().positive(), slug: z.string(), name: z.string(), active: z.boolean() })).max(500);
  return {
    async catalogue(query): Promise<CatalogueMatch[]> {
      return rows.parse(await call(rpc, "discovery_catalogue_lookup", { p_title: query.title })).map((row) => ({
        tmdbId: row.tmdb_id, mediaType: "movie" as const, title: row.title, originalTitle: row.original_title, year: row.year, movieId: row.movie_id, vjIds: row.vj_ids }));
    },
    async vjs(): Promise<KnownVj[]> {
      return vjRows.parse(await call(rpc, "discovery_vjs", {})).map((row) => ({ id: row.id, slug: row.slug, name: row.name, isActive: row.active }));
    },
  };
}

// ---------------------------------------------------------------------------
// Reviewer client (the reviewer's own session)
// ---------------------------------------------------------------------------

const stamp = z.string().transform((value) => new Date(value).toISOString());
const evidenceView = z.object({
  identity: z.string(), verified: z.boolean(), method: z.string(), scope: z.literal("bounded"), policy_version: z.number(), media_class: z.string(),
  reasons: z.array(z.string()), container: z.string().nullable(), video_codec: z.string().nullable(), audio_codec: z.string().nullable(),
  accessible: z.boolean(), gateway_compatible: z.boolean(), playback_ready: z.boolean(), bytes_read: z.number(), checked_at: stamp,
});
const viewSchema = z.object({
  key: z.string(), revision: z.number().int().positive(), status: z.string(), error_code: z.string().nullable(), attempts: z.number().int(),
  first_seen: stamp, last_seen: stamp,
  event: z.object({ event_id: z.string(), payload_digest: z.string(), chat_id: z.number(), message_id: z.number(), update_id: z.number().nullable(),
    kind: z.string().nullable(), observed_at: z.number(), file_unique_id: z.string(), size: z.number().nullable(), name: z.string().nullable(),
    mime: z.string().nullable(), caption: z.string().nullable() }),
  identity: z.string().nullable(), identity_state: z.enum(["unknown", "ambiguous", "proposed", "confirmed"]),
  title: z.string().nullable(), year: z.number().nullable(), vj_text: z.string().nullable(), warnings: z.array(z.string()),
  tmdb_id: z.number().nullable(), vj: z.object({ id: z.number(), slug: z.string(), name: z.string(), active: z.boolean() }).nullable(),
  relation: z.enum(["new_movie", "new_vj", "replacement", "unknown"]), movie_id: z.number().nullable(), duplicate_of: z.string().nullable(),
  snapshot: z.unknown().nullable(), evidence: evidenceView.nullable(),
  rights: z.object({ reference: z.string(), cleared_by: z.string(), cleared_at: stamp, revision: z.number() }).nullable(),
  approval: z.object({ revision: z.number(), by: z.string(), at: stamp }).nullable(),
  publication: z.object({ movie_slug: z.string(), version_id: z.number(), published_at: z.string().nullable() }).nullable(),
  blockers: z.array(z.string()),
  choices: z.array(z.unknown()).optional(),
  vjs: z.array(z.object({ id: z.number(), slug: z.string(), name: z.string(), active: z.boolean() })).optional(),
  audit: z.array(z.object({ at: stamp, actor_kind: z.string(), actor: z.string().nullable(), action: z.string(), revision: z.number(), detail: z.string().nullable() })).optional(),
});
type ReviewView = z.infer<typeof viewSchema>;

function reviewStatus(view: ReviewView): ReviewCandidate["status"] {
  const gates = view.blockers;
  switch (view.status) {
    case "received": return "detected";
    case "processing": return "inspecting";
    case "matched": return "approved";
    case "published": return "published";
    case "ignored": return "duplicate";
    case "rejected": return "rejected";
    case "failed": return "failed";
    case "needs_review":
      if (!view.snapshot) return view.identity_state === "ambiguous" ? "awaiting_identity" : "awaiting_metadata";
      if (gates.includes("identity_unconfirmed") || gates.includes("metadata_missing")) return "awaiting_identity";
      if (gates.includes("vj_unresolved")) return "awaiting_vj";
      if (gates.includes("media_verification_required")) return "awaiting_media";
      if (gates.includes("rights_clearance_required")) return "awaiting_rights";
      return "awaiting_review";
    default: return "blocked";
  }
}

/** A database review view as the shared review model the admin UI renders. */
export function toCandidate(input: unknown): ReviewCandidate {
  const view = viewSchema.parse(input);
  const snapshot = view.snapshot ?? null;
  const ev = view.evidence;
  return candidateSchema.parse({
    id: view.key, revision: view.revision,
    event: { id: view.event.event_id, messageKey: view.key, updateId: view.event.update_id, channelId: view.event.chat_id, messageId: view.event.message_id,
      kind: view.event.kind ?? "reconciliation", timestamp: view.event.observed_at, digest: view.event.payload_digest,
      media: { uniqueId: view.event.file_unique_id, size: view.event.size, name: view.event.name, mime: view.event.mime, caption: view.event.caption } },
    firstSeen: view.first_seen, lastSeen: view.last_seen, status: reviewStatus(view), attempts: view.attempts, lease: null, retryAt: 0,
    error: view.error_code, title: view.title, year: view.year, vjText: view.vj_text, vjId: view.vj?.id ?? null, tmdbId: view.tmdb_id, movieId: view.movie_id,
    identity: view.identity_state, relation: view.relation,
    choices: view.choices ?? (snapshot ? [snapshot] : []), snapshot, warnings: view.warnings.slice(0, 50),
    evidence: ev ? { mediaKey: ev.identity.slice(4), container: ev.container === "mp4" && ev.media_class !== "unverified", gateway: ev.gateway_compatible,
      browser: ev.playback_ready, accessible: ev.accessible, checkedAt: ev.checked_at,
      reference: `${ev.method}: ${ev.bytes_read} bytes read (bounded check, not full-file integrity)`.slice(0, 200),
      identity: ev.identity, mediaClass: ev.media_class, reasons: ev.reasons.slice(0, 50), video: ev.video_codec, audio: ev.audio_codec, bytesRead: ev.bytes_read } : null,
    rights: view.rights ? { actor: view.rights.cleared_by, at: view.rights.cleared_at, reference: view.rights.reference, revision: view.rights.revision } : null,
    approval: view.approval ? { actor: view.approval.by, at: view.approval.at, revision: view.approval.revision } : null,
    uploaderSource: null, duplicateOf: view.duplicate_of,
    publication: view.publication ? { movieSlug: view.publication.movie_slug, versionId: view.publication.version_id } : null,
    audit: (view.audit ?? []).slice(-500).map((entry) => ({ at: entry.at, actor: entry.actor ?? (entry.actor_kind === "worker" ? "discovery" : "owner"),
      action: entry.detail ? `${entry.action} (${entry.detail})`.slice(0, 100) : entry.action, revision: entry.revision })),
    gates: view.blockers.slice(0, 50),
  });
}

export interface ReviewDetailView { candidate: ReviewCandidate; vjs: ReviewVj[]; vjSlug: string | null }

export function createReviewClient(rpc: DiscoveryRpc) {
  const views = z.array(z.unknown()).max(200);
  return {
    async list(filter: { status?: string | null; query?: string | null; limit?: number } = {}): Promise<ReviewCandidate[]> {
      return views.parse(await call(rpc, "discovery_review_list", { p_status: filter.status || null, p_query: filter.query?.slice(0, 300) || null, p_limit: filter.limit ?? 100 })).map(toCandidate);
    },
    async get(key: string): Promise<ReviewDetailView | null> {
      const data = await call(rpc, "discovery_review_get", { p_key: key });
      if (data === null) return null;
      const view = viewSchema.parse(data);
      return { candidate: toCandidate(data), vjs: (view.vjs ?? []).map((vj) => ({ id: vj.id, slug: vj.slug, name: vj.name, isActive: vj.active })), vjSlug: view.vj?.slug ?? null };
    },
    async correct(key: string, revision: number, fields: { tmdbId: number; year: number; vjId: number }) {
      return toCandidate(await call(rpc, "discovery_review_correct", { p_key: key, p_revision: revision, p_tmdb_id: fields.tmdbId, p_year: fields.year, p_vj_id: fields.vjId }));
    },
    async clearRights(key: string, revision: number, reference: string) {
      return toCandidate(await call(rpc, "discovery_review_clear_rights", { p_key: key, p_revision: revision, p_reference: reference }));
    },
    /** Withdraws the clearance of an unpublished candidate (rights capability): a new revision, so an approval that relied on it cannot publish. */
    async revokeRights(key: string, revision: number) { return toCandidate(await call(rpc, "discovery_review_revoke_rights", { p_key: key, p_revision: revision })); },
    async reject(key: string, revision: number) { return toCandidate(await call(rpc, "discovery_review_reject", { p_key: key, p_revision: revision })); },
    async retry(key: string, revision: number) { return toCandidate(await call(rpc, "discovery_review_retry", { p_key: key, p_revision: revision })); },
  };
}
export type ReviewClient = ReturnType<typeof createReviewClient>;
