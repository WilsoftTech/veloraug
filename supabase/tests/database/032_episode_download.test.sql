-- Episode downloads (20261120055619_episode_download_resolver.sql): the gateway
-- resolver for original episode files, on top of the published-episode rule.
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
create function tests.publish(p_media bigint, p_vj bigint, p_number integer) returns bigint language sql as $$
  select episode_version_id from private.catalogue_publish_episode(p_media, p_vj,
    jsonb_build_object('tmdb_id', 71446, 'title', 'Synthetic Heist', 'original_title', null, 'overview', null, 'first_air_date', '2017-05-02',
      'poster_path', null, 'backdrop_path', null, 'vote_average', null, 'vote_count', null, 'genres', '[]'::jsonb),
    jsonb_build_object('season_number', 1, 'title', null, 'overview', null, 'air_date', null, 'poster_path', null),
    jsonb_build_object('tmdb_id', 900000 + p_number, 'episode_number', p_number, 'title', null, 'overview', null, 'air_date', null, 'runtime_minutes', null, 'still_path', null),
    true)
$$;
create function tests.download(p_version bigint, p_user uuid) returns text language sql as $$
  select coalesce((select r.message_id || ':' || r.file_size_bytes || ':' || r.mime_type || ':' || r.file_name
    from media_gateway.resolve_episode_download(p_version, p_user) r), 'none')
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('velora_media_gateway', 'media_gateway.resolve_episode_download(bigint,uuid)', 'execute'), 'the gateway may resolve episode downloads');
select ok(not has_function_privilege(r, 'media_gateway.resolve_episode_download(bigint,uuid)', 'execute'), r || ' may not resolve episode downloads')
  from unnest(array['public', 'anon', 'authenticated', 'service_role', 'velora_discovery_worker', 'velora_review_service']) r;
select ok((select prosecdef from pg_proc where oid = 'media_gateway.resolve_episode_download(bigint,uuid)'::regprocedure), 'security definer');
select is((select proconfig from pg_proc where oid = 'media_gateway.resolve_episode_download(bigint,uuid)'::regprocedure), array['search_path=""'], 'empty search_path');
select is((select provolatile from pg_proc where oid = 'media_gateway.resolve_episode_download(bigint,uuid)'::regprocedure), 's'::"char", 'stable');

-- ---------------------------------------------------------------------------
-- Fixtures: two published episodes (MP4 and MKV) and one user
-- ---------------------------------------------------------------------------
insert into private.telegram_channels (bot_type, chat_id) values ('series', -1002222222222);
insert into public.vjs (slug, name, is_active) values ('vj-series', 'VJ Series', true);
create temp table media (label text primary key, id bigint);
insert into media values ('e1', tests.media('series', -1002222222222, 12, 'Synthetic Heist S01E01.mp4')),
                         ('e2', tests.media('series', -1002222222222, 13, 'Synthetic Heist S01E02.mkv'));
update private.telegram_media set mime_type = 'video/x-matroska' where id = (select id from media where label = 'e2');
select isnt(tests.verify_next(), null, 'the first document carries passing whole-file evidence');
select isnt(tests.verify_next(), null, 'the second document carries passing whole-file evidence');
create temp table v (label text primary key, id bigint);
insert into v values ('e1', tests.publish((select id from media where label = 'e1'), (select id from public.vjs where slug = 'vj-series'), 1));
insert into v values ('e2', tests.publish((select id from media where label = 'e2'), (select id from public.vjs where slug = 'vj-series'), 2));
insert into auth.users (id, is_anonymous) values ('00000000-0000-4000-8000-000000000061', false);

-- ---------------------------------------------------------------------------
-- The resolver
-- ---------------------------------------------------------------------------
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'),
  '12:1000:video/mp4:Synthetic Heist S01E01.mp4', 'a signed-in user downloads a published episode with its original filename');
select is(tests.download((select id from v where label = 'e2'), '00000000-0000-4000-8000-000000000061'),
  '13:1000:video/x-matroska:Synthetic Heist S01E02.mkv', 'MKV originals are downloadable');
select is(tests.download(0, '00000000-0000-4000-8000-000000000061'), 'none', 'no row for id 0');
select is(tests.download(999999, '00000000-0000-4000-8000-000000000061'), 'none', 'no row for an unknown id');
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000099'), 'none', 'no row for an unknown user');
update auth.users set banned_until = now() + interval '1 day' where id = '00000000-0000-4000-8000-000000000061';
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'), 'none', 'no row for a banned user');
update auth.users set banned_until = null, deleted_at = now() where id = '00000000-0000-4000-8000-000000000061';
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'), 'none', 'no row for a deleted user');
update auth.users set deleted_at = null, is_anonymous = true where id = '00000000-0000-4000-8000-000000000061';
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'), 'none', 'no row for an anonymous user');
update auth.users set is_anonymous = false where id = '00000000-0000-4000-8000-000000000061';
update private.telegram_media set mime_type = 'video/webm' where id = (select id from media where label = 'e2');
select is(tests.download((select id from v where label = 'e2'), '00000000-0000-4000-8000-000000000061'), 'none', 'no row for a container other than MP4 or MKV');
update private.telegram_media set mime_type = 'video/x-matroska' where id = (select id from media where label = 'e2');
update public.episode_versions set availability_status = 'unavailable' where id = (select id from v where label = 'e1');
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'), 'none', 'no row for an unavailable version');
update public.episode_versions set availability_status = 'ready' where id = (select id from v where label = 'e1');
update public.series set publication_status = 'archived' where tmdb_id = 71446;
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'), 'none', 'no row once the series is withdrawn');
update public.series set publication_status = 'published' where tmdb_id = 71446;
select is(tests.download((select id from v where label = 'e1'), '00000000-0000-4000-8000-000000000061'),
  '12:1000:video/mp4:Synthetic Heist S01E01.mp4', 'restoring publication restores the download');

select * from finish();
rollback;
