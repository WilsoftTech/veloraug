-- Series review queue (20261120191536_series_review_queue.sql): manual series details, assignment,
-- rights and publication of Series-channel files by reviewers, each step behind its own capability.
-- Synthetic documents only. Everything runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
create schema tests;
grant usage on schema tests to authenticated;

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
create function tests.as_role(p_role text, p_claims jsonb, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    return sqlerrm;
  end;
  reset role;
  return coalesce(v, 'null');
end $$;
create function tests.claims(p_user uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', false) $$;
create function tests.reviewer(p_kind text) returns jsonb language sql immutable as $$
  select tests.claims(case p_kind when 'review' then '00000000-0000-4000-8000-0000000000b1' when 'rights' then '00000000-0000-4000-8000-0000000000b2'
    when 'publish' then '00000000-0000-4000-8000-0000000000b3' else '00000000-0000-4000-8000-0000000000b4' end::uuid) $$;
create function tests.meta(p_title text default 'Synthetic Heroes', p_poster text default '/posters/0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e.webp') returns jsonb language sql immutable as $$
  select jsonb_build_object('title', p_title, 'original_title', null, 'overview', 'A synthetic manual series.', 'first_air_date', '2024-03-01',
    'genres', jsonb_build_array('Drama', 'Action'), 'poster_path', p_poster, 'backdrop_path', null) $$;

insert into private.telegram_channels (bot_type, chat_id) values ('series', -1002222222222), ('movie', -1001111111111);
insert into public.vjs (slug, name, is_active) values ('vj-series', 'VJ Series', true), ('vj-off', 'VJ Off', false);
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'review@series.invalid'),
  ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'rights@series.invalid'),
  ('00000000-0000-4000-8000-0000000000b3', 'authenticated', 'authenticated', 'publish@series.invalid'),
  ('00000000-0000-4000-8000-0000000000b4', 'authenticated', 'authenticated', 'nobody@series.invalid');
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000b1', true, false, false),
  ('00000000-0000-4000-8000-0000000000b2', false, true, false),
  ('00000000-0000-4000-8000-0000000000b3', false, false, true);
create table tests.media (label text primary key, id bigint);
insert into tests.media values ('e1', tests.media('series', -1002222222222, 60, 'Heros Eo1 Ice P.mp4')),
                               ('e2', tests.media('series', -1002222222222, 61, 'Heros Eo2 Ice P.mp4')),
                               ('movie', tests.media('movie', -1001111111111, 9, 'Movie.mp4'));
create function tests.m(p text) returns bigint language sql as $$ select id from tests.media where label = p $$;
create function tests.vj(p text default 'vj-series') returns bigint language sql as $$ select id from public.vjs where slug = p $$;
create table tests.s (id bigint, updated_at timestamptz);
grant select on all tables in schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(not has_table_privilege(r, 'private.series_episode_reviews', 'select'), r || ' cannot read review rows')
  from unnest(array['anon', 'authenticated', 'service_role']) r;
select ok(has_function_privilege('authenticated', f, 'execute'), 'authenticated may call ' || f)
  from unnest(array['public.series_review_queue()', 'public.series_review_save_series(bigint,timestamptz,jsonb)',
    'public.series_review_assign(bigint,integer,bigint,integer,integer,text,text,bigint)', 'public.series_review_rights(bigint,integer,boolean)',
    'public.series_review_publish(bigint,integer)']) f;
select ok(not has_function_privilege(r, f, 'execute'), r || ' may not call ' || f)
  from unnest(array['anon', 'service_role', 'velora_discovery_worker', 'velora_media_gateway']) r,
       unnest(array['public.series_review_queue()', 'public.series_review_publish(bigint,integer)']) f;
select ok(not has_function_privilege('authenticated', f, 'execute'), 'authenticated may not call ' || f)
  from unnest(array['private.manual_series_metadata_valid(jsonb)', 'private.series_review_item(bigint)', 'private.series_review_media(bigint)']) f;
