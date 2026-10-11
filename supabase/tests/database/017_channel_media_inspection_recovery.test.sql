-- E3.8 media inspection recovery
-- (20261011112745_channel_media_inspection_recovery.sql).
--
-- A confirmed channel candidate can have its media inspected again without
-- losing the reviewer's film and VJ: the claim carries the confirmed choice,
-- the completion never replaces it, transient reader failures retry inside the
-- unchanged five-attempt bound without touching evidence, a failure of the
-- document itself stays visible at the media gate, and the reviewer view
-- reports the last inspection. Privileges are unchanged. Fake ids only.
-- Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(66);

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

-- ---------------------------------------------------------------------------
-- Privileges and shape of the replaced functions: exactly as before
-- ---------------------------------------------------------------------------
select is((select array_agg(format('%s %s', r, f) order by format('%s %s', r, f)) from
             unnest(array['public.discovery_claim(integer)', 'public.discovery_complete(text,uuid,integer,jsonb)',
                          'public.discovery_fail(text,uuid,integer,text)']) f,
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service', 'velora_media_gateway',
                          'velora_discovery_worker', 'velora_upload_worker']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  array['service_role public.discovery_claim(integer)', 'service_role public.discovery_complete(text,uuid,integer,jsonb)',
        'service_role public.discovery_fail(text,uuid,integer,text)',
        'velora_discovery_worker public.discovery_claim(integer)', 'velora_discovery_worker public.discovery_complete(text,uuid,integer,jsonb)',
        'velora_discovery_worker public.discovery_fail(text,uuid,integer,text)'],
  'worker commands: EXECUTE for service_role and the discovery worker login only');
select is((select array_agg(r order by r) from
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service', 'velora_media_gateway',
                          'velora_discovery_worker', 'velora_upload_worker']) r
           where has_function_privilege(r, 'public.discovery_review_retry(text,integer)', 'EXECUTE')),
  array['authenticated'], 'reviewer re-inspection: EXECUTE for authenticated only');
select is((select array_agg(r) from
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service', 'velora_media_gateway',
                          'velora_discovery_worker', 'velora_upload_worker']) r
           where has_function_privilege(r, 'private.channel_view(bigint,boolean)', 'EXECUTE')),
  null, 'the reviewer view stays an owner function no role can execute directly');
select is((select array_agg(p.proname::text || ':' || p.prosecdef order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname, p.proname) in (('public', 'discovery_claim'), ('public', 'discovery_complete'), ('public', 'discovery_fail'),
                                            ('public', 'discovery_review_retry'), ('private', 'channel_view'))
             and coalesce(p.proconfig @> array['search_path=""'], false)),
  array['channel_view:false', 'discovery_claim:true', 'discovery_complete:true', 'discovery_fail:true', 'discovery_review_retry:true'],
  'each keeps its security mode and an empty search_path');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.proname in ('discovery_claim', 'discovery_complete', 'discovery_fail', 'discovery_review_retry', 'channel_view')),
  5, 'no overload was added: the same five signatures');
select is((select array_agg(p.proname::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.proname in ('discovery_claim', 'discovery_complete', 'discovery_fail', 'discovery_review_retry', 'channel_view')
             and p.prosrc ~* '\mexecute\M|format\s*\('), null, 'no dynamic SQL');

-- ---------------------------------------------------------------------------
-- First inspection without a media reader, then the reviewer's confirmation
-- ---------------------------------------------------------------------------
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(200, 60, 'AgADuniq60', 1961905342, 1760000600, 'Seventh.Film.2024.VJ.Test.mkv'),
                    tests.doc(201, 61, 'AgADuniq61', 1771009492, 1760000601, 'Eighth.Film.2024.VJ.Test.mp4')))), '2', 'two channel documents detected');
update claim set c = (select public.discovery_claim(240));
select is((select (c->>'key') || ':' || (c ? 'confirmed_selection') || ':' || jsonb_typeof(c->'confirmed_selection') from claim), tests.key(60) || ':true:null',
  'an unconfirmed candidate is claimed for a full inspection (no confirmed choice)');
select is(public.discovery_complete(tests.key(60), (select c->>'lease' from claim)::uuid, 1, tests.result(9800007, 'Seventh Film', tests.vj(), null)),
  'needs_review', 'metadata inspection completes without media evidence (worker in metadata mode)');
