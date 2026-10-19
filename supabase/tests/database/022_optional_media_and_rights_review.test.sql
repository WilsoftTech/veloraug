-- Optional media verification and the rights review (migration 20261018090000).
-- Fake documents only. Uses nothing of the admin upload chain, so it also runs on
-- the hosted channel set plus this migration.
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
create function tests.ingest(p_message bigint, p_kind text) returns text language plpgsql as $$
declare v_claim jsonb; v_evidence jsonb;
begin
  perform public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111,
    jsonb_build_array(tests.doc(1000 + p_message, p_message, 'opt' || p_message, 10000, 1760000000 + p_message, 'Film ' || p_message || '.mp4')), null);
  v_claim := public.discovery_claim(240);
  if (v_claim->>'message_id')::bigint is distinct from p_message then
    raise exception 'unexpected claim';
  end if;
  v_evidence := case p_kind when 'bounded' then tests.bounded3(p_message, true) when 'refused' then tests.bounded3(p_message, false)
                            when 'legacy' then tests.evidence(tests.identity(p_message), false) end;
  perform public.discovery_complete(tests.key(p_message), (v_claim->>'lease')::uuid, 1,
    tests.result(9900000 + p_message::integer, 'Optional Film ' || p_message, tests.vj(), v_evidence));
  return tests.as_user('a1', format($q$ select (v->>'status') || ':' || (v->>'revision') from public.discovery_review_correct(%L, 1, %s, 2024, %s) v $q$,
    tests.key(p_message), 9900000 + p_message, tests.vj()));
end $$;
-- A whole-file verification result for a document, as the keyed verifier would record it.
create function tests.whole_file(p_message bigint, p_reason text) returns void language sql as $$
  insert into private.media_evidence (telegram_media_id, media_identity, method, scope, policy_version, media_class, reasons, container,
                                      video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read, assessment)
  values (tests.media(p_message), tests.identity(p_message), 'full_original_v1', 'whole_file', 3, 'unverified', array[p_reason], 'mp4',
          'h264', 'aac', true, true, false, 10000, tests.failed_whole(p_reason)) $$;

