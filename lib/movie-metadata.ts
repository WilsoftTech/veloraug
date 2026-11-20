import { z } from "zod";
import { movieSnapshotSchema } from "@/lib/tmdb/ingestion-search";
import { isPosterPath } from "@/lib/artwork";
const artwork = z.string().refine(value => /^\/[A-Za-z0-9_.-]{1,200}$/.test(value) || isPosterPath(value), "Invalid poster path.").nullable();
export const manualMovieMetadataSchema = movieSnapshotSchema.omit({ tmdb_id: true, vote_average: true, vote_count: true, genres: true }).extend({
  release_date: z.iso.date().refine(value => Number(value.slice(0,4)) >= 1870 && Number(value.slice(0,4)) <= 2199),
  runtime_minutes: z.number().int().positive().max(1440).nullable(), poster_path: artwork, backdrop_path: artwork,
  genres: z.array(z.string().trim().min(1).max(80)).max(20),
});
export type ManualMovieMetadata = z.infer<typeof manualMovieMetadataSchema>;
export const manualMovieSnapshotSchema = movieSnapshotSchema.extend({ tmdb_id: z.null(), poster_path: artwork, backdrop_path: artwork });
export interface MetadataFormState { error?: string; notice?: string }
export interface ManualMovieChoice { id: number; title: string; year: number | null }
