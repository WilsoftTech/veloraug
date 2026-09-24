-- Roadmap B4: canonical watchlist identity (20260924195306).
-- Internal movie/series ids are canonical and must name a public title at save
-- time; TMDB ids are external and stay a temporary legacy path; invalid or
-- conflicting identity never produces a row; catalogue access is not widened.
-- Everything runs in one transaction and is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(40);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
create schema tests;
grant usage on schema tests to authenticated;
create sequence tests.message_id;

create function tests.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function tests.as_user(uuid) to authenticated;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'one@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'two@example.test');

insert into public.vjs (slug, name, is_active) values ('vj', 'VJ', true);

-- A movie; public when p_status is published and p_rights cleared.
create function tests.movie(p_slug text, p_tmdb int, p_status text, p_rights text) returns void language sql as $$
  insert into public.movies (slug, title, tmdb_id, publication_status, published_at)
  values (p_slug, p_slug, p_tmdb, p_status, case when p_status = 'published' then now() end);
  insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
  select 'movie', -1, n, 'f' || n, 'u' || n, 'video', now() from (select nextval('tests.message_id') n) s;
  insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select m.id, v.id, 'ready', p_rights, now(), (select max(id) from private.telegram_media)
  from public.movies m, public.vjs v where m.slug = p_slug;
$$;

-- A series with one episode; public when published.
create function tests.series(p_slug text, p_tmdb int, p_status text) returns void language sql as $$
  insert into public.series (slug, title, tmdb_id, publication_status, published_at)
  values (p_slug, p_slug, p_tmdb, p_status, case when p_status = 'published' then now() end);
  insert into public.seasons (series_id, season_number) select id, 1 from public.series where slug = p_slug;
  insert into public.episodes (season_id, episode_number)
  select s.id, 1 from public.seasons s join public.series sr on sr.id = s.series_id where sr.slug = p_slug;
  insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
  select 'series', -1, n, 'f' || n, 'u' || n, 'video', now() from (select nextval('tests.message_id') n) s;
  insert into public.episode_versions (episode_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select e.id, v.id, 'ready', 'cleared', now(), (select max(id) from private.telegram_media)
  from public.episodes e join public.seasons s on s.id = e.season_id
  join public.series sr on sr.id = s.series_id, public.vjs v where sr.slug = p_slug;
$$;

select tests.movie('movie-a', 700, 'published', 'cleared');
select tests.movie('movie-fresh', 702, 'published', 'cleared');
select tests.movie('movie-later-hidden', 703, 'published', 'cleared');
select tests.movie('movie-draft', 701, 'draft', 'cleared');
select tests.movie('movie-blocked', 704, 'published', 'blocked');
-- Series ids start above every movie id, so "a movie id used as a series id"
-- (and the reverse) cannot accidentally name a real title.
select setval('public.series_id_seq', (select max(id) from public.movies) + 1000);
select tests.series('series-s', 800, 'published');
select tests.series('series-fresh', 802, 'published');
select tests.series('series-draft', 801, 'draft');

create table tests.ids as select
  (select id from public.movies where slug = 'movie-a') as movie_a,
  (select id from public.movies where slug = 'movie-fresh') as movie_fresh,
  (select id from public.movies where slug = 'movie-later-hidden') as movie_later_hidden,
  (select id from public.movies where slug = 'movie-draft') as movie_draft,
  (select id from public.movies where slug = 'movie-blocked') as movie_blocked,
  (select id from public.series where slug = 'series-s') as series_s,
  (select id from public.series where slug = 'series-fresh') as series_fresh,
  (select id from public.series where slug = 'series-draft') as series_draft,
  (select max(id) + 100000 from public.series) as missing_id;
grant select on tests.ids to authenticated;

select ok(
  (select movie_a not in (select id from public.series) and series_s not in (select id from public.movies) from tests.ids),
  'fixtures: movie and series ids do not overlap');

-- A row saved before B4 whose title is later unpublished (inserted while public).
insert into public.watchlist_items (user_id, movie_id, media_type)
select '00000000-0000-0000-0000-0000000000a1', movie_later_hidden, 'movie' from tests.ids;
update public.movies set publication_status = 'draft', published_at = null where slug = 'movie-later-hidden';

-- ---------------------------------------------------------------------------
-- Internal saves (user one)
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.as_user('00000000-0000-0000-0000-0000000000a1');

select lives_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select movie_a, 'movie' from tests.ids$q$,
  'internal movie save succeeds');
