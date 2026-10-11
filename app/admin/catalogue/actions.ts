"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DiscoveryStoreError, movieActions } from "@/lib/discovery/database";
import { databaseReviewClient, requireReviewAdmin, reviewMode } from "@/lib/discovery/runtime";

/**
 * Catalogue changes from the admin (migration 20261011081425). The database
 * takes the account from the session and requires the publish capability;
 * this only validates the form, forwards it and maps a refusal to a message.
 */
function refused(command: string, failure: unknown): string {
  const code = failure instanceof DiscoveryStoreError ? failure.code : "invalid_input";
  console.warn(JSON.stringify({ event: "catalogue_action_refused", command, code }));
  if (code === "review_not_authorized") return "unauthorized";
  if (code === "command_unavailable") return "unavailable";
  if (code === "catalogue_vj_exists") return "vj_exists";
  if (code === "catalogue_illegal_transition" || code === "catalogue_not_found") return "transition";
  return "invalid";
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The public pages that list or show a movie. */
function refreshMovie(slug: string) {
  for (const path of ["/", "/movies", "/vjs", "/search", `/movies/${slug}`]) revalidatePath(path);
}

export async function movieAction(data: FormData): Promise<void> {
  await requireReviewAdmin();
  let result = "unavailable";
  if (reviewMode() === "database") {
    const command = String(data.get("command"));
    try {
      const movieId = z.coerce.number().int().positive().parse(data.get("id"));
      const slug = z.string().regex(SLUG).max(300).parse(data.get("slug"));
      const client = await databaseReviewClient();
      if (command === "edit") {
        const overview = z.string().trim().max(10000).parse(data.get("overview") ?? "");
        await client.editMovie(movieId, z.string().trim().min(1).max(300).parse(data.get("title")), overview || null);
        result = "edited";
      } else {
        const action = z.enum(movieActions).parse(command);
        await client.setMovie(movieId, action);
        result = action;
      }
      refreshMovie(slug);
    } catch (failure) {
      result = refused(command, failure);
    }
  }
  revalidatePath("/admin/catalogue");
  redirect(`/admin/catalogue?result=${result}`);
}

export async function addVjAction(data: FormData): Promise<void> {
  await requireReviewAdmin();
  let result = "unavailable";
  if (reviewMode() === "database") {
    try {
      await (await databaseReviewClient()).addVj(z.string().trim().min(1).max(100).parse(data.get("name")));
      result = "vj_added";
      revalidatePath("/vjs");
    } catch (failure) {
      result = refused("add_vj", failure);
    }
  }
  revalidatePath("/admin/catalogue");
  redirect(`/admin/catalogue?result=${result}`);
}
