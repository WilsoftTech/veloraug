import { z } from "zod";
import { isPosterPath } from "@/lib/artwork";

/**
 * The series review queue (migration 20261120191536_series_review_queue.sql): Series-channel files that
 * no owner workflow has published, the series to assign them to, and the active VJs. The database
 * checks the reviewer's capability on every command; these schemas only validate what it returns.
 */
const artwork = z.string().refine((value) => /^\/[A-Za-z0-9_.-]{1,200}$/.test(value) || isPosterPath(value), "Invalid poster path.").nullable();

/** Hand-entered series details, for a series TMDB has no record of. Never carries a TMDB id. */
export const manualSeriesMetadataSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  original_title: z.string().trim().min(1).max(300).nullable(),
  overview: z.string().trim().min(1).max(10000).nullable(),
  first_air_date: z.iso.date().refine((value) => Number(value.slice(0, 4)) >= 1870 && Number(value.slice(0, 4)) <= 2199),
  genres: z.array(z.string().trim().min(1).max(80)).max(20),
  poster_path: artwork,
  backdrop_path: artwork,
});
export type ManualSeriesMetadata = z.infer<typeof manualSeriesMetadataSchema>;

const timestamp = z.string().min(1);
export const seriesReviewItemSchema = z.object({
  media_id: z.number().int().positive(),
  post: z.number().int().positive(),
  file_name: z.string().nullable(),
  file_size_bytes: z.number().int().nonnegative(),
  mime_type: z.string().nullable(),
  received_at: timestamp,
  verification: z.object({
    scope: z.string(), integrity: z.string().nullable(), streaming: z.string().nullable(), publishable: z.boolean(),
    reasons: z.array(z.string()), checked_at: timestamp,
  }).nullable(),
  job: z.object({ attempts: z.number().int(), error: z.string().nullable(), running: z.boolean().nullable(), completed: z.boolean() }).nullable(),
  revision: z.number().int().nonnegative(),
  series_id: z.number().int().positive().nullable(),
  season_number: z.number().int().nullable(),
  episode_number: z.number().int().nullable(),
  episode_title: z.string().nullable(),
  episode_overview: z.string().nullable(),
  vj_id: z.number().int().positive().nullable(),
  rights_cleared: z.boolean(),
  published_at: timestamp.nullable(),
  episode_version_id: z.number().int().positive().nullable(),
});
export type SeriesReviewItem = z.infer<typeof seriesReviewItemSchema>;

export const seriesChoiceSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  publication_status: z.enum(["draft", "published"]),
  updated_at: timestamp,
  manual: z.boolean(),
  metadata: z.object({
    title: z.string(), original_title: z.string().nullable(), overview: z.string().nullable(), first_air_date: z.string().nullable(),
    poster_path: z.string().nullable(), backdrop_path: z.string().nullable(), genres: z.array(z.string()),
  }),
});
export type SeriesChoice = z.infer<typeof seriesChoiceSchema>;

export const seriesReviewQueueSchema = z.object({
  items: z.array(seriesReviewItemSchema).max(2000),
  series: z.array(seriesChoiceSchema).max(2000),
  vjs: z.array(z.object({ id: z.number().int().positive(), name: z.string() })).max(500),
});
export type SeriesReviewQueue = z.infer<typeof seriesReviewQueueSchema>;

/** Where a file stands, for the queue: the next thing it is waiting for. */
export type SeriesItemStage = "published" | "check_failed" | "checking" | "awaiting_check" | "unassigned" | "awaiting_rights" | "ready";
export function seriesItemStage(item: SeriesReviewItem): SeriesItemStage {
  if (item.published_at) return "published";
  if (item.verification && !item.verification.publishable && item.verification.scope === "whole_file") return "check_failed";
  // Assignment and rights can be done while the whole-file check is still running.
  if (item.series_id === null) return "unassigned";
  if (!item.rights_cleared) return "awaiting_rights";
  if (!item.verification?.publishable) return item.job?.running ? "checking" : "awaiting_check";
  return "ready";
}
