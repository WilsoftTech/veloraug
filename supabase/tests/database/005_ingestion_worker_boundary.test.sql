-- C2A.1 uploader-origin ingestion and worker boundary
-- (20260925004059_ingestion_uploader_worker_boundary.sql).
--
-- Schema and origin-specific constraints, webhook regression, the channel
-- allow-list, exact privileges and SECURITY DEFINER hardening of the four
-- worker commands, their state machine as service_role, and the publication
-- boundary. Fake channel ids only. Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(92);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.fp(p_char text) returns text language sql immutable as $$
  select 'sf1-' || repeat(p_char, 64)
$$;
create function tests.caption(p_fp text) returns text language sql immutable as $$
  select E'John Wick (2014)\nVJ Junior\nMovie\nvelora-src:' || p_fp
$$;
-- A sendDocument reply for the Movies fixture channel.
create function tests.record(p_fp text, p_message bigint, p_unique text, p_bot text default 'movie',
  p_chat bigint default -1001111111111, p_size bigint default 1000, p_caption text default null)
returns text language sql as $$
  select public.ingest_upload_record(p_fp, p_bot, p_chat, p_message, 'file-' || p_message, p_unique,
    'document', 'John.Wick.2014.VJ.Junior.mkv', 'video/x-matroska', coalesce(p_caption, tests.caption(p_fp)),
    p_size, null, null, null, now())
$$;
create function tests.state(p_fp text) returns text language sql stable security definer set search_path = '' as $$
  select e.upload_state from private.ingestion_events e where e.source_fingerprint = p_fp
$$;
grant execute on function tests.state(text) to service_role;

-- ---------------------------------------------------------------------------
-- Schema: origin discriminator and shape constraints (as postgres)
-- ---------------------------------------------------------------------------
select has_column('private', 'ingestion_events', 'origin', 'ingestion_events has an origin discriminator');
select col_default_is('private', 'ingestion_events', 'origin', 'webhook', 'origin defaults to webhook');
select has_table('private', 'telegram_channels', 'the channel allow-list exists');
select is((select count(*)::int from private.telegram_channels), 0, 'the allow-list ships empty (configured per deployment)');

-- Webhook regression: the original B-1 contract still holds.
select lives_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id, update_kind) values ('movie', 700, 'channel_post')$q$,
  'webhook: a valid channel_post row inserts with no new columns');
select is((select origin from private.ingestion_events where telegram_update_id = 700), 'webhook', 'webhook: existing inserts get origin webhook');
select throws_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id, update_kind) values ('movie', 700, 'edited_channel_post')$q$,
  '23505', null, 'webhook: a replayed update id is still refused');
select lives_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id, update_kind) values ('series', 700, 'channel_post')$q$,
  'webhook: update ids stay unique per bot, not globally');
select throws_ok($q$insert into private.ingestion_events (bot_type, update_kind) values ('movie', 'channel_post')$q$,
  '23514', null, 'webhook: an update id is still required');
select throws_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id) values ('movie', 701)$q$,
  '23514', null, 'webhook: an update kind is still required');
select throws_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id, update_kind) values ('movie', 703, 'bogus')$q$,
  '23514', null, 'webhook: update kind is still limited to channel posts');
select throws_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id, update_kind, source_fingerprint) values ('movie', 704, 'channel_post', tests.fp('a'))$q$,
  '23514', null, 'webhook: cannot carry uploader columns');
select lives_ok($q$insert into private.metadata_match_candidates (ingestion_event_id, tmdb_media_type, tmdb_id, score)
  select id, 'movie', 245891, 1 from private.ingestion_events where telegram_update_id = 700 and bot_type = 'movie'$q$,
  'webhook: match candidates still attach to webhook events');

