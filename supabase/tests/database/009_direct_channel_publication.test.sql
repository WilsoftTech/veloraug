-- E3.8A direct channel discovery, review and publication
-- (20261010090000_direct_channel_publication.sql).
--
-- Privileges of every new object; provenance separation from the uploader;
-- delivery dedupe, ordering, edits and the consumer lease; fenced inspection;
-- every review and publication gate (identity, VJ, media evidence, rights,
-- revision, capability, relation); stale evidence after a replaced document;
-- atomic, idempotent publication through the shared materializer; the public
-- read and gateway resolver afterwards. Fake ids only. Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(139);

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
    'release_date', '2024-05-01', 'runtime_minutes', 100, 'poster_path', null, 'backdrop_path', null,
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

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select is((select array_agg(c.relname::text order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'private' and c.relkind = 'r' and not c.relrowsecurity), null, 'RLS on every private table');
select is((select array_agg(format('%s %s %s', r, p, t)) from
             unnest(array['private.channel_reviews', 'private.media_evidence', 'private.rights_clearances', 'private.catalogue_reviewers',
                          'private.channel_review_audit', 'private.discovery_deliveries', 'private.discovery_cursors']) t,
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service', 'velora_media_gateway']) r,
             unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
           where has_table_privilege(r, t, p)), null, 'no API or service role has any privilege on the new tables');
select is((select count(*)::int from pg_policies where schemaname = 'private'), 0, 'no policy opens a private table');
select is((select array_agg(format('%s %s', r, f) order by format('%s %s', r, f)) from
             unnest(array['public.discovery_acquire_consumer(uuid,integer)', 'public.discovery_receive(uuid,bigint,jsonb,jsonb)',
                          'public.discovery_claim(integer)', 'public.discovery_complete(text,uuid,integer,jsonb)',
                          'public.discovery_fail(text,uuid,integer,text)', 'public.discovery_catalogue_lookup(text)',
                          'public.discovery_vjs()', 'public.discovery_health()']) f,
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  array(select 'service_role ' || f from unnest(array['public.discovery_acquire_consumer(uuid,integer)', 'public.discovery_catalogue_lookup(text)',
          'public.discovery_claim(integer)', 'public.discovery_complete(text,uuid,integer,jsonb)', 'public.discovery_fail(text,uuid,integer,text)',
          'public.discovery_health()', 'public.discovery_receive(uuid,bigint,jsonb,jsonb)', 'public.discovery_vjs()']) f order by 1),
  'worker commands: EXECUTE for service_role only');
select is((select array_agg(format('%s %s', r, f) order by format('%s %s', r, f)) from
             unnest(array['public.discovery_review_list(text,text,integer)', 'public.discovery_review_get(text)',
                          'public.discovery_review_correct(text,integer,integer,integer,bigint)',
                          'public.discovery_review_clear_rights(text,integer,text)', 'public.discovery_review_reject(text,integer)',
                          'public.discovery_review_retry(text,integer)']) f,
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  array(select 'authenticated ' || f from unnest(array['public.discovery_review_clear_rights(text,integer,text)',
          'public.discovery_review_correct(text,integer,integer,integer,bigint)', 'public.discovery_review_get(text)',
          'public.discovery_review_list(text,text,integer)', 'public.discovery_review_reject(text,integer)',
          'public.discovery_review_retry(text,integer)']) f order by 1),
  'reviewer commands: EXECUTE for authenticated only');
select is((select array_agg(format('%s %s', r, f) order by format('%s %s', r, f)) from
             unnest(array['catalogue_review.approve_channel_candidate(text,integer,uuid)', 'catalogue_review.publish_channel_candidate(text,integer,uuid)']) f,
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service', 'velora_media_gateway']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  array['velora_review_service catalogue_review.approve_channel_candidate(text,integer,uuid)',
        'velora_review_service catalogue_review.publish_channel_candidate(text,integer,uuid)'],
  'approval and publication: velora_review_service only');
select is((select array_agg(r order by r) from unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service']) r
           where has_schema_privilege(r, 'catalogue_review', 'USAGE')), array['velora_review_service'], 'catalogue_review schema: review service only');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname ~ 'approve|publish'), 0, 'still no approval or publication function in the Data API schema');
select is((select array_agg(format('%s %s', r, f)) from
             unnest(array['private.catalogue_materialize_movie_version(integer,bigint,bigint,jsonb)', 'private.catalogue_publish_channel_movie(bigint,integer,uuid)',
                          'private.catalogue_publish_movie(text,jsonb,boolean)', 'private.channel_review_blockers(bigint)',
                          'private.reviewer_has(uuid,text)', 'private.channel_view(bigint,boolean)']) f,
             unnest(array['anon', 'authenticated', 'service_role', 'velora_review_service', 'velora_media_gateway']) r
           where has_function_privilege(r, f, 'EXECUTE')), null, 'owner functions: no API or service role can execute them');
select is((select array_agg(p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('catalogue_materialize_movie_version', 'catalogue_publish_channel_movie', 'catalogue_publish_movie')
             and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false))), null,
  'owner publication functions: SECURITY INVOKER with an empty search_path');
