-- E3.8B restricted-role boundary and rollout operations
-- (20261010150000_channel_review_operations.sql, on top of E3.8A).
--
-- What a deployed database starts with (no reviewer, no cursor), and what the
-- two operational identities can and cannot do when probed live:
--   velora_review_service  approve / publish / inspect, and nothing else
--   service_role (worker)  record discovery, and nothing of review or the catalogue
-- Plus rights withdrawal, consumer lease release and the health fields.
-- Fake ids only. Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(62);

-- ---------------------------------------------------------------------------
-- The state the migrations leave behind (before any fixture)
-- ---------------------------------------------------------------------------
select is((select count(*)::int from private.catalogue_reviewers), 0, 'no reviewer is enrolled by the migrations');
select is((select count(*)::int from private.discovery_cursors), 0, 'no discovery cursor exists until the owner initializes it');
select is((select count(*)::int from private.channel_reviews) + (select count(*)::int from private.media_evidence)
        + (select count(*)::int from private.rights_clearances) + (select count(*)::int from private.discovery_deliveries), 0,
  'no candidate, evidence, clearance or delivery exists');
select ok((select not rolcanlogin from pg_roles where rolname = 'velora_review_service'), 'the review service cannot log in until the operator enables it');

create schema tests;
grant usage on schema tests to service_role, authenticated, anon, velora_review_service;
create function tests.hex(p text) returns text language sql immutable as $$ select md5(p) || md5(p || '#') $$;
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
create function tests.key() returns text language sql as $$ select private.discovery_message_key(-1001111111111, 10) $$;
create function tests.ev() returns bigint language sql as $$
  select r.ingestion_event_id from private.channel_reviews r where r.discovery_key = tests.key() $$;
create function tests.status() returns text language sql as $$ select e.status from private.ingestion_events e where e.id = tests.ev() $$;
grant velora_review_service to postgres;

-- Fixtures: one channel candidate, inspected with verified evidence.
insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into private.discovery_cursors (bot_type, update_offset) values ('movie', 99);
insert into public.vjs (slug, name, is_active) values ('vj-e38b-test', 'VJ E38B Test', true);
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'review@e38b.invalid'),
  ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'rights@e38b.invalid'),
  ('00000000-0000-4000-8000-0000000000b3', 'authenticated', 'authenticated', 'publish@e38b.invalid');
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000b1', true, false, false),
  ('00000000-0000-4000-8000-0000000000b2', false, true, false),
  ('00000000-0000-4000-8000-0000000000b3', false, false, true);
select is((select coalesce(update_offset::text, 'none') from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000d1', 60)), '99',
  'a cursor initialized at a chosen offset starts the consumer there');
select is((public.discovery_receive('00000000-0000-4000-8000-0000000000d1', -1001111111111, jsonb_build_array(jsonb_build_object(
  'key', 'u:100', 'digest', tests.hex('d'), 'update_id', 100, 'withdrawn_message_id', null,
  'event', jsonb_build_object('event_id', tests.hex('e'), 'payload_digest', tests.hex('p'), 'kind', 'channel_post', 'message_id', 10,
    'observed_at', 1760000100, 'date', 1760000100, 'file_id', 'synthetic-file-10', 'file_unique_id', 'AgADuniq10', 'size', 1048576,
    'name', 'Example.Movie.2024.VJ.Test.mp4', 'mime', 'video/mp4', 'caption', null))), null)->>'detected'), '1', 'one synthetic document detected');
create temporary table claim on commit drop as select public.discovery_claim(30) as c;
select is(public.discovery_complete(tests.key(), (select c->>'lease' from claim)::uuid, 1, jsonb_build_object(
  'outcome', 'review', 'error_code', null, 'title', 'Example Movie', 'year', 2024, 'vj_text', 'Test',
  'vj_id', (select id from public.vjs where slug = 'vj-e38b-test'), 'warnings', '[]'::jsonb, 'identity_state', 'proposed', 'proposed_tmdb_id', 9820001,
  'candidates', jsonb_build_array(jsonb_build_object('tmdb_id', 9820001, 'score', 1, 'reasons', '{}'::jsonb, 'snapshot', jsonb_build_object(
    'tmdb_id', 9820001, 'title', 'Example Movie', 'original_title', 'Example Movie', 'overview', 'Synthetic.', 'release_date', '2024-05-01',
    'runtime_minutes', 100, 'poster_path', null, 'backdrop_path', null, 'vote_average', 7, 'vote_count', 1, 'genres', '[]'::jsonb))),
  'evidence', jsonb_build_object('identity', (select c->>'identity' from claim), 'method', 'bounded_mtproto_v1', 'policy_version', 2,
    'media_class', 'canonical', 'reasons', '[]'::jsonb, 'container', 'mp4', 'video_codec', 'h264', 'audio_codec', 'aac',
    'accessible', true, 'gateway_compatible', true, 'playback_ready', true, 'bytes_read', 3072))), 'needs_review', 'inspected with verified evidence');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b1'),
  format($$ select public.discovery_review_correct(%L, 1, 9820001, 2024, %s)->>'revision' $$, tests.key(), (select id from public.vjs where slug = 'vj-e38b-test'))),
  '2', 'identity confirmed');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b2'),
  format($$ select public.discovery_review_clear_rights(%L, 2, 'contract E38B-001')->>'revision' $$, tests.key())), '3', 'rights cleared');