select ok((select bool_and(prosecdef) from pg_proc where proname in ('series_review_queue','series_review_save_series','series_review_assign','series_review_rights','series_review_publish')), 'commands are security definer');
select ok((select bool_and(proconfig = array['search_path=""']) from pg_proc where proname in ('series_review_queue','series_review_save_series','series_review_assign','series_review_rights','series_review_publish','series_review_item','series_review_media','manual_series_metadata_valid','manual_series_metadata')), 'every function pins an empty search_path');

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.reviewer('nobody'), 'select public.series_review_queue()::text'), 'review_not_authorized', 'a non-reviewer cannot list the queue');
select is(tests.as_role('authenticated', tests.reviewer('rights'), $q$select (public.series_review_queue()->'items')::text$q$) ~ 'Heros Eo1', true, 'any reviewer lists the queue');
select is(tests.as_role('authenticated', tests.reviewer('rights'), $q$select (public.series_review_queue()->'items')::text$q$) ~ 'Movie.mp4', false, 'movie media is not in the series queue');
select is(tests.as_role('authenticated', tests.reviewer('rights'), format('select public.series_review_save_series(null, null, %L::jsonb)::text', tests.meta())), 'review_not_authorized', 'rights alone cannot create a series');

-- ---------------------------------------------------------------------------
-- Manual series details
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_save_series(null, null, %L::jsonb)::text', tests.meta() || '{"extra":1}')), 'manual_metadata_invalid', 'unknown keys are refused');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_save_series(null, null, %L::jsonb)::text', tests.meta(p_poster => 'https://example.invalid/p.jpg'))), 'manual_metadata_invalid', 'artwork must be a stored poster path');
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_save_series(null, null, %L::jsonb)->>'slug'$q$, tests.meta())), 'synthetic-heroes-2024', 'a reviewer creates a manual series with a year slug');
insert into tests.s select id, updated_at from public.series where slug = 'synthetic-heroes-2024';
select is((select tmdb_id is null and publication_status = 'draft' and metadata_status = 'reviewed' and poster_path like '/posters/%' from public.series where id = (select id from tests.s)), true, 'it is a draft with no TMDB id and the uploaded poster');
select is((select count(*)::integer from public.series_genres where series_id = (select id from tests.s)), 2, 'its genres are linked');
select matches(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_save_series(null, null, %L::jsonb)->>'slug'$q$, tests.meta())), '^synthetic-heroes-2024-[0-9a-f]{6}$', 'a second series with the same title gets a distinct slug');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_save_series(%s, %L, %L::jsonb)::text', (select id from tests.s), '2000-01-01T00:00:00Z', tests.meta())), 'review_stale_revision', 'an edit against an old version is refused');
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_save_series(%s, %L, %L::jsonb)->>'id'$q$, (select id from tests.s), (select updated_at from tests.s), tests.meta('Synthetic Heroes Renamed'))), (select id from tests.s)::text, 'a current edit is saved');
select is((select title from public.series where id = (select id from tests.s)), 'Synthetic Heroes Renamed', 'with the new title');
insert into public.series (slug, title, tmdb_id) values ('tmdb-backed-2020', 'TMDB Backed', 123456);
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_save_series(%s, now(), %L::jsonb)::text', (select id from public.series where tmdb_id = 123456), tests.meta())), 'manual_metadata_use_catalogue', 'a TMDB-backed series is never edited here');

-- ---------------------------------------------------------------------------
-- Assignment
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_assign(%s, 0, %s, 1, 1, 'Pilot', null, %s)::text$q$, tests.m('movie'), (select id from tests.s), tests.vj())), 'catalogue_media_not_registered', 'movie media cannot be assigned');
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_assign(%s, 0, %s, 1, 1, 'Pilot', null, %s)::text$q$, tests.m('e1'), (select id from tests.s), tests.vj('vj-off'))), 'catalogue_vj_not_active', 'an inactive VJ is refused');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_assign(%s, 0, %s, 1, 0, null, null, %s)::text', tests.m('e1'), (select id from tests.s), tests.vj())), 'catalogue_invalid_input', 'episode numbers start at 1');
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_assign(%s, 0, %s, 1, 1, 'Pilot', null, %s)->>'revision'$q$, tests.m('e1'), (select id from tests.s), tests.vj())), '1', 'a reviewer assigns the first file');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_assign(%s, 0, %s, 1, 1, null, null, %s)::text', tests.m('e2'), (select id from tests.s), tests.vj())), 'catalogue_version_conflict', 'a second file for the same episode and VJ is refused');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_assign(%s, 5, %s, 1, 2, null, null, %s)::text', tests.m('e2'), (select id from tests.s), tests.vj())), 'review_stale_revision', 'a stale revision is refused');
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_assign(%s, 0, %s, 1, 2, null, null, %s)->>'episode_number'$q$, tests.m('e2'), (select id from tests.s), tests.vj())), '2', 'the second file becomes episode 2');

