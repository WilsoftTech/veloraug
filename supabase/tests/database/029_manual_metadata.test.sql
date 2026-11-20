begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

create schema tests;
grant usage on schema tests to service_role, authenticated, velora_review_service;

-- Synthetic 64-hex digests.
create function tests.hex(p text) returns text language sql immutable as $$ select md5(p) || md5(p || '#') $$;
-- One Bot API delivery of a channel document (key u:<update>).
create function tests.doc(p_update bigint, p_message bigint, p_unique text, p_size bigint, p_observed bigint,
                          p_name text default 'Example.Movie.2024.VJ.Test.mp4', p_kind text default 'channel_post')
returns jsonb language sql immutable as $$
  select jsonb_build_object('key', 'u:' || p_update, 'digest', tests.hex('d' || p_update || p_unique || p_observed),
    'update_id', p_update, 'withdrawn_message_id', null,
    'event', jsonb_build_object('event_id', tests.hex('e' || p_message || p_unique || p_observed),
      'payload_digest', tests.hex('p' || p_message || p_unique || p_observed), 'kind', p_kind,
      'message_id', p_message, 'observed_at', p_observed, 'date', 1760000000, 'file_id', 'synthetic-file-' || p_message,
      'file_unique_id', p_unique, 'size', p_size, 'name', p_name, 'mime', 'video/mp4', 'caption', null))
$$;
create function tests.key(p_message bigint) returns text language sql as $$
  select private.discovery_message_key(-1001111111111, p_message) $$;
create function tests.ev_id(p_message bigint) returns bigint language sql as $$
  select r.ingestion_event_id from private.channel_reviews r where r.discovery_key = tests.key(p_message) $$;
create function tests.status(p_message bigint) returns text language sql as $$
  select e.status from private.ingestion_events e where e.id = tests.ev_id(p_message) $$;
create function tests.rev(p_message bigint) returns integer language sql as $$
  select r.review_revision from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(p_message) $$;
create function tests.identity(p_message bigint) returns text language sql as $$
  select private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes)
  from private.telegram_media m where m.chat_id = -1001111111111 and m.message_id = p_message $$;
create function tests.snapshot(p_tmdb integer, p_title text) returns jsonb language sql immutable as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'original_title', p_title, 'overview', 'Synthetic.',
    'release_date', '2024-05-01', 'runtime_minutes', 100, 'poster_path', '/shared-poster.jpg', 'backdrop_path', null,
    'vote_average', 7.1, 'vote_count', 10, 'genres', jsonb_build_array(jsonb_build_object('tmdb_id', 18, 'name', 'Drama'))) $$;
create function tests.evidence(p_identity text, p_class text default 'canonical', p_video text default 'h264') returns jsonb language sql immutable as $$
  select jsonb_build_object('identity', p_identity, 'method', 'bounded_mtproto_v1', 'policy_version', 2, 'media_class', p_class,
    'reasons', case when p_class = 'canonical' then '[]'::jsonb else jsonb_build_array('video_codec_' || p_video) end,
    'container', 'mp4', 'video_codec', p_video, 'audio_codec', 'aac',
    'accessible', true, 'gateway_compatible', true, 'playback_ready', p_class = 'canonical', 'bytes_read', 3072) $$;