select is((select array_agg(n.nspname || '.' || p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private', 'catalogue_review') and (p.proname ~ '^discovery_|^channel_|_channel_' or n.nspname = 'catalogue_review')
             and p.prosrc ~* '\mexecute\M|format\s*\('), null, 'no dynamic SQL in the new functions');
select ok((select not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
           from pg_roles where rolname = 'velora_review_service'), 'velora_review_service: NOLOGIN, NOINHERIT, no attributes');
select is((select count(*)::int from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'velora_review_service'), 0,
  'velora_review_service is a member of no role');

-- ---------------------------------------------------------------------------
-- Consumer lease and delivery recording
-- ---------------------------------------------------------------------------
select is(tests.as_role('service_role', null, $$ select update_offset::text from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c1', 60) $$),
  'discovery_not_initialized', 'no cursor: discovery fails closed before the owner initializes it');
insert into private.discovery_cursors (bot_type) values ('movie');
select is(tests.as_role('service_role', null, $$ select coalesce(update_offset::text, 'none') from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c1', 60) $$),
  'none', 'consumer lease acquired; offset starts empty');
select is(tests.as_role('service_role', null, $$ select update_offset::text from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c2', 60) $$),
  'discovery_consumer_busy', 'a second consumer is refused while the lease is held');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c2', -1001111111111, %L, null)::text $$,
  jsonb_build_array(tests.doc(100, 10, 'AgADuniq10', 1048576, 1760000100)))), 'discovery_consumer_lease_lost', 'a non-holder cannot record deliveries');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1009999999999, %L, null)::text $$,
  jsonb_build_array(tests.doc(100, 10, 'AgADuniq10', 1048576, 1760000100)))), 'discovery_channel_not_allowed', 'an unregistered channel is refused');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'), format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)::text $$,
  jsonb_build_array(tests.doc(100, 10, 'AgADuniq10', 1048576, 1760000100)))), 'permission denied for function discovery_receive', 'a reviewer session cannot record deliveries');
select is(tests.as_role('service_role', null, format($$ select (public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected') $$,
  jsonb_build_array(tests.doc(100, 10, 'AgADuniq10', 1048576, 1760000100)))), '1', 'a new channel document is detected');
select is(tests.status(10), 'received', 'its candidate waits for inspection');
select is((select e.origin || ':' || coalesce(e.source_fingerprint, '-') || ':' || e.upload_attempt_count from private.ingestion_events e where e.id = tests.ev_id(10)),
  'channel:-:0', 'channel provenance: no fingerprint, no upload track');
select is(tests.identity(10), 'tg1-' || encode(sha256(convert_to('[-1001111111111,10,"AgADuniq10",1048576]', 'UTF8')), 'hex'),
  'tg1 identity is the SHA-256 of [chat, message, file_unique_id, size]');
select is(tests.as_role('service_role', null, format($$ select (public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'duplicates') $$,
  jsonb_build_array(tests.doc(100, 10, 'AgADuniq10', 1048576, 1760000100)))), '1', 'a replayed delivery is a duplicate');
select is((select count(*)::int from private.channel_reviews), 1, 'the replay created no second candidate');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)::text $$,
  jsonb_build_array(tests.doc(101, 11, 'AgADuniq11', 2048, 1760000101), jsonb_set(tests.doc(100, 10, 'AgADuniq10', 1048576, 1760000100), '{digest}', to_jsonb(tests.hex('other')))))),
  'discovery_update_payload_conflict', 'the same update with another payload is refused');
