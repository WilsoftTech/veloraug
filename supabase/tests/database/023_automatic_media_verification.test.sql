-- Automatic whole-file media verification (migration 20261018100000): which
-- candidates are due. Fake documents only; nothing of the admin upload chain.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
create schema tests;

-- ---------------------------------------------------------------------------
-- Fixtures (the same shapes as suites 018 and 021)
-- ---------------------------------------------------------------------------
create function tests.hex(p text) returns text language sql immutable as $$ select md5(p) || md5(p || '#') $$;
create function tests.doc(p_update bigint, p_message bigint, p_unique text, p_size bigint, p_observed bigint, p_name text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('key', 'u:' || p_update, 'digest', tests.hex('d' || p_update || p_unique || p_observed),
    'update_id', p_update, 'withdrawn_message_id', null,
    'event', jsonb_build_object('event_id', tests.hex('e' || p_message || p_unique || p_observed),
      'payload_digest', tests.hex('p' || p_message || p_unique || p_observed), 'kind', 'channel_post',
      'message_id', p_message, 'observed_at', p_observed, 'date', 1760000000, 'file_id', 'synthetic-file-' || p_message,
      'file_unique_id', p_unique, 'size', p_size, 'name', p_name, 'mime', 'video/mp4', 'caption', null))
$$;
create function tests.key(p_message bigint) returns text language sql as $$
  select private.discovery_message_key(-1001111111111, p_message) $$;
create function tests.ev_id(p_message bigint) returns bigint language sql as $$
  select r.ingestion_event_id from private.channel_reviews r where r.discovery_key = tests.key(p_message) $$;
create function tests.media(p_message bigint) returns bigint language sql as $$
  select id from private.telegram_media where chat_id = -1001111111111 and message_id = p_message $$;
create function tests.identity(p_message bigint) returns text language sql as $$
  select private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes)
  from private.telegram_media m where m.id = tests.media(p_message) $$;
create function tests.revision(p_message bigint) returns integer language sql as $$
  select r.review_revision from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(p_message) $$;
create function tests.snapshot(p_tmdb integer, p_title text) returns jsonb language sql immutable as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'original_title', p_title, 'overview', 'Synthetic.',
    'release_date', '2024-05-01', 'runtime_minutes', 100, 'poster_path', null, 'backdrop_path', null,
    'vote_average', 7.1, 'vote_count', 10, 'genres', jsonb_build_array(jsonb_build_object('tmdb_id', 18, 'name', 'Drama'))) $$;
