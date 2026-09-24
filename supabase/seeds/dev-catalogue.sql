-- DEVELOPMENT / TEST FIXTURES ONLY. Never load into hosted.
--
-- Loaded explicitly by `npm run test:catalogue` (and for local browsing) with
--   npx supabase@2.117.0 db reset --local --sql-paths ./seeds/dev-catalogue.sql
-- Seeding is disabled in supabase/config.toml, `npm run test:db` resets with no
-- seed, and `supabase db push` never sends seeds unless --include-seed is given.
--
-- Covers the B5 catalogue states: several movies (pagination, ties), one
-- movie from two VJs, missing artwork, a multi-season series with a hidden
-- season, featured titles, genres, and every hidden case (draft, rights-blocked,
-- unready, inactive-VJ-only).

insert into public.vjs (slug, name, description, badge_variant, is_active, sort_order) values
  ('vj-junior', 'VJ Junior', 'Action and thrillers.', 'blue', true, 1),
  ('vj-emmy', 'VJ Emmy', 'Drama and series.', 'rose', true, 2),
  ('vj-retired', 'VJ Retired', null, 'slate', false, 3);

insert into public.genres (slug, name) values ('action', 'Action'), ('drama', 'Drama'), ('comedy', 'Comedy');

-- One Telegram delivery per ready version (a version cannot be ready without media).
insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
select case when n <= 20 then 'movie' else 'series' end, -1001, n, 'dev-file-' || n, 'dev-unique-' || n, 'video', now()
from generate_series(1, 40) n;

insert into public.movies
  (slug, title, overview, release_date, runtime_minutes, poster_path, backdrop_path, tmdb_id, tmdb_vote_average, tmdb_vote_count,
   metadata_status, publication_status, is_featured, published_at) values
  ('last-kingdom-run', 'The Last Kingdom Run', 'A courier races across the city.', '2024-03-01', 118,
   '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', '/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg', 900001, 7.8, 1200, 'reviewed', 'published', true, '2026-09-20 10:00+00'),
  ('kampala-nights', 'Kampala Nights', 'Three friends, one night in Kampala.', '2023-07-15', 95,
   null, null, 900002, null, null, 'reviewed', 'published', false, '2026-09-19 10:00+00'),
  ('river-crossing', 'River Crossing', null, '2022-01-10', 101,
   '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', null, 900003, 6.9, 300, 'matched', 'published', false, '2026-09-18 10:00+00'),
  ('mountain-echo', 'Mountain Echo', null, '2021-05-05', 88,
   null, null, null, null, null, 'unmatched', 'published', false, '2026-09-18 10:00+00'),
  ('city-of-gold', 'City of Gold', null, '2020-11-11', 132,
   null, null, 900005, 7.1, 800, 'reviewed', 'published', false, '2026-09-17 10:00+00'),
  ('secret-draft', 'Secret Draft', null, null, null, null, null, 900010, null, null, 'unmatched', 'draft', false, null),
  ('blocked-feature', 'Blocked Feature', null, null, null, null, null, 900011, null, null, 'reviewed', 'published', false, '2026-09-21 10:00+00'),
  ('unready-feature', 'Unready Feature', null, null, null, null, null, 900012, null, null, 'reviewed', 'published', false, '2026-09-21 10:00+00'),
  ('retired-pick', 'Retired Pick', null, null, null, null, null, 900013, null, null, 'reviewed', 'published', false, '2026-09-21 10:00+00');

-- (movie, vj, availability, rights, media number or null)
insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
select m.id, v.id, x.availability, x.rights, case when x.availability = 'ready' then now() end,
       (select t.id from private.telegram_media t where t.file_unique_id = 'dev-unique-' || x.media)
