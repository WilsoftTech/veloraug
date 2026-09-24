-- Watchlist security and identity (20260919000000, 20260920000000,
-- 20260922080911): own-row RLS, cross-user isolation, legacy TMDB
-- normalization, internal catalogue ids, duplicates, the 500-item cap, and
-- that the SECURITY DEFINER trigger does not leak catalogue rows.
-- Everything runs in one transaction and is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function tests.as_user(uuid) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'one@example.test', '{"display_name": "  One  "}'),
  ('00000000-0000-0000-0000-0000000000b2', 'two@example.test', '{}');

-- Published movies (TMDB 550, and 552 which is never saved), draft movie mapped
-- to TMDB 551, published series (TMDB 1399).
insert into public.vjs (slug, name, is_active) values ('vj', 'VJ', true);
insert into private.telegram_media
  (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
values ('movie', -1, 1, 'f1', 'u1', 'video', now()),
       ('series', -1, 2, 'f2', 'u2', 'video', now()),
       ('movie', -1, 3, 'f3', 'u3', 'video', now());
insert into public.movies (slug, title, tmdb_id, publication_status, published_at) values
  ('published-movie', 'Published Movie', 550, 'published', now()),
  ('draft-movie', 'Draft Movie', 551, 'draft', null),
  ('second-movie', 'Second Movie', 552, 'published', now());
insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
select m.id, v.id, 'ready', 'cleared', now(), t.id
from public.movies m, public.vjs v, private.telegram_media t
where (m.slug, t.file_unique_id) in (('published-movie', 'u1'), ('second-movie', 'u3'));
insert into public.series (slug, title, tmdb_id, publication_status, published_at) values
  ('published-series', 'Published Series', 1399, 'published', now());
insert into public.seasons (series_id, season_number) select id, 1 from public.series;
insert into public.episodes (season_id, episode_number) select id, 1 from public.seasons;
insert into public.episode_versions (episode_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
select e.id, v.id, 'ready', 'cleared', now(), t.id
from public.episodes e, public.vjs v, private.telegram_media t where t.file_unique_id = 'u2';

create table tests.ids as
select (select id from public.movies where slug = 'published-movie') as published_movie,
       (select id from public.movies where slug = 'draft-movie') as draft_movie,
       (select id from public.movies where slug = 'second-movie') as second_movie,
       (select id from public.series where slug = 'published-series') as published_series;
grant select on tests.ids to authenticated;

select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  'One', 'signup trigger creates a profile with a trimmed display name');

-- ---------------------------------------------------------------------------
-- Anonymous visitors have no watchlist access
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($q$select id from public.watchlist_items$q$, '42501', null, 'anon: cannot read watchlist_items');
select throws_ok($q$insert into public.watchlist_items (tmdb_id, media_type) values (1, 'movie')$q$,
  '42501', null, 'anon: cannot insert watchlist_items');
select throws_ok($q$select id from public.profiles$q$, '42501', null, 'anon: cannot read profiles');
reset role;

-- ---------------------------------------------------------------------------
-- User one: identity normalization and duplicates
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.as_user('00000000-0000-0000-0000-0000000000a1');

insert into public.watchlist_items (tmdb_id, media_type) values (550, 'movie');
select is(
  (select movie_id from public.watchlist_items where tmdb_id = 550),
  (select published_movie from tests.ids),
  'legacy TMDB save of a published movie is normalized to movie_id');

insert into public.watchlist_items (tmdb_id, media_type) values (550, 'movie');
insert into public.watchlist_items (movie_id, media_type) select published_movie, 'movie' from tests.ids;
select is((select count(*)::int from public.watchlist_items), 1,
  'repeat legacy and internal saves of the same movie are no-ops');

insert into public.watchlist_items (tmdb_id, media_type) values (1399, 'tv');
select results_eq(
  $q$select series_id, media_type from public.watchlist_items where tmdb_id = 1399$q$,
  $q$select published_series, 'series'::text from tests.ids$q$,
  'legacy TMDB tv save is normalized to series_id / series');

insert into public.watchlist_items (series_id, media_type) select published_series, 'series' from tests.ids;
select is((select count(*)::int from public.watchlist_items where media_type = 'series'), 1,
  'internal series save after its legacy save is a no-op');

insert into public.watchlist_items (tmdb_id, media_type) values (999999, 'movie');
select results_eq(
  $q$select movie_id, series_id, tmdb_id from public.watchlist_items where tmdb_id = 999999$q$,
  $q$values (null::bigint, null::bigint, 999999)$q$,
  'unmapped TMDB title stays a legacy tmdb_id row');

insert into public.watchlist_items (tmdb_id, media_type) values (999999, 'movie');
select is((select count(*)::int from public.watchlist_items where tmdb_id = 999999), 1,
  'duplicate legacy save is a no-op');

select is(
  (select user_id from public.watchlist_items limit 1),
  '00000000-0000-0000-0000-0000000000a1'::uuid, 'user_id defaults to the caller');

select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select second_movie, 'tv' from tests.ids$q$,
  '23514', null, 'identity check rejects a movie_id stored as tv');