create function tests.result(p_tmdb integer, p_title text, p_vj bigint, p_evidence jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('outcome', 'review', 'error_code', null, 'title', p_title, 'year', 2024, 'vj_text', 'Test',
    'vj_id', p_vj, 'warnings', '[]'::jsonb, 'identity_state', 'proposed', 'proposed_tmdb_id', p_tmdb,
    'candidates', jsonb_build_array(jsonb_build_object('tmdb_id', p_tmdb, 'score', 1, 'reasons', '{"title_match":"exact"}'::jsonb,
                                                       'snapshot', tests.snapshot(p_tmdb, p_title))),
    'evidence', p_evidence) $$;
-- Error code of a statement run as a role (or the result text).
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

-- Fixtures: registered Movies channel, an active VJ, reviewer accounts.
insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into public.vjs (slug, name, is_active) values ('vj-e38a-test', 'VJ E38A Test', true), ('vj-e38a-off', 'VJ E38A Off', false);
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'review@e38a.invalid'),
  ('00000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'rights@e38a.invalid'),
  ('00000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'publish@e38a.invalid'),
  ('00000000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'nobody@e38a.invalid');
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000a1', true, false, false),
  ('00000000-0000-4000-8000-0000000000a2', false, true, false),
  ('00000000-0000-4000-8000-0000000000a3', false, false, true);
create function tests.vj() returns bigint language sql as $$ select id from public.vjs where slug = 'vj-e38a-test' $$;
grant execute on all functions in schema tests to service_role, authenticated, velora_review_service;
-- Lets this (rolled-back) session assume the restricted roles, as suite 008 does.
grant velora_review_service to postgres;
grant velora_media_gateway to postgres;


insert into private.discovery_cursors(bot_type) values('movie');
select public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c1',60);
create function tests.full_evidence(p_id bigint,p_container text default 'mp4',p_fail boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object('identity',private.channel_media_identity(m.chat_id,m.message_id,m.file_unique_id,m.file_size_bytes),
    'method','full_original_v1','inspection_scope','whole_file','policy_version',3,
    'media_class',case when p_fail then 'unverified' else 'original' end,
    'reasons',case when p_fail then '["decode_error_at_end"]'::jsonb else '[]'::jsonb end,
    'container',p_container,'video_codec','h264','audio_codec','aac',
    'accessible',true,'gateway_compatible',true,'playback_ready',false,'bytes_read',1100,
    'assessment',jsonb_build_object('accepted',not p_fail,'container',p_container,
      'integrity',case when p_fail then 'incomplete' else 'verified' end,
      'streaming',case when p_fail then 'unverified' else 'verified' end,'download','original_servable',
      'reasons',case when p_fail then '["decode_error_at_end"]'::jsonb else '[]'::jsonb end,'warnings','[]'::jsonb,
      'compatibility',jsonb_build_object('basis','tested_fixture_combinations','perFile','prediction',
        'evidence','docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
        'chromium','tested_combination','firefox',case when p_container='mkv' then 'streaming_unreliable' else 'tested_combination' end,
        'safari','real_device_not_tested','ios','real_device_not_tested','android','real_device_not_tested'),
      'tracks','[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"attachedPicture":false}]'::jsonb,
      'verification',jsonb_build_object('contract',1,'digest',jsonb_build_object('algorithm','sha256','value',repeat('a',64),'bytes',1000),
        'integrity',jsonb_build_object('status',case when p_fail then 'failed' else 'verified' end,'method','whole_file_decode_v1',
          'duration_seconds',5400,'decoded_seconds',5400,'reasons',case when p_fail then '["decode_error_at_end"]'::jsonb else '[]'::jsonb end),
        'streaming',jsonb_build_object('status',case when p_fail then 'not_attempted' else 'verified' end,'method','sampled_seek_decode_v1',
          'layout',case when p_fail then null when p_container='mkv' then 'matroska' else 'mp4_head_index' end,
          'reasons','[]'::jsonb,'samples',case when p_fail then '[]'::jsonb else '[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":2700,"decoded":true},{"position":"end","seconds":4860,"decoded":true}]'::jsonb end),
        'download',jsonb_build_object('status','original_servable','reasons','[]'::jsonb),
        'tools',jsonb_build_object('ffmpeg','9.0.2','ffprobe','9.0.2'),
        'started_at','2026-10-18T07:00:00.000Z','finished_at','2026-10-18T07:10:00.000Z')))
  from private.telegram_media m where m.id=p_id
$$;

create function tests.meta() returns jsonb language sql as $$ select '{"title":"Manual Film","original_title":null,"overview":"Admin supplied description","release_date":"2024-05-01","runtime_minutes":100,"poster_path":"/posters/11111111-1111-4111-8111-111111111111.webp","backdrop_path":null,"genres":["Action"]}'::jsonb $$;
select ok(private.manual_movie_metadata_valid(tests.meta()),'manual metadata accepts WebP poster');
select ok(not private.manual_movie_metadata_valid(tests.meta()||'{"poster_path":"https://evil.example/x"}'),'external URL refused');
select ok(not private.manual_movie_metadata_valid(tests.meta()||'{"release_date":"2024-02-31"}'),'invalid calendar date refused');
select ok(not private.manual_movie_metadata_valid(tests.meta()||'{"tmdb_id":123}'),'no invented external identity');
select ok(not has_function_privilege(r,'public.discovery_review_manual_metadata(text,integer,bigint,jsonb,bigint)','execute'),r||' cannot enter manual metadata') from unnest(array['anon','service_role','velora_discovery_worker','velora_review_service']) r;
select ok(not has_function_privilege(r,'private.write_manual_movie_metadata(bigint,jsonb)','execute'),r||' cannot bypass metadata checks') from unnest(array['anon','authenticated','service_role','velora_review_service']) r;
select public.discovery_receive('00000000-0000-4000-8000-0000000000c1',-1001111111111,jsonb_build_array(tests.doc(200,200,'manual-200',1000,1760000200,'Manual Film Part 1 VJ TEST.mp4')),null);
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a4')::text,true);
select throws_ok(format('select public.discovery_review_manual_metadata(%L,%s,%s,tests.meta(),null)',tests.key(200),tests.rev(200),tests.vj()),'42501','review_not_authorized','ordinary user cannot edit');
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a1')::text,true);
select is(public.discovery_review_manual_metadata(tests.key(200),tests.rev(200),tests.vj(),tests.meta(),null)->>'identity_state','confirmed','explicit manual decision confirms identity');
select ok((select tmdb_id is null and manual_movie_id is not null from private.channel_reviews where ingestion_event_id=tests.ev_id(200)),'manual identity has no fake TMDB id');
select is(private.channel_view(tests.ev_id(200),false)->'snapshot'->>'tmdb_id',null,'snapshot TMDB null');
select is(private.channel_movie_part(tests.ev_id(200)),1::smallint,'manual part recognised');
select ok('rights_clearance_required'=any(private.channel_review_blockers(tests.ev_id(200))),'rights still required');
select ok('media_verification_required'=any(private.channel_review_blockers(tests.ev_id(200))),'full file verification still required');
select throws_ok(format('select catalogue_review.approve_channel_candidate(%L,%s,%L)',tests.key(200),tests.rev(200),'00000000-0000-4000-8000-0000000000a1'),'P0001','review_gates_not_met','cannot approve missing gates');
select throws_ok(format('select catalogue_review.publish_channel_candidate(%L,%s,%L)',tests.key(200),tests.rev(200),'00000000-0000-4000-8000-0000000000a3'),'P0001','catalogue_not_approved','cannot publish unapproved');
create temp table manual_claim as select public.discovery_claim_verification(tests.key(200),60) as c;
select ok((select c->'confirmed_selection'->>'manual_movie_id' is not null from manual_claim),'media claim preserves explicit manual choice');
select public.discovery_complete(tests.key(200),(select (c->>'lease')::uuid from manual_claim),tests.rev(200),tests.result(999,'Ignored provider title',tests.vj(),tests.full_evidence((select telegram_media_id from private.ingestion_events where id=tests.ev_id(200)))));
select is((select title from private.channel_reviews where ingestion_event_id=tests.ev_id(200)),'Manual Film','media inspection cannot replace manual identity');
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a2')::text,true);
select public.discovery_review_clear_rights(tests.key(200),tests.rev(200),'synthetic-manual-license');
select is(cardinality(private.channel_review_blockers(tests.ev_id(200))),0,'all independent gates pass');
select is(catalogue_review.approve_channel_candidate(tests.key(200),tests.rev(200),'00000000-0000-4000-8000-0000000000a1')->>'status','matched','manual title approved');
create temp table old_rev as select tests.rev(200) as n;
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a3')::text,true);
select public.catalogue_admin_save_metadata(m.id,m.updated_at,tests.meta()||'{"overview":"Corrected description"}') from public.movies m where m.title='Manual Film';
select ok(tests.rev(200)>(select n from old_rev),'metadata edit invalidates revision');
select ok((select approved_revision is null from private.channel_reviews where ingestion_event_id=tests.ev_id(200)),'metadata edit revokes stale approval');
select ok('rights_clearance_required'=any(private.channel_review_blockers(tests.ev_id(200))),'old revision rights cannot be borrowed');
select throws_ok(format('select catalogue_review.publish_channel_candidate(%L,%s,%L)',tests.key(200),(select n from old_rev),'00000000-0000-4000-8000-0000000000a3'),'P0001','review_stale_revision','stale publication refused');
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a2')::text,true);
select public.discovery_review_clear_rights(tests.key(200),tests.rev(200),'synthetic-manual-license-current');
select catalogue_review.approve_channel_candidate(tests.key(200),tests.rev(200),'00000000-0000-4000-8000-0000000000a1');
select is(catalogue_review.publish_channel_candidate(tests.key(200),tests.rev(200),'00000000-0000-4000-8000-0000000000a3')->>'result','published','manual title publishes after all gates');
select is(catalogue_review.publish_channel_candidate(tests.key(200),tests.rev(200),'00000000-0000-4000-8000-0000000000a3')->>'result','already_published','manual publication is idempotent');
select is(tests.as_role('anon',null,$q$select count(*)::text from public.movies where title='Manual Film'$q$),'1','manual title publicly visible only after publication');
select public.discovery_receive('00000000-0000-4000-8000-0000000000c1',-1001111111111,jsonb_build_array(tests.doc(201,201,'manual-201',1000,1760000201,'Manual Film Part 2 VJ TEST.mp4')),null);
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a1')::text,true);
select public.discovery_review_manual_metadata(tests.key(201),tests.rev(201),tests.vj(),null,(select id from public.movies where title='Manual Film'));
select is(private.channel_view(tests.ev_id(201),false)->>'relation','new_part','another part reuses existing manual movie');
select is((select count(*)::integer from public.movies where title='Manual Film'),1,'parts share one metadata record');
select ok('media_verification_required'=any(private.channel_review_blockers(tests.ev_id(201))),'second part needs independent verification');
select * from finish();
rollback;