select is((select count(*)::int from private.channel_reviews), 1, 'the conflicting batch rolled back entirely (message 11 not recorded)');
select is((select update_offset from private.discovery_cursors), 100::bigint, 'the update offset advanced with the committed batch only');

-- A repost of the same document in another message, and a conflicting size.
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(102, 12, 'AgADuniq10', 1048576, 1760000102), tests.doc(103, 13, 'AgADuniq10', 999, 1760000103)))), '2', 'reposts are recorded');
select is(tests.status(12) || ':' || (select e.error_code from private.ingestion_events e where e.id = tests.ev_id(12)), 'ignored:duplicate_media', 'same document reposted: duplicate, never a second version');
select is(tests.status(13) || ':' || (select e.error_code from private.ingestion_events e where e.id = tests.ev_id(13)), 'blocked:document_identity_conflict', 'same unique id with another size: blocked');
select is((select r.duplicate_of_media_id from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(12)),
  (select id from private.telegram_media where chat_id = -1001111111111 and message_id = 10), 'the duplicate names the original document');

-- The uploader's own post never becomes a channel candidate.
select is(tests.as_role('service_role', null, $$
  select upload_state from public.ingest_upload_start('sf1-' || repeat('9', 64), 'movie', -1001111111111, 4096) $$), 'uploading', 'uploader registers a source');
select is(tests.as_role('service_role', null, $$
  select public.ingest_upload_record('sf1-' || repeat('9', 64), 'movie', -1001111111111, 20, 'up-file', 'AgADupload20', 'document',
    'Upload.mp4', 'video/mp4', 'velora-src:sf1-' || repeat('9', 64), 4096, null, null, null, now())::text $$), 'recorded', 'uploader records its message');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'ignored' $$,
  jsonb_build_array(tests.doc(104, 20, 'AgADupload20', 4096, 1760000104)))), '1', 'a delivery of the uploader''s message is ignored');
select is((select count(*)::int from private.ingestion_events where origin = 'channel' and telegram_media_id = (select id from private.telegram_media where message_id = 20)),
  0, 'no channel row claims uploader media');
select throws_ok($$ insert into private.ingestion_events (bot_type, origin, telegram_media_id, status)
                    values ('movie', 'channel', (select id from private.telegram_media where message_id = 20), 'received') $$,
  '23505', null, 'one document has one provenance: a channel row cannot attach to uploader media');
select throws_ok($$ insert into private.ingestion_events (bot_type, origin, telegram_media_id, status, source_fingerprint)
                    values ('movie', 'channel', (select id from private.telegram_media where message_id = 11 union select null limit 1), 'received', 'sf1-' || repeat('8', 64)) $$,
  '23514', null, 'a channel row can never carry an uploader fingerprint');

-- ---------------------------------------------------------------------------
-- Fenced inspection
-- ---------------------------------------------------------------------------
create temporary table claim on commit drop as select null::jsonb as c;
grant all on claim to service_role;
select is(tests.as_role('service_role', null, $$ with x as (select public.discovery_claim(30) c) update claim set c = x.c from x returning (claim.c->>'key') $$),
  tests.key(10), 'the worker claims the pending candidate');
select is(tests.as_role('service_role', null, $$ select coalesce(public.discovery_claim(30)::text, 'none') $$), 'none', 'no other candidate is due (duplicates are not inspected)');
select is(tests.as_role('service_role', null, format($$ select public.discovery_complete(%L, '00000000-0000-4000-8000-00000000dead', 1, %L) $$,
  tests.key(10), tests.result(9800001, 'Example Movie', tests.vj(), null))), 'stale', 'another lease cannot complete it');
