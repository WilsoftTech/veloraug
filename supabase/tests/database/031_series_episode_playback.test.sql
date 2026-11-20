-- Series support (20261119194500_series_episode_playback.sql): the episode
-- resolver, the series-aware verification claim and owner episode publication.
-- Synthetic documents only. Everything runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
create schema tests;

create function tests.media(p_bot text, p_chat bigint, p_message integer, p_name text, p_size bigint default 1000)
returns bigint language sql as $$
  insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, file_name, mime_type, file_size_bytes, telegram_date)
  values (p_bot, p_chat, p_message, 'synthetic-' || p_bot || p_message, 'AgADseries' || p_bot || p_message, 'document', p_name, 'video/mp4', p_size, now())
  returning id
$$;
-- A passing whole-file result in the worker's format (as 024_media_verification_on_upload).
create function tests.evidence(p_id bigint) returns jsonb language sql as $$
  select jsonb_build_object('identity', private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes),
    'method', 'full_original_v1', 'inspection_scope', 'whole_file', 'policy_version', 3, 'media_class', 'original', 'reasons', '[]'::jsonb,
    'container', 'mp4', 'video_codec', 'h264', 'audio_codec', 'aac', 'accessible', true, 'gateway_compatible', true, 'playback_ready', false, 'bytes_read', 1100,
    'assessment', jsonb_build_object('accepted', true, 'container', 'mp4', 'integrity', 'verified', 'streaming', 'verified', 'download', 'original_servable',
      'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb,
      'compatibility', jsonb_build_object('basis', 'tested_fixture_combinations', 'perFile', 'prediction',
        'evidence', 'docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
        'chromium', 'tested_combination', 'firefox', 'tested_combination',
        'safari', 'real_device_not_tested', 'ios', 'real_device_not_tested', 'android', 'real_device_not_tested'),
      'tracks', '[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"attachedPicture":false}]'::jsonb,
      'verification', jsonb_build_object('contract', 1, 'digest', jsonb_build_object('algorithm', 'sha256', 'value', repeat('b', 64), 'bytes', m.file_size_bytes),
        'integrity', jsonb_build_object('status', 'verified', 'method', 'whole_file_decode_v1', 'duration_seconds', 3000, 'decoded_seconds', 3000, 'reasons', '[]'::jsonb),
        'streaming', jsonb_build_object('status', 'verified', 'method', 'sampled_seek_decode_v1', 'layout', 'mp4_head_index', 'reasons', '[]'::jsonb,
          'samples', '[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":1500,"decoded":true},{"position":"end","seconds":2700,"decoded":true}]'::jsonb),
        'download', jsonb_build_object('status', 'original_servable', 'reasons', '[]'::jsonb),
        'tools', jsonb_build_object('ffmpeg', '9.0.2', 'ffprobe', '9.0.2'),
        'started_at', '2026-11-19T07:00:00.000Z', 'finished_at', '2026-11-19T07:10:00.000Z')))
  from private.telegram_media m where m.id = p_id
$$;
-- Claims the next document as a series-capable worker and records a passing result for it.
create function tests.verify_next() returns bigint language plpgsql as $$
declare c jsonb;
begin
  c := public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['movie', 'series']);
  if c is null then return null; end if;
  perform public.media_verification_finish((c->>'media_id')::bigint, (c->>'lease')::uuid, c->>'identity', tests.evidence((c->>'media_id')::bigint), null);
  return (c->>'media_id')::bigint;
end $$;
create function tests.series(p_tmdb integer default 71446) returns jsonb language sql as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', 'Synthetic Heist', 'original_title', 'La casa sintética', 'overview', 'A synthetic series.',
    'first_air_date', '2017-05-02', 'poster_path', '/poster.jpg', 'backdrop_path', null, 'vote_average', 8.24, 'vote_count', 100,
    'genres', '[{"tmdb_id":80,"name":"Crime"},{"tmdb_id":10759,"name":"Action & Adventure"}]'::jsonb)