-- ---------------------------------------------------------------------------
-- velora_review_service: live probes
-- ---------------------------------------------------------------------------
select is((select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p
           where has_function_privilege('velora_review_service', p.oid, 'EXECUTE')
             and has_schema_privilege('velora_review_service', p.pronamespace, 'USAGE')
             and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace, 'catalogue_review'::regnamespace,
                                    'catalogue_access'::regnamespace, 'media_gateway'::regnamespace)),
  array['catalogue_review.approve_channel_candidate(text,integer,uuid)', 'catalogue_review.inspect_channel_candidate(text)',
        'catalogue_review.publish_channel_candidate(text,integer,uuid)', 'catalogue_review.reviewer_capabilities(uuid)'],
  'the review service can execute exactly four application functions');
select ok((select not rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and not rolinherit
           from pg_roles where rolname = 'velora_review_service'), 'it cannot bypass RLS and holds no attribute');
select matches(tests.as_role('velora_review_service', null, $$ select count(*)::text from public.movies $$), '^permission denied', 'cannot read movies');
select matches(tests.as_role('velora_review_service', null, $$ update public.movies set publication_status = 'published' returning 'x' $$), '^permission denied', 'cannot change movies');
select matches(tests.as_role('velora_review_service', null, $$ update public.movie_versions set rights_status = 'cleared' returning 'x' $$), '^permission denied', 'cannot change version rights');
select matches(tests.as_role('velora_review_service', null, $$ insert into private.rights_clearances (ingestion_event_id, review_revision, media_identity, reference, cleared_by)
  values (1, 1, 'tg1-' || repeat('0', 64), 'x', '00000000-0000-4000-8000-0000000000b2') returning 'x' $$), '^permission denied', 'cannot grant rights to anything');
select matches(tests.as_role('velora_review_service', null, $$ insert into private.catalogue_reviewers (user_id, can_publish) values ('00000000-0000-4000-8000-0000000000b1', true) returning 'x' $$),
  '^permission denied', 'cannot enroll a reviewer');
