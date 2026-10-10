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
import type { Reviewer } from "@/lib/discovery/model";

const commands = ["correct", "rights", "approve", "reject", "retry", "prepare", "refresh"] as const;
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
    if (kind === "refresh") throw new Error("fixture_has_no_public_pages");
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

const correction = z.object({ tmdbId: z.coerce.number().int().positive().max(2147483647), year: z.coerce.number().int().min(1870).max(2199), vjId: z.coerce.number().int().positive() });

/**
 * Every decision is made by the database; this only forwards the reviewer's own
 * choice and maps refusals. Approval and publication are not available here:
 * they are owner commands run through psql (lib/discovery/owner-commands.ts).
 */
async function databaseAction(_actor: Reviewer, id: string, revision: number, kind: Command, data: FormData): Promise<string> {
  const client = await databaseReviewClient();
  try {
    if (kind === "correct") {
      await client.correct(id, revision, correction.parse({ tmdbId: data.get("tmdbId"), year: data.get("year"), vjId: data.get("vjId") }));
    } else if (kind === "rights") {
      await client.clearRights(id, revision, z.string().trim().min(1).max(200).parse(data.get("reference")));
    } else if (kind === "reject") {
      await client.reject(id, revision);
    } else if (kind === "retry") {
      await client.retry(id, revision);
    } else if (kind === "refresh") {
      // After the owner command published it: refresh the cached public pages that list or show it
      // (the existing revalidation; Home and VJs otherwise refresh within five minutes).
      const detail = await client.get(id);
      const publication = detail?.candidate.publication;
      if (!publication) return "blocked";
      for (const path of ["/", "/movies", "/vjs", "/search", `/movies/${publication.movieSlug}`, ...(detail.vjSlug ? [`/vjs/${detail.vjSlug}`] : [])]) revalidatePath(path);
      return "refreshed";
    } else {
      return "blocked";
    }
    return "saved";
  } catch (failure) {
    const code = failure instanceof DiscoveryStoreError ? failure.code : "invalid_input";
    console.warn(JSON.stringify({ event: "review_action_refused", command: kind, code }));
    if (code === "review_not_authorized") return "unauthorized";
    if (code === "review_stale_revision" || code === "catalogue_stale_review") return "stale";
    return "blocked";
  }
}
