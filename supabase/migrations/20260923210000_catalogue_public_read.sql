-- Velora UG Phase B, checkpoint B-2: the public read contract for the catalogue.
-- Decision D1 in docs/PHASE_B_CATALOGUE_DESIGN.md.
--
-- Visibility rules (anon and authenticated alike):
--   VJ        active.
--   movie     published AND has a ready, rights-cleared version from an active VJ.
--   series    published AND has an episode with a ready, rights-cleared version
--             from an active VJ.
--   season    its series is published AND it has a public episode.
--   episode   its series is published AND it has a ready, rights-cleared version
--             from an active VJ.
--   version   ready, rights-cleared, active VJ, and its title/episode is public.
--   genre     always (taxonomy, not content); genre links only for public titles.
--
-- Titles and versions depend on each other, so policies that queried each other
-- would recurse. The predicates therefore live in SECURITY DEFINER functions in
-- catalogue_access, a schema the Data API does not expose: clients can use them
-- only inside these policies, never as /rpc endpoints. Each returns a boolean
-- and nothing else, has an empty search_path and contains no dynamic SQL.
--
-- Reads are column-level: workflow state (publication/availability/rights,
-- metadata status, sync times) and Telegram links are never granted, so a
-- client can neither read nor filter by them. Queries must name their columns.

create schema catalogue_access;
revoke all on schema catalogue_access from public;
grant usage on schema catalogue_access to anon, authenticated;

create function catalogue_access.movie_is_public(p_movie_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.movies m
    join public.movie_versions mv on mv.movie_id = m.id
    join public.vjs v on v.id = mv.vj_id
    where m.id = p_movie_id
      and m.publication_status = 'published'
      and mv.availability_status = 'ready'
      and mv.rights_status = 'cleared'
      and v.is_active
  );
$$;

create function catalogue_access.series_is_public(p_series_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.series sr
    join public.seasons s on s.series_id = sr.id
    join public.episodes e on e.season_id = s.id
    join public.episode_versions ev on ev.episode_id = e.id
    join public.vjs v on v.id = ev.vj_id
    where sr.id = p_series_id
      and sr.publication_status = 'published'
      and ev.availability_status = 'ready'
      and ev.rights_status = 'cleared'
      and v.is_active
  );
$$;

create function catalogue_access.season_is_public(p_season_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.seasons s
    join public.series sr on sr.id = s.series_id
    join public.episodes e on e.season_id = s.id
    join public.episode_versions ev on ev.episode_id = e.id
    join public.vjs v on v.id = ev.vj_id
    where s.id = p_season_id
      and sr.publication_status = 'published'
      and ev.availability_status = 'ready'
      and ev.rights_status = 'cleared'
      and v.is_active
  );
$$;

create function catalogue_access.episode_is_public(p_episode_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.episodes e
    join public.seasons s on s.id = e.season_id
    join public.series sr on sr.id = s.series_id
    join public.episode_versions ev on ev.episode_id = e.id
    join public.vjs v on v.id = ev.vj_id
    where e.id = p_episode_id
      and sr.publication_status = 'published'
      and ev.availability_status = 'ready'
      and ev.rights_status = 'cleared'
      and v.is_active
  );
$$;

revoke all on all functions in schema catalogue_access from public, anon, authenticated, service_role;
grant execute on function
  catalogue_access.movie_is_public(bigint),
  catalogue_access.series_is_public(bigint),
  catalogue_access.season_is_public(bigint),
  catalogue_access.episode_is_public(bigint)
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Policies. The inline publication_status test lets the planner use the
-- partial published_* indexes before calling the predicate per row.
-- ---------------------------------------------------------------------------
create policy "vjs: read active"
  on public.vjs for select to anon, authenticated
  using (is_active);

create policy "movies: read public"
  on public.movies for select to anon, authenticated
  using (publication_status = 'published' and catalogue_access.movie_is_public(id));

create policy "series: read public"
  on public.series for select to anon, authenticated
  using (publication_status = 'published' and catalogue_access.series_is_public(id));

create policy "seasons: read public"
  on public.seasons for select to anon, authenticated
  using (catalogue_access.season_is_public(id));

create policy "episodes: read public"
  on public.episodes for select to anon, authenticated
  using (catalogue_access.episode_is_public(id));

create policy "movie_versions: read public"
  on public.movie_versions for select to anon, authenticated
  using (
    availability_status = 'ready'
    and rights_status = 'cleared'
    and catalogue_access.movie_is_public(movie_id)
    -- Filtered by the vjs policy (active only): is_active itself is not granted.
    and exists (select 1 from public.vjs v where v.id = vj_id)
  );

create policy "episode_versions: read public"
  on public.episode_versions for select to anon, authenticated
  using (
    availability_status = 'ready'
    and rights_status = 'cleared'
    and catalogue_access.episode_is_public(episode_id)
    -- Filtered by the vjs policy (active only): is_active itself is not granted.
    and exists (select 1 from public.vjs v where v.id = vj_id)
  );

create policy "genres: read all"
  on public.genres for select to anon, authenticated
  using (true);

create policy "movie_genres: read public"
  on public.movie_genres for select to anon, authenticated
  using (catalogue_access.movie_is_public(movie_id));

create policy "series_genres: read public"
  on public.series_genres for select to anon, authenticated
  using (catalogue_access.series_is_public(series_id));

-- ---------------------------------------------------------------------------
-- Grants: SELECT only, column-level, display fields only. Nothing else changes:
-- no write grant, no sequence grant, and service_role stays without access.
-- ---------------------------------------------------------------------------
grant select (id, slug, name, description, avatar_url, badge_variant, sort_order)
  on public.vjs to anon, authenticated;

grant select (
  id, slug, title, original_title, overview, release_date, runtime_minutes,
  poster_path, backdrop_path, tmdb_id, tmdb_vote_average, tmdb_vote_count,
  is_featured, published_at
) on public.movies to anon, authenticated;

grant select (
  id, slug, title, original_title, overview, first_air_date,
  poster_path, backdrop_path, tmdb_id, tmdb_vote_average, tmdb_vote_count,
  is_featured, published_at
) on public.series to anon, authenticated;

grant select (id, series_id, season_number, title, overview, air_date, poster_path)
  on public.seasons to anon, authenticated;

grant select (
  id, season_id, episode_number, title, overview, air_date, runtime_minutes, still_path
) on public.episodes to anon, authenticated;

grant select (id, movie_id, vj_id, title_override, available_at)
  on public.movie_versions to anon, authenticated;

grant select (id, episode_id, vj_id, title_override, available_at)
  on public.episode_versions to anon, authenticated;

grant select (id, slug, name) on public.genres to anon, authenticated;
grant select (movie_id, genre_id) on public.movie_genres to anon, authenticated;
grant select (series_id, genre_id) on public.series_genres to anon, authenticated;