$$;
create function tests.season(p_number integer default 1) returns jsonb language sql as $$
  select jsonb_build_object('season_number', p_number, 'title', 'Part ' || p_number, 'overview', null, 'air_date', '2017-05-02', 'poster_path', null)
$$;
create function tests.episode(p_number integer, p_tmdb integer) returns jsonb language sql as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'episode_number', p_number, 'title', 'Episode ' || p_number, 'overview', null,
    'air_date', '2017-05-02', 'runtime_minutes', 47, 'still_path', null)
$$;
create function tests.publish(p_media bigint, p_vj bigint, p_episode jsonb, p_rights boolean default true, p_series jsonb default null) returns text
language plpgsql as $$
declare r record;
begin
  select * into r from private.catalogue_publish_episode(p_media, p_vj, coalesce(p_series, tests.series()), tests.season(), p_episode, p_rights);
  return 'published:' || r.episode_version_id;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
-- Resolver row count (SECURITY DEFINER: the caller does not matter; execute rights are checked above).
create function tests.resolve(p_version bigint) returns integer language sql as $$
  select count(*)::integer from media_gateway.resolve_episode_version(p_version)
$$;

create temp table media (label text primary key, id bigint);
insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into public.vjs (slug, name, is_active) values ('vj-series', 'VJ Series', true), ('vj-series-b', 'VJ Series B', true), ('vj-inactive', 'VJ Inactive', false);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('velora_media_gateway', 'media_gateway.resolve_episode_version(bigint)', 'execute'), 'the gateway may resolve episodes');
select ok(not has_function_privilege(r, 'media_gateway.resolve_episode_version(bigint)', 'execute'), r || ' may not resolve episodes')
  from unnest(array['anon', 'authenticated', 'service_role', 'velora_upload_worker', 'velora_discovery_worker', 'velora_review_service']) r where to_regrole(r) is not null;
select ok(has_function_privilege('velora_discovery_worker', 'public.media_verification_claim_v2(uuid,integer,integer,text[])', 'execute'), 'the worker may claim series media');
select ok(not has_function_privilege(r, 'public.media_verification_claim_v2(uuid,integer,integer,text[])', 'execute'), r || ' may not claim')
  from unnest(array['anon', 'authenticated', 'service_role', 'velora_upload_worker', 'velora_review_service', 'velora_media_gateway']) r where to_regrole(r) is not null;
select ok(not has_function_privilege(r, 'private.catalogue_publish_episode(bigint,bigint,jsonb,jsonb,jsonb,boolean)', 'execute'), r || ' may not publish episodes')
  from unnest(array['public', 'anon', 'authenticated', 'service_role', 'velora_upload_worker', 'velora_discovery_worker', 'velora_review_service', 'velora_media_gateway']) r
  where r = 'public' or to_regrole(r) is not null;
select ok(not has_function_privilege('public', 'media_gateway.resolve_episode_version(bigint)', 'execute'), 'PUBLIC may not resolve episodes');
select ok(not has_function_privilege('public', 'public.media_verification_claim_v2(uuid,integer,integer,text[])', 'execute'), 'PUBLIC may not claim');
select ok((select bool_and(prosecdef and proconfig = array['search_path=""']) from pg_proc where oid in
  ('media_gateway.resolve_episode_version(bigint)'::regprocedure, 'public.media_verification_claim_v2(uuid,integer,integer,text[])'::regprocedure)),
  'definers pin an empty search_path');
select ok((select not prosecdef and proconfig = array['search_path=""'] from pg_proc
  where oid = 'private.catalogue_publish_episode(bigint,bigint,jsonb,jsonb,jsonb,boolean)'::regprocedure), 'publication is SECURITY INVOKER with an empty search_path');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'media_gateway' and p.proname = 'resolve_episode_version'), 1, 'one episode resolver');

