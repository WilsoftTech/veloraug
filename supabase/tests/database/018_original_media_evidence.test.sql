-- Policy 3: fake documents only; works without the six admin migrations.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

create schema tests;
grant usage on schema tests to service_role, authenticated;

create function tests.hex(p text) returns text language sql immutable as $$ select md5(p) || md5(p || '#') $$;
create function tests.doc(p_update bigint, p_message bigint, p_unique text, p_size bigint, p_observed bigint, p_name text, p_kind text default 'channel_post')
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
create function tests.state(p_message bigint) returns text language sql as $$
  select e.status || ':' || r.review_revision || ':' || e.attempt_count || ':' || coalesce(e.error_code, '-')
  from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id = e.id where e.id = tests.ev_id(p_message) $$;
-- The reviewed facts of a candidate: what a media-only inspection must never change.
create function tests.choice(p_message bigint) returns text language sql as $$
  select r.identity_state || ':' || coalesce(r.tmdb_id::text, '-') || ':' || coalesce(r.title, '-') || ':' || coalesce(r.release_year::text, '-')
         || ':' || coalesce((select v.slug from public.vjs v where v.id = r.vj_id), '-')
  from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(p_message) $$;
create function tests.delay(p_message bigint) returns integer language sql as $$
  select extract(epoch from r.retry_at - now())::integer from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(p_message) $$;
create function tests.identity(p_message bigint) returns text language sql as $$
  select private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes)
  from private.telegram_media m where m.chat_id = -1001111111111 and m.message_id = p_message $$;
create function tests.evidence_rows(p_message bigint) returns integer language sql as $$
  select count(*)::integer from private.media_evidence ev join private.telegram_media m on m.id = ev.telegram_media_id
  where m.chat_id = -1001111111111 and m.message_id = p_message $$;
create function tests.last_audit(p_message bigint) returns text language sql as $$
  select a.actor_kind || ':' || a.action || ':' || coalesce(a.detail, '-') || ':' || a.review_revision
  from private.channel_review_audit a where a.ingestion_event_id = tests.ev_id(p_message) order by a.id desc limit 1 $$;
create function tests.snapshot(p_tmdb integer, p_title text) returns jsonb language sql immutable as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'original_title', p_title, 'overview', 'Synthetic.',
    'release_date', '2024-05-01', 'runtime_minutes', 100, 'poster_path', null, 'backdrop_path', null,
    'vote_average', 7.1, 'vote_count', 10, 'genres', jsonb_build_array(jsonb_build_object('tmdb_id', 18, 'name', 'Drama'))) $$;
-- Bounded evidence: verified (canonical), or a property of the document (not an MP4).
create function tests.evidence(p_identity text, p_verified boolean) returns jsonb language sql immutable as $$
  select jsonb_build_object('identity', p_identity, 'method', 'bounded_mtproto_v1', 'policy_version', 2,
    'media_class', case when p_verified then 'canonical' else 'unverified' end,
    'reasons', case when p_verified then '[]'::jsonb else '["container_not_mp4"]'::jsonb end,
    'container', case when p_verified then 'mp4' end, 'video_codec', case when p_verified then 'h264' end,
    'audio_codec', case when p_verified then 'aac' end, 'accessible', p_verified, 'gateway_compatible', true,
    'playback_ready', p_verified, 'bytes_read', case when p_verified then 3072 else 16 end) $$;
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
-- The reviewer (a1) requests a re-inspection at the given revision.
create function tests.retry(p_message bigint, p_revision integer) returns text language sql as $$
  select tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
    format($q$ select (v->>'status') || ':' || (v->>'revision') from public.discovery_review_retry(%L, %s) v $q$, tests.key(p_message), p_revision)) $$;
create function tests.blockers(p_message bigint) returns text language sql as $$
  select tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
    format($q$ select public.discovery_review_get(%L)->'blockers' $q$, tests.key(p_message))) $$;
create function tests.view(p_message bigint) returns jsonb language sql as $$
  select tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
    format($q$ select public.discovery_review_get(%L) $q$, tests.key(p_message)))::jsonb $$;

insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into public.vjs (slug, name, is_active) values ('vj-e38r-test', 'VJ E38R Test', true), ('vj-e38r-other', 'VJ E38R Other', true);
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'review@e38r.invalid'),
  ('00000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'rights@e38r.invalid');
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000a1', true, false, false),
  ('00000000-0000-4000-8000-0000000000a2', false, true, false);
create function tests.vj() returns bigint language sql as $$ select id from public.vjs where slug = 'vj-e38r-test' $$;
create function tests.other_vj() returns bigint language sql as $$ select id from public.vjs where slug = 'vj-e38r-other' $$;
grant execute on all functions in schema tests to service_role, authenticated;
insert into private.discovery_cursors (bot_type) values ('movie');
select update_offset from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c1', 60);
create temporary table claim on commit drop as select null::jsonb as c;

create function tests.assessment(p_container text, p_ok boolean default true, p_tail boolean default false)
returns jsonb language sql as $$
 select jsonb_build_object('accepted',p_ok,'container',p_container,
  'reasons',case when p_ok then '[]'::jsonb else '["audio_metadata_incomplete"]'::jsonb end,
  'warnings',case when p_container='mkv' then '["firefox_mkv_streaming_unreliable"]'::jsonb
    when p_tail then '["mp4_startup_tail_required"]'::jsonb else '[]'::jsonb end,
  'integrity',case when p_ok then 'metadata_consistent' else 'incomplete' end,
  'streaming',case when not p_ok then 'unverified' when p_tail then 'potentially_playable_startup_warning' else 'potentially_playable' end,
  'download','not_implemented_authorization_required',
  'compatibility',jsonb_build_object('basis','tested_fixture_combinations','perFile','prediction',
    'evidence','docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
    'chromium','tested_combination','firefox',case when p_container='mkv' then 'streaming_unreliable' else 'tested_combination' end,
    'safari','real_device_not_tested','ios','real_device_not_tested','android','real_device_not_tested'),
  'tracks','[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"language":"eng","defaultTrack":true,"forced":false,"attachedPicture":false}]'::jsonb)
$$;
create function tests.evidence3(p_message bigint,p_container text,p_ok boolean default true,p_tail boolean default false)
returns jsonb language sql as $$
 select tests.evidence(tests.identity(p_message),true)||jsonb_build_object('method','bounded_original_v2','policy_version',3,
   'media_class',case when p_ok then 'original' else 'unverified' end,'container',p_container,'playback_ready',false,
   'reasons',tests.assessment(p_container,p_ok,p_tail)->'reasons','assessment',tests.assessment(p_container,p_ok,p_tail),'inspection_scope','bounded')
$$;
grant execute on all functions in schema tests to authenticated,service_role;

select ok(private.original_media_assessment_valid(tests.assessment('mp4')), 'actual assessment shape is accepted');
select ok(private.original_media_assessment_valid(tests.assessment('mkv')), 'MKV assessment is accepted');
select ok(not private.original_media_assessment_valid(tests.assessment('mkv')||'{"integrity":"verified"}'), 'bounded worker cannot assert verified integrity');
select ok(not private.original_media_assessment_valid(tests.assessment('mp4')||'{"streaming":"verified"}'), 'bounded worker cannot assert verified streaming');
select ok(not private.original_media_assessment_valid(jsonb_set(tests.assessment('mkv'),'{compatibility,firefox}','"tested_combination"')), 'Firefox MKV reliability claim refused');
select ok(not private.original_media_assessment_valid(jsonb_set(tests.assessment('mp4'),'{compatibility,safari}','"tested_combination"')), 'Safari real-device support claim refused');
select ok(not private.original_media_assessment_valid(tests.assessment('mp4')||'{"download":"available"}'), 'inspection cannot authorize downloads');
select ok(not private.original_media_assessment_valid(tests.assessment('mp4')||'{"tracks":[]}'), 'accepted result needs complete video and audio metadata');
select ok(not private.original_media_assessment_valid(tests.assessment('mp4')||'{"privileged":true}'), 'unexpected assessment fields refused');
select ok(private.original_media_assessment_valid(tests.assessment('mp4',false)), 'incomplete evidence can be retained');

select is(public.discovery_receive('00000000-0000-4000-8000-0000000000c1',-1001111111111,
  jsonb_build_array(tests.doc(900,90,'fake90',10000,1760000900,'Original.MP4'),tests.doc(901,91,'fake91',10000,1760000901,'Original.MKV')),null)->>'detected','2','two original fixture documents');
update claim set c=public.discovery_claim(240);
select is(public.discovery_complete(tests.key(90),(select c->>'lease' from claim)::uuid,1,
  tests.result(9800090,'Original Film',tests.vj(),tests.evidence(tests.identity(90),false))),'needs_review','historical failure recorded');
select is(tests.as_role('authenticated',tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format('select public.discovery_review_correct(%L,1,9800090,2024,%s)->>''revision''',tests.key(90),tests.vj())),'2','reviewer confirms film and VJ');
-- Finish 91 before requesting media-only work on 90; do not rely on tie order.
update claim set c=public.discovery_claim(240);
select is(public.discovery_complete(tests.key(91),(select c->>'lease' from claim)::uuid,1,
  tests.result(9800091,'MKV Film',tests.vj(),tests.evidence3(91,'mkv'))),'needs_review','policy 3 MKV persisted through existing completion');
select is(tests.retry(90,2),'received:3','media-only reinspection requested on synthetic candidate');
update claim set c=public.discovery_claim(240);
select throws_ok(format('select public.discovery_complete(%L,%L,3,%L)',tests.key(90),(select c->>'lease' from claim),
  tests.result(9800090,'Original Film',tests.vj(),tests.evidence3(90,'mp4')||'{"playback_ready":true}')),
  '22023','discovery_invalid_input','legacy ready flag cannot promote policy 3');
select throws_ok(format('select public.discovery_complete(%L,%L,3,%L)',tests.key(90),(select c->>'lease' from claim),
  tests.result(9800090,'Original Film',tests.vj(),tests.evidence3(90,'mp4')||jsonb_build_object('identity','tg1-'||repeat('0',64)))),
  'P0001','discovery_evidence_identity_mismatch','exact Telegram identity remains authoritative');
select is(public.discovery_complete(tests.key(90),(select c->>'lease' from claim)::uuid,3,
  tests.result(9899999,'Wrong Film',tests.other_vj(),tests.evidence3(90,'mp4',true,true))),'needs_review','tail-index MP4 retained without conversion');
select is(tests.choice(90),'confirmed:9800090:Original Film:2024:vj-e38r-test','confirmed film and VJ preserved');
select is(tests.evidence_rows(90),2,'failure and later inspection both retained');
select is((select count(*)::integer from private.media_evidence where media_identity=tests.identity(90) and reasons=array['container_not_mp4']),1,'historical failure is not rewritten as success');
select is((select integrity_status||':'||streaming_status||':'||verified from private.channel_current_evidence((select telegram_media_id from private.ingestion_events where id=tests.ev_id(90)))),
 'metadata_consistent:potentially_playable_startup_warning:false','metadata and startup warning are distinct from verification');
select is(tests.blockers(90),'["media_verification_required", "rights_clearance_required"]','browser warnings do not bypass verification or rights');
select is(tests.view(91)->'evidence'->'browser_profile'->>'firefox','streaming_unreliable','readback retains Firefox limitation');
select is(tests.view(90)->'evidence'->'tracks'->1->>'language','eng','audio language and full tracks retained');
select is(tests.as_role('authenticated',tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format('select public.discovery_review_clear_rights(%L,3,''contract-test'')',tests.key(90))), 'review_not_authorized','review-only user cannot clear rights');
select is(tests.as_role('authenticated',tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format('select public.discovery_review_publish(%L,3)',tests.key(90))), 'review_not_authorized','review-only user cannot publish');
select is(tests.as_role('authenticated',tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format('select public.discovery_review_clear_rights(%L,3,''fixture-contract'')->>''revision''',tests.key(90))), '4','separate rights-capable actor may clear rights');
select is(tests.blockers(90),'["media_verification_required"]','rights clearance does not imply verified integrity or streaming');
select is(tests.as_role('authenticated',tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format('select public.discovery_review_approve(%L,4)',tests.key(90))), 'review_gates_not_met','approval still rejects insufficient media proof with rights cleared');
select throws_ok('update private.media_evidence set reasons=''{}''','P0001','audit_append_only','evidence cannot be edited');
select throws_ok('delete from private.media_evidence','P0001','audit_append_only','evidence cannot be deleted');

-- Pure proposed publication predicate. No producer currently persists these
-- verified states: this fixture is a composite value, not a row or a new RPC.
create function tests.proof(p jsonb default '{}'::jsonb) returns boolean language sql as $$
 select private.media_evidence_publishable(jsonb_populate_record(null::private.media_evidence,
  '{"policy_version":3,"integrity_status":"verified","streaming_status":"verified","accessible":true,"gateway_compatible":true,"reasons":[],"container":"mkv","warnings":["firefox_mkv_streaming_unreliable"]}'::jsonb||p))
$$;
select ok(tests.proof(),'verified integrity and streaming permit the media gate despite browser warning');
select ok(not tests.proof('{"integrity_status":"incomplete"}'),'incomplete integrity blocks');
select ok(not tests.proof('{"streaming_status":"potentially_playable_startup_warning"}'),'potential streaming is not verified streaming');
select ok(not tests.proof('{"streaming_status":"unverified"}'),'indeterminate streaming blocks');
select ok(tests.proof('{"container":"mp4"}'),'non-fast-start container has no automatic corruption veto');
select ok(not has_function_privilege('anon','public.discovery_complete(text,uuid,integer,jsonb)','EXECUTE'),'anon cannot complete inspections');
select is(tests.as_role('anon',null,format('select public.discovery_complete(%L,null,1,null)',tests.key(90))), 'permission denied for function discovery_complete','actual unauthenticated execution denied');
select ok(not has_table_privilege('authenticated','private.media_evidence','SELECT,INSERT,UPDATE,DELETE'),'no direct evidence access');
select ok((select relrowsecurity from pg_class where oid='private.media_evidence'::regclass),'evidence RLS retained');
select is((select count(*)::integer from pg_proc where oid in ('public.discovery_complete(text,uuid,integer,jsonb)'::regprocedure,'public.movie_media_profile(bigint)'::regprocedure) and proconfig=array['search_path=""']),2,'definer search paths are pinned');
select is(public.movie_media_profile(99999999)::text,null,'unknown or unpublished version has no public profile');

select * from finish();
rollback;