-- ---------------------------------------------------------------------------
-- 1. Privileges and the setting
-- ---------------------------------------------------------------------------
select is(private.media_inspection_mode(), 'required', 'the default mode is required (unchanged behaviour)');
select is((select count(*)::integer from private.catalogue_policy_audit), 1, 'the initial value is recorded');
select ok(not has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE'), r || ' has no access to ' || t)
from unnest(array['anon', 'authenticated', 'service_role', 'velora_discovery_worker', 'velora_review_service', 'velora_media_gateway']) r,
     unnest(array['private.catalogue_policy', 'private.catalogue_policy_audit', 'private.rights_submissions']) t;
select ok((select relrowsecurity from pg_class where oid = t::regclass), t || ' has RLS on')
from unnest(array['private.catalogue_policy', 'private.catalogue_policy_audit', 'private.rights_submissions']) t;
select ok(not has_function_privilege(r, f, 'EXECUTE'), r || ' cannot execute ' || f)
from unnest(array['anon', 'authenticated', 'service_role', 'velora_discovery_worker', 'velora_review_service', 'velora_media_gateway']) r,
     unnest(array['private.media_inspection_mode()', 'private.media_evidence_known_failure(private.media_evidence)',
                  'private.channel_rights_status(bigint)', 'private.channel_review_blockers(bigint)', 'private.channel_view(bigint,boolean)']) f;
select ok(has_function_privilege('authenticated', f, 'EXECUTE'), 'authenticated may call ' || f)
from unnest(array['public.discovery_review_submit_rights(text,integer,text,text)', 'public.discovery_review_decide_rights(text,integer,bigint,text)']) f;
select ok(not has_function_privilege(r, f, 'EXECUTE'), r || ' cannot call ' || f)
from unnest(array['anon', 'service_role', 'velora_discovery_worker', 'velora_review_service', 'velora_media_gateway']) r,
     unnest(array['public.discovery_review_submit_rights(text,integer,text,text)', 'public.discovery_review_decide_rights(text,integer,bigint,text)']) f;
select is((select count(*)::integer from pg_proc where oid in ('public.discovery_review_submit_rights(text,integer,text,text)'::regprocedure,
  'public.discovery_review_decide_rights(text,integer,bigint,text)'::regprocedure) and prosecdef and proconfig = array['search_path=""']
  and pg_get_userbyid(proowner) = 'postgres'), 2, 'both commands are owner-defined definers with a pinned search_path');
select throws_ok($q$update private.catalogue_policy set media_inspection_mode = 'off'$q$, '23514', null, 'only the three modes exist');
select throws_ok($q$delete from private.catalogue_policy$q$, 'P0001', 'catalogue_policy_required', 'the setting cannot be removed');
select throws_ok($q$update private.catalogue_policy_audit set media_inspection_mode = 'optional'$q$, 'P0001', 'audit_append_only', 'the setting history is append-only');

-- ---------------------------------------------------------------------------
-- 2. Trusted channel documents, with every kind of media evidence
-- ---------------------------------------------------------------------------
select is(tests.ingest(100, 'none'), 'needs_review:2', 'a trusted document is ingested and confirmed with no media evidence');
select is(tests.ingest(101, 'bounded'), 'needs_review:2', 'one with an accepted bounded Policy 3 inspection');
select is(tests.ingest(102, 'refused'), 'needs_review:2', 'one whose file Policy 3 refused');
select is(tests.ingest(103, 'none'), 'needs_review:2', 'one that will have an inconclusive whole-file decode');
select is(tests.ingest(104, 'none'), 'needs_review:2', 'one that will have a damaged whole-file decode');
select is(tests.ingest(105, 'legacy'), 'needs_review:2', 'one with only an earlier policy''s refusal');
select tests.whole_file(103, 'decode_failed');
select tests.whole_file(104, 'decode_corrupt_data');
select is((select count(*)::integer from private.media_evidence where telegram_media_id = tests.media(100)), 0, 'no evidence is invented for an uninspected document');
select is((select count(*)::integer from private.rights_clearances rc where rc.ingestion_event_id in
  (select tests.ev_id(m) from generate_series(100, 105) m)), 0, 'ingestion records no rights clearance');
select is(tests.rights(100), 'not_provided', 'rights start not provided');

-- Duplicates: a replayed delivery and a repost of the same document create no second candidate.
select is((public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111,
  jsonb_build_array(tests.doc(1100, 100, 'opt100', 10000, 1760000100, 'Film 100.mp4')), null))->>'duplicates', '1', 'a replayed delivery is a duplicate');
select is((select count(*)::integer from private.channel_reviews r join private.ingestion_events e on e.id = r.ingestion_event_id
  join private.telegram_media m on m.id = e.telegram_media_id where m.file_unique_id = 'opt100'), 1, 'one candidate for the document');
select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111,
  jsonb_build_array(tests.doc(1200, 200, 'opt100', 10000, 1760000200, 'Film 100 again.mp4')), null);
select is((select e.status || ':' || coalesce(e.error_code, '-') from private.ingestion_events e where e.id = tests.ev_id(200)), 'ignored:duplicate_media',
  'a repost of the same document is a duplicate, never a second candidate for review');

-- ---------------------------------------------------------------------------
-- 3. Required mode: unchanged gates
-- ---------------------------------------------------------------------------
select is(tests.view(100)->>'media_inspection_mode', 'required', 'the reviewer view reports the mode');
select is(tests.blockers(100), '["media_verification_required", "rights_clearance_required"]', 'required: unchecked media blocks');
select is(tests.blockers(101), '["media_verification_required", "rights_clearance_required"]', 'required: metadata-consistent media blocks');
select is(tests.blockers(103), '["media_verification_required", "rights_clearance_required"]', 'required: an inconclusive decode blocks');