select is(tests.as_role('service_role', null, format($$ select public.discovery_complete(%L, %L, 1, %L) $$,
  tests.key(10), (select c->>'lease' from claim), tests.result(9800001, 'Example Movie', tests.vj(), tests.evidence('tg1-' || repeat('0', 64))))),
  'discovery_evidence_identity_mismatch', 'evidence for another document identity is refused');
select is(tests.as_role('service_role', null, format($$ select public.discovery_complete(%L, %L, 1, %L) $$,
  tests.key(10), (select c->>'lease' from claim), jsonb_set(tests.result(9800001, 'Example Movie', tests.vj(), null), '{proposed_tmdb_id}', '42'))),
  'discovery_invalid_input', 'a proposed identity must be one of the recorded validated choices');
select is(tests.as_role('service_role', null, format($$ select public.discovery_complete(%L, %L, 1, %L) $$,
  tests.key(10), (select c->>'lease' from claim), tests.result(9800001, 'Example Movie', tests.vj(), tests.evidence(tests.identity(10))))),
  'needs_review', 'inspection completes under its lease');
select is((select r.identity_state || ':' || r.tmdb_id || ':' || r.vj_id from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(10)),
  'proposed:9800001:' || tests.vj(), 'a high-confidence match is only a proposal');
select is((select c.snapshot->>'title' from private.metadata_match_candidates c where c.ingestion_event_id = tests.ev_id(10)), 'Example Movie',
  'the validated snapshot is kept with its candidate');
select is((select ev.verified from private.channel_current_evidence((select telegram_media_id from private.ingestion_events where id = tests.ev_id(10))) ev),
  true, 'bounded evidence for the current identity is recorded and verified');
select is((select scope from private.media_evidence limit 1), 'bounded', 'evidence never claims more than a bounded inspection');
select is(tests.as_role('service_role', null, format($$ select public.discovery_complete(%L, %L, 1, %L) $$,
  tests.key(10), (select c->>'lease' from claim), tests.result(9800001, 'Example Movie', tests.vj(), null))), 'stale', 'a completed lease cannot complete twice');
select is(tests.as_role('service_role', null, $$ select public.discovery_complete(null, null, null, null) $$), 'discovery_invalid_input', 'malformed completion is refused');
select is(tests.as_role('service_role', null, $$ select public.discovery_catalogue_lookup('Example Movie')::text $$), '[]', 'catalogue lookup: no title yet');

-- ---------------------------------------------------------------------------
-- Review: capabilities, revisions, gates
-- ---------------------------------------------------------------------------
select is(tests.as_role('anon', null, $$ select public.discovery_review_list(null, null, 10)::text $$),
  'permission denied for function discovery_review_list', 'anon cannot read the review queue');
select is(tests.as_role('service_role', null, $$ select public.discovery_review_list(null, null, 10)::text $$),
  'permission denied for function discovery_review_list', 'the worker cannot read the review queue');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a4'), $$ select public.discovery_review_list(null, null, 10)::text $$),
  'review_not_authorized', 'a signed-in account without a capability is refused');
