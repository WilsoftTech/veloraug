import { duplicateIsNoop, duplicateNeedsReview } from "@/lib/ingestion/duplicates";
import type { ApprovalEvidence, IngestionEvent, IngestionState, TransitionResult } from "@/types/ingestion";

/**
 * Ingestion lifecycle. Two independent tracks:
 *
 *   review: discovered -> parsed -> matched -> approved -> published
 *                               \-> review_pending -> matched (reviewer)
 *           any non-final stage -> rejected (permanent)
 *   upload: not_uploaded -> uploading -> uploaded
 *                                     \-> upload_failed -> uploading (retry)
 *
 * Invariants:
 * - An upload never moves the review track: an uploaded file can stay
 *   unmatched, in review or rejected indefinitely.
 * - `published` requires `approved` AND `uploaded`.
 * - `approved` is reachable only from `matched`; `review_pending` must first be
 *   resolved with complete evidence. Automatic approval also requires the
 *   match to have been reached automatically (`matchedBy: "auto"`).
 * - Retryable failures are a flag on the record; permanent ones are
 *   `rejected`. A retry never repeats an interrupted upload blindly: an
 *   `uploading` record must be confirmed or abandoned first.
 *
 * Storage mapping (docs/PHASE_C_INGESTION_DESIGN.md): the local journal holds
 * the pre-upload stages; private.ingestion_events.status, telegram_media and
 * metadata_match_candidates hold the rest.
 */

export const MAX_UPLOAD_ATTEMPTS = 5;

export function initialState(): IngestionState {
  return { review: "discovered", upload: "not_uploaded", matchedBy: null, reasons: [], failure: null, uploadAttempts: 0, telegram: null };
}

/**
 * Everything that stops approval. Automatic approval also needs a high-confidence
 * match; a reviewer may confirm a medium one (unique exact title, year missing
 * or off by one) but never an ambiguous or missing one.
 */
export function approvalBlockers(evidence: ApprovalEvidence, by: "auto" | "reviewer"): string[] {
  const blockers: string[] = [];
  const { kind, vj, match } = evidence;
  if (kind.status === "conflict") blockers.push("kind_conflict");
  if (kind.status === "inferred") blockers.push("kind_not_declared");
  if (vj.status !== "resolved") blockers.push(`vj_${vj.status}`);
  if (match.outcome !== "matched") blockers.push(`match_${match.outcome}`);
  else if (by === "auto" && match.confidence !== "high") blockers.push("match_needs_confirmation");
  if (kind.status !== "conflict" && kind.kind === "series") {
    if (evidence.season === null) blockers.push("missing_season");
    if (evidence.episode === null) blockers.push("missing_episode");
  }
  if (duplicateNeedsReview(evidence.duplicate)) blockers.push(`duplicate_${evidence.duplicate.type}`);
  if (duplicateIsNoop(evidence.duplicate)) blockers.push("already_ingested");
  return blockers;
}

const fail = (error: string): TransitionResult => ({ ok: false, error });
const ok = (state: IngestionState): TransitionResult => ({ ok: true, state });
const isFinal = (state: IngestionState) => state.review === "rejected" || state.review === "published";

export function transition(state: IngestionState, event: IngestionEvent): TransitionResult {
  switch (event.type) {
    case "parsed":
      if (state.review !== "discovered") return fail(`cannot parse from ${state.review}`);
      return ok({ ...state, review: "parsed" });

    case "evaluated": {
      if (state.review !== "parsed") return fail(`cannot evaluate from ${state.review}`);
      // A failed search is retryable, not a review case and not a rejection.
      if (event.evidence.match.outcome === "error") {
        return ok({ ...state, failure: { code: event.evidence.match.code, retryable: true } });
      }
      const blockers = approvalBlockers(event.evidence, "auto");
      return blockers.length === 0
        ? ok({ ...state, review: "matched", matchedBy: "auto", reasons: [], failure: null })
        : ok({ ...state, review: "review_pending", reasons: blockers, failure: null });
    }

    case "review_resolved": {
      if (state.review !== "review_pending") return fail(`nothing to resolve in ${state.review}`);
      const blockers = approvalBlockers(event.evidence, "reviewer");
      if (blockers.length > 0) return fail(`evidence still incomplete: ${blockers.join(", ")}`);
      return ok({ ...state, review: "matched", matchedBy: "reviewer", reasons: [] });
    }

    case "approve":
      if (state.review !== "matched") return fail(`cannot approve from ${state.review}`);
      if (event.by === "auto" && state.matchedBy !== "auto") return fail("a reviewer-resolved match needs reviewer approval");
      return ok({ ...state, review: "approved" });

    case "reject":
      if (isFinal(state)) return fail(`cannot reject from ${state.review}`);
      return ok({ ...state, review: "rejected", reasons: [event.reason] });

    case "processing_failed":
      if (isFinal(state)) return fail(`cannot fail from ${state.review}`);
      return event.failure.retryable
        ? ok({ ...state, failure: event.failure })
        : ok({ ...state, review: "rejected", reasons: [event.failure.code], failure: null });

    case "retry":
      if (!state.failure?.retryable) return fail("nothing to retry");
      if (state.upload === "upload_failed") return fail("retry an upload with upload_started");
      return ok({ ...state, failure: null });

    case "upload_started":
      if (state.review === "rejected") return fail("rejected records are not uploaded");
      if (state.upload === "uploading") return fail("an interrupted upload must be confirmed or abandoned first");
      if (state.upload === "uploaded") return fail("already uploaded");
      if (state.uploadAttempts >= MAX_UPLOAD_ATTEMPTS) return fail("upload attempts exhausted");
      return ok({ ...state, upload: "uploading", uploadAttempts: state.uploadAttempts + 1, failure: null });

    case "upload_succeeded":
    case "upload_confirmed":
      if (state.upload !== "uploading") return fail(`no upload in progress (${state.upload})`);
      // The review track is deliberately untouched.
      return ok({ ...state, upload: "uploaded", telegram: { chatId: event.chatId, messageId: event.messageId }, failure: null });

    case "upload_failed":
      if (state.upload !== "uploading") return fail(`no upload in progress (${state.upload})`);
      return event.failure.retryable
        ? ok({ ...state, upload: "upload_failed", failure: event.failure })
        : ok({ ...state, upload: "upload_failed", failure: null, review: isFinal(state) ? state.review : "rejected", reasons: [event.failure.code] });

    case "upload_abandoned":
      if (state.upload !== "uploading") return fail(`no upload in progress (${state.upload})`);
      return ok({ ...state, upload: "not_uploaded" });

    case "publish":
      if (state.review !== "approved") return fail(`cannot publish from ${state.review}`);
      if (state.upload !== "uploaded") return fail("cannot publish without an uploaded file");
      return ok({ ...state, review: "published" });
  }
}
