"use server";

import { z } from "zod";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireReviewAdmin, offlineReviewRuntime, reviewMode, databaseReviewClient } from "@/lib/discovery/runtime";
import { decideReview, approvedPublicationScript, type ReviewCommand } from "@/lib/discovery/review";
import { inspectNext } from "@/lib/discovery/pipeline";
import { DiscoveryStoreError } from "@/lib/discovery/database";
import { awaitingNewVj, inspectionExhausted } from "@/lib/discovery/guidance";
import type { Reviewer } from "@/lib/discovery/model";
import { publishedMoviePaths } from "@/lib/utils";

const commands = ["correct", "rights", "submit_rights", "decide_rights", "approve", "publish", "reject", "retry", "prepare", "refresh"] as const;
type Command = (typeof commands)[number];

export async function reviewAction(data: FormData): Promise<void> {
  // The UI and each individual mutation check authorization independently.
  const actor = await requireReviewAdmin();
  const id = z.string().regex(/^[a-f0-9]{64}$/).parse(data.get("id"));
  const revision = z.coerce.number().int().positive().parse(data.get("revision"));
  const kind = z.enum(commands).parse(data.get("command"));
  const result = reviewMode() === "database" ? await databaseAction(actor, id, revision, kind, data) : await fixtureAction(actor, id, revision, kind, data);
  revalidatePath("/admin/discovery");
  redirect(`/admin/discovery/${id}?result=${result}`);
}

async function fixtureAction(actor: Reviewer, id: string, revision: number, kind: Command, data: FormData): Promise<string> {
  const { store, fixture, ports } = await offlineReviewRuntime();
  try {
    if (kind === "refresh" || kind === "publish" || kind === "submit_rights" || kind === "decide_rights") throw new Error("fixture_has_no_database_command");
    if (kind === "prepare") {
      const candidate = (await store.read()).candidates[id];
      if (!candidate || candidate.revision !== revision) throw new Error("stale_review");
      const script = approvedPublicationScript(candidate);
      await writeFile(join(process.cwd(), ".velora-ingest", "discovery", `${id}.${revision}.owner-review.sql`), script, { flag: "wx", mode: 0o600, flush: true });
      return "prepared";
    }
    const command: ReviewCommand = kind === "correct" ? { kind, fields: { title: String(data.get("title") ?? ""), year: Number(data.get("year")), tmdbId: Number(data.get("tmdbId")), vjId: Number(data.get("vjId")) } } : kind === "rights" ? { kind, reference: String(data.get("reference") ?? "") } : { kind };
    await decideReview(store, actor, id, revision, command, fixture.vjs, new Date(), fixture.catalogue);
    if (kind === "retry") await inspectNext(store, ports, () => new Date());
    return "saved";
  } catch {
    console.warn(JSON.stringify({ event: "offline_review_action_blocked", command: kind }));
    return "blocked";
  }
}

const correction = z.object({ tmdbId: z.coerce.number().int().positive().max(2147483647), vjId: z.coerce.number().int().positive() });
const rightsSubmission = z.object({
  // Both optional: an empty field means none.
  reference: z.string().trim().max(200).transform((value) => value || null),
  document: z.string().trim().transform((value) => value.toLowerCase()).pipe(z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)])).transform((value) => value || null),
});
const rightsDecision = z.object({ submission: z.coerce.number().int().positive(), decision: z.enum(["verified", "rejected"]) });

/**
 * Every decision is made by the database; this only forwards the reviewer's own
 * choice and maps refusals. Approval and publication run as the reviewer's
 * session as well: the database takes the account from it, checks the
 * capability and re-evaluates every gate before anything is written.
 */
