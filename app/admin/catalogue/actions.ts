"use server";

import { z } from "zod";
import { manualMovieMetadataSchema, type MetadataFormState } from "@/lib/movie-metadata";
import { storePoster } from "@/lib/artwork-storage";
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


/** Every upload and metadata write runs as the fresh admin/reviewer's own session. */
export async function saveMovieMetadata(_previous: MetadataFormState, data: FormData): Promise<MetadataFormState> {
  await requireReviewAdmin();
  if (reviewMode() !== "database") return {error:"Manual movie metadata is available in database review mode."};
  try {
    const client = await databaseReviewClient(); const capabilities = await client.capabilities();
    const target = z.enum(["review","catalogue"]).parse(data.get("target"));
    if (target === "review" ? !capabilities?.review : !capabilities?.publish) return {error:"Your account does not have permission to change these movie details."};
    const rawId = z.string().parse(data.get("id"));
    const key = target === "review" ? z.string().regex(/^[a-f0-9]{64}$/).parse(rawId) : null;
    const movieId = target === "catalogue" ? z.coerce.number().int().positive().parse(rawId) : null;
    const revision = key ? z.coerce.number().int().positive().parse(data.get("revision")) : null;
    const current = key ? await client.get(key) : null;
    const record = movieId ? await client.movieMetadata(movieId) : null;
    if (key && (!current || current.candidate.revision !== revision)) return {error:"This review changed. Refresh the page before saving."};
    const updatedAt = movieId ? z.iso.datetime({offset:true}).parse(data.get("updatedAt")) : null;
    if (movieId && (!record || record.updated_at !== updatedAt)) return {error:"This movie changed. Refresh the page before saving."};
    const existingMovieId = key && data.get("existingMovieId") ? z.coerce.number().int().positive().parse(data.get("existingMovieId")) : null;
    const vjId = key ? z.coerce.number().int().positive().parse(data.get("vjId")) : null;
    if (key && existingMovieId) {
      await client.saveManualReview(key,revision!,vjId!,null,existingMovieId);
    } else {
      const previous = record?.metadata ?? current?.candidate.manualMetadata ?? current?.candidate.snapshot;
      const nullable = (field:string) => z.string().trim().parse(data.get(field) ?? "") || null;
      let metadata = manualMovieMetadataSchema.parse({title:data.get("title"),original_title:nullable("originalTitle"),overview:nullable("overview"),release_date:data.get("releaseDate"),runtime_minutes:data.get("runtime") ? Number(data.get("runtime")) : null,
        genres:z.string().parse(data.get("genres") ?? "").split(",").map(value=>value.trim()).filter(Boolean),poster_path:previous?.poster_path ?? null,backdrop_path:previous?.backdrop_path ?? null});
      const file = data.get("poster");
      if (file instanceof File && file.size > 0) metadata = {...metadata,poster_path:await storePoster(file)};
      // On an uncertain DB response, retain the newly uploaded immutable object: it may already be referenced.
      if (key) await client.saveManualReview(key,revision!,vjId!,metadata,null);
      else await client.saveMovieMetadata(movieId!,updatedAt!,metadata);
    }
    revalidatePath("/admin/discovery"); revalidatePath("/admin/catalogue");
    for (const path of ["/","/movies","/vjs","/search"]) revalidatePath(path);
    if (key) revalidatePath("/admin/discovery/"+key);
    if (record) revalidatePath("/movies/"+record.slug);
    return {notice:target === "review" ? "Manual movie details saved. Refresh the review to continue with rights and approval." : "Movie details and poster saved. Refresh this page before making another change."};
  } catch (error) {
    const code = error instanceof DiscoveryStoreError ? error.code : error instanceof Error && /^poster_[a-z_]+$/.test(error.message) ? error.message : "invalid_input";
    console.warn(JSON.stringify({event:"movie_metadata_save_refused",code}));
    if (code === "review_stale_revision") return {error:"This review or movie changed. Refresh before saving again."};
    if (code === "command_unavailable") return {error:"Manual metadata is waiting for the database update."};
    if (code === "poster_storage_not_configured" || code === "r2_configuration_invalid") return {error:"The dedicated poster storage is not configured."};
    if (code === "poster_upload_failed") return {error:"The poster could not be uploaded. No movie details were changed. Please try again."};
    if (code === "poster_image_invalid" || code === "poster_file_too_large") return {error:"Choose a readable JPEG, PNG or WebP poster up to 5 MB and at least 120 pixels wide and tall."};
    if (code === "manual_metadata_use_catalogue") return {error:"Edit this published movie's details from the Catalogue, or select it from the existing movies list."};
    return {error:"Could not save movie details. Check the fields and refresh the page to see its current state."};
  }
}