from (values
  ('last-kingdom-run', 'vj-junior', 'ready', 'cleared', 1),
  ('last-kingdom-run', 'vj-emmy', 'ready', 'cleared', 2),
  ('kampala-nights', 'vj-junior', 'ready', 'cleared', 3),
  ('river-crossing', 'vj-emmy', 'ready', 'cleared', 4),
  ('mountain-echo', 'vj-junior', 'ready', 'cleared', 5),
  ('city-of-gold', 'vj-junior', 'ready', 'cleared', 6),
  ('secret-draft', 'vj-junior', 'ready', 'cleared', 7),
  ('blocked-feature', 'vj-junior', 'ready', 'blocked', 8),
  ('unready-feature', 'vj-junior', 'draft', 'cleared', null),
  ('retired-pick', 'vj-retired', 'ready', 'cleared', 9)
) as x(movie, vj, availability, rights, media)
join public.movies m on m.slug = x.movie
join public.vjs v on v.slug = x.vj;

insert into public.movie_genres (movie_id, genre_id)
select m.id, g.id from (values
  ('last-kingdom-run', 'action'), ('kampala-nights', 'drama'), ('river-crossing', 'drama'),
  ('city-of-gold', 'action'), ('secret-draft', 'action')
) as x(movie, genre)
join public.movies m on m.slug = x.movie
join public.genres g on g.slug = x.genre;

insert into public.series
  (slug, title, overview, first_air_date, poster_path, backdrop_path, tmdb_id, metadata_status, publication_status, is_featured, published_at) values
  ('pearl-of-africa', 'Pearl of Africa', 'A family saga on the shores of Lake Victoria.', '2022-02-01',
   '/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg', '/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg', 900100, 'reviewed', 'published', true, '2026-09-20 09:00+00'),
  ('kampala-diaries', 'Kampala Diaries', null, '2024-01-01', null, null, 900101, 'reviewed', 'published', false, '2026-09-16 09:00+00'),
  ('hidden-series', 'Hidden Series', null, null, null, null, 900102, 'unmatched', 'draft', false, null);

insert into public.seasons (series_id, season_number)
select s.id, x.season from (values
  ('pearl-of-africa', 1), ('pearl-of-africa', 2), ('pearl-of-africa', 3), ('kampala-diaries', 1), ('hidden-series', 1)
) as x(series, season)
join public.series s on s.slug = x.series;

insert into public.episodes (season_id, episode_number, title, runtime_minutes)
select se.id, x.episode, x.title, 45 from (values
  ('pearl-of-africa', 1, 1, 'Homecoming'), ('pearl-of-africa', 1, 2, 'The Harbour'),
  ('pearl-of-africa', 2, 1, 'New Waters'), ('pearl-of-africa', 3, 1, 'Unreleased'),
  ('kampala-diaries', 1, 1, 'Pilot'), ('hidden-series', 1, 1, 'Secret Pilot')
) as x(series, season, episode, title)
join public.series s on s.slug = x.series
join public.seasons se on se.series_id = s.id and se.season_number = x.season;

-- Season 3 of Pearl of Africa has only a draft version, so it stays hidden.
insert into public.episode_versions (episode_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
select e.id, v.id, x.availability, 'cleared', case when x.availability = 'ready' then now() end,
       (select t.id from private.telegram_media t where t.file_unique_id = 'dev-unique-' || x.media)
from (values
  ('pearl-of-africa', 1, 1, 'vj-emmy', 'ready', 21),
  ('pearl-of-africa', 1, 2, 'vj-emmy', 'ready', 22),
  ('pearl-of-africa', 2, 1, 'vj-junior', 'ready', 23),
  ('pearl-of-africa', 3, 1, 'vj-emmy', 'draft', null),
  ('kampala-diaries', 1, 1, 'vj-junior', 'ready', 24),
  ('hidden-series', 1, 1, 'vj-junior', 'ready', 25)
) as x(series, season, episode, vj, availability, media)
join public.series s on s.slug = x.series
join public.seasons se on se.series_id = s.id and se.season_number = x.season
join public.episodes e on e.season_id = se.id and e.episode_number = x.episode
join public.vjs v on v.slug = x.vj;

insert into public.series_genres (series_id, genre_id)
select s.id, g.id from (values ('pearl-of-africa', 'drama'), ('kampala-diaries', 'comedy'), ('hidden-series', 'drama')) as x(series, genre)
join public.series s on s.slug = x.series
join public.genres g on g.slug = x.genre;
