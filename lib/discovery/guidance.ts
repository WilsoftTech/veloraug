import type { ReviewCandidate } from "@/lib/discovery/model";

/**
 * What the admin shows a person about one candidate: which queue group it
 * belongs to, a short label and the next step in plain words. Presentation
 * only. The database decides every gate and every transition; nothing here
 * grants, approves or publishes.
 */
export type ReviewGroup = "action" | "progress" | "published" | "closed";
export interface ReviewGuidance { group: ReviewGroup; label: string; next: string }

export const REVIEW_GROUPS: readonly { id: ReviewGroup; label: string }[] = [
  { id: "action", label: "Needs you" },
  { id: "progress", label: "In progress" },
  { id: "published", label: "Published" },
  { id: "closed", label: "Closed" },
];

const WORKING = ["detected", "inspecting"];
const CLOSED = ["published", "publishing", "duplicate", "rejected", "blocked", "inspecting"];
const BLOCKED: Record<string, string> = {
  inspection_attempts_exhausted: "Automatic inspection failed five times. Reinspect to run it again.",
  series_out_of_scope: "The filename looks like a series episode. Series are not handled here yet.",
  unsupported_media_metadata: "The post has no readable file name, size or supported video extension.",
  edited_media_unavailable: "The post was edited and no longer carries the movie file.",
  rejected_message_changed: "This candidate was rejected and its post changed afterwards.",
  published_message_changed: "This movie is published and its post changed afterwards.",
  document_identity_conflict: "The same file appears in another post with a different size.",
};

/** A blocked candidate may be inspected again only when inspection itself gave up (the database rule). */
export const inspectionExhausted = (candidate: ReviewCandidate): boolean =>
  candidate.status === "blocked" && candidate.error === "inspection_attempts_exhausted";

/** Reviewer decisions (film, VJ, rights, reject) are open: the candidate is neither finished nor being inspected. */
export const reviewOpen = (candidate: ReviewCandidate): boolean => !CLOSED.includes(candidate.status);

/** `database`: review against Supabase. The offline fixture cannot reinspect a blocked candidate. */
export const canReinspect = (candidate: ReviewCandidate, database: boolean): boolean =>
  reviewOpen(candidate) || (database && inspectionExhausted(candidate));

export function guidance(candidate: ReviewCandidate): ReviewGuidance {
  const status = candidate.status;
  if (WORKING.includes(status)) return { group: "progress", label: "Being inspected", next: "The listener is reading the file name and looking the film up. Refresh in a few seconds." };
  if (status === "failed") return { group: "progress", label: "Inspection retrying", next: `Attempt ${candidate.attempts} of 5 failed. It retries by itself; you can also reinspect now.` };
  if (status === "blocked") {
    return { group: inspectionExhausted(candidate) ? "action" : "closed", label: inspectionExhausted(candidate) ? "Inspection failed" : "Blocked",
      next: BLOCKED[candidate.error ?? ""] ?? "This candidate cannot continue. See the warnings below." };
  }
  if (status === "awaiting_metadata" || status === "awaiting_identity") return { group: "action", label: "Choose the film", next: "Pick the correct film and the VJ, then confirm." };
  if (status === "awaiting_vj") return { group: "action", label: "Choose the VJ", next: "The film is confirmed. Pick the VJ, then confirm." };
  if (status === "awaiting_media") return { group: "progress", label: "Waiting for media check", next: "Film and VJ are confirmed. The file still has to pass the automatic media check before it can be published." };
  if (status === "awaiting_rights") return { group: "action", label: "Rights needed", next: "Record the contract or licence reference that allows this movie to be streamed." };
  if (status === "awaiting_review") return { group: "action", label: "Ready to approve", next: "Every check passes. Approve it; publishing is the step after." };
  if (status === "approved") return { group: "action", label: "Approved", next: "Approved at this revision. Publish it to put it on the site." };
  if (status === "publishing") return { group: "progress", label: "Publishing", next: "Publication is running. Refresh to see the result." };
  if (status === "published") return { group: "published", label: "Published", next: "Live on the site." };
  if (status === "duplicate") return { group: "closed", label: "Duplicate", next: "The same file was already detected in another post." };
  return { group: "closed", label: "Rejected", next: "Rejected by a reviewer. Nothing will be published from this post." };
}

const NOTICES: Record<string, string> = {
  saved: "Saved.",
  confirmed: "Film and VJ confirmed.",
  rights: "Rights clearance recorded for this revision.",
  rejected: "Candidate rejected. Nothing will be published from this post.",
  reinspecting: "Reinspection requested. The listener picks it up within a few seconds; refresh to see the result.",
  prepared: "Owner script prepared in the local ignored discovery folder. Nothing was published.",
  refreshed: "Public catalogue pages were refreshed.",
  approved: "Approved. It can now be published.",
  published: "Published. It is live on the site.",
  withdraw: "Movie withdrawn. It is no longer on the site and cannot be played.",
  restore: "Movie restored. It is live on the site again.",
  feature: "Movie featured on the home page.",
  unfeature: "Movie no longer featured.",
  edited: "Title and description saved.",
  vj_added: "VJ added. New posts can now be matched to it.",
};
const ERRORS: Record<string, string> = {
  blocked: "That action is not available for this candidate right now. Check its status and the latest revision.",
  stale: "This candidate changed since you opened it. Review the latest revision and try again.",
  unauthorized: "Your account does not have permission for this action.",
  no_rights_permission: "Your account can review but cannot record rights clearance. That needs the separate rights permission.",
  selection: "That film or VJ is no longer available for this candidate. Reinspect it and choose again.",
  no_year: "That film has no release year on TMDB, so it cannot be confirmed. Choose another entry.",
  gates: "Not every check has passed yet, so the database refused. See the publication gates on this page.",
  not_approved: "This revision is not approved yet. Approve it first.",
  unavailable: "This control is not switched on yet: the database is waiting for an update.",
  vj_exists: "A VJ with that name already exists.",
  transition: "That change does not apply to this movie in its current state.",
  invalid: "That value is not accepted. Check it and try again.",
};
/** The message for an action's `?result=` code: a confirmation or an error, never both. Unknown codes show nothing. */
export const resultMessage = (code: string | undefined): { notice?: string; error?: string } =>
  code === undefined ? {} : NOTICES[code] ? { notice: NOTICES[code] } : ERRORS[code] ? { error: ERRORS[code] } : {};

/** The four reviewer steps a channel candidate passes before approval, from the gates the database reports. */
export function steps(gates: readonly string[]): { label: string; done: boolean; blockers: string[] }[] {
  const of = (...names: string[]) => gates.filter((gate) => names.includes(gate));
  return [
    { label: "Film identified", blockers: of("identity_unconfirmed", "metadata_missing") },
    { label: "VJ chosen", blockers: of("vj_unresolved") },
    { label: "Media check passed", blockers: of("media_verification_required", "media_identity_incomplete") },
    { label: "Rights cleared", blockers: of("rights_clearance_required") },
  ].map((step) => ({ ...step, done: step.blockers.length === 0 }));
}
const STEP_GATES = ["identity_unconfirmed", "metadata_missing", "vj_unresolved", "media_verification_required", "media_identity_incomplete", "rights_clearance_required"];
/** Gates outside the four steps (closed candidate, duplicates, conflicts, replacements). */
export const otherGates = (gates: readonly string[]): string[] => gates.filter((gate) => !STEP_GATES.includes(gate));
