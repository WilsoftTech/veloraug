/**
 * Row shapes for the tables in supabase/migrations. Confined to the data layer:
 * components work with the domain types in types/media.ts.
 *
 * This file is generated schema shapes plus deliberate application-level
 * restrictions, not raw generator output. The `search_*` objects come from
 * `supabase gen types typescript --schema public`; the restrictions are:
 *  - `media_type` stays a `"movie" | "tv"` union (the generator emits `string`);
 *  - `Insert`/`Update: never` (or a narrowed `Update`) encode which writes
 *    clients are actually granted. `search_history.Insert` and `.Update` are
 *    `never` on purpose: clients cannot write it, only `record_search` can;
 *  - catalogue `Row`s list only the column-level SELECT grants;
 *  - the `ingest_upload_*` worker RPCs (20260925004059) are deliberately
 *    absent: only service_role may execute them, and the uploader CLI calls
 *    them through its own typed transport (lib/uploader/store.ts).
 *
 * Regenerating? Diff-review the output against this file; never replace it
 * wholesale, or those restrictions are silently lost.
 */
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        // Clients may only change display_name (column-level grant).
        Insert: never;
        Update: { display_name?: string | null };
        Relationships: [];
      };
      watchlist_items: {
        // watchlist_items_identity_check (20260922080911): a row is either a
        // catalogue save (movie_id or series_id) or a legacy TMDB save
        // (tmdb_id with media_type movie/tv). A legacy insert that maps to the
        // catalogue is normalized by the insert trigger and keeps its tmdb_id.
        Row: {
          id: string;
          user_id: string;
          movie_id: number | null;
          series_id: number | null;
          tmdb_id: number | null;
          media_type: "movie" | "tv" | "series";
          created_at: string;
        };
        // user_id defaults to the caller in the database, so it is never sent.
        // Which id goes with which media_type is enforced by the identity check.
        Insert: {
          movie_id?: number;
          series_id?: number;
          tmdb_id?: number;
          media_type: "movie" | "tv" | "series";
        };
        Update: never;
        Relationships: [];
      };
      search_history: {
        Row: {
          query: string;
          scope: string;
          searched_at: string;
          user_id: string;
        };
        // No INSERT/UPDATE grant: rows are written only by record_search.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      // Catalogue (20260923210000): read-only, and Row lists only the columns
      // granted to anon/authenticated. Workflow state and Telegram links are
      // not readable by clients, so they are deliberately absent here.
      vjs: {
        Row: {
          id: number;
          slug: string;
          name: string;
          description: string | null;
          avatar_url: string | null;
          badge_variant: "blue" | "amber" | "emerald" | "violet" | "rose" | "slate";
          sort_order: number;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      movies: {
        Row: {
          id: number;
          slug: string;
          title: string;
          original_title: string | null;
          overview: string | null;
          release_date: string | null;
          runtime_minutes: number | null;
          poster_path: string | null;
          backdrop_path: string | null;
          tmdb_id: number | null;
          tmdb_vote_average: number | null;
          tmdb_vote_count: number | null;
          is_featured: boolean;
          published_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      series: {
        Row: {
          id: number;
          slug: string;
          title: string;
          original_title: string | null;
          overview: string | null;
          first_air_date: string | null;
          poster_path: string | null;
          backdrop_path: string | null;
          tmdb_id: number | null;
          tmdb_vote_average: number | null;
          tmdb_vote_count: number | null;
          is_featured: boolean;
          published_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      seasons: {
        Row: {
          id: number;
          series_id: number;
          season_number: number;
          title: string | null;
          overview: string | null;
          air_date: string | null;
          poster_path: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          { foreignKeyName: "seasons_series_id_fkey"; columns: ["series_id"]; isOneToOne: false; referencedRelation: "series"; referencedColumns: ["id"] },
        ];
      };
      episodes: {
        Row: {
          id: number;
          season_id: number;
          episode_number: number;
          title: string | null;
          overview: string | null;
          air_date: string | null;
          runtime_minutes: number | null;
          still_path: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          { foreignKeyName: "episodes_season_id_fkey"; columns: ["season_id"]; isOneToOne: false; referencedRelation: "seasons"; referencedColumns: ["id"] },
        ];
      };
      movie_versions: {
        Row: {
          id: number;
          movie_id: number;
          vj_id: number;
          title_override: string | null;
          available_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          { foreignKeyName: "movie_versions_movie_id_fkey"; columns: ["movie_id"]; isOneToOne: false; referencedRelation: "movies"; referencedColumns: ["id"] },
          { foreignKeyName: "movie_versions_vj_id_fkey"; columns: ["vj_id"]; isOneToOne: false; referencedRelation: "vjs"; referencedColumns: ["id"] },
        ];
      };
      episode_versions: {
        Row: {
          id: number;
          episode_id: number;
          vj_id: number;
          title_override: string | null;
          available_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          { foreignKeyName: "episode_versions_episode_id_fkey"; columns: ["episode_id"]; isOneToOne: false; referencedRelation: "episodes"; referencedColumns: ["id"] },
          { foreignKeyName: "episode_versions_vj_id_fkey"; columns: ["vj_id"]; isOneToOne: false; referencedRelation: "vjs"; referencedColumns: ["id"] },
        ];
      };
      genres: {
        Row: {
          id: number;
          slug: string;
          name: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      movie_genres: {
        Row: {
          movie_id: number;
          genre_id: number;
        };
        Insert: never;
        Update: never;
        Relationships: [
          { foreignKeyName: "movie_genres_movie_id_fkey"; columns: ["movie_id"]; isOneToOne: false; referencedRelation: "movies"; referencedColumns: ["id"] },
          { foreignKeyName: "movie_genres_genre_id_fkey"; columns: ["genre_id"]; isOneToOne: false; referencedRelation: "genres"; referencedColumns: ["id"] },
        ];
      };
      series_genres: {
        Row: {
          series_id: number;
          genre_id: number;
        };
        Insert: never;
        Update: never;
        Relationships: [
          { foreignKeyName: "series_genres_series_id_fkey"; columns: ["series_id"]; isOneToOne: false; referencedRelation: "series"; referencedColumns: ["id"] },
          { foreignKeyName: "series_genres_genre_id_fkey"; columns: ["genre_id"]; isOneToOne: false; referencedRelation: "genres"; referencedColumns: ["id"] },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      record_search: {
        Args: { p_query: string; p_result_count: number; p_scope: string };
        Returns: undefined;
      };
      trending_searches: {
        Args: { p_limit?: number };
        Returns: {
          query: string;
          search_count: number;
        }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
