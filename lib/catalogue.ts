import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/lib/supabase/database.types";
import type {
  CataloguePage,
  Genre,
  MovieDetail,
  Season,
  SeriesDetail,
  TitleSummary,
  TitleVersion,
  Vj,
  VjSummary,
} from "@/types/catalogue";

/**
 * Server-side reads of the published Velora UG catalogue.
 *
 * Visibility is enforced by the database, not here: every query runs as the
 * anonymous role under the published-only policies of
 * 20260923210000_catalogue_public_read.sql, so a draft, blocked or unready row
 * cannot be returned even if a query forgets a filter. The client carries no
 * session, so these reads are identical for every visitor and never touch
 * cookies. Workflow state and Telegram links are not granted, so selects name
 * their columns.
 *
 * Failures throw (for the route's error boundary); a missing title resolves to null.
 */

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

function catalogueClient() {
  const { url, key } = requireSupabaseConfig();
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function fail(what: string, error: { code?: string; message: string }): never {
  console.error(`Catalogue read failed: ${what}`, error.code, error.message);
  throw new Error("Could not load the catalogue.");
}

// ---------------------------------------------------------------------------
// Keyset cursor: the (published_at, id) of the last row, opaque to callers.
// ---------------------------------------------------------------------------
const cursorSchema = z.tuple([z.iso.datetime({ offset: true }), z.number().int().positive()]);

function encodeCursor(publishedAt: string, id: number) {
  return Buffer.from(JSON.stringify([publishedAt, id])).toString("base64url");
}

/** An unreadable cursor is treated as "start from the beginning", never as an error. */
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? { publishedAt: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

function pageSize(limit: number | undefined) {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Row -> domain mapping
// ---------------------------------------------------------------------------
type VjRow = Pick<Database["public"]["Tables"]["vjs"]["Row"], "id" | "slug" | "name" | "badge_variant">;
type VersionRow = { id: number; title_override: string | null; vjs: VjRow };

function toVjSummary(row: VjRow): VjSummary {
  return { id: row.id, slug: row.slug, name: row.name, badgeVariant: row.badge_variant };
}

/** Distinct VJs, alphabetical, from any number of versions. */
function distinctVjs(versions: VersionRow[]): VjSummary[] {
  const byId = new Map(versions.map((version) => [version.vjs.id, toVjSummary(version.vjs)]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function toVersion(row: VersionRow): TitleVersion {
  return { id: row.id, vj: toVjSummary(row.vjs), title: row.title_override };
}

function toYear(date: string | null) {
  const year = Number.parseInt(date?.slice(0, 4) ?? "", 10);
  return Number.isNaN(year) ? null : year;
}

function toRating(average: number | null, count: number | null) {
  return count && average !== null ? Math.round(average * 10) / 10 : null;
}

function toGenres(rows: { genres: Genre }[]): Genre[] {
  return rows.map(({ genres }) => genres).sort((a, b) => a.name.localeCompare(b.name));
}

const VJ = "id, slug, name, badge_variant";

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
export interface TitleListOptions {
  cursor?: string;
  limit?: number;
  featured?: boolean;
  /** Only titles available from this VJ. */
  vjSlug?: string;
  /** Only titles in this genre. */
  genreSlug?: string;
}

/**
 * Published movies, newest first. The filter_* embeds are inner joins used only
 * to filter, so the displayed VJ list still shows every VJ of each movie.
 */
export async function listMovies(options: TitleListOptions = {}): Promise<CataloguePage<TitleSummary>> {
  const size = pageSize(options.limit);
  const cursor = decodeCursor(options.cursor);

  let query = catalogueClient()
    .from("movies")
    .select(
      `id, slug, title, poster_path, release_date, tmdb_vote_average, tmdb_vote_count, published_at,
       movie_versions(id, title_override, vjs(${VJ}))
       ${options.vjSlug ? ", filter_vj:movie_versions!inner(vjs!inner(slug))" : ""}
       ${options.genreSlug ? ", filter_genre:movie_genres!inner(genres!inner(slug))" : ""}`,
    )
    .order("published_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);

  if (options.featured) query = query.eq("is_featured", true);
  if (options.vjSlug) query = query.eq("filter_vj.vjs.slug", options.vjSlug);
  if (options.genreSlug) query = query.eq("filter_genre.genres.slug", options.genreSlug);
  if (cursor) {
    query = query.or(`published_at.lt."${cursor.publishedAt}",and(published_at.eq."${cursor.publishedAt}",id.lt.${cursor.id})`);
  }

  const { data, error } = await query.overrideTypes<
    {
      id: number;
      slug: string;
      title: string;
      poster_path: string | null;
      release_date: string | null;
      tmdb_vote_average: number | null;
      tmdb_vote_count: number | null;
      published_at: string;
      movie_versions: VersionRow[];
    }[],
    { merge: false }
  >();
  if (error) fail("movies", error);

  const rows = data.slice(0, size);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      kind: "movie",
      id: row.id,
      slug: row.slug,
      title: row.title,
      posterPath: row.poster_path,
      releaseYear: toYear(row.release_date),
      rating: toRating(row.tmdb_vote_average, row.tmdb_vote_count),
      vjs: distinctVjs(row.movie_versions),
    })),
    nextCursor: data.length > size && last ? encodeCursor(last.published_at, last.id) : null,
  };
}

type SeriesVersionTree = { seasons: { episodes: { episode_versions: VersionRow[] }[] }[] };

function seriesVersions(row: SeriesVersionTree): VersionRow[] {
  return row.seasons.flatMap((season) => season.episodes.flatMap((episode) => episode.episode_versions));
}

/** Published series, newest first. A series is available from every VJ of any of its episodes. */
export async function listSeries(options: TitleListOptions = {}): Promise<CataloguePage<TitleSummary>> {
  const size = pageSize(options.limit);
  const cursor = decodeCursor(options.cursor);

  let query = catalogueClient()
    .from("series")
    .select(
      `id, slug, title, poster_path, first_air_date, tmdb_vote_average, tmdb_vote_count, published_at,
       seasons(episodes(episode_versions(id, title_override, vjs(${VJ}))))
       ${options.vjSlug ? ", filter_vj:seasons!inner(episodes!inner(episode_versions!inner(vjs!inner(slug))))" : ""}
       ${options.genreSlug ? ", filter_genre:series_genres!inner(genres!inner(slug))" : ""}`,
    )
    .order("published_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);

  if (options.featured) query = query.eq("is_featured", true);
  if (options.vjSlug) query = query.eq("filter_vj.episodes.episode_versions.vjs.slug", options.vjSlug);
  if (options.genreSlug) query = query.eq("filter_genre.genres.slug", options.genreSlug);
  if (cursor) {
    query = query.or(`published_at.lt."${cursor.publishedAt}",and(published_at.eq."${cursor.publishedAt}",id.lt.${cursor.id})`);
  }

  const { data, error } = await query.overrideTypes<
    ({
      id: number;
      slug: string;
      title: string;
      poster_path: string | null;
      first_air_date: string | null;
      tmdb_vote_average: number | null;
      tmdb_vote_count: number | null;
      published_at: string;
    } & SeriesVersionTree)[],
    { merge: false }
  >();
  if (error) fail("series", error);

  const rows = data.slice(0, size);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      kind: "series",
      id: row.id,
      slug: row.slug,
      title: row.title,
      posterPath: row.poster_path,
      releaseYear: toYear(row.first_air_date),
      rating: toRating(row.tmdb_vote_average, row.tmdb_vote_count),
      vjs: distinctVjs(seriesVersions(row)),
    })),
    nextCursor: data.length > size && last ? encodeCursor(last.published_at, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------
export async function getMovie(slug: string): Promise<MovieDetail | null> {
  const { data, error } = await catalogueClient()
    .from("movies")
    .select(
      `id, slug, title, original_title, overview, release_date, runtime_minutes, poster_path, backdrop_path,
       tmdb_vote_average, tmdb_vote_count,
       movie_versions(id, title_override, vjs(${VJ})),
       movie_genres(genres(id, slug, name))`,
    )
    .eq("slug", slug)
    .maybeSingle()
    .overrideTypes<
      {
        id: number;
        slug: string;
        title: string;
        original_title: string | null;
        overview: string | null;
        release_date: string | null;
        runtime_minutes: number | null;
        poster_path: string | null;
        backdrop_path: string | null;
        tmdb_vote_average: number | null;
        tmdb_vote_count: number | null;
        movie_versions: VersionRow[];
        movie_genres: { genres: Genre }[];
      } | null,
      { merge: false }
    >();
  if (error) fail("movie", error);
  if (!data) return null;

  return {
    kind: "movie",
    id: data.id,
    slug: data.slug,
    title: data.title,
    originalTitle: data.original_title,
    overview: data.overview,
    posterPath: data.poster_path,
    backdropPath: data.backdrop_path,
    releaseYear: toYear(data.release_date),
    rating: toRating(data.tmdb_vote_average, data.tmdb_vote_count),
    runtimeMinutes: data.runtime_minutes,
    genres: toGenres(data.movie_genres),
    vjs: distinctVjs(data.movie_versions),
    versions: data.movie_versions.map(toVersion).sort((a, b) => a.vj.name.localeCompare(b.vj.name)),
  };
}

export async function getSeries(slug: string): Promise<SeriesDetail | null> {
  const { data, error } = await catalogueClient()
    .from("series")
    .select(
      `id, slug, title, original_title, overview, first_air_date, poster_path, backdrop_path,
       tmdb_vote_average, tmdb_vote_count,
       series_genres(genres(id, slug, name)),
       seasons(id, season_number, title, overview, air_date, poster_path,
         episodes(id, episode_number, title, overview, air_date, runtime_minutes, still_path,
           episode_versions(id, title_override, vjs(${VJ}))))`,
    )
    .eq("slug", slug)
    .order("season_number", { referencedTable: "seasons" })
    .order("episode_number", { referencedTable: "seasons.episodes" })
    .maybeSingle()
    .overrideTypes<
      {
        id: number;
        slug: string;
        title: string;
        original_title: string | null;
        overview: string | null;
        first_air_date: string | null;
        poster_path: string | null;
        backdrop_path: string | null;
        tmdb_vote_average: number | null;
        tmdb_vote_count: number | null;
        series_genres: { genres: Genre }[];
        seasons: {
          id: number;
          season_number: number;
          title: string | null;
          overview: string | null;
          air_date: string | null;
          poster_path: string | null;
          episodes: {
            id: number;
            episode_number: number;
            title: string | null;
            overview: string | null;
            air_date: string | null;
            runtime_minutes: number | null;
            still_path: string | null;
            episode_versions: VersionRow[];
          }[];
        }[];
      } | null,
      { merge: false }
    >();
  if (error) fail("series detail", error);
  if (!data) return null;

  const seasons: Season[] = data.seasons.map((season) => ({
    id: season.id,
    seasonNumber: season.season_number,
    title: season.title,
    overview: season.overview,
    airDate: season.air_date,
    posterPath: season.poster_path,
    episodes: season.episodes.map((episode) => ({
      id: episode.id,
      episodeNumber: episode.episode_number,
      title: episode.title,
      overview: episode.overview,
      airDate: episode.air_date,
      runtimeMinutes: episode.runtime_minutes,
      stillPath: episode.still_path,
      versions: episode.episode_versions.map(toVersion).sort((a, b) => a.vj.name.localeCompare(b.vj.name)),
    })),
  }));

  return {
    kind: "series",
    id: data.id,
    slug: data.slug,
    title: data.title,
    originalTitle: data.original_title,
    overview: data.overview,
    posterPath: data.poster_path,
    backdropPath: data.backdrop_path,
    releaseYear: toYear(data.first_air_date),
    rating: toRating(data.tmdb_vote_average, data.tmdb_vote_count),
    genres: toGenres(data.series_genres),
    vjs: distinctVjs(seriesVersions(data)),
    seasons,
  };
}

// ---------------------------------------------------------------------------
// VJs and genres
// ---------------------------------------------------------------------------
type VjDetailRow = Pick<
  Database["public"]["Tables"]["vjs"]["Row"],
  "id" | "slug" | "name" | "badge_variant" | "description" | "avatar_url"
>;

function toVj(row: VjDetailRow): Vj {
  return { ...toVjSummary(row), description: row.description, avatarUrl: row.avatar_url };
}

/** Active VJs in their editorial order. */
export async function listVjs(): Promise<Vj[]> {
  const { data, error } = await catalogueClient()
    .from("vjs")
    .select(`${VJ}, description, avatar_url`)
    .order("sort_order")
    .order("id");
  if (error) fail("vjs", error);
  return data.map(toVj);
}

export async function getVj(slug: string): Promise<Vj | null> {
  const { data, error } = await catalogueClient()
    .from("vjs")
    .select(`${VJ}, description, avatar_url`)
    .eq("slug", slug)
    .maybeSingle();
  if (error) fail("vj", error);
  return data ? toVj(data) : null;
}

/** Every genre, alphabetical. Callers decide whether to hide genres with no titles. */
export async function listGenres(): Promise<Genre[]> {
  const { data, error } = await catalogueClient().from("genres").select("id, slug, name").order("name");
  if (error) fail("genres", error);
  return data;
}
