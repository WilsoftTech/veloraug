import { randomUUID } from "node:crypto";
import { parseDocument, mediaKey } from "@/lib/discovery/events";
import { evidenceSchema, type InboxStore, type ReviewCandidate, type DiscoveryEvent, type MediaEvidence } from "@/lib/discovery/model";
import { resolveVj } from "@/lib/ingestion/vj";
import { decideMatch } from "@/lib/ingestion/match";
import { movieSnapshotSchema, type MovieSnapshot } from "@/lib/tmdb/ingestion-search";
import type { KnownVj, MatchQuery, TmdbCandidate } from "@/types/ingestion";

export interface CatalogueMatch extends TmdbCandidate { movieId: number; vjIds: number[] }
export interface InspectionPorts {
  // Server/worker implementations must use restricted catalogue reads, never a browser key for private media.
  catalogue(query: MatchQuery): Promise<CatalogueMatch[]>;
  vjs(): Promise<KnownVj[]>;
  search(query: MatchQuery): Promise<TmdbCandidate[]>;
  snapshot(tmdbId: number): Promise<MovieSnapshot | null>;
  media(event: DiscoveryEvent): Promise<{ duplicateOf: string | null; source: ReviewCandidate["uploaderSource"]; evidence: MediaEvidence | null }>;
}
export function blockers(candidate: ReviewCandidate): string[] {
  const blocked: string[] = [];
  if (candidate.identity !== "confirmed" || !candidate.snapshot || !candidate.tmdbId) blocked.push("identity_unconfirmed");
  if (!candidate.vjId) blocked.push("vj_unresolved");
  if (!candidate.event.media.size || !candidate.event.media.uniqueId) blocked.push("media_identity_incomplete");
  const proof = candidate.evidence;
  if (!proof || proof.mediaKey !== mediaKey(candidate.event) || !proof.accessible || !proof.container || !proof.gateway || !proof.browser) blocked.push("media_verification_required");
  if (!candidate.rights || candidate.rights.revision !== candidate.revision) blocked.push("rights_clearance_required");
  if (candidate.relation === "replacement") blocked.push("existing_version_replacement_requires_separate_workflow");
  if (candidate.duplicateOf) blocked.push("duplicate_media");
  if (candidate.warnings.some((warning) => /conflict|multiple_|series|unsupported|uncertain/.test(warning))) blocked.push("unresolved_evidence_conflict");
  if (candidate.status === "rejected" || candidate.status === "blocked" || candidate.publication) blocked.push("candidate_closed");
  return blocked;
}
export function waitingState(candidate: ReviewCandidate): ReviewCandidate["status"] {
  if (candidate.duplicateOf) return "duplicate";
  if (!candidate.snapshot) return candidate.identity === "ambiguous" ? "awaiting_identity" : "awaiting_metadata";
  if (candidate.identity !== "confirmed") return "awaiting_identity";
  if (!candidate.vjId) return "awaiting_vj";
  const missing = blockers(candidate);
  if (missing.includes("media_verification_required")) return "awaiting_media";
  if (missing.includes("rights_clearance_required")) return "awaiting_rights";
  return "awaiting_review";
}

/** Lease fencing makes a slow worker's result unable to overwrite an edit or a new lease. */
export async function inspectNext(store: InboxStore, ports: InspectionPorts, now: () => Date, leaseMs = 30000): Promise<boolean> {
  const claim = await store.transaction((inbox) => {
    const candidate = Object.values(inbox.candidates).find((item) => item.retryAt <= now().getTime() && (item.status === "detected" || item.status === "failed" || (item.status === "inspecting" && (!item.lease || item.lease.until <= now().getTime()))));
    if (!candidate) return null;
    candidate.status = "inspecting"; candidate.attempts++;
    candidate.lease = { token: randomUUID(), until: now().getTime() + leaseMs };
    return structuredClone(candidate);
  });
  if (!claim) return false;
  let result: ReviewCandidate;
  try {
    result = await inspectCandidate(claim, ports);
  } catch {
    // Never persist provider exception text (tokens/URLs can appear there).
    result = { ...claim, status: claim.attempts >= 5 ? "blocked" : "failed", error: "inspection_provider_failed", retryAt: now().getTime() + Math.min(60000, 1000 * 2 ** claim.attempts) };
  }
  await store.transaction((inbox) => {
    const current = inbox.candidates[claim.id];
    if (current?.revision !== claim.revision || current.lease?.token !== claim.lease?.token) return;
    result.lease = null;
    result.audit.push({ at: now().toISOString(), actor: "discovery", action: result.status, revision: result.revision });
    result.audit = result.audit.slice(-500);
    inbox.candidates[claim.id] = result;
    inbox.events[claim.event.id].status = "processed";
  });
  return true;
}