create function tests.evidence(p_identity text, p_verified boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('identity', p_identity, 'method', 'bounded_mtproto_v1', 'policy_version', 2,
    'media_class', case when p_verified then 'canonical' else 'unverified' end,
    'reasons', case when p_verified then '[]'::jsonb else '["container_not_mp4"]'::jsonb end,
    'container', case when p_verified then 'mp4' end, 'video_codec', case when p_verified then 'h264' end,
    'audio_codec', case when p_verified then 'aac' end, 'accessible', p_verified, 'gateway_compatible', true,
    'playback_ready', p_verified, 'bytes_read', case when p_verified then 3072 else 16 end) $$;
create function tests.assessment(p_ok boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('accepted', p_ok, 'container', 'mp4',
    'reasons', case when p_ok then '[]'::jsonb else '["audio_metadata_incomplete"]'::jsonb end, 'warnings', '[]'::jsonb,
    'integrity', case when p_ok then 'metadata_consistent' else 'incomplete' end,
    'streaming', case when p_ok then 'potentially_playable' else 'unverified' end,
    'download', 'not_implemented_authorization_required',
    'compatibility', jsonb_build_object('basis', 'tested_fixture_combinations', 'perFile', 'prediction',
      'evidence', 'docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
      'chromium', 'tested_combination', 'firefox', 'tested_combination', 'safari', 'real_device_not_tested', 'ios', 'real_device_not_tested', 'android', 'real_device_not_tested'),
    'tracks', '[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"attachedPicture":false}]'::jsonb) $$;
create function tests.bounded3(p_message bigint, p_ok boolean) returns jsonb language sql as $$
  select tests.evidence(tests.identity(p_message), true) || jsonb_build_object('method', 'bounded_original_v2', 'policy_version', 3,
    'media_class', case when p_ok then 'original' else 'unverified' end, 'playback_ready', false,
    'reasons', tests.assessment(p_ok)->'reasons', 'assessment', tests.assessment(p_ok), 'inspection_scope', 'bounded') $$;
-- A whole-file verification whose integrity failed with one reason (shape of suite 021).
create function tests.failed_whole(p_reason text) returns jsonb language sql immutable as $$
  select tests.assessment(true) || jsonb_build_object('accepted', false, 'reasons', jsonb_build_array(p_reason),
    'integrity', 'incomplete', 'streaming', 'unverified', 'download', 'original_servable',
    'verification', jsonb_build_object('contract', 1,
      'digest', jsonb_build_object('algorithm', 'sha256', 'value', repeat('b', 64), 'bytes', 10000),
      'integrity', jsonb_build_object('status', 'failed', 'method', 'whole_file_decode_v1', 'duration_seconds', 5400, 'decoded_seconds', 5399.98, 'reasons', jsonb_build_array(p_reason)),
      'streaming', jsonb_build_object('status', 'not_attempted', 'method', 'sampled_seek_decode_v1', 'layout', null, 'reasons', '[]'::jsonb, 'samples', '[]'::jsonb),
      'download', jsonb_build_object('status', 'original_servable', 'reasons', '[]'::jsonb),
      'tools', jsonb_build_object('ffmpeg', '9.0.2-essentials_build', 'ffprobe', '9.0.2-essentials_build'),
      'started_at', '2026-10-18T08:00:00.000Z', 'finished_at', '2026-10-18T08:20:00.000Z')) $$;
create function tests.result(p_tmdb integer, p_title text, p_vj bigint, p_evidence jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('outcome', 'review', 'error_code', null, 'title', p_title, 'year', 2024, 'vj_text', 'Test',
    'vj_id', p_vj, 'warnings', '[]'::jsonb, 'identity_state', 'proposed', 'proposed_tmdb_id', p_tmdb,
    'candidates', jsonb_build_array(jsonb_build_object('tmdb_id', p_tmdb, 'score', 1, 'reasons', '{"title_match":"exact"}'::jsonb,
                                                       'snapshot', tests.snapshot(p_tmdb, p_title))),
    'evidence', p_evidence) $$;
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
-- a1 reviews, a2 decides rights, a3 publishes, a4 has no capability.
create function tests.as_user(p_user text, p_sql text) returns text language sql as $$
  select tests.as_role('authenticated', tests.claims(('00000000-0000-4000-8000-0000000000' || p_user)::uuid), p_sql) $$;
create function tests.view(p_message bigint) returns jsonb language sql as $$
  select tests.as_user('a1', format($q$ select public.discovery_review_get(%L) $q$, tests.key(p_message)))::jsonb $$;
create function tests.blockers(p_message bigint) returns text language sql as $$
  select (tests.view(p_message)->'blockers')::text $$;
create function tests.rights(p_message bigint) returns text language sql as $$
  select tests.view(p_message)->>'rights_status' $$;
create function tests.vj() returns bigint language sql as $$ select id from public.vjs where slug = 'vj-opt-test' $$;

insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into public.vjs (slug, name, is_active) values ('vj-opt-test', 'VJ Opt Test', true);
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'review@opt.invalid'),
  ('00000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'rights@opt.invalid'),
  ('00000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'publish@opt.invalid'),
  ('00000000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'nobody@opt.invalid');
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000a1', true, false, false),
  ('00000000-0000-4000-8000-0000000000a2', false, true, false),
  ('00000000-0000-4000-8000-0000000000a3', false, false, true);
grant execute on all functions in schema tests to service_role, authenticated;
grant usage on schema tests to service_role, authenticated;
insert into private.discovery_cursors (bot_type) values ('movie');
select update_offset from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c1', 60);

-- One trusted channel document: detected, inspected (with the given evidence) and confirmed by a reviewer.
create function tests.ingest(p_message bigint, p_kind text, p_size bigint default 10000, p_confirm boolean default true) returns text language plpgsql as $$
declare v_claim jsonb; v_evidence jsonb;
begin
  perform public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111,
    jsonb_build_array(tests.doc(1000 + p_message, p_message, 'opt' || p_message, p_size, 1760000000 + p_message, 'Film ' || p_message || '.mp4')), null);
  v_claim := public.discovery_claim(240);
  if (v_claim->>'message_id')::bigint is distinct from p_message then
    raise exception 'unexpected claim';
  end if;
  v_evidence := case p_kind when 'bounded' then tests.bounded3(p_message, true) when 'refused' then tests.bounded3(p_message, false)
                            when 'legacy' then tests.evidence(tests.identity(p_message), false) end;
  perform public.discovery_complete(tests.key(p_message), (v_claim->>'lease')::uuid, 1,
    tests.result(9900000 + p_message::integer, 'Optional Film ' || p_message, tests.vj(), v_evidence));
  if not p_confirm then return 'unconfirmed'; end if;
  return tests.as_user('a1', format($q$ select (v->>'status') || ':' || (v->>'revision') from public.discovery_review_correct(%L, 1, %s, 2024, %s) v $q$,
    tests.key(p_message), 9900000 + p_message, tests.vj()));
end $$;
-- A whole-file verification result for a document, as the keyed verifier would record it.
create function tests.whole_file(p_message bigint, p_reason text) returns void language sql as $$
  insert into private.media_evidence (telegram_media_id, media_identity, method, scope, policy_version, media_class, reasons, container,
                                      video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read, assessment)
  values (tests.media(p_message), tests.identity(p_message), 'full_original_v1', 'whole_file', 3, 'unverified', array[p_reason], 'mp4',
          'h264', 'aac', true, true, false, 10000, tests.failed_whole(p_reason)) $$;


create function tests.due(p_retry integer default 3600) returns text language sql as $$
  select coalesce(string_agg((select m.message_id::text from private.channel_reviews r join private.ingestion_events e on e.id = r.ingestion_event_id
                                join private.telegram_media m on m.id = e.telegram_media_id where r.discovery_key = x.k #>> '{}'), ',' order by x.ord), '-')
  from jsonb_array_elements(public.discovery_verification_due(100, p_retry)) with ordinality as x(k, ord) $$;
create function tests.worker_audit(p_message bigint, p_action text, p_age interval) returns void language sql as $$
  insert into private.channel_review_audit (ingestion_event_id, review_revision, actor_kind, actor, action, detail, created_at)
  values (tests.ev_id(p_message), tests.revision(p_message), 'worker', null, p_action, 'media_read_upstream_timeout', now() - p_age) $$;
grant execute on all functions in schema tests to service_role, authenticated, velora_discovery_worker;
grant usage on schema tests to velora_discovery_worker;

-- 1. Privileges
select ok(has_function_privilege(r, 'public.discovery_verification_due(integer,integer)', 'EXECUTE'), r || ' may ask what is due')
from unnest(array['service_role', 'velora_discovery_worker']) r;
select ok(not has_function_privilege(r, 'public.discovery_verification_due(integer,integer)', 'EXECUTE'), r || ' may not')
from unnest(array['anon', 'authenticated', 'velora_review_service', 'velora_media_gateway']) r;
select ok((select p.prosecdef and p.proconfig = array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres'
  from pg_proc p where p.oid = 'public.discovery_verification_due(integer,integer)'::regprocedure), 'an owner-defined definer with a pinned search_path');
select throws_ok('select public.discovery_verification_due(0, 3600)', '22023', 'discovery_invalid_input', 'the limit is bounded');
select throws_ok('select public.discovery_verification_due(101, 3600)', '22023', 'discovery_invalid_input', 'the limit is bounded above');
select throws_ok('select public.discovery_verification_due(10, 59)', '22023', 'discovery_invalid_input', 'the retry wait is bounded');

-- 2. Candidates
select is(tests.ingest(300, 'none'), 'needs_review:2', 'confirmed, never checked');
select is(tests.ingest(301, 'none', 10000, false), 'unconfirmed', 'film and VJ not confirmed');
select is(tests.ingest(302, 'bounded'), 'needs_review:2', 'confirmed, bounded inspection only');
select is(tests.ingest(303, 'none', 2097152001), 'needs_review:2', 'confirmed, over the verification size limit');
select is(tests.ingest(304, 'none'), 'needs_review:2', 'confirmed, will be verified whole');
select is(tests.ingest(305, 'none'), 'needs_review:2', 'confirmed, five failed attempts at this revision');
select is(tests.ingest(306, 'none'), 'needs_review:2', 'confirmed, one old failed attempt');
select is(tests.ingest(307, 'none'), 'needs_review:2', 'confirmed, a recent failed attempt');
select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111,
  jsonb_build_array(tests.doc(1400, 400, 'opt300', 10000, 1760000400, 'Film 300 again.mp4')), null);
select is((select e.status from private.ingestion_events e where e.id = tests.ev_id(400)), 'ignored', 'a repost is a duplicate');
select tests.whole_file(304, 'decode_corrupt_data');
select tests.worker_audit(305, 'inspection_failed', interval '2 days') from generate_series(1, 5);
select tests.worker_audit(306, 'inspection_failed', interval '2 days');
select tests.worker_audit(307, 'inspection_failed', interval '5 minutes');

select is(tests.due(), '300,302,306', 'due: confirmed, not yet verified whole, not waiting after a failure; oldest first');
select is(tests.due(60), '300,302,306,307', 'a shorter wait lets the recent failure through');
-- Inside this rolled-back transaction only: lets the test session act as the worker.
grant velora_discovery_worker to postgres;
select is(tests.as_role('velora_discovery_worker', null, $q$ select jsonb_array_length(public.discovery_verification_due(100, 3600))::text $q$), '3',
  'the worker''s own role gets the same answer');
select is((select count(*)::integer from jsonb_array_elements(public.discovery_verification_due(2, 3600))), 2, 'the limit is applied');

-- A finished verification is not repeated by itself; a reviewer's request makes it due again.
insert into private.channel_review_audit (ingestion_event_id, review_revision, actor_kind, actor, action, detail, created_at)
values (tests.ev_id(304), tests.revision(304), 'reviewer', '00000000-0000-4000-8000-0000000000a1', 'reinspection_requested', null, now() + interval '1 second');
select is(tests.due(), '300,302,304,306', 'a reviewer''s request for a new check makes a verified file due again');

-- Claimed through the unchanged keyed claim, a candidate stops being due.
select is((public.discovery_claim_verification(tests.key(300), 3600))->>'message_id', '300', 'the due key is claimable by the keyed claim');
select is(tests.due(), '302,304,306', 'a claimed candidate is not due');
-- Asking what is due writes nothing.
select is((select count(*)::integer from private.media_evidence ev join private.telegram_media m on m.id = ev.telegram_media_id where m.chat_id = -1001111111111), 2,
  'only the evidence the fixtures wrote exists');

select * from finish();
rollback;