-- ---------------------------------------------------------------------------
-- Rights and publication
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_rights(%s, 1, true)::text', tests.m('e1'))), 'review_not_authorized', 'review alone cannot record rights');
select is(tests.as_role('authenticated', tests.reviewer('publish'), format('select public.series_review_publish(%s, 1)::text', tests.m('e1'))), 'rights_not_cleared', 'nothing publishes without a rights decision');
select is(tests.as_role('authenticated', tests.reviewer('rights'), format($q$select public.series_review_rights(%s, 1, true)->>'rights_cleared'$q$, tests.m('e1'))), 'true', 'a rights reviewer clears the first file');
select is(tests.as_role('authenticated', tests.reviewer('publish'), format('select public.series_review_publish(%s, 1)::text', tests.m('e1'))), 'catalogue_media_not_verified', 'nothing publishes before its whole-file check passes');
select isnt(tests.verify_next(), null, 'the worker verifies a document');
select isnt(tests.verify_next(), null, 'and the next');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_publish(%s, 1)::text', tests.m('e1'))), 'review_not_authorized', 'review alone cannot publish');
select is(tests.as_role('authenticated', tests.reviewer('publish'), format($q$select public.series_review_publish(%s, 1)->>'series_slug'$q$, tests.m('e1'))), 'synthetic-heroes-2024', 'a verified, rights-cleared file publishes');
select is((select publication_status from public.series where id = (select id from tests.s)), 'published', 'the series is now public');
select is((select e.title || ':' || v.availability_status || ':' || v.rights_status from public.episode_versions v join public.episodes e on e.id = v.episode_id where v.telegram_media_id = tests.m('e1')),
  'Pilot:ready:cleared', 'the episode carries the reviewer''s title and a ready, cleared version');
select is((select count(*)::integer from media_gateway.resolve_episode_version((select id from public.episode_versions where telegram_media_id = tests.m('e1')))), 1, 'the gateway resolves it');
select is(tests.as_role('authenticated', tests.reviewer('publish'), format('select public.series_review_publish(%s, 1)::text', tests.m('e1'))), 'review_already_published', 'a replay is refused');
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_assign(%s, 1, null, null, null, null, null, null)::text', tests.m('e1'))), 'review_already_published', 'a published file cannot be reassigned');
-- Rights belong to a revision: a later change makes them stale.
select is(tests.as_role('authenticated', tests.reviewer('rights'), format($q$select public.series_review_rights(%s, 1, true)->>'rights_cleared'$q$, tests.m('e2'))), 'true', 'the second file is cleared');
select is(tests.as_role('authenticated', tests.reviewer('review'), format($q$select public.series_review_assign(%s, 1, %s, 1, 3, null, null, %s)->>'rights_cleared'$q$, tests.m('e2'), (select id from tests.s), tests.vj())), 'false', 'reassigning it withdraws the clearance');
select is(tests.as_role('authenticated', tests.reviewer('publish'), format('select public.series_review_publish(%s, 2)::text', tests.m('e2'))), 'rights_not_cleared', 'so it cannot publish');
-- Editing a published series needs the publish capability.
select is(tests.as_role('authenticated', tests.reviewer('review'), format('select public.series_review_save_series(%s, %L, %L::jsonb)::text', (select id from tests.s), (select updated_at from public.series where id = (select id from tests.s)), tests.meta('Again'))), 'review_not_authorized', 'review alone cannot edit a public series');
select is((select count(*)::integer from private.series_review_audit), 9, 'every change is audited');
-- The published file stays listed with its publication.
select is(tests.as_role('authenticated', tests.reviewer('rights'), $q$select jsonb_array_length(public.series_review_queue()->'items')::text$q$), '2', 'both files are listed');

select * from finish();
rollback;
