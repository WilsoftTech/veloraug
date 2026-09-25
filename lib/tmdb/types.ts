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