select matches(tests.as_role('velora_review_service', null, $$ update private.catalogue_reviewers set can_publish = true returning 'x' $$), '^permission denied', 'cannot alter reviewer capabilities');
select matches(tests.as_role('velora_review_service', null, $$ select count(*)::text from private.channel_reviews $$), '^permission denied', 'cannot read review tables directly');
select matches(tests.as_role('velora_review_service', null, $$ delete from private.channel_review_audit returning 'x' $$), '^permission denied', 'cannot touch the audit');
select matches(tests.as_role('velora_review_service', null, $$ update private.ingestion_events set status = 'published' returning 'x' $$), '^permission denied', 'cannot change ingestion state');
select matches(tests.as_role('velora_review_service', null, $$ update private.discovery_cursors set update_offset = 0 returning 'x' $$), '^permission denied', 'cannot move the discovery cursor');
select matches(tests.as_role('velora_review_service', null, $$ update private.telegram_media set file_unique_id = 'x' returning 'x' $$), '^permission denied', 'cannot change Telegram media');
select matches(tests.as_role('velora_review_service', null, $$ update private.telegram_channels set checkpoint_message_id = 0 returning 'x' $$), '^permission denied', 'cannot change the uploader checkpoint');
select matches(tests.as_role('velora_review_service', null, $$ select public.discovery_claim(30)::text $$), '^permission denied', 'cannot run worker commands');
select matches(tests.as_role('velora_review_service', null, format($$ select public.discovery_review_clear_rights(%L, 3, 'x')::text $$, tests.key())), '^permission denied', 'cannot clear rights');
select matches(tests.as_role('velora_review_service', null, $$ select upload_state from public.ingest_upload_status('sf1-' || repeat('a', 64), 'movie') $$), '^permission denied', 'cannot run uploader commands');
select matches(tests.as_role('velora_review_service', null, $$ select count(*)::text from media_gateway.resolve_movie_version(1) $$), '^permission denied', 'cannot use the gateway resolver');
select matches(tests.as_role('velora_review_service', null, $$ select (private.catalogue_publish_movie('sf1-' || repeat('a', 64), '{}'::jsonb, true)).result $$), '^permission denied', 'cannot reach the uploader publisher');
select matches(tests.as_role('velora_review_service', null, $$ select count(*)::text from auth.users $$), '^permission denied', 'cannot read accounts');
select matches(tests.as_role('velora_review_service', null, $$ create table public.x (i int) $$), '^permission denied', 'cannot create tables');
select is((select array_agg(r) from unnest(array['postgres', 'service_role', 'authenticated', 'anon', 'velora_media_gateway', 'supabase_admin']) r
           where pg_has_role('velora_review_service', r, 'MEMBER')), null, 'it is a member of no other role (a real login cannot SET ROLE; proven live in the rollout rehearsal)');
select matches(tests.as_role('velora_review_service', null, $$ alter function catalogue_review.publish_channel_candidate(text, integer, uuid) security invoker $$), 'must be owner', 'cannot alter its own commands');

-- Its three capabilities are bound to the gates and to a capable reviewer.
select is(tests.as_role('velora_review_service', null, $$ select catalogue_review.reviewer_capabilities('00000000-0000-4000-8000-0000000000b3')::text $$),
  '{"review": false, "rights": false, "publish": true}', 'reads a reviewer''s capabilities (no account data)');
select is(tests.as_role('velora_review_service', null, $$ select catalogue_review.reviewer_capabilities('00000000-0000-4000-8000-0000000000ff')::text $$),
  '{"review": false, "rights": false, "publish": false}', 'an unknown account has none');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.inspect_channel_candidate(%L)->>'status' $$, tests.key())), 'needs_review', 'inspects a candidate');
select is(tests.as_role('velora_review_service', null, format($$ select (catalogue_review.inspect_channel_candidate(%L)::text ~ 'synthetic-file')::text $$, tests.key())), 'false',
  'the inspection never contains the bot file_id');
select is(tests.as_role('velora_review_service', null, format($$ select (catalogue_review.inspect_channel_candidate(%L)->'blockers')::text $$, tests.key())), '[]', 'and reports the gates');
select is(tests.as_role('velora_review_service', null, $$ select catalogue_review.inspect_channel_candidate(repeat('0', 64))::text $$), 'discovery_not_found',
  'a candidate key from another environment does not exist here');
select matches(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b1'), format($$ select catalogue_review.inspect_channel_candidate(%L)::text $$, tests.key())),
  '^permission denied', 'reviewer sessions cannot use the restricted schema');
select matches(tests.as_role('service_role', null, format($$ select catalogue_review.inspect_channel_candidate(%L)::text $$, tests.key())), '^permission denied', 'nor can the worker');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000b3')::text $$, tests.key())),
  'catalogue_not_approved', 'it cannot publish a candidate that is not approved');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000b3')::text $$, tests.key())),
  'review_not_authorized', 'it cannot approve in the name of an account without the review capability');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.approve_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000b1')->>'status' $$, tests.key())),
  'matched', 'it approves for a capable reviewer when every gate passes');

-- ---------------------------------------------------------------------------
-- Rights withdrawal before publication
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b1'), format($$ select public.discovery_review_revoke_rights(%L, 3)::text $$, tests.key())),
  'review_not_authorized', 'only a rights reviewer can withdraw a clearance');
