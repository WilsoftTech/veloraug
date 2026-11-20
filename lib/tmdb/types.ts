// Raw TMDB response shapes. Only the fields Velora reads are declared.

export interface TmdbResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
}

export interface TmdbSearchResponse {
  results?: TmdbResult[];
}

/** GET /movie/{id}: the fields an approved catalogue snapshot takes. */
export interface TmdbMovieDetails {
  id: number;
  title?: string;
  original_title?: string;
  overview?: string | null;
  release_date?: string;
  runtime?: number | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  genres?: { id: number; name: string }[];
}

/** GET /tv/{id}: the fields an approved series snapshot takes. */
export interface TmdbTvDetails {
  id: number;
  name?: string;
  original_name?: string;
  overview?: string | null;
  first_air_date?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  genres?: { id: number; name: string }[];
}

/** GET /tv/{id}/season/{n}: one season and its episodes. */
export interface TmdbSeasonDetails {
  season_number: number;
  name?: string | null;
  overview?: string | null;
  air_date?: string | null;
  poster_path?: string | null;
  episodes?: {
    id: number;
    episode_number: number;
    season_number?: number;
    name?: string | null;
    overview?: string | null;
    air_date?: string | null;
    runtime?: number | null;
    still_path?: string | null;
  }[];
}
