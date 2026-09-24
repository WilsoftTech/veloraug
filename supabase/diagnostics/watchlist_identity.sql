-- Watchlist identity report (roadmap B4). Read-only and aggregate-only: it
-- returns counts, never user ids or titles. Run it as an operator (for example
-- the read-only Supabase MCP, or psql against a local stack). It is not exposed
-- through any API.
--
--   canonical_*            rows stored by internal catalogue id (target state)
--   legacy_*               TMDB-only rows (pre-B5 compatibility path)
--   legacy_published_match legacy rows whose TMDB id now matches a published
--                          catalogue title. Reads already resolve these; they
--                          are candidates for a later backfill
--   legacy_draft_match     legacy rows whose TMDB id matches an unpublished title
--   legacy_created_7d      legacy rows created in the last 7 days (debt still growing?)
--   malformed              rows breaking the identity rule; the check constraint
--                          makes this structurally 0, and it is reported to prove it
select
  count(*) as total_rows,
  count(*) filter (where w.movie_id is not null) as canonical_movie_rows,
  count(*) filter (where w.series_id is not null) as canonical_series_rows,
  count(*) filter (where w.movie_id is null and w.series_id is null and w.media_type = 'movie') as legacy_movie_rows,
  count(*) filter (where w.movie_id is null and w.series_id is null and w.media_type = 'tv') as legacy_tv_rows,
  count(*) filter (where w.movie_id is null and w.series_id is null and (
    (w.media_type = 'movie' and exists (select 1 from public.movies m where m.tmdb_id = w.tmdb_id and m.publication_status = 'published'))
    or (w.media_type = 'tv' and exists (select 1 from public.series s where s.tmdb_id = w.tmdb_id and s.publication_status = 'published'))
  )) as legacy_published_match,
  count(*) filter (where w.movie_id is null and w.series_id is null and (
    (w.media_type = 'movie' and exists (select 1 from public.movies m where m.tmdb_id = w.tmdb_id and m.publication_status <> 'published'))
    or (w.media_type = 'tv' and exists (select 1 from public.series s where s.tmdb_id = w.tmdb_id and s.publication_status <> 'published'))
  )) as legacy_draft_match,
  count(*) filter (where w.movie_id is null and w.series_id is null and w.created_at > now() - interval '7 days') as legacy_created_7d,
  count(*) filter (where num_nonnulls(w.movie_id, w.series_id) > 1 or num_nonnulls(w.movie_id, w.series_id, w.tmdb_id) = 0) as malformed
from public.watchlist_items as w;
