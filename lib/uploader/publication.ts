import { randomBytes } from "node:crypto";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { movieSnapshotSchema, type MovieSnapshot } from "@/lib/tmdb/ingestion-search";
import type { SourceFingerprint } from "@/types/ingestion";

/**
 * The owner's publication script for one uploaded movie (C2B.2H). The CLI
 * writes it and the operator reviews it, then runs it as the database owner
 * (psql over the pooler). The worker's service-role key cannot approve or
 * publish, so a compromised uploader cannot either.
 *
 * One transaction: approve the recorded unique match, publish with the TMDB
 * snapshot, then read the result back. The database re-checks everything
 * (upload, evaluation, unique match, active VJ, TMDB id, metadata, conflicts),
 * and a rerun is a no-op (`already_approved`, `already_published`).
 */
export interface PublicationScriptInput {
  fingerprint: SourceFingerprint;
  tmdbId: number;
  snapshot: MovieSnapshot;
  /** The operator's explicit rights attestation. Without it the database refuses to publish. */
  rightsCleared: boolean;
}

export function publicationScript({ fingerprint, tmdbId, snapshot, rightsCleared }: PublicationScriptInput): string {
  if (!isFingerprint(fingerprint)) throw new Error("publication script: invalid fingerprint");
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) throw new Error("publication script: invalid TMDB id");
  const metadata = JSON.stringify(movieSnapshotSchema.parse(snapshot));
  if (snapshot.tmdb_id !== tmdbId) throw new Error("publication script: the snapshot is for another TMDB id");
  // A dollar-quote tag that cannot occur in the TMDB text, so the snapshot
  // stays one literal whatever it contains.
  let tag = "";
  while (tag === "" || metadata.includes(tag)) tag = `$velora_${randomBytes(8).toString("hex")}$`;

  const fp = `'${fingerprint}'`;
  return `-- Velora UG C2B.2H: approve and publish one uploaded movie.
-- Source ${fingerprint}, TMDB ${tmdbId} (${JSON.stringify(snapshot.title)}${snapshot.release_date ? `, ${snapshot.release_date}` : ""}).
-- Review, then run as the database owner:
--   psql "<owner connection>" -X -v ON_ERROR_STOP=1 -f <this file>
-- The database refuses anything not uploaded, evaluated, uniquely matched and
-- approvable; a rerun changes nothing.
\\set ON_ERROR_STOP on
begin;
select private.catalogue_approve_movie_match(${fp}, ${tmdbId}) as approval;
select result, movie_id, movie_slug, version_id
from private.catalogue_publish_movie(${fp}, ${tag}${metadata}${tag}::jsonb, ${rightsCleared ? "true" : "false"});
-- Readback (inside the transaction).
select e.status as ingestion_status, e.upload_state, e.upload_attempt_count,
       (select count(*) from private.metadata_match_candidates c where c.ingestion_event_id = e.id) as candidates,
       (select c.tmdb_id from private.metadata_match_candidates c where c.ingestion_event_id = e.id and c.decision = 'approved') as approved_tmdb_id,
       m.slug, m.publication_status, mv.availability_status, mv.rights_status, v.slug as vj_slug, v.is_active as vj_active,
       mv.telegram_media_id = e.telegram_media_id as media_linked
from private.ingestion_events e
join public.movie_versions mv on mv.telegram_media_id = e.telegram_media_id
join public.movies m on m.id = mv.movie_id
join public.vjs v on v.id = mv.vj_id
where e.origin = 'uploader' and e.source_fingerprint = ${fp};
commit;
`;
}