-- Uploader rows (direct inserts, as the table owner, to probe the constraints).
select lives_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', tests.fp('0'), 1000, 'uploading', 1, now())$q$,
  'uploader: a row needs no Telegram update id or kind');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', 1000, 'uploading', 1, now())$q$,
  '23514', null, 'uploader: the fingerprint is required');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', 'sf1-ABC', 1000, 'uploading', 1, now())$q$,
  '23514', null, 'uploader: a malformed fingerprint is refused');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('series', 'uploader', tests.fp('0'), 1000, 'uploading', 1, now())$q$,
  '23505', null, 'uploader: one ingestion per fingerprint (database-enforced)');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, telegram_update_id, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', 705, tests.fp('1'), 1000, 'uploading', 1, now())$q$,
  '23514', null, 'uploader: a fabricated update id is refused');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', tests.fp('1'), 1000, 'uploaded', 1, now())$q$,
  '23514', null, 'uploader: uploaded requires linked media');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', tests.fp('1'), 1000, 'approved', 1, now())$q$,
  '23514', null, 'uploader: the upload state is a closed set');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values ('movie', 'uploader', tests.fp('1'), 2097152001, 'uploading', 1, now())$q$,
  '23514', null, 'uploader: size above the 2000 MiB ceiling is refused');
delete from private.ingestion_events where source_fingerprint = tests.fp('0');

select throws_ok($q$insert into private.telegram_channels values ('movie', -100)$q$, '23514', null, 'allow-list: only -100… channel ids');
select throws_ok($q$insert into private.telegram_channels values ('trailer', -1009999999999)$q$, '23514', null, 'allow-list: only movie and series');

-- Fixture channels (fake ids).
insert into private.telegram_channels values ('movie', -1001111111111);
select throws_ok($q$insert into private.telegram_channels values ('series', -1001111111111)$q$, '23505', null,
  'allow-list: Movies and Series must be different channels');
insert into private.telegram_channels values ('series', -1002222222222);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
create temp table worker_functions (f regprocedure);
insert into worker_functions values
  ('public.ingest_upload_status(text, text)'),
  ('public.ingest_upload_start(text, text, bigint, bigint)'),
  ('public.ingest_upload_record(text, text, bigint, bigint, text, text, text, text, text, text, bigint, integer, integer, integer, timestamptz)'),
  ('public.ingest_upload_fail(text, text, text, text)');

select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'ingest\_%'),
  array['ingest_upload_fail', 'ingest_upload_record', 'ingest_upload_start', 'ingest_upload_status'],
  'exactly four worker commands (no CRUD, no evaluation or publication command)');
select is((select array_agg(format('%s %s', r, f)) from worker_functions, unnest(array['anon', 'authenticated']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  null, 'anon/authenticated cannot execute any worker command');
select is((select array_agg(f::text) from worker_functions w, pg_proc p, aclexplode(p.proacl) a
           where p.oid = w.f and a.grantee = 0),
  null, 'PUBLIC holds no EXECUTE on any worker command');
select is((select array_agg(f::text) from worker_functions where not has_function_privilege('service_role', f, 'EXECUTE')),
  null, 'service_role can execute every worker command');
select is((select array_agg(distinct array_to_string(p.proacl, ',')) from worker_functions w join pg_proc p on p.oid = w.f),
  array['postgres=X/postgres,service_role=X/postgres'], 'exact ACL on every worker command: owner and service_role only');
select is((select array_agg(distinct pg_get_userbyid(p.proowner)) from worker_functions w join pg_proc p on p.oid = w.f),
  array['postgres'::name], 'worker commands are owned by postgres');
select is((select array_agg(f::text) from worker_functions w join pg_proc p on p.oid = w.f
           where not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false)),
  null, 'every worker command is SECURITY DEFINER with search_path pinned to empty');
select is((select array_agg(f::text) from worker_functions w join pg_proc p on p.oid = w.f
           where p.prosrc ~* '\mexecute\M|format\s*\('),
  null, 'no worker command uses dynamic SQL');
select is(
  (select array_agg(format('%s %s %s', r, p, t))
   from unnest(array['private.telegram_channels', 'private.ingestion_events', 'private.telegram_media']) t,
        unnest(array['anon', 'authenticated', 'service_role']) r,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where has_table_privilege(r, t, p)),
  null, 'no client role and not service_role holds a table privilege on the ingestion tables or the allow-list');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'private.telegram_channels'::regclass), 'allow-list has RLS enabled');
select is((select count(*)::int from pg_policies where schemaname = 'private' and tablename = 'telegram_channels'), 0,
  'allow-list has no policies');

set local role anon;
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 1000)$q$, '42501', null,
  'anon: cannot start an upload');