select throws_ok(
  $q$insert into public.watchlist_items (media_type) values ('movie')$q$,
  '23514', null, 'identity check rejects a row with no identity');
select throws_ok(
  $q$insert into public.watchlist_items (user_id, tmdb_id, media_type)
     values ('00000000-0000-0000-0000-0000000000b2', 42, 'movie')$q$,
  '42501', null, 'cannot insert a row for another user');
select throws_ok(
  $q$update public.watchlist_items set tmdb_id = 1$q$,
  '42501', null, 'watchlist rows are immutable (no UPDATE grant)');

-- Catalogue security is not bypassed through the watchlist or its trigger.
-- Since B4 (20260924195306) the SECURITY DEFINER trigger normalizes only onto
-- public titles, so a draft-mapped TMDB save stays legacy and reveals no id.
insert into public.watchlist_items (tmdb_id, media_type) values (551, 'movie');
select is(
  (select movie_id from public.watchlist_items where tmdb_id = 551),
  null::bigint,
  'legacy save of a draft-mapped TMDB id stays legacy (no draft id revealed)');
select is(
  (select array_agg(m.slug order by m.slug) from public.watchlist_items w join public.movies m on m.id = w.movie_id),
  array['published-movie'],
  'joining the watchlist to movies still returns published movies only');
select is(
  (select count(*)::int from public.movies where id = (select draft_movie from tests.ids)),
  0, 'the draft movie stays unreadable');
select throws_ok(
  $q$select publication_status from public.movies$q$, '42501', null,
  'watchlist access grants no catalogue workflow columns');
select throws_ok(
  $q$select private.enforce_watchlist_limit()$q$, '42501', null,
  'the watchlist trigger function cannot be called directly');

-- ---------------------------------------------------------------------------
-- The 500-item cap (user one currently has 4 rows)
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.watchlist_items), 4, 'user one has 4 rows before the cap test');
insert into public.watchlist_items (tmdb_id, media_type)
select g, 'movie' from generate_series(100001, 100496) g;
select is((select count(*)::int from public.watchlist_items), 500, 'user one can fill the list to 500');
select throws_ok(
  $q$insert into public.watchlist_items (tmdb_id, media_type) values (200000, 'movie')$q$,
  '23514', 'Watchlist limit reached', 'the 501st title is rejected');
insert into public.watchlist_items (tmdb_id, media_type) values (550, 'movie');
select is((select count(*)::int from public.watchlist_items), 500,
  're-saving an existing title at the cap is a harmless no-op');
reset role;

-- ---------------------------------------------------------------------------
-- User two: cross-user isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.as_user('00000000-0000-0000-0000-0000000000b2');

select is((select count(*)::int from public.watchlist_items), 0, 'user two sees none of user one''s rows');
select is((select count(*)::int from public.profiles), 1, 'user two sees only their own profile');
delete from public.watchlist_items where user_id = '00000000-0000-0000-0000-0000000000a1';
insert into public.watchlist_items (tmdb_id, media_type) values (550, 'movie');
select is((select count(*)::int from public.watchlist_items), 1,
  'user two can save a title user one also saved (cap is per user)');
update public.profiles set display_name = 'Hacked' where id = '00000000-0000-0000-0000-0000000000a1';
select throws_ok(
  $q$update public.profiles set avatar_url = 'https://example.test/a.png'$q$,
  '42501', null, 'profiles: only display_name is updatable');
delete from public.watchlist_items;
select is((select count(*)::int from public.watchlist_items), 0, 'user two can remove their own rows');
reset role;

select is(
  (select count(*)::int from public.watchlist_items where user_id = '00000000-0000-0000-0000-0000000000a1'),
  500, 'user two''s delete did not touch user one''s rows');
select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  'One', 'user two could not rename user one');

-- Removal by the owner works for both legacy and internal rows.
set local role authenticated;
select tests.as_user('00000000-0000-0000-0000-0000000000a1');
delete from public.watchlist_items where tmdb_id = 999999;
delete from public.watchlist_items where movie_id = (select published_movie from tests.ids);
select is((select count(*)::int from public.watchlist_items where tmdb_id in (550, 999999)), 0,
  'owner can remove legacy and internal rows');
reset role;

select * from finish();
rollback;
