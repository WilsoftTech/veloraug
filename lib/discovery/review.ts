import { z } from "zod";
import { requireAdmin, type Reviewer, type InboxStore, type ReviewCandidate } from "@/lib/discovery/model";
import { blockers, waitingState } from "@/lib/discovery/pipeline";
import { mediaKey } from "@/lib/discovery/events";
import { publicationScript } from "@/lib/uploader/publication";
import type { KnownVj, SourceFingerprint } from "@/types/ingestion";

const correctionSchema = z.strictObject({
  title: z.string().trim().min(1).max(300), year: z.number().int().min(1900).max(2100),
  tmdbId: z.number().int().positive(), vjId: z.number().int().positive(),
});
export type Correction = z.infer<typeof correctionSchema>;
export type ReviewCommand =
  | { kind: "correct"; fields: Correction }
  | { kind: "rights"; reference: string }
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "retry" };
export async function decideReview(store: InboxStore, actor: Reviewer, id: string, revision: number, command: ReviewCommand, vjs: readonly KnownVj[], now: Date, catalogue?: readonly { movieId: number; tmdbId: number; vjIds: number[] }[]): Promise<ReviewCandidate> {
  requireAdmin(actor);
  return store.transaction((inbox) => {
    const candidate = inbox.candidates[id];
    if (!candidate) throw new Error("candidate_not_found");
    if (candidate.revision !== revision) throw new Error("stale_review");
    if (["published", "publishing", "duplicate", "rejected", "blocked", "inspecting"].includes(candidate.status) || candidate.publication) throw new Error("illegal_review_transition");
    if (command.kind === "approve" && candidate.status === "approved") return structuredClone(candidate);
    candidate.approval = null;
    if (command.kind === "correct") {
      const fields = correctionSchema.parse(command.fields);
      const selected = candidate.choices.find((item) => item.tmdb_id === fields.tmdbId);
      if (!selected || !vjs.some((item) => item.id === fields.vjId && item.isActive)) throw new Error("review_selection_unavailable");
      if (Number(selected.release_date?.slice(0, 4)) !== fields.year) throw new Error("review_year_mismatch");
      const relationshipChanged = candidate.tmdbId !== fields.tmdbId || candidate.vjId !== fields.vjId;
      // Title is the reviewer's local label; publication metadata remains the validated selected snapshot.
      candidate.title = fields.title; candidate.year = fields.year; candidate.snapshot = selected; candidate.tmdbId = fields.tmdbId; candidate.vjId = fields.vjId;
      candidate.identity = "confirmed";
      candidate.revision++;
      candidate.rights = null;
      candidate.warnings = candidate.warnings.filter((warning) => !/caption_|missing_vj|multiple_years|vj_boundary_uncertain|multiple_vjs/.test(warning));
      // Existing relationship must be re-evaluated server-side after selecting another identity/VJ.
      if (catalogue) {
        const existing = catalogue.find((item) => item.tmdbId === fields.tmdbId);
        candidate.movieId = existing?.movieId ?? null;
        candidate.relation = existing ? existing.vjIds.includes(fields.vjId) ? "replacement" : "new_vj" : "new_movie";
      } else if (relationshipChanged) candidate.relation = "unknown";
      candidate.status = waitingState(candidate);
    } else if (command.kind === "rights") {
      const reference = z.string().trim().min(1).max(200).regex(/^[\w .:/-]+$/).parse(command.reference);
      if (reference.includes("://")) throw new Error("rights_reference_must_not_be_url");
      candidate.revision++;
      candidate.rights = { actor: actor.id, at: now.toISOString(), reference, revision: candidate.revision };
      candidate.status = waitingState(candidate);
    } else if (command.kind === "approve") {
      const missing = blockers(candidate);
      if (missing.length) throw new Error(missing.join(","));
      if (candidate.status !== "awaiting_review") throw new Error("illegal_approval_transition");
      if (candidate.relation === "unknown") throw new Error("catalogue_relationship_unconfirmed");
      candidate.approval = { actor: actor.id, at: now.toISOString(), revision };
      candidate.status = "approved";
    } else if (command.kind === "reject") {
      candidate.status = "rejected";
    } else {
      if (!["failed", "awaiting_metadata", "awaiting_identity", "awaiting_vj", "awaiting_media"].includes(candidate.status)) throw new Error("illegal_retry_transition");
      candidate.revision++; candidate.rights = null; candidate.status = "detected"; candidate.retryAt = 0; candidate.error = null;
    }
    candidate.audit.push({ at: now.toISOString(), actor: actor.id, action: command.kind, revision: candidate.revision });
    candidate.audit = candidate.audit.slice(-500);
    return structuredClone(candidate);
  });
}

export interface PublicationPort {
  /** Existing owner boundary only, or an explicitly isolated test double. Key is stable across retries. */
  publish(script: string, idempotencyKey: string): Promise<{ movieSlug: string; versionId: number }>;
}
export function approvedPublicationScript(candidate: ReviewCandidate): string {
  if (candidate.status !== "approved" && candidate.status !== "publishing") throw new Error("approval_required");
  if (!candidate.approval || candidate.approval.revision !== candidate.revision) throw new Error("stale_approval");
  const missing = blockers(candidate);
  if (missing.length || !candidate.snapshot || !candidate.tmdbId) throw new Error(missing.join(",") || "metadata_missing");
  const source = candidate.uploaderSource;
  if (!source || source.mediaKey !== mediaKey(candidate.event) || source.evaluatedTmdbId !== candidate.tmdbId || source.evaluatedVjId !== candidate.vjId) throw new Error("channel_publication_extension_required");
  return "-- SYNTHETIC OFFLINE REVIEW ONLY. Do not run against hosted resources.\n" + publicationScript({ fingerprint: source.fingerprint as SourceFingerprint, tmdbId: candidate.tmdbId, snapshot: candidate.snapshot, rightsCleared: true });
}
/** An uncertain publication is retried through the SAME idempotent owner transaction, never a direct insert. */
export async function publishReviewed(store: InboxStore, actor: Reviewer, id: string, revision: number, port: PublicationPort, now: () => Date): Promise<ReviewCandidate> {
  requireAdmin(actor);
  const claim = await store.transaction((inbox) => {
    const candidate = inbox.candidates[id];
    if (!candidate || candidate.revision !== revision) throw new Error("stale_review");
    if (candidate.status === "published") return { candidate: structuredClone(candidate), script: null };
    if (candidate.status === "publishing") throw new Error("publication_in_progress_owner_reconciliation_required");
    const script = approvedPublicationScript(candidate);
    candidate.status = "publishing";
    return { candidate: structuredClone(candidate), script };
  });
  if (!claim.script) return claim.candidate;
  let receipt: { movieSlug: string; versionId: number };
  try { receipt = await port.publish(claim.script, `${id}:${revision}`); }
  catch {
    await store.transaction((inbox) => {
      const current = inbox.candidates[id];
      if (current?.revision !== revision || current.status !== "publishing") return;
      current.error = "publication_uncertain_owner_reconciliation_required";
    });
    throw new Error("publication_uncertain_owner_reconciliation_required");
  }
  return store.transaction((inbox) => {
    const candidate = inbox.candidates[id];
    if (!candidate || candidate.revision !== revision || candidate.status !== "publishing") throw new Error("publication_result_requires_owner_reconciliation");
    candidate.publication = receipt; candidate.status = "published"; candidate.error = null;
    candidate.audit.push({ at: now().toISOString(), actor: actor.id, action: "published", revision });
    return structuredClone(candidate);
  });
}