select results_eq(
  $q$select movie_id, series_id, tmdb_id, media_type from public.watchlist_items
     where movie_id = (select movie_a from tests.ids)$q$,
  $q$select movie_a, null::bigint, null::int, 'movie'::text from tests.ids$q$,
  'canonical movie identity is stored (no TMDB id needed)');
insert into public.watchlist_items (movie_id, media_type) select movie_a, 'movie' from tests.ids;
insert into public.watchlist_items (tmdb_id, media_type) values (700, 'movie');
select is(
  (select count(*)::int from public.watchlist_items where movie_id = (select movie_a from tests.ids) or tmdb_id = 700),
  1, 'repeat internal and legacy saves of the movie are idempotent');

select lives_ok(
  $q$insert into public.watchlist_items (series_id, media_type) select series_s, 'series' from tests.ids$q$,
  'internal series save succeeds');
select results_eq(
  $q$select movie_id, series_id, tmdb_id, media_type from public.watchlist_items
     where series_id = (select series_s from tests.ids)$q$,
  $q$select null::bigint, series_s, null::int, 'series'::text from tests.ids$q$,
  'canonical series identity is stored');
insert into public.watchlist_items (series_id, media_type) select series_s, 'series' from tests.ids;
insert into public.watchlist_items (tmdb_id, media_type) values (800, 'tv');
select is(
  (select count(*)::int from public.watchlist_items where series_id = (select series_s from tests.ids) or tmdb_id = 800),
  1, 'repeat internal and legacy saves of the series are idempotent');

-- ---------------------------------------------------------------------------
-- Invalid identities never produce a row
-- ---------------------------------------------------------------------------
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select missing_id, 'movie' from tests.ids$q$,
  '23503', 'Title is not available', 'nonexistent movie id is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (series_id, media_type) select missing_id, 'series' from tests.ids$q$,
  '23503', 'Title is not available', 'nonexistent series id is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (series_id, media_type) select movie_fresh, 'series' from tests.ids$q$,
  '23503', 'Title is not available', 'a movie id supplied as series_id is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select series_fresh, 'movie' from tests.ids$q$,
  '23503', 'Title is not available', 'a series id supplied as movie_id is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, series_id, media_type)
     select movie_fresh, series_fresh, 'movie' from tests.ids$q$,
  '23514', null, 'movie and series identity together are rejected');
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select movie_fresh, 'series' from tests.ids$q$,
  '23514', null, 'movie id with media_type series is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (series_id, media_type) select series_fresh, 'tv' from tests.ids$q$,
  '23514', null, 'series id with legacy media_type tv is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (tmdb_id, media_type) values (9001, 'series')$q$,
  '23514', null, 'a TMDB-only row cannot claim media_type series');
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select movie_draft, 'movie' from tests.ids$q$,
  '23503', 'Title is not available', 'a draft movie id is rejected like a missing one');
select throws_ok(
  $q$insert into public.watchlist_items (series_id, media_type) select series_draft, 'series' from tests.ids$q$,
  '23503', 'Title is not available', 'a draft series id is rejected like a missing one');
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select movie_blocked, 'movie' from tests.ids$q$,
  '23503', 'Title is not available', 'a published movie with no playable version is rejected');
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select movie_later_hidden, 'movie' from tests.ids$q$,
  '23503', 'Title is not available', 'a title that stopped being public cannot be newly saved');
select is(
  (select count(*)::int from public.watchlist_items), 3,
  'rejected saves stored nothing (movie, series, pre-existing row)');

-- ---------------------------------------------------------------------------
-- Legacy TMDB compatibility (temporary, until B5)
-- ---------------------------------------------------------------------------
insert into public.watchlist_items (tmdb_id, media_type) values (702, 'movie');
select results_eq(
  $q$select movie_id, media_type from public.watchlist_items where tmdb_id = 702$q$,
  $q$select movie_fresh, 'movie'::text from tests.ids$q$,
  'legacy TMDB movie save of a public title is stored canonically');