select is(tests.as_role('authenticated', jsonb_build_object('sub', '00000000-0000-4000-8000-0000000000a1', 'role', 'authenticated', 'is_anonymous', true),
  $$ select public.discovery_review_list(null, null, 10)::text $$), 'review_not_authorized', 'an anonymous sign-in is refused');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  $$ select jsonb_array_length(public.discovery_review_list(null, null, 10))::text $$), '3', 'a reviewer sees the queue');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_get(%L)->'blockers' $$, tests.key(10))),
  '["identity_unconfirmed", "rights_clearance_required"]', 'the reviewer sees exactly what still blocks it');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_get(%L)::text ~ 'synthetic-file' $$, tests.key(10))), 'false', 'the review view never contains the bot file_id');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 1, '00000000-0000-4000-8000-0000000000a1')::text $$, tests.key(10))),
  'review_gates_not_met', 'a proposal cannot be approved before identity confirmation and rights');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_correct(%L, 1, 9800001, 2024, %s)::text $$, tests.key(10), tests.vj())), 'review_not_authorized',
  'a rights-only reviewer cannot confirm identity');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 9, 9800001, 2024, %s)::text $$, tests.key(10), tests.vj())), 'review_stale_revision',
  'a stale revision is refused');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 9800001, 2024, %s)::text $$, tests.key(10), (select id from public.vjs where slug = 'vj-e38a-off'))),
  'review_selection_unavailable', 'an inactive VJ cannot be selected');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 9800001, 2023, %s)::text $$, tests.key(10), tests.vj())), 'review_year_mismatch',
  'the year must agree with the selected metadata');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 77, 2024, %s)::text $$, tests.key(10), tests.vj())), 'review_selection_unavailable',
  'an identity outside the validated choices cannot be selected');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 9800001, 2024, %s)->>'revision' $$, tests.key(10), tests.vj())), '2', 'identity confirmed (revision 2)');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_get(%L)->'blockers' $$, tests.key(10))), '["rights_clearance_required"]', 'only rights remain');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 2, '00000000-0000-4000-8000-0000000000a1')::text $$, tests.key(10))),
  'review_gates_not_met', 'missing rights block approval');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_clear_rights(%L, 2, 'contract E38A-001')::text $$, tests.key(10))), 'review_not_authorized',
  'a review-only account cannot clear rights');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_clear_rights(%L, 2, 'https://evil.example/x')::text $$, tests.key(10))), 'discovery_invalid_input',
  'a rights reference cannot be a URL');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_clear_rights(%L, 2, 'contract E38A-001')->>'revision' $$, tests.key(10))), '3', 'rights cleared at revision 3');
select is((select rc.media_identity = tests.identity(10) and rc.review_revision = 3 from private.rights_clearances rc where rc.ingestion_event_id = tests.ev_id(10)),
  true, 'the clearance is bound to the document identity and revision');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a2')::text $$, tests.key(10))),
  'review_not_authorized', 'approval needs the review capability');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000ff')::text $$, tests.key(10))),
  'review_not_authorized', 'approval for an unknown account is refused');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 2, '00000000-0000-4000-8000-0000000000a1')::text $$, tests.key(10))),
  'review_stale_revision', 'approval of a superseded revision is refused');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a1')->>'status' $$, tests.key(10))),
  'matched', 'all gates pass: approved');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a1')->>'status' $$, tests.key(10))),
  'matched', 'an identical approval replay changes nothing');
select is((select count(*)::int from private.metadata_match_candidates c where c.ingestion_event_id = tests.ev_id(10) and c.decision = 'approved' and c.decided_by = '00000000-0000-4000-8000-0000000000a1'),
  1, 'exactly one approved candidate, attributed to the reviewer');

-- ---------------------------------------------------------------------------
-- Publication
-- ---------------------------------------------------------------------------
select matches(tests.as_role('service_role', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a3')::text $$, tests.key(10))),
  '^permission denied', 'the worker cannot publish');
select matches(tests.as_role('service_role', null, format($$ select (private.catalogue_publish_channel_movie(%s, 3, null)).result $$, tests.ev_id(10))),
  '^permission denied', 'the worker cannot reach the owner publisher');
select matches(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a3'), format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a3')::text $$, tests.key(10))),
  '^permission denied', 'a reviewer session cannot call publication directly through the Data API');
select matches(tests.as_role('velora_review_service', null, format($$ select (private.catalogue_publish_channel_movie(%s, 3, null)).result $$, tests.ev_id(10))),
  '^permission denied', 'the review service cannot bypass to the owner publisher');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a1')::text $$, tests.key(10))),
  'review_not_authorized', 'publication needs the separate publish capability');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 2, '00000000-0000-4000-8000-0000000000a3')::text $$, tests.key(10))),
  'catalogue_stale_review', 'publication of a stale revision is refused');
select is((select count(*)::int from public.movies where tmdb_id = 9800001), 0, 'nothing is public before publication');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a3')->>'result' $$, tests.key(10))),
  'published', 'the approved candidate is published');