select is(tests.choice(60), 'proposed:9800007:Seventh Film:2024:vj-e38r-test', 'an unconfirmed candidate takes the worker''s proposal, as before');
select is(tests.last_audit(60), 'worker:inspected:proposed:1', 'the first inspection is audited as before');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 9800007, 2024, %s)->>'revision' $$, tests.key(60), tests.vj())), '2', 'the reviewer confirms the film and the VJ');
select is(tests.blockers(60), '["media_verification_required", "rights_clearance_required"]', 'confirmed, waiting at the media gate');

-- A non-media failure keeps its short schedule (message 61, never confirmed).
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_fail(tests.key(61), (select c->>'lease' from claim)::uuid, 1, 'inspection_provider_failed') || ':' || tests.delay(61), 'failed:2',
  'a metadata provider failure still retries after 2 s');
select is(public.discovery_claim(240)::text, null, 'a confirmed candidate at the media gate is not claimed by itself: a reviewer requests the check');

-- ---------------------------------------------------------------------------
-- Reviewer-requested media check: confirmed metadata travels with the claim
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_retry(%L, 2)::text $$, tests.key(60))), 'review_not_authorized', 'a rights-only account cannot request an inspection');
select is(tests.as_role('service_role', null, format($$ select public.discovery_review_retry(%L, 2)::text $$, tests.key(60))),
  'permission denied for function discovery_review_retry', 'the worker cannot request an inspection');
select is(tests.retry(60, 1), 'review_stale_revision', 'a stale revision is refused');
select is(tests.retry(60, 2), 'received:3', 'the reviewer requests the media check (new revision)');
select is(tests.choice(60), 'confirmed:9800007:Seventh Film:2024:vj-e38r-test', 'the request keeps the confirmed film and VJ');
select is(tests.last_audit(60), 'reviewer:reinspection_requested:media_only:3', 'the request is audited as media-only');
update claim set c = (select public.discovery_claim(240));
select is((select (c->'confirmed_selection') - 'snapshot'::text from claim),
  jsonb_build_object('title', 'Seventh Film', 'year', 2024, 'vj_text', 'Test', 'vj_id', tests.vj(), 'tmdb_id', 9800007),
  'the claim carries the confirmed film, year and VJ');
select is((select c->'confirmed_selection'->'snapshot' from claim), tests.snapshot(9800007, 'Seventh Film'), 'and the validated snapshot the reviewer chose');
select is((select (c->>'key') || ':' || (c->>'revision') || ':' || (c->>'attempts') || ':' || (c->>'identity') from claim),
  tests.key(60) || ':3:1:' || tests.identity(60), 'under a fenced lease for the same document identity');

-- ---------------------------------------------------------------------------
-- Transient reader failures: bounded retry, longer backoff, no evidence
-- ---------------------------------------------------------------------------
select is(public.discovery_fail(tests.key(60), (select c->>'lease' from claim)::uuid, 3, 'media_read_flood_wait') || ':' || tests.delay(60), 'failed:30',
  'a transient reader failure retries after 30 s');
select is(tests.state(60), 'failed:3:1:media_read_flood_wait', 'the failure keeps its fixed code');
select is(tests.choice(60) || ':' || tests.evidence_rows(60), 'confirmed:9800007:Seventh Film:2024:vj-e38r-test:0',
  'it changes neither the confirmed choice nor the evidence');
select is(public.discovery_claim(240)::text, null, 'it waits for its backoff');
select is((select (v->'inspection'->'last'->>'action') || ':' || (v->'inspection'->'last'->>'detail') || ':' || ((v->'inspection'->>'retry_at') is not null) || ':' || (v->>'attempts')
           from tests.view(60) v), 'inspection_failed:media_read_flood_wait:true:1', 'the reviewer sees the last failure, the attempt count and the next retry');