select throws_ok($q$select * from public.ingest_upload_status(tests.fp('a'), 'movie')$q$, '42501', null, 'anon: cannot read upload status');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c0de", "role": "authenticated"}';
select throws_ok($q$select tests.record(tests.fp('a'), 1, 'u')$q$, '42501', null, 'authenticated: cannot record an upload');
select throws_ok($q$select public.ingest_upload_fail(tests.fp('a'), 'movie', 'retryable', 'x')$q$, '42501', null,
  'authenticated: cannot record a failure');
reset role;

-- ---------------------------------------------------------------------------
-- Worker behaviour (as service_role)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok($q$select * from private.ingestion_events$q$, '42501', null, 'service_role: no direct read of ingestion_events');
select throws_ok($q$select * from private.telegram_channels$q$, '42501', null, 'service_role: no direct read of the allow-list');
select throws_ok($q$insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
  values ('movie', -1001111111111, 1, 'f', 'u', 'document', now())$q$, '42501', null, 'service_role: no direct write to telegram_media');

-- Input validation
select throws_ok($q$select * from public.ingest_upload_start('sf1-xyz', 'movie', -1001111111111, 1000)$q$, '22023', 'ingest_invalid_input',
  'malformed fingerprint is refused');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'trailer', -1001111111111, 1000)$q$, '22023', 'ingest_invalid_input',
  'unknown media type is refused');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 2097152001)$q$, '22023', 'ingest_invalid_input',
  'size above the ceiling is refused');

-- Channel allow-list
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1009999999999, 1000)$q$, 'P0001', 'ingest_channel_not_allowed',
  'an unknown channel is refused');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1002222222222, 1000)$q$, 'P0001', 'ingest_channel_not_allowed',
  'a movie cannot start towards the Series channel');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'series', -1001111111111, 1000)$q$, 'P0001', 'ingest_channel_not_allowed',
  'an episode cannot start towards the Movies channel');

-- Registration and idempotency
select results_eq($q$select upload_state, upload_attempt_count from public.ingest_upload_status(tests.fp('a'), 'movie')$q$,
  $q$values ('new'::text, 0)$q$, 'status: an unknown fingerprint is new');
select results_eq($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 1000)$q$,
  $q$values ('uploading'::text, 1)$q$, 'start: first registration starts attempt 1');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 1000)$q$, 'P0001', 'ingest_illegal_transition',
  'start: a second start while uploading is refused (reconcile first)');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'series', -1002222222222, 1000)$q$, 'P0001', 'ingest_identity_mismatch',
  'start: the same fingerprint cannot re-register as another kind');
select throws_ok($q$select * from public.ingest_upload_status(tests.fp('a'), 'series')$q$, 'P0001', 'ingest_identity_mismatch',
  'status: kind must match the registration');

-- Recording the sendDocument reply
select throws_ok($q$select tests.record(tests.fp('a'), 42, 'uniq-42', p_caption => 'no token here')$q$, '22023', 'ingest_invalid_input',
  'record: the caption must carry this fingerprint');
select throws_ok($q$select tests.record(tests.fp('a'), 42, 'uniq-42', p_caption => tests.caption(tests.fp('a')) || ' velora-src:' || tests.fp('b'))$q$,
  '22023', 'ingest_invalid_input', 'record: a caption with two tokens is refused');
select throws_ok($q$select tests.record(tests.fp('a'), 42, 'uniq-42', p_chat => -1002222222222)$q$, 'P0001', 'ingest_channel_not_allowed',
  'record: a movie message from the Series channel is refused');
select throws_ok($q$select tests.record(tests.fp('a'), 42, 'uniq-42', p_size => 999)$q$, 'P0001', 'ingest_identity_mismatch',
  'record: a different file size is refused');
select throws_ok($q$select tests.record(tests.fp('9'), 42, 'uniq-42')$q$, 'P0001', 'ingest_not_registered',
  'record: an unregistered fingerprint is refused');
select throws_ok($q$select public.ingest_upload_record(tests.fp('a'), 'movie', -1001111111111, 0, 'f', 'u', 'document', null, null,
  tests.caption(tests.fp('a')), 1000, null, null, null, now())$q$, '22023', 'ingest_invalid_input', 'record: malformed Telegram identity is refused');