select is((select m.publication_status || ':' || mv.availability_status || ':' || mv.rights_status || ':' || (mv.vj_id = tests.vj())
           from public.movies m join public.movie_versions mv on mv.movie_id = m.id where m.tmdb_id = 9800001),
  'published:ready:cleared:true', 'one published title with one ready, cleared VJ version');
select is((select mv.telegram_media_id from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.tmdb_id = 9800001),
  (select telegram_media_id from private.ingestion_events where id = tests.ev_id(10)), 'the version links the exact channel document');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a3')->>'result' $$, tests.key(10))),
  'already_published', 'a replayed publication is idempotent');
select is((select count(*)::int from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.tmdb_id = 9800001), 1, 'the replay created nothing');
select is((select array_agg(a.action order by a.id) from private.channel_review_audit a where a.ingestion_event_id = tests.ev_id(10)),
  array['detected', 'inspected', 'identity_confirmed', 'rights_cleared', 'approved', 'published'], 'every transition is audited in order');
select throws_ok($$ update private.channel_review_audit set action = 'forged' $$, 'P0001', 'audit_append_only', 'the audit is append-only');
select is(tests.as_role('anon', null, $$ select string_agg(m.slug, ',') from public.movies m where m.slug = 'example-movie-2024' $$),
  'example-movie-2024', 'anon reads the published title through the public policies');
select is(tests.as_role('velora_media_gateway', null, format($$ select message_id::text || ':' || file_unique_id from media_gateway.resolve_movie_version(%s) $$,
  (select mv.id from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.tmdb_id = 9800001))), '10:AgADuniq10',
  'the restricted gateway resolver serves the published channel document');

-- After publication the document is frozen; an edit never reaches the catalogue.
select throws_ok($$ update private.telegram_media set file_unique_id = 'AgADswap' where chat_id = -1001111111111 and message_id = 10 $$,
  'P0001', 'telegram_media_identity_immutable', 'published media identity is immutable');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(105, 10, 'AgADreplaced10', 1048576, 1760000200, 'Example.Movie.2024.VJ.Test.mp4', 'edited_channel_post')))), '0',
  'an edit of a published message is not a new candidate');
select is((select e.status || ':' || e.error_code || ':' || m.file_unique_id from private.ingestion_events e join private.telegram_media m on m.id = e.telegram_media_id
           where e.id = tests.ev_id(10)), 'published:published_message_changed:AgADuniq10', 'the published document is unchanged and the change is flagged');

-- ---------------------------------------------------------------------------
-- Stale evidence after a replaced document; unsupported codecs; rejection
-- ---------------------------------------------------------------------------
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(106, 30, 'AgADuniq30', 5000, 1760000300, 'Second.Film.2024.VJ.Test.mp4'),
                    tests.doc(107, 31, 'AgADuniq31', 6000, 1760000301, 'Third.Film.2024.VJ.Test.mp4')))), '2', 'two more documents');
update claim set c = (select public.discovery_claim(30));
select is((select c->>'key' from claim), tests.key(30), 'claims are oldest-first');
select is(public.discovery_complete(tests.key(30), (select c->>'lease' from claim)::uuid, 1, tests.result(9800002, 'Second Film', tests.vj(), tests.evidence(tests.identity(30)))),
  'needs_review', 'second film inspected with verified evidence');
select set_config('request.jwt.claims', '', true);
select throws_ok(format($$ select public.discovery_review_correct(%L, 1, 9800002, 2024, %s) $$, tests.key(30), tests.vj()), '42501', 'review_not_authorized',
  'the owner session has no implicit reviewer identity');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 9800002, 2024, %s)->>'revision' $$, tests.key(30), tests.vj())), '2', 'second film confirmed');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_clear_rights(%L, 2, 'contract E38A-002')->>'revision' $$, tests.key(30))), '3', 'second film rights cleared');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a1')->>'status' $$, tests.key(30))),
  'matched', 'second film approved');