async function inspectCandidate(candidate: ReviewCandidate, ports: InspectionPorts): Promise<ReviewCandidate> {
  const parsed = parseDocument(candidate.event);
  const next = { ...candidate, title: parsed.title?.slice(0, 300) ?? null, year: parsed.year, vjText: parsed.vjText?.slice(0, 100) ?? null, warnings: parsed.warnings, error: null };
  if (parsed.kind !== "movie") return { ...next, status: "blocked", error: "series_out_of_scope", warnings: [...next.warnings, "series_out_of_scope"] };
  if (!next.event.media.size || !next.event.media.name || !/\.(mp4|mkv|webm|mov|avi|m4v)$/i.test(next.event.media.name)) return { ...next, status: "blocked", error: "unsupported_media_metadata" };
  const media = await ports.media(next.event);
  const known = media.duplicateOf ?? null;
  next.duplicateOf = known;
  next.uploaderSource = media.source?.mediaKey === mediaKey(next.event) ? media.source : null;
  next.evidence = media.evidence ? evidenceSchema.parse(media.evidence) : null;
  if (next.evidence?.mediaKey !== mediaKey(next.event)) next.evidence = null;
  if (known) return { ...next, status: "duplicate" };
  const vj = resolveVj(next.vjText, await ports.vjs());
  next.vjId = vj.status === "resolved" ? vj.vjId : null;
  if (!next.title) return { ...next, status: "awaiting_identity" };
  const query: MatchQuery = { kind: "movie", title: next.title, year: next.year };
  const local = await ports.catalogue(query);
  const localMatch = decideMatch(query, local);
  let found: TmdbCandidate[];
  if (localMatch.outcome === "matched" && localMatch.confidence === "high") found = local;
  else if (localMatch.outcome === "ambiguous" && localMatch.reason === "multiple_exact") found = local;
  else found = await ports.search(query);
  const matched = decideMatch(query, found);
  const snapshots = await Promise.all(found.slice(0, 20).filter((item) => item.mediaType === "movie").map(async (item) => {
    const raw = await ports.snapshot(item.tmdbId);
    if (!raw) return null;
    const snapshot = movieSnapshotSchema.parse(raw);
    if (snapshot.tmdb_id !== item.tmdbId) throw new Error("snapshot_identity_mismatch");
    return snapshot;
  }));
  next.choices = snapshots.filter((item): item is MovieSnapshot => item !== null);
  if (matched.outcome !== "matched" || matched.confidence !== "high") return { ...next, identity: matched.outcome === "ambiguous" ? "ambiguous" : "unknown", status: "awaiting_identity" };
  next.tmdbId = matched.best.candidate.tmdbId;
  next.snapshot = next.choices.find((item) => item.tmdb_id === next.tmdbId) ?? null;
  next.identity = "proposed"; // Exact matching is a suggestion, never an administrator's approval.
  const existing = local.find((item) => item.tmdbId === next.tmdbId);
  next.movieId = existing?.movieId ?? null;
  next.relation = existing ? next.vjId && existing.vjIds.includes(next.vjId) ? "replacement" : "new_vj" : "new_movie";
  next.status = waitingState(next);
  return next;
}