select is(tests.record(tests.fp('a'), 42, 'uniq-42'), 'recorded', 'record: a valid reply is recorded');
select results_eq($q$select upload_state, message_id, file_unique_id, file_name, duration_seconds from public.ingest_upload_status(tests.fp('a'), 'movie')$q$,
  $q$values ('uploaded'::text, 42::bigint, 'uniq-42'::text, 'John.Wick.2014.VJ.Junior.mkv'::text, null::integer)$q$,
  'record: telegram_media is created and linked; absent optional fields stay null');
select is(tests.record(tests.fp('a'), 42, 'uniq-42'), 'already_recorded', 'record: an identical replay is safe');
select is(tests.record(tests.fp('a'), 43, 'uniq-43'), 'conflict', 'record: a different message for an uploaded source is a conflict');
select results_eq($q$select upload_state, message_id, needs_review from public.ingest_upload_status(tests.fp('a'), 'movie')$q$,
  $q$values ('uploaded'::text, 42::bigint, true)$q$, 'record: the conflict overwrote nothing and flagged review');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 1000)$q$, 'P0001', 'ingest_already_uploaded',
  'start: an uploaded source cannot be uploaded again');
select throws_ok($q$select public.ingest_upload_fail(tests.fp('a'), 'movie', 'retryable', 'late_error')$q$, 'P0001', 'ingest_illegal_transition',
  'fail: a failure cannot erase a recorded upload');
select is(tests.state(tests.fp('a')), 'uploaded', 'fail: the upload stays recorded');

-- A message that already belongs to another ingestion is never adopted.
select * from public.ingest_upload_start(tests.fp('b'), 'movie', -1001111111111, 1000);
select is(tests.record(tests.fp('b'), 42, 'uniq-42'), 'conflict', 'record: another source''s message is a conflict');
select is(tests.state(tests.fp('b')), 'uploading', 'record: the conflicting source is not marked uploaded');

-- Uncertain completion blocks a blind retry; reconciliation records it.
select * from public.ingest_upload_start(tests.fp('c'), 'movie', -1001111111111, 1000);
select is(public.ingest_upload_fail(tests.fp('c'), 'movie', 'uncertain', 'timeout'), 'uncertain', 'fail: a timeout is uncertain');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('c'), 'movie', -1001111111111, 1000)$q$, 'P0001', 'ingest_illegal_transition',
  'start: an uncertain upload cannot be restarted blindly');
select throws_ok($q$select public.ingest_upload_fail(tests.fp('c'), 'movie', 'retryable', 'x')$q$, 'P0001', 'ingest_illegal_transition',
  'fail: an uncertain upload cannot become a definite failure');
select is(tests.record(tests.fp('c'), 50, 'uniq-50'), 'recorded', 'record: reconciliation records the found message');

-- Verified absence (abandon) and definite failures may be retried.
select * from public.ingest_upload_start(tests.fp('d'), 'movie', -1001111111111, 1000);
select public.ingest_upload_fail(tests.fp('d'), 'movie', 'uncertain', 'timeout');
select is(public.ingest_upload_fail(tests.fp('d'), 'movie', 'abandoned', 'verified_absent'), 'upload_failed', 'fail: verified absence abandons the attempt');
select results_eq($q$select * from public.ingest_upload_start(tests.fp('d'), 'movie', -1001111111111, 1000)$q$,
  $q$values ('uploading'::text, 2)$q$, 'start: an abandoned attempt may be retried (attempt 2)');

select * from public.ingest_upload_start(tests.fp('e'), 'series', -1002222222222, 1000);
select is(public.ingest_upload_fail(tests.fp('e'), 'series', 'retryable', 'telegram_forbidden'), 'upload_failed', 'fail: a definite failure is retryable');
select is(public.ingest_upload_fail(tests.fp('e'), 'series', 'retryable', 'telegram_forbidden'), 'upload_failed', 'fail: replaying it is safe');
select results_eq($q$select * from public.ingest_upload_start(tests.fp('e'), 'series', -1002222222222, 1000)$q$,
  $q$values ('uploading'::text, 2)$q$, 'start: a definite failure is retried');