-- ---------------------------------------------------------------------------
-- Series-aware verification claim
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.media_verification_claim_v2(gen_random_uuid(), 600, 60, null) $$, '22023', 'media_verification_invalid_input', 'bot types required');
select throws_ok($$ select public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array[]::text[]) $$, '22023', 'media_verification_invalid_input', 'bot types not empty');
select throws_ok($$ select public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['movie', 'webhook']) $$, '22023', 'media_verification_invalid_input', 'only movie and series');
select throws_ok($$ select public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['series', null]) $$, '22023', 'media_verification_invalid_input', 'no null bot type');
select throws_ok($$ select public.media_verification_claim_v2(gen_random_uuid(), 14401, 60, array['series']) $$, '22023', 'media_verification_invalid_input', 'lease bounded');

insert into media values ('e1', tests.media('series', -1002222222222, 12, 'Synthetic Heist S01E01.mp4')),
  ('e2', tests.media('series', -1002222222222, 13, 'Synthetic Heist S01E02.mp4')),
  ('e3', tests.media('series', -1002222222222, 14, 'Synthetic Heist S01E03.mp4')),
  ('elsewhere', tests.media('series', -1003333333333, 15, 'Elsewhere S01E01.mp4')),
  ('movie', tests.media('movie', -1001111111111, 16, 'A Movie.mp4'));
-- Before the Series channel is registered nothing of it is claimable; the movie still is.
select is((public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['series']))::text, null, 'series media in an unregistered channel is skipped');
insert into private.telegram_channels (bot_type, chat_id) values ('series', -1002222222222);
select is((public.media_verification_claim(gen_random_uuid(), 600, 60)->>'media_id')::bigint, (select id from media where label = 'movie'),
  'the original claim still serves movie media only');
select is((public.media_verification_claim(gen_random_uuid(), 600, 60))::text, null, 'the original claim never returns series media');
select is((public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['movie']))::text, null, 'a movie-only worker is never handed series media');
select is(tests.verify_next(), (select id from media where label = 'e1'), 'a series-capable worker claims the first episode');
select is(tests.verify_next(), (select id from media where label = 'e2'), 'then the second');
select is((select count(*)::integer from private.media_evidence where telegram_media_id = (select id from media where label = 'e1') and scope = 'whole_file'), 1,
  'the finish command records series whole-file evidence unchanged');
-- e3 stays unverified; the unregistered channel is still skipped.
select is((public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['series'])->>'media_id')::bigint, (select id from media where label = 'e3'),
  'the third episode is next; the other channel never is');
update private.media_verification_jobs set lease_token = null, lease_until = null where telegram_media_id = (select id from media where label = 'e3');

-- ---------------------------------------------------------------------------
-- Owner episode publication: gates
-- ---------------------------------------------------------------------------
select is(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001), false),
  '22023:catalogue_invalid_input', 'rights must be recorded as cleared');
select is(tests.publish((select id from media where label = 'e3'), (select id from public.vjs where slug = 'vj-series'), tests.episode(3, 900003)),
  'P0001:catalogue_media_not_verified', 'media without whole-file evidence is refused');
select is(tests.publish((select id from media where label = 'movie'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001)),
  'P0001:catalogue_media_not_registered', 'movie media is refused');
select is(tests.publish((select id from media where label = 'elsewhere'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001)),
  'P0001:catalogue_media_not_registered', 'media outside the registered Series channel is refused');
select is(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-inactive'), tests.episode(1, 900001)),
  'P0001:catalogue_vj_not_active', 'an inactive VJ is refused');
select is(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001) || '{"extra":1}'),
  '22023:catalogue_invalid_input', 'an episode snapshot with unknown keys is refused');
select is(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001), true,
  tests.series() || '{"poster_path":"https://example.invalid/x.jpg"}'), '22023:catalogue_invalid_input', 'artwork must be a TMDB path');
select is((select count(*)::integer from public.series), 0, 'refusals leave no catalogue rows');

-- Publication
select matches(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001)),
  '^published:[0-9]+$', 'a verified episode is published');
select is((select slug || ':' || publication_status || ':' || (published_at is not null)::text from public.series where tmdb_id = 71446),
  'synthetic-heist-2017:published:true', 'the series is created and published with a year slug');