-- The document is replaced in the same message before publication.
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(108, 30, 'AgADswap30', 5000, 1760000400, 'Second.Film.2024.VJ.Test.mp4', 'edited_channel_post')))), '1', 'the replacement is recorded');
select is(tests.status(30) || ':' || tests.rev(30), 'received:4', 'the replacement reopens inspection at a new revision');
select is((select approved_revision from private.channel_reviews where ingestion_event_id = tests.ev_id(30)), null, 'the approval was invalidated');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a3')::text $$, tests.key(30))),
  'catalogue_stale_review', 'the old approval cannot publish the replaced document');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'ignored' $$,
  jsonb_build_array(tests.doc(109, 30, 'AgADuniq30', 5000, 1760000350, 'Second.Film.2024.VJ.Test.mp4', 'edited_channel_post')))), '1',
  'an older edit delivered late never overwrites the newer document');
update claim set c = (select public.discovery_claim(30));
select is(public.discovery_complete(tests.key(30), (select c->>'lease' from claim)::uuid, 4, tests.result(9800002, 'Second Film', tests.vj(), null)),
  'needs_review', 're-inspected without new evidence');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 4, 9800002, 2024, %s)->>'revision' $$, tests.key(30), tests.vj())), '5', 'reconfirmed');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_get(%L)->'blockers' $$, tests.key(30))), '["media_verification_required", "rights_clearance_required"]',
  'evidence and rights for the replaced document are stale');
select is((select count(*)::int from private.media_evidence ev join private.telegram_media m on m.id = ev.telegram_media_id where m.message_id = 30), 1,
  'the old evidence is kept for audit but no longer counts');

-- Unsupported codec evidence never verifies; newer failing evidence supersedes older passing evidence.
update claim set c = (select public.discovery_claim(30));
select is(public.discovery_complete(tests.key(31), (select c->>'lease' from claim)::uuid, 1,
  tests.result(9800003, 'Third Film', tests.vj(), tests.evidence(tests.identity(31), 'video_transcode_required', 'hevc'))), 'needs_review', 'third film inspected (HEVC)');
select is((select ev.verified from private.channel_current_evidence((select telegram_media_id from private.ingestion_events where id = tests.ev_id(31))) ev), false,
  'HEVC evidence is recorded but unverified');
select throws_ok(format($$ insert into private.media_evidence (telegram_media_id, media_identity, method, policy_version, media_class, container, video_codec, audio_codec,
                    accessible, gateway_compatible, playback_ready, bytes_read, scope) values ((select id from private.telegram_media where message_id = 31), %L,
                    'synthetic', 2, 'canonical', 'mp4', 'h264', 'aac', true, true, true, 1, 'full') $$, tests.identity(31)),
  '23514', null, 'evidence cannot claim a full-file scope');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_reject(%L, 1)->>'status' $$, tests.key(31))), 'rejected', 'the reviewer rejects the third film');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 1, '00000000-0000-4000-8000-0000000000a1')::text $$, tests.key(31))),
  'review_illegal_transition', 'a rejected candidate cannot be approved');

-- ---------------------------------------------------------------------------
-- Atomicity and concurrent versions
-- ---------------------------------------------------------------------------
-- Message 11 (rolled back earlier) arrives again: a second document for the
-- published title with the same VJ, i.e. a replacement. Its first inspection
-- fails and is retried by the reviewer.
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(110, 11, 'AgADuniq11', 2048, 1760000450)))), '1', 'message 11 detected');
update claim set c = (select public.discovery_claim(30));
select is(public.discovery_fail(tests.key(11), (select c->>'lease' from claim)::uuid, 1, 'tmdb_unavailable'), 'failed', 'a provider failure is retryable');
select is(public.discovery_claim(30)::text, null, 'a failed candidate waits for its backoff');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_retry(%L, 1)->>'status' $$, tests.key(11))), 'received', 'the reviewer can request re-inspection');
update claim set c = (select public.discovery_claim(30));
select is(public.discovery_complete(tests.key(11), (select c->>'lease' from claim)::uuid, 2, tests.result(9800001, 'Example Movie', tests.vj(), tests.evidence(tests.identity(11)))),
  'needs_review', 'a second document for the published title');
