-- Catalogue public read contract (20260923210000_catalogue_public_read.sql).
--
-- Fixtures cover every hidden case: draft, archived, rights-blocked, unready,
-- unavailable, inactive-VJ-only and version-less titles; the inactive VJ's
-- version of a public title; seasons/episodes without a public version.
-- The same assertions run as anon and as authenticated.
-- Everything runs in one transaction and is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(64);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres, which owns the tables and bypasses RLS)
-- ---------------------------------------------------------------------------
create schema tests;
grant usage on schema tests to anon, authenticated;
create sequence tests.message_id;

create function tests.media(p_bot text) returns bigint language sql as $$
  insert into private.telegram_media
    (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
  select p_bot, -100, n, 'file-' || n, 'unique-' || n, 'video', now()
  from (select nextval('tests.message_id') as n) s
  returning id
$$;

create function tests.movie_version(p_movie text, p_vj text, p_availability text, p_rights text)
returns void language sql as $$
  insert into public.movie_versions
    (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select m.id, v.id, p_availability, p_rights,
    case when p_availability = 'ready' then now() end,
    case when p_availability = 'ready' then tests.media('movie') end
  from public.movies m, public.vjs v
  where m.slug = p_movie and v.slug = p_vj
$$;

-- Creates season/episode as needed, then one version of that episode.
create function tests.episode_version(
  p_series text, p_season int, p_episode int, p_vj text, p_availability text, p_rights text
) returns void language plpgsql as $$
declare
  v_season bigint;
  v_episode bigint;
begin
  insert into public.seasons (series_id, season_number)
  select id, p_season from public.series where slug = p_series
  on conflict (series_id, season_number) do nothing;
  select s.id into v_season from public.seasons s join public.series sr on sr.id = s.series_id
  where sr.slug = p_series and s.season_number = p_season;

  insert into public.episodes (season_id, episode_number, title)
  values (v_season, p_episode, p_series || ' ' || p_season || 'x' || p_episode)
  on conflict (season_id, episode_number) do nothing;
  select id into v_episode from public.episodes
  where season_id = v_season and episode_number = p_episode;

  insert into public.episode_versions
    (episode_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select v_episode, v.id, p_availability, p_rights,
    case when p_availability = 'ready' then now() end,
    case when p_availability = 'ready' then tests.media('series') end
  from public.vjs v where v.slug = p_vj;
end;
$$;

insert into public.vjs (slug, name, is_active) values
  ('vj-active', 'VJ Active', true),
  ('vj-inactive', 'VJ Inactive', false);

insert into public.movies (slug, title, publication_status, published_at) values
  ('m-public', 'Public', 'published', now()),
  ('m-draft', 'Draft', 'draft', null),
  ('m-archived', 'Archived', 'archived', null),
  ('m-blocked', 'Blocked', 'published', now()),
  ('m-unready', 'Unready', 'published', now()),
  ('m-unavailable', 'Unavailable', 'published', now()),
  ('m-inactive-vj', 'Inactive VJ', 'published', now()),
  ('m-no-version', 'No Version', 'published', now());

select tests.movie_version('m-public', 'vj-active', 'ready', 'cleared');
select tests.movie_version('m-public', 'vj-inactive', 'ready', 'cleared');
select tests.movie_version('m-draft', 'vj-active', 'ready', 'cleared');
select tests.movie_version('m-archived', 'vj-active', 'ready', 'cleared');
select tests.movie_version('m-blocked', 'vj-active', 'ready', 'blocked');
select tests.movie_version('m-unready', 'vj-active', 'draft', 'cleared');
select tests.movie_version('m-unavailable', 'vj-active', 'unavailable', 'cleared');
select tests.movie_version('m-inactive-vj', 'vj-inactive', 'ready', 'cleared');

insert into public.series (slug, title, publication_status, published_at) values
  ('s-public', 'Public Series', 'published', now()),
  ('s-draft', 'Draft Series', 'draft', null),
  ('s-blocked', 'Blocked Series', 'published', now()),
  ('s-inactive-vj', 'Inactive VJ Series', 'published', now());

-- s-public: only 1x1 is public (plus a hidden inactive-VJ version of it).
select tests.episode_version('s-public', 1, 1, 'vj-active', 'ready', 'cleared');
select tests.episode_version('s-public', 1, 1, 'vj-inactive', 'ready', 'cleared');
select tests.episode_version('s-public', 1, 2, 'vj-active', 'unavailable', 'cleared');
select tests.episode_version('s-public', 1, 3, 'vj-inactive', 'ready', 'cleared');
select tests.episode_version('s-public', 2, 1, 'vj-active', 'draft', 'cleared');
select tests.episode_version('s-draft', 1, 1, 'vj-active', 'ready', 'cleared');
select tests.episode_version('s-blocked', 1, 1, 'vj-active', 'ready', 'blocked');
select tests.episode_version('s-inactive-vj', 1, 1, 'vj-inactive', 'ready', 'cleared');

insert into public.genres (slug, name) values ('drama', 'Drama');
insert into public.movie_genres (movie_id, genre_id)
select m.id, g.id from public.movies m, public.genres g
where m.slug in ('m-public', 'm-draft') and g.slug = 'drama';
insert into public.series_genres (series_id, genre_id)
select s.id, g.id from public.series s, public.genres g
where s.slug in ('s-public', 's-draft') and g.slug = 'drama';

-- ---------------------------------------------------------------------------
-- Assertions, run as the current role (security invoker)
-- ---------------------------------------------------------------------------
create function tests.catalogue_checks(p_role text) returns setof text language plpgsql as $$
begin
  -- Visible rows: exactly the eligible published records.
  return next is(
    (select array_agg(slug order by slug) from public.vjs),
    array['vj-active'], p_role || ': only active VJs');
  return next is(
    (select array_agg(slug order by slug) from public.movies),
    array['m-public'], p_role || ': only the published, ready, cleared, active-VJ movie');
  return next is(
    (select count(*)::int from public.movie_versions), 1,
    p_role || ': only the public movie''s active-VJ version');
  return next is(
    (select array_agg(m.slug || '/' || v.slug) from public.movie_versions mv
       join public.movies m on m.id = mv.movie_id join public.vjs v on v.id = mv.vj_id),
    array['m-public/vj-active'], p_role || ': visible movie version is the active-VJ one');
  return next is(
    (select array_agg(slug order by slug) from public.series),
    array['s-public'], p_role || ': only the published series with a public episode');
  return next is(
    (select array_agg(season_number order by season_number) from public.seasons),
    array[1], p_role || ': only seasons that have a public episode');
  return next is(
    (select array_agg(title order by title) from public.episodes),
    array['s-public 1x1'], p_role || ': only episodes with a ready, cleared, active-VJ version');
  return next is(
    (select count(*)::int from public.episode_versions), 1,
    p_role || ': only the public episode''s active-VJ version');
  return next is(
    (select array_agg(slug) from public.genres), array['drama'], p_role || ': genres are readable');
  return next is(
    (select count(*)::int from public.movie_genres), 1, p_role || ': movie genre links for public movies only');
  return next is(
    (select count(*)::int from public.series_genres), 1, p_role || ': series genre links for public series only');
  return next is(
    (select count(*)::int from public.movies where slug in ('m-draft', 'm-archived', 'm-blocked', 'm-unready')),
    0, p_role || ': hidden movies are not reachable by slug');

  -- Hidden security columns can be neither read nor filtered on.
  return next throws_ok($q$select publication_status from public.movies$q$, '42501', null,
    p_role || ': cannot read movies.publication_status');
  return next throws_ok($q$select id from public.movies where publication_status = 'draft'$q$, '42501', null,
    p_role || ': cannot filter movies by publication_status');
  return next throws_ok($q$select id from public.series where publication_status = 'draft'$q$, '42501', null,
    p_role || ': cannot filter series by publication_status');
  return next throws_ok($q$select id from public.movie_versions where rights_status = 'blocked'$q$, '42501', null,
    p_role || ': cannot filter versions by rights_status');
  return next throws_ok($q$select id from public.episode_versions where availability_status = 'draft'$q$, '42501', null,
    p_role || ': cannot filter versions by availability_status');
  return next throws_ok($q$select id from public.vjs where not is_active$q$, '42501', null,
    p_role || ': cannot filter VJs by is_active');
  return next throws_ok($q$select * from public.movies$q$, '42501', null,
    p_role || ': select * is refused (column-level grants)');

  -- Telegram references are never readable.
  return next throws_ok($q$select telegram_media_id from public.movie_versions$q$, '42501', null,
    p_role || ': cannot read movie_versions.telegram_media_id');
  return next throws_ok($q$select telegram_media_id from public.episode_versions$q$, '42501', null,
    p_role || ': cannot read episode_versions.telegram_media_id');
  return next throws_ok($q$select id from private.telegram_media$q$, '42501', null,
    p_role || ': cannot read private.telegram_media');
  return next throws_ok($q$select id from private.ingestion_events$q$, '42501', null,
    p_role || ': cannot read private.ingestion_events');
  return next throws_ok($q$select id from private.metadata_match_candidates$q$, '42501', null,
    p_role || ': cannot read private.metadata_match_candidates');

  -- No catalogue writes.
  return next throws_ok($q$insert into public.movies (slug, title) values ('x', 'X')$q$, '42501', null,
    p_role || ': cannot insert movies');
  return next throws_ok($q$update public.movies set title = 'X'$q$, '42501', null,
    p_role || ': cannot update movies');
  return next throws_ok($q$delete from public.vjs$q$, '42501', null,
    p_role || ': cannot delete VJs');
  return next throws_ok($q$insert into public.vjs (slug, name) values ('x', 'X')$q$, '42501', null,
    p_role || ': cannot insert VJs');
  return next throws_ok($q$update public.movie_versions set title_override = 'X'$q$, '42501', null,
    p_role || ': cannot update movie versions');
  return next throws_ok($q$insert into public.genres (slug, name) values ('x', 'X')$q$, '42501', null,
    p_role || ': cannot insert genres');
  return next throws_ok($q$delete from public.episodes$q$, '42501', null,
    p_role || ': cannot delete episodes');
end;
$$;
grant execute on function tests.catalogue_checks(text) to anon, authenticated;

-- Sanity: the fixtures really contain the hidden rows (owner view).
select is((select count(*)::int from public.movies), 8, 'fixtures: 8 movies exist');
select is((select count(*)::int from public.episodes), 7, 'fixtures: 7 episodes exist');

set local role anon;
select tests.catalogue_checks('anon');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c0de", "role": "authenticated"}';
select tests.catalogue_checks('authenticated');
reset role;

select * from finish();
rollback;