insert into public.watchlist_items (tmdb_id, media_type) values (802, 'tv');
select results_eq(
  $q$select series_id, media_type from public.watchlist_items where tmdb_id = 802$q$,
  $q$select series_fresh, 'series'::text from tests.ids$q$,
  'legacy TMDB tv save of a public series is stored canonically as series');
insert into public.watchlist_items (tmdb_id, media_type) values (701, 'movie');
select results_eq(
  $q$select movie_id, series_id, media_type from public.watchlist_items where tmdb_id = 701$q$,
  $q$values (null::bigint, null::bigint, 'movie'::text)$q$,
  'legacy save of a draft-mapped TMDB movie stays legacy');
insert into public.watchlist_items (tmdb_id, media_type) values (801, 'tv');
select results_eq(
  $q$select movie_id, series_id, media_type from public.watchlist_items where tmdb_id = 801$q$,
  $q$values (null::bigint, null::bigint, 'tv'::text)$q$,
  'legacy save of a draft-mapped TMDB series stays legacy tv');
insert into public.watchlist_items (tmdb_id, media_type) values (424242, 'tv');
select results_eq(
  $q$select movie_id, series_id, media_type from public.watchlist_items where tmdb_id = 424242$q$,
  $q$values (null::bigint, null::bigint, 'tv'::text)$q$,
  'unmapped TMDB title is kept as a legacy row (no catalogue row fabricated)');
select is(
  (select count(*)::int from public.watchlist_items where movie_id is null and series_id is null), 3,
  'legacy rows are exactly the unresolved saves');

-- Existing rows survive later catalogue changes and stay removable.
select is(
  (select movie_id from public.watchlist_items where movie_id = (select movie_later_hidden from tests.ids)),
  (select movie_later_hidden from tests.ids),
  'a saved title that stopped being public is still listed');
select is(
  (select count(*)::int from public.movies where id = (select movie_later_hidden from tests.ids)),
  0, 'the unpublished title itself stays unreadable');
delete from public.watchlist_items where movie_id = (select movie_later_hidden from tests.ids);
select is(
  (select count(*)::int from public.watchlist_items where movie_id = (select movie_later_hidden from tests.ids)),
  0, 'the owner can still remove it');
select is(
  (select count(*)::int from public.watchlist_items
   where num_nonnulls(movie_id, series_id) > 1 or num_nonnulls(movie_id, series_id, tmdb_id) = 0),
  0, 'no stored row is malformed');

-- Internal-id validation grants no catalogue access.
select throws_ok($q$select publication_status from public.movies$q$, '42501', null,
  'hidden movie columns remain inaccessible');
select throws_ok($q$select rights_status from public.movie_versions$q$, '42501', null,
  'hidden version columns remain inaccessible');
select throws_ok($q$select telegram_media_id from public.movie_versions$q$, '42501', null,
  'Telegram references remain inaccessible');
select throws_ok($q$select id from private.telegram_media$q$, '42501', null,
  'private Telegram media remains inaccessible');
reset role;

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------
set local role authenticated;
select tests.as_user('00000000-0000-0000-0000-0000000000b2');
select is((select count(*)::int from public.watchlist_items), 0, 'user two cannot read user one''s rows');
delete from public.watchlist_items;
select lives_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) select movie_a, 'movie' from tests.ids$q$,
  'user two saves the same internal id independently');
reset role;

set local role anon;
select throws_ok(
  $q$insert into public.watchlist_items (movie_id, media_type) values (1, 'movie')$q$,
  '42501', null, 'anon cannot save');
select throws_ok($q$delete from public.watchlist_items$q$, '42501', null, 'anon cannot delete');
reset role;

select is(
  (select count(*)::int from public.watchlist_items where user_id = '00000000-0000-0000-0000-0000000000a1'),
  7, 'user two''s delete did not touch user one''s rows');
select is(
  (select count(*)::int from public.watchlist_items where user_id = '00000000-0000-0000-0000-0000000000b2'),
  1, 'user two has exactly their own row');

select * from finish();
rollback;