select is(tests.blockers(60), '["inspection_pending", "media_verification_required", "rights_clearance_required"]', 'the gates say an inspection is pending');
update private.channel_reviews set retry_at = now() - interval '1 second' where ingestion_event_id = tests.ev_id(60);
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_fail(tests.key(60), (select c->>'lease' from claim)::uuid, 3, 'media_read_mtproto_disconnected') || ':' || tests.delay(60), 'failed:60', 'second attempt: 60 s');
update private.channel_reviews set retry_at = now() - interval '1 second' where ingestion_event_id = tests.ev_id(60);
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_fail(tests.key(60), (select c->>'lease' from claim)::uuid, 3, 'probe_timeout') || ':' || tests.delay(60), 'failed:120', 'third attempt (probe timeout): 120 s');
update private.channel_reviews set retry_at = now() - interval '1 second' where ingestion_event_id = tests.ev_id(60);
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_fail(tests.key(60), (select c->>'lease' from claim)::uuid, 3, 'media_read_upstream_timeout') || ':' || tests.delay(60), 'failed:240', 'fourth attempt: 240 s');
update private.channel_reviews set retry_at = now() - interval '1 second' where ingestion_event_id = tests.ev_id(60);
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_fail(tests.key(60), (select c->>'lease' from claim)::uuid, 3, 'media_read_flood_wait'), 'blocked', 'the fifth failure exhausts the bound: no endless retry');
select is(tests.state(60), 'blocked:3:5:inspection_attempts_exhausted', 'it is blocked for a reviewer, attempts not reset');
update private.channel_reviews set retry_at = now() - interval '1 second' where ingestion_event_id = tests.ev_id(60);
select is(public.discovery_claim(240)::text, null, 'an exhausted candidate is never claimed again by itself');
select is((select (v->'inspection'->'last'->>'detail') || ':' || coalesce(v->'inspection'->>'retry_at', 'none') from tests.view(60) v),
  'media_read_flood_wait:none', 'the last reason stays visible and no retry is scheduled');
select is(tests.choice(60) || ':' || tests.evidence_rows(60), 'confirmed:9800007:Seventh Film:2024:vj-e38r-test:0', 'exhaustion loses nothing the reviewer decided');

-- ---------------------------------------------------------------------------
-- An authorized re-inspection of the exhausted candidate; the document itself fails
-- ---------------------------------------------------------------------------
select is(tests.retry(60, 3), 'received:4', 'a reviewer re-opens the exhausted candidate');
select is(tests.state(60), 'received:4:0:-', 'attempts restart only on that explicit, audited request');
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_complete(tests.key(60), '00000000-0000-4000-8000-00000000dead', 4, tests.result(9800007, 'Seventh Film', tests.vj(), tests.evidence(tests.identity(60), true)))
          || ':' || tests.evidence_rows(60), 'stale:0', 'another lease cannot record evidence');
select is(public.discovery_complete(tests.key(60), (select c->>'lease' from claim)::uuid, 3, tests.result(9800007, 'Seventh Film', tests.vj(), tests.evidence(tests.identity(60), true)))
          || ':' || tests.evidence_rows(60), 'stale:0', 'nor can a lease for an older revision');
select throws_ok(format($$ select public.discovery_complete(%L, %L, 4, %L) $$, tests.key(60), (select c->>'lease' from claim),
  tests.result(9800007, 'Seventh Film', tests.vj(), tests.evidence('tg1-' || repeat('0', 64), true))),
  'P0001', 'discovery_evidence_identity_mismatch', 'evidence for another document identity is refused');
-- The worker reports the wrong film, another VJ and a document that is not an MP4.
select is(public.discovery_complete(tests.key(60), (select c->>'lease' from claim)::uuid, 4,
  tests.result(9899999, 'Wrong Film', tests.other_vj(), tests.evidence(tests.identity(60), false))), 'needs_review', 'the media-only inspection completes');
select is(tests.choice(60), 'confirmed:9800007:Seventh Film:2024:vj-e38r-test', 'nothing the worker sent replaces the confirmed film, year or VJ');
select is((select array_agg(c.tmdb_id || ':' || c.decision order by c.tmdb_id) from private.metadata_match_candidates c where c.ingestion_event_id = tests.ev_id(60)),
  array['9800007:pending'], 'the match candidates are untouched: none added, none superseded');