select public.ingest_upload_fail(tests.fp('e'), 'series', 'retryable', 'x');
select * from public.ingest_upload_start(tests.fp('e'), 'series', -1002222222222, 1000);
select public.ingest_upload_fail(tests.fp('e'), 'series', 'retryable', 'x');
select * from public.ingest_upload_start(tests.fp('e'), 'series', -1002222222222, 1000);
select public.ingest_upload_fail(tests.fp('e'), 'series', 'retryable', 'x');
select * from public.ingest_upload_start(tests.fp('e'), 'series', -1002222222222, 1000);
select public.ingest_upload_fail(tests.fp('e'), 'series', 'retryable', 'x');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('e'), 'series', -1002222222222, 1000)$q$, 'P0001', 'ingest_attempts_exhausted',
  'start: at most five attempts');

-- Permanent failures block for review.
select * from public.ingest_upload_start(tests.fp('f'), 'movie', -1001111111111, 1000);
select is(public.ingest_upload_fail(tests.fp('f'), 'movie', 'permanent', 'reconcile_multiple_matches'), 'blocked', 'fail: permanent blocks the source');
select results_eq($q$select upload_state, needs_review from public.ingest_upload_status(tests.fp('f'), 'movie')$q$,
  $q$values ('blocked'::text, true)$q$, 'fail: a blocked source is in review');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('f'), 'movie', -1001111111111, 1000)$q$, 'P0001', 'ingest_illegal_transition',
  'start: a blocked source cannot be uploaded');
select throws_ok($q$select tests.record(tests.fp('f'), 60, 'uniq-60')$q$, 'P0001', 'ingest_illegal_transition',
  'record: a blocked source takes no upload evidence');
select throws_ok($q$select public.ingest_upload_fail(tests.fp('f'), 'movie', 'bogus', 'x')$q$, '22023', 'ingest_invalid_input',
  'fail: unknown outcomes are refused');
reset role;

-- The D3 rule: a second delivery of the same Telegram file is recorded but flagged.
set local role service_role;
select * from public.ingest_upload_start(tests.fp('7'), 'movie', -1001111111111, 1000);
select is(tests.record(tests.fp('7'), 70, 'uniq-50'), 'recorded', 'record: a re-delivered Telegram file is recorded');
select results_eq($q$select needs_review from public.ingest_upload_status(tests.fp('7'), 'movie')$q$, $q$values (true)$q$,
  'record: ...and flagged for review, never merged (D3)');
reset role;

select is((select count(*)::int from private.ingestion_events where origin = 'uploader'), 7,
  'one ingestion per fingerprint across every retry and replay');

-- ---------------------------------------------------------------------------
-- Publication boundary
-- ---------------------------------------------------------------------------
select is((select array_agg(f::text) from worker_functions w join pg_proc p on p.oid = w.f
           where p.prosrc ~ 'public\.' or p.prosrc ~ '''approved'''),
  null, 'no worker command references a public table or approves a candidate');

insert into public.vjs (slug, name, is_active) values ('vj-c2a', 'VJ C2A', true);
insert into public.movies (slug, title, publication_status) values ('c2a-draft', 'C2A Draft', 'draft');
insert into public.movie_versions (movie_id, vj_id)
select m.id, v.id from public.movies m, public.vjs v where m.slug = 'c2a-draft' and v.slug = 'vj-c2a';

set local role service_role;
select * from public.ingest_upload_start(tests.fp('8'), 'movie', -1001111111111, 1000);
select tests.record(tests.fp('8'), 80, 'uniq-80');
reset role;

select results_eq(
  $q$select m.publication_status, v.availability_status = 'ready', v.telegram_media_id from public.movies m
     join public.movie_versions v on v.movie_id = m.id where m.slug = 'c2a-draft'$q$,
  $q$values ('draft'::text, false, null::bigint)$q$,
  'an upload does not publish, ready or link any catalogue version');
select is((select count(*)::int from public.movie_versions where telegram_media_id is not null)
        + (select count(*)::int from public.episode_versions where telegram_media_id is not null), 0,
  'no catalogue version references uploaded media');
select is((select count(*)::int from private.metadata_match_candidates where decision = 'approved'), 0,
  'no match candidate was approved');
set local role anon;
select is((select count(*)::int from public.movies where slug = 'c2a-draft'), 0, 'anon: the uploaded draft stays invisible');
reset role;

select * from finish();
rollback;
