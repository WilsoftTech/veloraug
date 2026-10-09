import { z } from "zod";
import { movieSnapshotSchema } from "@/lib/tmdb/ingestion-search";
import { evidenceSchema, candidateSchema } from "@/lib/discovery/model";
import type { InspectionPorts } from "@/lib/discovery/pipeline";
import { mediaKey } from "@/lib/discovery/events";

/** Explicit synthetic inputs. This adapter has no fetch, Supabase, Telegram or publication transport. */
export const fixtureSchema = z.strictObject({
  mode: z.literal("synthetic-offline"), channelId: z.number().int().safe().negative(), updates: z.array(z.unknown()).max(1000),
  vjs: z.array(z.strictObject({ id: z.number().int().positive(), slug: z.string().max(100), name: z.string().max(100), isActive: z.boolean(), aliases: z.array(z.string().max(100)).optional() })).max(100),
  movies: z.array(movieSnapshotSchema).max(100),
  catalogue: z.array(z.strictObject({ movieId: z.number().int().positive(), tmdbId: z.number().int().positive(), vjIds: z.array(z.number().int().positive()) })).max(100),
  media: z.array(z.strictObject({ mediaKey: z.string().regex(/^[a-f0-9]{64}$/), evidence: evidenceSchema.nullable(), source: candidateSchema.shape.uploaderSource, duplicateOf: z.string().regex(/^[a-f0-9]{64}$/).nullable() })).max(100),
});
export type DiscoveryFixture = z.infer<typeof fixtureSchema>;
export function fixturePorts(fixture: DiscoveryFixture): InspectionPorts {
  const results = fixture.movies.map((movie) => ({ tmdbId: movie.tmdb_id, mediaType: "movie" as const, title: movie.title, originalTitle: movie.original_title, year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : null }));
  return {
    async catalogue() { return fixture.catalogue.flatMap((entry) => { const movie = results.find((item) => item.tmdbId === entry.tmdbId); return movie ? [{ ...movie, ...entry }] : []; }); },
    async vjs() { return fixture.vjs; }, async search() { return results; },
    async snapshot(id) { return fixture.movies.find((item) => item.tmdb_id === id) ?? null; },
    async media(event) { const found = fixture.media.find((item) => item.mediaKey === mediaKey(event)); return found ?? { duplicateOf: null, source: null, evidence: null }; },
  };
}