select is((select count(*)::integer from public.series_genres sg join public.series s on s.id = sg.series_id where s.tmdb_id = 71446), 2, 'series genres are linked');
select is((select count(*)::integer from public.genres where tmdb_tv_id in (80, 10759)), 2, 'genres carry their TMDB TV ids');
select is((select availability_status || ':' || rights_status || ':' || (available_at is not null)::text || ':' || (telegram_media_id = (select id from media where label = 'e1'))::text
  from public.episode_versions), 'ready:cleared:true:true', 'the version is ready, cleared and bound to the media');
select is((select s.season_number || '/' || e.episode_number || '/' || e.tmdb_id from public.episodes e join public.seasons s on s.id = e.season_id),
  '1/1/900001', 'season and episode come from the snapshots');
-- Replay is idempotent and returns the same version.
select is(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001)),
  'published:' || (select id from public.episode_versions), 'a replay returns the same version');
select is((select count(*)::integer from public.episode_versions), 1, 'and creates nothing new');
-- Conflicts are review decisions, never made by the function.
select is(tests.publish((select id from media where label = 'e2'), (select id from public.vjs where slug = 'vj-series'), tests.episode(1, 900001)),
  'P0001:catalogue_version_conflict', 'other media for the same episode and VJ is refused');
select is(tests.publish((select id from media where label = 'e2'), (select id from public.vjs where slug = 'vj-series-b'), tests.episode(1, 900099)),
  'P0001:catalogue_episode_conflict', 'a different TMDB episode at the same number is refused');
select is(tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series-b'), tests.episode(1, 900001)),
  'P0001:catalogue_version_conflict', 'one document cannot back two versions');
select matches(tests.publish((select id from media where label = 'e2'), (select id from public.vjs where slug = 'vj-series'), tests.episode(2, 900002)),
  '^published:[0-9]+$', 'the second episode joins the same series and season');
select is((select count(*)::integer from public.series) || '/' || (select count(*)::integer from public.seasons) || '/' || (select count(*)::integer from public.episodes),
  '1/1/2', 'one series, one season, two episodes');

-- ---------------------------------------------------------------------------
-- Public read and the gateway resolver
-- ---------------------------------------------------------------------------
create temp table v as select ev.id, e.episode_number from public.episode_versions ev join public.episodes e on e.id = ev.episode_id;
set local role anon;
select is((select count(*)::integer from public.episode_versions), 2, 'anon reads both published episode versions');
select is((select count(*)::integer from public.series where slug = 'synthetic-heist-2017'), 1, 'anon reads the published series');
reset role;
select is(tests.resolve((select id from v where episode_number = 1)), 1, 'the gateway resolves a published episode');
select is((select r.message_id::text || ':' || r.file_size_bytes from media_gateway.resolve_episode_version((select id from v where episode_number = 1)) r),
  '12:1000', 'with its Series-channel transport fields');
select is(tests.resolve(0), 0, 'no row for id 0');
select is(tests.resolve(999999), 0, 'no row for an unknown id');
update public.vjs set is_active = false where slug = 'vj-series';
select is(tests.resolve((select id from v where episode_number = 1)), 0, 'no row while the VJ is inactive');
update public.vjs set is_active = true where slug = 'vj-series';
update public.episode_versions set availability_status = 'unavailable' where id = (select id from v where episode_number = 2);
select is(tests.resolve((select id from v where episode_number = 2)), 0, 'no row for an unavailable version');
select is(tests.resolve((select id from v where episode_number = 1)), 1, 'the other episode is unaffected');
update public.series set publication_status = 'archived' where tmdb_id = 71446;
select is(tests.resolve((select id from v where episode_number = 1)), 0, 'no row once the series is withdrawn');
update public.series set publication_status = 'published' where tmdb_id = 71446;
delete from private.telegram_channels where bot_type = 'series';
select is(tests.resolve((select id from v where episode_number = 1)), 0, 'no row when the Series channel is not registered');

select * from finish();
rollback;
