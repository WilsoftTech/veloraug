"use server";

import { z } from "zod";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireReviewAdmin, offlineReviewRuntime } from "@/lib/discovery/runtime";
import { decideReview, approvedPublicationScript, type ReviewCommand } from "@/lib/discovery/review";
import { inspectNext } from "@/lib/discovery/pipeline";

export async function reviewAction(data: FormData): Promise<void> {
  // The UI and each individual mutation check authorization independently.
  const actor = await requireReviewAdmin();
  const id = z.string().regex(/^[a-f0-9]{64}$/).parse(data.get("id"));
  const revision = z.coerce.number().int().positive().parse(data.get("revision"));
  const kind = z.enum(["correct", "rights", "approve", "reject", "retry", "prepare"]).parse(data.get("command"));
  const { store, fixture, ports } = await offlineReviewRuntime();
  let result = "saved";
  try {
    if (kind === "prepare") {
      const candidate = (await store.read()).candidates[id];
      if (!candidate || candidate.revision !== revision) throw new Error("stale_review");
      const script = approvedPublicationScript(candidate);
      await writeFile(join(process.cwd(), ".velora-ingest", "discovery", `${id}.${revision}.owner-review.sql`), script, { flag: "wx", mode: 0o600, flush: true });
      result = "prepared";
    } else {
      const command: ReviewCommand = kind === "correct" ? { kind, fields: { title: String(data.get("title") ?? ""), year: Number(data.get("year")), tmdbId: Number(data.get("tmdbId")), vjId: Number(data.get("vjId")) } } : kind === "rights" ? { kind, reference: String(data.get("reference") ?? "") } : { kind };
      await decideReview(store, actor, id, revision, command, fixture.vjs, new Date(), fixture.catalogue);
      if (kind === "retry") await inspectNext(store, ports, () => new Date());
    }
  } catch {
    console.warn(JSON.stringify({ event: "offline_review_action_blocked", command: kind }));
    result = "blocked";
  }
  revalidatePath("/admin/discovery");
  redirect(`/admin/discovery/${id}?result=${result}`);
}
