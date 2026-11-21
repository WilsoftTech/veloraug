"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { storePoster } from "@/lib/artwork-storage";
import { DiscoveryStoreError } from "@/lib/discovery/database";
import { databaseReviewClient, requireReviewAdmin, reviewMode } from "@/lib/discovery/runtime";
import { manualSeriesMetadataSchema } from "@/lib/series-review";
import type { MetadataFormState } from "@/lib/movie-metadata";

/**
 * Series review queue commands (migration 20261120191536). The database takes the account from the
 * session and checks its capability on every command; these only validate the form and map refusals.
 */
const RESULTS: Record<string, string> = {
  review_not_authorized: "unauthorized",
  review_stale_revision: "stale",
  catalogue_version_conflict: "conflict",
  catalogue_media_not_verified: "not_verified",
  rights_not_cleared: "rights",
  catalogue_vj_not_active: "vj",
  review_already_published: "published_already",
  command_unavailable: "unavailable",
};

function refused(command: string, failure: unknown): string {
  const code = failure instanceof DiscoveryStoreError ? failure.code : "invalid_input";
  console.warn(JSON.stringify({ event: "series_review_refused", command, code }));
  return RESULTS[code] ?? "invalid";
}

function done(result: string, mediaId?: number): never {
  revalidatePath("/admin/series");
  redirect(`/admin/series?result=${result}${mediaId ? `#file-${mediaId}` : ""}`);
}

const id = z.coerce.number().int().positive();
const revision = z.coerce.number().int().nonnegative();

export async function seriesFileAction(data: FormData): Promise<void> {
  await requireReviewAdmin();
  if (reviewMode() !== "database") done("unavailable");
  const command = z.enum(["assign", "unassign", "clear_rights", "withdraw_rights", "publish"]).catch("assign").parse(data.get("command"));
  let mediaId: number | undefined;
  let result: string;
  try {
    mediaId = id.parse(data.get("mediaId"));
    const current = revision.parse(data.get("revision"));
    const client = await databaseReviewClient();
    if (command === "assign") {
      const text = (field: string, max: number) => z.string().trim().max(max).parse(data.get(field) ?? "") || null;
      await client.assignEpisode(mediaId, current, {
        seriesId: id.parse(data.get("seriesId")),
        season: z.coerce.number().int().min(0).max(999).parse(data.get("season")),
        episode: z.coerce.number().int().min(1).max(9999).parse(data.get("episode")),
        title: text("episodeTitle", 300),
        overview: text("episodeOverview", 10000),
        vjId: id.parse(data.get("vjId")),
      });
      result = "assigned";
    } else if (command === "unassign") {
      await client.assignEpisode(mediaId, current, null);
      result = "unassigned";
    } else if (command === "clear_rights" || command === "withdraw_rights") {
      await client.episodeRights(mediaId, current, command === "clear_rights");
      result = command === "clear_rights" ? "rights_cleared" : "rights_withdrawn";
    } else {
      const published = await client.publishEpisode(mediaId, current);
      for (const path of ["/", "/series", "/vjs", "/search", `/series/${published.series_slug}`]) revalidatePath(path);
      result = "published";
    }
  } catch (failure) {
    result = refused(command, failure);
  }
  done(result, mediaId);
}

/** Creates or edits a manually entered series, with an optional poster from the reviewer's device. */
export async function saveSeriesDetails(_previous: MetadataFormState, data: FormData): Promise<MetadataFormState> {
  await requireReviewAdmin();
  if (reviewMode() !== "database") return { error: "Series details are available in database review mode." };
  try {
    const client = await databaseReviewClient();
    const rawId = z.string().parse(data.get("seriesId") ?? "");
    const seriesId = rawId ? id.parse(rawId) : null;
    const queue = await client.seriesQueue();
    if (!queue) return { error: "Series review is waiting for the database update." };
    const existing = seriesId ? queue.series.find((series) => series.id === seriesId) : null;
    if (seriesId && (!existing || !existing.manual)) return { error: "Only series entered by hand can be edited here." };
    const updatedAt = seriesId ? z.string().parse(data.get("updatedAt")) : null;
    if (existing && existing.updated_at !== updatedAt) return { error: "This series changed. Refresh the page before saving." };
    const nullable = (field: string) => z.string().trim().parse(data.get(field) ?? "") || null;
    let metadata = manualSeriesMetadataSchema.parse({
      title: data.get("title"), original_title: nullable("originalTitle"), overview: nullable("overview"),
      first_air_date: data.get("firstAirDate"),
      genres: z.string().parse(data.get("genres") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
      poster_path: existing?.metadata.poster_path ?? null, backdrop_path: existing?.metadata.backdrop_path ?? null,
    });
    const file = data.get("poster");
    // An uploaded poster is immutable; on an uncertain database answer it is kept, since it may already be referenced.
    if (file instanceof File && file.size > 0) metadata = { ...metadata, poster_path: await storePoster(file) };
    const saved = await client.saveSeries(seriesId, updatedAt, metadata);
    revalidatePath("/admin/series");
    if (saved.publication_status === "published") for (const path of ["/", "/series", "/search", `/series/${saved.slug}`]) revalidatePath(path);
    return { notice: seriesId ? "Series details saved." : `"${saved.metadata.title}" added. Assign its files below.` };
  } catch (error) {
    const code = error instanceof DiscoveryStoreError ? error.code : error instanceof Error && /^poster_[a-z_]+$/.test(error.message) ? error.message : "invalid_input";
    console.warn(JSON.stringify({ event: "series_details_save_refused", code }));
    if (code === "review_not_authorized") return { error: "Your account does not have permission to change these series details." };
    if (code === "review_stale_revision") return { error: "This series changed. Refresh before saving again." };
    if (code === "command_unavailable") return { error: "Series review is waiting for the database update." };
    if (code === "poster_storage_not_configured" || code === "r2_configuration_invalid") return { error: "The dedicated poster storage is not configured." };
    if (code === "poster_upload_failed") return { error: "The poster could not be uploaded. No series details were changed. Please try again." };
    if (code === "poster_image_invalid" || code === "poster_file_too_large") return { error: "Choose a readable JPEG, PNG or WebP poster up to 5 MB and at least 120 pixels wide and tall." };
    return { error: "Could not save the series details. Check the fields and try again." };
  }
}