-- ---------------------------------------------------------------------------
-- 4. Optional mode: only a definite failure blocks; rights still do
-- ---------------------------------------------------------------------------
update private.catalogue_policy set media_inspection_mode = 'optional';
select is((select media_inspection_mode || ':' || changed_by_role from private.catalogue_policy_audit order by id desc limit 1), 'optional:postgres', 'the change is recorded with its role');
select is(tests.blockers(100), '["rights_clearance_required"]', 'optional: an uninspected file does not block, rights do');
select is(tests.blockers(101), '["rights_clearance_required"]', 'optional: a bounded inspection does not block');
select is(tests.blockers(102), '["media_known_failure", "rights_clearance_required"]', 'optional: a file Policy 3 refused still blocks');
select is(tests.blockers(103), '["rights_clearance_required"]', 'optional: a decode that does not show damage does not block');
select is(tests.blockers(104), '["media_known_failure", "rights_clearance_required"]', 'optional: a damaged file still blocks');
select is(tests.blockers(105), '["rights_clearance_required"]', 'optional: an earlier policy''s refusal is history');
select is(tests.view(100)->'evidence', 'null'::jsonb, 'optional: an uninspected file still has no evidence');
select is((tests.view(103)->'evidence'->>'publishable_media') || ':' || (tests.view(103)->'evidence'->>'known_failure') || ':' || (tests.view(103)->'evidence'->>'integrity_status'),
  'false:false:incomplete', 'an inconclusive decode stays unverified');
select is((tests.view(104)->'evidence'->>'publishable_media') || ':' || (tests.view(104)->'evidence'->>'known_failure'),
  'false:true', 'a damaged file stays failed, never passing');
select is(tests.as_user('a1', format('select public.discovery_review_approve(%L, 2)', tests.key(100))), 'review_gates_not_met',
  'optional: approval without a rights decision is refused');
update private.catalogue_policy set media_inspection_mode = 'disabled';
select is(tests.blockers(100) || tests.blockers(104), '["rights_clearance_required"]["media_known_failure", "rights_clearance_required"]', 'disabled: the same gates as optional');

-- ---------------------------------------------------------------------------
-- 5. The rights review
-- ---------------------------------------------------------------------------
select is(tests.as_user('a4', format($q$ select public.discovery_review_submit_rights(%L, 2, 'licence OPT-100', null) $q$, tests.key(100))),
  'review_not_authorized', 'an account without a capability cannot submit');
select is(tests.as_role('anon', null, format($q$ select public.discovery_review_submit_rights(%L, 2, 'licence OPT-100', null) $q$, tests.key(100))),
  'permission denied for function discovery_review_submit_rights', 'anon cannot submit');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 2, 'https://x.invalid/l', null) $q$, tests.key(100))),
  'discovery_invalid_input', 'a URL is not a reference');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 2, 'licence OPT-100', 'ABC') $q$, tests.key(100))),
  'discovery_invalid_input', 'a document digest must be a SHA-256');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 1, 'licence OPT-100', null) $q$, tests.key(100))),
  'review_stale_revision', 'a stale revision is refused');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 2, 'licence OPT-100', null)->>'rights_status' $q$, tests.key(100))),
  'pending_review', 'a reviewer submits a reference without a document: pending review');
select is(tests.revision(100), 2, 'a submission does not change the reviewed revision');
select is(tests.blockers(100), '["rights_clearance_required"]', 'a pending submission grants nothing');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 2, 'licence OPT-100b', null) $q$, tests.key(100))),
  'review_illegal_transition', 'one open submission per revision');
create temporary table sub on commit drop as select max(id) as id from private.rights_submissions;
grant select on sub to authenticated;
select is(tests.as_user('a1', format($q$ select public.discovery_review_decide_rights(%L, 2, %s, 'verified') $q$, tests.key(100), (select id from sub))),
  'review_not_authorized', 'the review capability cannot decide rights');
select is(tests.as_user('a2', format($q$ select public.discovery_review_decide_rights(%L, 2, %s, 'approved') $q$, tests.key(100), (select id from sub))),
  'discovery_invalid_input', 'only verified or rejected');