select is((select ev.verified::text || ':' || ev.media_class || ':' || array_to_string(ev.reasons, ',') || ':' || ev.scope
           from private.channel_current_evidence((select telegram_media_id from private.ingestion_events where id = tests.ev_id(60))) ev),
  'false:unverified:container_not_mp4:bounded', 'the bounded evidence is recorded with its reason and is not verified');
select is(tests.state(60) || ' ' || tests.last_audit(60), 'needs_review:4:1:- worker:media_inspected:unverified:unverified:4',
  'a document outside the policy returns to review at the media gate, audited');
select is(tests.blockers(60), '["media_verification_required", "rights_clearance_required"]', 'publication stays blocked');
select is((select (v->'evidence'->'reasons')::text || ':' || (v->'inspection'->'last'->>'action') || ':' || (v::text ~ 'synthetic-file') from tests.view(60) v),
  '["container_not_mp4"]:media_inspected:false', 'the reviewer sees why, and never the bot file_id');
select is(public.discovery_claim(240)::text, null, 'a failure of the document itself is not retried by itself');

-- ---------------------------------------------------------------------------
-- A passing check; later reader-less passes and outages never supersede it
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_clear_rights(%L, 4, 'contract E38R-060')->>'revision' $$, tests.key(60))), '5', 'rights cleared at revision 5');
select is(tests.retry(60, 5), 'received:6', 'the reviewer runs the media check again (new revision)');
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_complete(tests.key(60), (select c->>'lease' from claim)::uuid, 6, tests.result(9800007, 'Seventh Film', tests.vj(), tests.evidence(tests.identity(60), true))),
  'needs_review', 'the check passes');
select is(tests.last_audit(60) || ' ' || tests.evidence_rows(60), 'worker:media_inspected:verified:6 2', 'verified evidence is recorded beside the earlier failing record');
select is(tests.blockers(60), '["rights_clearance_required"]',
  'the media gate passes; the clearance of the earlier revision no longer counts (revision semantics unchanged)');
select is(tests.choice(60), 'confirmed:9800007:Seventh Film:2024:vj-e38r-test', 'still the confirmed film and VJ');
select is(tests.retry(60, 6), 'received:7', 'another request');
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_complete(tests.key(60), (select c->>'lease' from claim)::uuid, 7, tests.result(9800007, 'Seventh Film', tests.vj(), null))
          || ' ' || tests.last_audit(60), 'needs_review worker:media_inspected:no_evidence:7', 'a worker without a media reader records that nothing was checked');
select is(tests.blockers(60) || ' ' || tests.evidence_rows(60), '["rights_clearance_required"] 2', 'which never supersedes the verified evidence');
select is(tests.retry(60, 7), 'received:8', 'and another');
update claim set c = (select public.discovery_claim(240));
select is(public.discovery_fail(tests.key(60), (select c->>'lease' from claim)::uuid, 8, 'media_read_mtproto_disconnected') || ' ' || tests.evidence_rows(60)
          || ' ' || (select ev.verified from private.channel_current_evidence((select telegram_media_id from private.ingestion_events where id = tests.ev_id(60))) ev),
  'failed 2 true', 'a reader outage is a failed attempt: the verified evidence stands');

-- ---------------------------------------------------------------------------
-- A replaced document is never inspected as the confirmed film
-- ---------------------------------------------------------------------------
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(202, 60, 'AgADswap60', 1961905342, 1760000700, 'Other.Film.2023.VJ.Test.mp4', 'edited_channel_post')))), '1', 'the post is edited to another document');
select is(tests.choice(60) || ' ' || tests.state(60), 'unknown:-:-:-:- received:9:0:-', 'the confirmation does not survive a replaced document');
update private.channel_reviews set retry_at = now() - interval '1 hour' where ingestion_event_id = tests.ev_id(60);
update claim set c = (select public.discovery_claim(240));
select is((select (c->>'key') || ':' || jsonb_typeof(c->'confirmed_selection') || ':' || ((c->>'identity') = tests.identity(60)) from claim), tests.key(60) || ':null:true',
  'it is claimed for a full inspection of the new document, with no confirmed choice');
select is(tests.blockers(60), '["inspection_pending", "identity_unconfirmed", "vj_unresolved", "media_verification_required", "rights_clearance_required"]',
  'and evidence of the old document no longer counts');

select * from finish();
rollback;
