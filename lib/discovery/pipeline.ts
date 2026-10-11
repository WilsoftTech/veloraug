import { randomUUID } from "node:crypto";
import { parseDocument, mediaKey } from "@/lib/discovery/events";
import { evidenceSchema, type InboxStore, type ReviewCandidate, type DiscoveryEvent, type MediaEvidence } from "@/lib/discovery/model";
import { resolveVj } from "@/lib/ingestion/vj";
import { decideMatch, scoreCandidate } from "@/lib/ingestion/match";
import { SUPPORTED_EXTENSIONS } from "@/lib/ingestion/parser";
import { movieSnapshotSchema, type MovieSnapshot } from "@/lib/tmdb/ingestion-search";
import type { KnownVj, MatchQuery, TmdbCandidate } from "@/types/ingestion";
import type { ChannelMediaEvidence } from "@/lib/discovery/media-verification";

export interface CatalogueMatch extends TmdbCandidate { movieId: number; vjIds: number[] }
export interface InspectionPorts {
  // Server/worker implementations must use restricted catalogue reads, never a browser key for private media.
  catalogue(query: MatchQuery): Promise<CatalogueMatch[]>;
  vjs(): Promise<KnownVj[]>;
  search(query: MatchQuery): Promise<TmdbCandidate[]>;
  snapshot(tmdbId: number): Promise<MovieSnapshot | null>;
  // `verification`: the bounded channel verification the database records (database adapter only).
  media(event: DiscoveryEvent): Promise<{ duplicateOf: string | null; source: ReviewCandidate["uploaderSource"]; evidence: MediaEvidence | null; verification?: ChannelMediaEvidence | null }>;
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

/** The title without articles or a trailing part number: "In The Cold Light" gives "In Cold Light", "Gaslight 1" gives "Gaslight". */
const looseTitle = (title: string): string =>
  title.split(" ").filter((word, index, all) => !/^(?:the|a|an)$/i.test(word) && !(index > 0 && index === all.length - 1 && /^\d{1,2}$/.test(word))).join(" ") || title;

/** One inspection of one candidate (pure apart from the ports). Shared by the JSON and database adapters. */
export async function inspectCandidate(candidate: ReviewCandidate, ports: InspectionPorts): Promise<ReviewCandidate> {
  const parsed = parseDocument(candidate.event);
  const next = { ...candidate, title: parsed.title?.slice(0, 300) ?? null, year: parsed.year, vjText: parsed.vjText?.slice(0, 100) ?? null, warnings: parsed.warnings, error: null };
  if (parsed.kind !== "movie") return { ...next, status: "blocked", error: "series_out_of_scope", warnings: [...next.warnings, "series_out_of_scope"] };
  if (!next.event.media.size || !next.event.media.name || !SUPPORTED_EXTENSIONS.includes(next.event.media.name.split(".").pop()!.toLowerCase())) return { ...next, status: "blocked", error: "unsupported_media_metadata" };
  const media = await ports.media(next.event);
  const known = media.duplicateOf ?? null;
  next.duplicateOf = known;
  next.uploaderSource = media.source?.mediaKey === mediaKey(next.event) ? media.source : null;
  next.evidence = media.evidence ? evidenceSchema.parse(media.evidence) : null;
  if (next.evidence?.mediaKey !== mediaKey(next.event)) next.evidence = null;
  if (known) return { ...next, status: "duplicate" };
  // The reviewer confirms the VJ, so its opening characters are enough to suggest one here.
  const vj = resolveVj(next.vjText, await ports.vjs(), { prefix: true });
  next.vjId = vj.status === "resolved" ? vj.vjId : null;
  if (vj.status === "resolved" && vj.match === "prefix") next.warnings = [...next.warnings, "vj_prefix_match"];
  if (!next.title) return { ...next, status: "awaiting_identity" };
  const query: MatchQuery = { kind: "movie", title: next.title, year: next.year };
  const local = await ports.catalogue(query);
  const localMatch = decideMatch(query, local);
  let found: TmdbCandidate[];
  if (localMatch.outcome === "matched" && localMatch.confidence === "high") found = local;
  else if (localMatch.outcome === "ambiguous" && localMatch.reason === "multiple_exact") found = local;
  else {
    found = await ports.search(query);
    // No exact title: also offer what a looser query finds. Choices only; the decision below still compares the parsed title.
    const loose = looseTitle(query.title);
    if (loose !== query.title && !found.some((item) => scoreCandidate(query, item).reasons.title === "exact")) {
      const more = await ports.search({ ...query, title: loose });
      found = [...found, ...more.filter((item) => !found.some((known) => known.tmdbId === item.tmdbId && known.mediaType === item.mediaType))];
    }
  }
  const matched = decideMatch(query, found);
  const snapshots = await Promise.all(found.slice(0, 20).filter((item) => item.mediaType === "movie").map(async (item) => {
    const raw = await ports.snapshot(item.tmdbId);
    if (!raw) return null;
    const snapshot = movieSnapshotSchema.parse(raw);
    if (snapshot.tmdb_id !== item.tmdbId) throw new Error("snapshot_identity_mismatch");
    return snapshot;
  }));
  next.choices = snapshots.filter((item): item is MovieSnapshot => item !== null);
  // The uploader's caption tag (tmdb:movie:<id>) names the film: offered first and proposed, still never an approval.
  const tagged = parsed.externalId && Number(parsed.externalId) <= 2147483647 ? Number(parsed.externalId) : null;
  if (tagged && !next.choices.some((item) => item.tmdb_id === tagged)) {
    const raw = await ports.snapshot(tagged);
    if (raw && raw.tmdb_id === tagged) next.choices = [movieSnapshotSchema.parse(raw), ...next.choices].slice(0, 20);
  }
  const proposed = tagged && next.choices.some((item) => item.tmdb_id === tagged) ? tagged
    : matched.outcome === "matched" && matched.confidence === "high" ? matched.best.candidate.tmdbId : null;
  if (proposed === null) return { ...next, identity: matched.outcome === "ambiguous" ? "ambiguous" : "unknown", status: "awaiting_identity" };
  next.tmdbId = proposed;
  next.snapshot = next.choices.find((item) => item.tmdb_id === next.tmdbId) ?? null;
  next.identity = "proposed"; // Exact matching is a suggestion, never an administrator's approval.
  const existing = local.find((item) => item.tmdbId === next.tmdbId);
  next.movieId = existing?.movieId ?? null;
  next.relation = existing ? next.vjId && existing.vjIds.includes(next.vjId) ? "replacement" : "new_vj" : "new_movie";
  next.status = waitingState(next);
  return next;
}