select is((select relation from private.channel_reviews where ingestion_event_id = tests.ev_id(11)), 'replacement', 'same title and VJ: a replacement');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 2, 9800001, 2024, %s)->'blockers' $$, tests.key(11), tests.vj())),
  '["rights_clearance_required", "existing_version_replacement_requires_separate_workflow"]', 'replacements need a separate workflow');

-- A slug collision inside the materializer rolls the whole publication back.
insert into public.movies (slug, title, tmdb_id) values ('fourth-film-2024', 'Other Fourth', 9899999);
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'detected' $$,
  jsonb_build_array(tests.doc(111, 40, 'AgADuniq40', 7000, 1760000500, 'Fourth.Film.2024.VJ.Test.mp4')))), '1', 'fourth film detected');
update claim set c = (select public.discovery_claim(30));
select is(public.discovery_complete(tests.key(40), (select c->>'lease' from claim)::uuid, 1, tests.result(9800004, 'Fourth Film', tests.vj(), tests.evidence(tests.identity(40)))),
  'needs_review', 'fourth film inspected');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a1'),
  format($$ select public.discovery_review_correct(%L, 1, 9800004, 2024, %s)->>'revision' $$, tests.key(40), tests.vj())), '2', 'fourth film confirmed');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000a2'),
  format($$ select public.discovery_review_clear_rights(%L, 2, 'contract E38A-004')->>'revision' $$, tests.key(40))), '3', 'fourth film rights cleared');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a1')->>'status' $$, tests.key(40))),
  'matched', 'fourth film approved');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000a3')::text $$, tests.key(40))),
  'catalogue_slug_conflict', 'a failure inside publication is reported');
select is((select count(*)::int from public.movies where tmdb_id = 9800004) + (select count(*)::int from public.movie_versions where telegram_media_id = (select id from private.telegram_media where message_id = 40)),
  0, 'no partial movie or version remains');
select is(tests.status(40), 'matched', 'the candidate stays approved for a retry after the conflict is resolved');

-- ---------------------------------------------------------------------------
-- Withdrawn documents, reconciliation, worker retry bounds, uploader path
-- ---------------------------------------------------------------------------
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, null)->>'ignored' $$,
  jsonb_build_array(jsonb_build_object('key', 'u:112', 'digest', tests.hex('withdraw'), 'update_id', 112, 'withdrawn_message_id', 40, 'event', null)))), '1',
  'an edit that removes the document is recorded');
select is(tests.status(40) || ':' || (select error_code from private.ingestion_events where id = tests.ev_id(40)) || ':' || coalesce((select approved_revision::text from private.channel_reviews where ingestion_event_id = tests.ev_id(40)), 'none'),
  'blocked:edited_media_unavailable:none', 'the withdrawn document blocks review and invalidates approval');
select is(tests.as_role('service_role', null, format($$ select public.discovery_receive('00000000-0000-4000-8000-0000000000c1', -1001111111111, %L, %L)->>'detected' $$,
  jsonb_build_array(jsonb_set(jsonb_set(jsonb_set(tests.doc(0, 50, 'AgADuniq50', 8000, 1760000600), '{key}', to_jsonb('r:' || tests.hex('r50'))), '{update_id}', 'null'), '{event,kind}', '"reconciliation"')),
  '{"cursor": "page-2", "incomplete": true}')), '1', 'a history page records a document');
select is((select update_offset::text || ':' || reconciliation_cursor || ':' || reconciliation_incomplete from private.discovery_cursors), '112:page-2:true',
  'reconciliation moves its own cursor, never the update offset');
update private.channel_reviews set lease_token = '00000000-0000-4000-8000-00000000beef', lease_until = now() - interval '1 minute' where ingestion_event_id = tests.ev_id(50);
update private.ingestion_events set status = 'processing', attempt_count = 5 where id = tests.ev_id(50);
select is(public.discovery_claim(30)::text, null, 'an expired lease after five attempts is not reclaimed');
select is(tests.status(50) || ':' || (select error_code from private.ingestion_events where id = tests.ev_id(50)), 'blocked:inspection_attempts_exhausted',
  'it is blocked for the reviewer instead');
select is(public.discovery_health()->>'published', '1', 'health counters are available without identifiers');

select * from finish();
rollback;