async function databaseAction(_actor: Reviewer, id: string, revision: number, kind: Command, data: FormData): Promise<string> {
  const client = await databaseReviewClient();
  try {
    if (kind === "correct") {
      const picked = correction.parse({ tmdbId: data.get("tmdbId"), vjId: data.get("vjId") });
      // The reviewer picks a film whose year is shown; the year sent is that film's own, which the database compares again.
      const film = (await client.get(id))?.candidate.choices.find((choice) => choice.tmdb_id === picked.tmdbId);
      const year = Number(film?.release_date?.slice(0, 4));
      if (!Number.isInteger(year)) return "no_year";
      await client.correct(id, revision, { ...picked, year });
      return "confirmed";
    } else if (kind === "rights") {
      // Optional: an empty field records the decision without a reference.
      await client.clearRights(id, revision, z.string().trim().max(200).parse(data.get("reference") ?? "") || null);
      return "rights";
    } else if (kind === "submit_rights") {
      const submitted = rightsSubmission.parse({ reference: data.get("reference"), document: data.get("document") ?? "" });
      await client.submitRights(id, revision, submitted.reference, submitted.document);
      return "rights_submitted";
    } else if (kind === "decide_rights") {
      const decided = rightsDecision.parse({ submission: data.get("submission"), decision: data.get("decision") });
      await client.decideRights(id, revision, decided.submission, decided.decision);
      return decided.decision === "verified" ? "rights_verified" : "rights_rejected";
    } else if (kind === "reject") {
      await client.reject(id, revision);
      return "rejected";
    } else if (kind === "retry") {
      await client.retry(id, revision);
      return "reinspecting";
    } else if (kind === "approve") {
      await client.approve(id, revision);
      return "approved";
    } else if (kind === "publish") {
      const published = await client.publish(id, revision);
      refreshPublicPages(published.movie_slug, published.vj_slug);
      return "published";
    } else if (kind === "refresh") {
      // Refresh the cached public pages that list or show a published movie
      // (Home and VJs otherwise refresh within five minutes).
      const detail = await client.get(id);
      const publication = detail?.candidate.publication;
      if (!publication) return "blocked";
      refreshPublicPages(publication.movieSlug, detail.vjSlug);
      return "refreshed";
    }
    return "blocked";
  } catch (failure) {
    const code = failure instanceof DiscoveryStoreError ? failure.code : "invalid_input";
    console.warn(JSON.stringify({ event: "review_action_refused", command: kind, code }));
    if (code === "review_not_authorized") return kind === "rights" || kind === "decide_rights" ? "no_rights_permission" : "unauthorized";
    if (code === "review_stale_revision" || code === "catalogue_stale_review") return "stale";
    if (code === "review_selection_unavailable") return "selection";
    if (code === "review_gates_not_met") return "gates";
    if (code === "catalogue_not_approved") return "not_approved";
    if (code === "command_unavailable") return "unavailable";
    return "blocked";
  }
}

function refreshPublicPages(movieSlug: string, vjSlug: string | null) {
  for (const path of publishedMoviePaths(movieSlug, vjSlug)) revalidatePath(path);
}

/**
 * Adds a VJ read from an upload (the same audited command as the catalogue page's Add VJ, which needs
 * the publish permission), then sends each waiting upload that names it back to the listener, which
 * attaches the VJ when it reads the post again. Returns to the candidate it was started from, if any.
 */
export async function addDetectedVjAction(data: FormData): Promise<void> {
  await requireReviewAdmin();
  const from = data.get("id");
  const back = typeof from === "string" && /^[a-f0-9]{64}$/.test(from) ? from : null;
  let result = "unavailable";
  if (reviewMode() === "database") {
    try {
      const client = await databaseReviewClient();
      const added = await client.addVj(z.string().trim().min(1).max(100).parse(data.get("name")));
      revalidatePath("/vjs");
      let reread = 0;
      for (const item of awaitingNewVj(await client.list({ limit: 200 }), { ...added, isActive: true })) {
        try {
          await client.retry(item.id, item.revision);
          reread++;
        } catch (failure) {
          // The VJ is added either way; this upload can still be assigned by hand.
          console.warn(JSON.stringify({ event: "review_action_refused", command: "retry_new_vj", code: failure instanceof DiscoveryStoreError ? failure.code : "store_error" }));
        }
      }
      result = reread > 0 ? "vj_assigned" : "vj_added";
    } catch (failure) {
      const code = failure instanceof DiscoveryStoreError ? failure.code : "invalid_input";
      console.warn(JSON.stringify({ event: "review_action_refused", command: "add_vj", code }));
      result = code === "catalogue_vj_exists" ? "vj_exists" : code === "review_not_authorized" ? "unauthorized" : code === "command_unavailable" ? "unavailable" : "invalid";
    }
  }
  revalidatePath("/admin/discovery");
  redirect(back ? `/admin/discovery/${back}?result=${result}` : `/admin/discovery?result=${result}`);
}

/**
 * Sends every candidate whose automatic inspection gave up back for a fresh
 * one, as the signed-in reviewer (the same audited command as the single
 * button). The database checks the permission and each revision.
 */
export async function reinspectAllAction(): Promise<void> {
  await requireReviewAdmin();
  let requested = 0;
  if (reviewMode() === "database") {
    try {
      const client = await databaseReviewClient();
      for (const item of (await client.list({ limit: 200 })).filter(inspectionExhausted)) {
        await client.retry(item.id, item.revision);
        requested++;
      }
    } catch (failure) {
      console.warn(JSON.stringify({ event: "review_action_refused", command: "retry_all", code: failure instanceof DiscoveryStoreError ? failure.code : "store_error", requested }));
    }
  }
  revalidatePath("/admin/discovery");
  redirect(`/admin/discovery?result=${requested > 0 ? "reinspecting" : "blocked"}`);
}