select is(tests.as_user('a2', format($q$ select public.discovery_review_decide_rights(%L, 2, %s, 'rejected')->>'rights_status' $q$, tests.key(100), (select id from sub))),
  'rejected', 'a rights reviewer rejects it');
select is(tests.revision(100), 2, 'a rejection does not change the revision');
select is(tests.blockers(100), '["rights_clearance_required"]', 'a rejected submission grants nothing');
select is(tests.as_user('a2', format($q$ select public.discovery_review_decide_rights(%L, 2, %s, 'verified') $q$, tests.key(100), (select id from sub))),
  'review_illegal_transition', 'a decided submission cannot be decided again');
select throws_ok(format($q$update private.rights_submissions set decision = 'verified' where id = %s$q$, (select id from sub)), 'P0001', 'rights_submission_immutable', 'a decision is final');
select throws_ok(format($q$delete from private.rights_submissions where id = %s$q$, (select id from sub)), 'P0001', 'rights_submission_immutable', 'submissions are kept');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 2, 'licence OPT-100c', %L)->>'rights_status' $q$, tests.key(100), repeat('c', 64))),
  'pending_review', 'a corrected reference, with a document digest, is submitted again');
update sub set id = (select max(id) from private.rights_submissions);
select is(tests.as_user('a2', format($q$ select (v->>'rights_status') || ':' || (v->>'revision') from public.discovery_review_decide_rights(%L, 2, %s, 'verified') v $q$, tests.key(100), (select id from sub))),
  'verified:3', 'a rights reviewer verifies it: a clearance at a new revision');
select is((select rc.reference || ':' || rc.document_sha256 || ':' || (rc.submission_id = (select id from sub))::text from private.rights_clearances rc
  where rc.ingestion_event_id = tests.ev_id(100)), 'licence OPT-100c:' || repeat('c', 64) || ':true', 'the clearance names its submission and document');
select is(jsonb_array_length(tests.view(100)->'rights_submissions'), 2, 'the rights history keeps both submissions');
select is(tests.blockers(100), '[]', 'optional mode: identity, VJ and rights are enough to approve');
select is((select string_agg(action, ',' order by id) from private.channel_review_audit where ingestion_event_id = tests.ev_id(100) and action like 'rights_%'),
  'rights_submitted,rights_rejected,rights_submitted,rights_cleared', 'every rights step is audited');

-- ---------------------------------------------------------------------------
-- 6. Approval and publication: the same capabilities and the same rights gate
-- ---------------------------------------------------------------------------
select is(tests.as_user('a3', format('select public.discovery_review_approve(%L, 3)', tests.key(100))), 'review_not_authorized', 'the publish capability cannot approve');
select is(tests.as_user('a1', format($q$ select public.discovery_review_approve(%L, 3)->>'status' $q$, tests.key(100))), 'matched', 'the reviewer approves');
select is(tests.as_user('a1', format('select public.discovery_review_publish(%L, 3)', tests.key(100))), 'review_not_authorized', 'the review capability cannot publish');
select is(tests.as_user('a3', format($q$ select public.discovery_review_publish(%L, 3)->>'result' $q$, tests.key(100))), 'published', 'the publisher publishes');
select is((select mv.rights_status || ':' || mv.availability_status from public.movie_versions mv where mv.telegram_media_id = tests.media(100)), 'cleared:ready',
  'the version is cleared only because a rights clearance was recorded');
select is((select count(*)::integer from media_gateway.resolve_movie_version((select mv.id from public.movie_versions mv where mv.telegram_media_id = tests.media(100)))), 1,
  'the published, cleared version is streamable');

-- Without a rights decision nothing is published or streamable, whatever the mode.
select is(tests.as_user('a3', format('select public.discovery_review_publish(%L, 2)', tests.key(101))), 'catalogue_not_approved', 'an unapproved candidate is not published');
select is((select count(*)::integer from public.movie_versions mv where mv.telegram_media_id in (tests.media(101), tests.media(102), tests.media(103), tests.media(104), tests.media(105))), 0,
  'no version exists for a document without rights');
