import "server-only";
import type { CurrentUser } from "@/lib/auth";
import { isMovieVersionPlayable } from "@/lib/catalogue";

/**
 * The one server-side decision on whether a caller may stream a movie version
 * (E2). Route handlers and any future client API ask this, never their own
 * checks. The caller comes from the verified session, never from a payload.
 *
 * Order matters, so the answer cannot be used to probe the catalogue: the id's
 * shape, then the caller, then entitlement. Only an entitled caller learns
 * whether a version is playable, and even then every unplayable case (unknown,
 * unpublished, not ready, rights not cleared, inactive VJ) is one "unavailable".
 */

export type StreamDenial = "invalid_version" | "authentication_required" | "not_entitled" | "unavailable";

export type StreamDecision = { allowed: true; movieVersionId: number; subject: string } | { allowed: false; reason: StreamDenial };

export interface EntitlementDeps {
  hasStreamingEntitlement(user: CurrentUser): Promise<boolean>;
  isMovieVersionPlayable(movieVersionId: number): Promise<boolean>;
}

/**
 * Current access policy: every signed-in user may stream published movies.
 * This is the interim rule until Phase F, approved by the product owner on
 * 2026-09-30 (IMPLEMENTATION_ROADMAP.md, "E2"). Signed-out callers never reach
 * it. Phase F replaces this body with the subscription check (an active,
 * started, unexpired, non-revoked subscription: docs/VELORA_UG_MIGRATION_PLAN.md
 * section 13). Callers do not change.
 */
export async function hasStreamingEntitlement(user: CurrentUser): Promise<boolean> {
  return user.id.length > 0;
}

const defaultDeps: EntitlementDeps = { hasStreamingEntitlement, isMovieVersionPlayable };

/** Throws only when the catalogue cannot be read; the caller answers "temporarily unavailable". */
export async function canStreamMovieVersion(user: CurrentUser | null, movieVersionId: unknown, deps: EntitlementDeps = defaultDeps): Promise<StreamDecision> {
  if (typeof movieVersionId !== "number" || !Number.isSafeInteger(movieVersionId) || movieVersionId <= 0) {
    return { allowed: false, reason: "invalid_version" };
  }
  if (!user) return { allowed: false, reason: "authentication_required" };
  if (!(await deps.hasStreamingEntitlement(user))) return { allowed: false, reason: "not_entitled" };
  if (!(await deps.isMovieVersionPlayable(movieVersionId))) return { allowed: false, reason: "unavailable" };
  return { allowed: true, movieVersionId, subject: user.id };
}