select matches(tests.as_role('service_role', null, format($$ select public.discovery_review_revoke_rights(%L, 3)::text $$, tests.key())), '^permission denied', 'the worker cannot');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b2'), format($$ select public.discovery_review_revoke_rights(%L, 2)::text $$, tests.key())),
  'review_stale_revision', 'a stale revision is refused');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b2'), format($$ select public.discovery_review_revoke_rights(%L, 3)->'blockers' $$, tests.key())),
  '["rights_clearance_required"]', 'the clearance is withdrawn: rights block again');
select is(tests.status() || ':' || coalesce((select approved_revision::text from private.channel_reviews where ingestion_event_id = tests.ev()), 'none'), 'needs_review:none',
  'and the approval that relied on it is gone');
select is(tests.as_role('velora_review_service', null, format($$ select catalogue_review.publish_channel_candidate(%L, 3, '00000000-0000-4000-8000-0000000000b3')::text $$, tests.key())),
  'catalogue_stale_review', 'the old approval can no longer publish');
select is((select count(*)::int from private.rights_clearances where ingestion_event_id = tests.ev()), 1, 'the withdrawn clearance is kept as history');
select is(tests.as_role('authenticated', tests.claims('00000000-0000-4000-8000-0000000000b2'), format($$ select public.discovery_review_revoke_rights(%L, 4)::text $$, tests.key())),
  'review_illegal_transition', 'nothing to withdraw at the new revision');
select is((select a.action from private.channel_review_audit a where a.ingestion_event_id = tests.ev() order by a.id desc limit 1), 'rights_revoked', 'the withdrawal is audited');
select is((select count(*)::int from public.movies where tmdb_id = 9820001), 0, 'nothing was published');

-- ---------------------------------------------------------------------------
-- Worker: lease release, health, and no review or catalogue authority
-- ---------------------------------------------------------------------------
select is(tests.as_role('service_role', null, $$ select public.discovery_release_consumer('00000000-0000-4000-8000-0000000000d2')::text $$), 'false', 'another consumer''s lease cannot be released');
select is(tests.as_role('service_role', null, $$ select update_offset::text from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000d2', 60) $$), 'discovery_consumer_busy',
  'the lease is still held');
select is(tests.as_role('service_role', null, $$ select public.discovery_release_consumer('00000000-0000-4000-8000-0000000000d1')::text $$), 'true', 'the holder releases its lease');
select is(tests.as_role('service_role', null, $$ select update_offset::text from public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000d2', 60) $$), '100',
  'the next consumer continues from the durable offset at once');
select is((select array_agg(k order by k) from jsonb_object_keys(public.discovery_health()) k),
  array['approved', 'awaiting_review', 'blocked', 'candidates', 'consumer_active', 'consumer_heartbeat_at', 'cursor_initialized', 'duplicates', 'failed',
        'last_delivery_at', 'media_blocked', 'oldest_pending_at', 'pending', 'published', 'reconciliation_checked_at', 'reconciliation_incomplete', 'rights_blocked'],
  'health reports counts, lag and liveness, and no identifier');
select is(public.discovery_health()->>'consumer_active' || ':' || (public.discovery_health()->>'rights_blocked') || ':' || (public.discovery_health()->>'last_delivery_at' is not null)::text,
  'true:1:true', 'health reflects the lease, the gate backlog and the last delivery');
select is((select array_agg(format('%s %s', r, f)) from unnest(array['anon', 'authenticated', 'velora_review_service']) r,
             unnest(array['public.discovery_release_consumer(uuid)', 'public.discovery_health()']) f where has_function_privilege(r, f, 'EXECUTE')), null,
  'release and health: the worker only');
select matches(tests.as_role('service_role', null, $$ insert into private.catalogue_reviewers (user_id, can_publish) values ('00000000-0000-4000-8000-0000000000b1', true) returning 'x' $$),
  '^permission denied', 'the worker cannot enroll reviewers');
select matches(tests.as_role('service_role', null, $$ update public.movies set publication_status = 'published' returning 'x' $$), '^permission denied', 'the worker cannot change the catalogue');

select * from finish();
rollback;