select is(tests.as_user('a1', format('select public.discovery_review_approve(%L, 2)', tests.key(104))), 'review_gates_not_met', 'a damaged file is not approved');

-- A candidate approved under optional mode is re-checked at publication: back to required, it is refused.
select is(tests.as_user('a2', format($q$ select public.discovery_review_clear_rights(%L, 2, 'licence OPT-103')->>'rights_status' $q$, tests.key(103))), 'verified',
  'the existing direct clearance reports verified');
select is(tests.as_user('a1', format($q$ select public.discovery_review_approve(%L, 3)->>'status' $q$, tests.key(103))), 'matched', 'approved under disabled mode');
update private.catalogue_policy set media_inspection_mode = 'required';
select is(tests.as_user('a3', format('select public.discovery_review_publish(%L, 3)', tests.key(103))), 'catalogue_gates_not_met',
  'back in required mode, publication re-checks the media gate and refuses');
select is((select count(*)::integer from private.catalogue_policy_audit), 4, 'every mode change is recorded');

-- ---------------------------------------------------------------------------
-- 7. The reference is optional; the rights decision is not
-- ---------------------------------------------------------------------------
select is(tests.blockers(101), '["media_verification_required", "rights_clearance_required"]', 'still no rights for 101 before any decision');
select is(tests.as_user('a1', format($q$ select public.discovery_review_submit_rights(%L, 2, null, null)->>'rights_status' $q$, tests.key(101))),
  'pending_review', 'a rights review can be requested with neither reference nor document');
select is(tests.blockers(101), '["media_verification_required", "rights_clearance_required"]', 'and it grants nothing');
update sub set id = (select max(id) from private.rights_submissions);
select is(tests.as_user('a2', format($q$ select (v->>'rights_status') || ':' || coalesce(v->'rights'->>'reference', 'none') from public.discovery_review_decide_rights(%L, 2, %s, 'verified') v $q$, tests.key(101), (select id from sub))),
  'verified:none', 'a rights reviewer verifies it: a clearance with no reference');
select is(tests.as_user('a2', format($q$ select (v->>'rights_status') || ':' || coalesce(v->'rights'->>'reference', 'none') from public.discovery_review_clear_rights(%L, 2, '') v $q$, tests.key(105))),
  'verified:none', 'the existing direct clearance accepts an empty reference');
select is((select a.detail from private.channel_review_audit a where a.ingestion_event_id = tests.ev_id(105) and a.action = 'rights_cleared'), 'no_reference',
  'a clearance without a reference is audited as such');
select is(tests.as_user('a1', format($q$ select public.discovery_review_clear_rights(%L, 3, null) $q$, tests.key(105))), 'review_not_authorized',
  'a review-only account still cannot clear rights, with or without a reference');
select is(tests.as_user('a2', format($q$ select public.discovery_review_clear_rights(%L, 3, 'https://x.invalid/l') $q$, tests.key(105))), 'discovery_invalid_input',
  'a given reference is still never a URL');
select is(tests.as_user('a4', format($q$ select public.discovery_review_clear_rights(%L, 3, null) $q$, tests.key(105))), 'review_not_authorized',
  'an account without a capability cannot clear rights');
select is(tests.as_role('anon', null, format($q$ select public.discovery_review_clear_rights(%L, 3, null) $q$, tests.key(105))),
  'permission denied for function discovery_review_clear_rights', 'anon cannot clear rights');
select ok(has_function_privilege('authenticated', 'public.discovery_review_clear_rights(text,integer,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.discovery_review_clear_rights(text,integer,text)', 'EXECUTE')
  and not has_function_privilege('velora_discovery_worker', 'public.discovery_review_clear_rights(text,integer,text)', 'EXECUTE'),
  'the clearance command keeps its grants: reviewers only, never the worker');

select * from finish();
rollback;
