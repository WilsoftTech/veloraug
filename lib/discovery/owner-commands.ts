import type { ReviewCandidate } from "@/lib/discovery/model";

/**
 * Approval and publication of channel candidates (E3.8A) run through the
 * existing owner service, psql, never through the Data API (C2B.2H) and never
 * from the Next.js application (which carries no Postgres client, E1.2).
 *
 * The functions live in the unexposed catalogue_review schema. The operator
 * runs them as the restricted `velora_review_service` login (EXECUTE on these
 * two functions only), or as the owner. Each names the reviewer account that
 * authorizes it; the database checks that account's capability (review for
 * approval, publish for publication) and re-evaluates every gate in the same
 * transaction that writes the catalogue. These builders only prepare the text:
 * every value is strictly validated, so nothing from a caption, filename or
 * request can reach the SQL.
 */

const KEY = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function checked(key: string, revision: number, reviewer: string) {
  if (!KEY.test(key) || !Number.isSafeInteger(revision) || revision < 1 || !UUID.test(reviewer)) throw new Error("owner_command_input_invalid");
}

export function approvalCommand(key: string, revision: number, reviewer: string): string {
  checked(key, revision, reviewer);
  return `-- Velora UG: approve channel candidate ${key} at revision ${revision} (reviewer ${reviewer}).\n`
    + `-- Run as velora_review_service (or the owner) through psql. The database re-checks the reviewer's capability and every gate.\n`
    + `select catalogue_review.approve_channel_candidate('${key}', ${revision}, '${reviewer}');\n`;
}

export function publicationCommand(key: string, revision: number, reviewer: string): string {
  checked(key, revision, reviewer);
  return `-- Velora UG: publish channel candidate ${key} approved at revision ${revision} (reviewer ${reviewer}).\n`
    + `-- Run as velora_review_service (or the owner) through psql. One transaction: movie, VJ version and Telegram media together.\n`
    + `-- If the result is lost (connection dropped), check the candidate's state first; a re-run at the same revision returns already_published.\n`
    + `select catalogue_review.publish_channel_candidate('${key}', ${revision}, '${reviewer}');\n`;
}

export type PublicationState = "published" | "approved_not_published" | "not_approved";

/**
 * Reconciliation after an uncertain publication: the database state decides.
 * `published` at the approved revision means the transaction committed; then a
 * re-run is unnecessary. `approved_not_published` means nothing was committed,
 * and the same command may be run again (it is idempotent). Never a guess.
 */
export function publicationState(candidate: Pick<ReviewCandidate, "status" | "publication" | "approval">, revision: number): PublicationState {
  if (candidate.publication && candidate.approval?.revision === revision) return "published";
  if (candidate.status === "approved" && candidate.approval?.revision === revision) return "approved_not_published";
  return "not_approved";
}
