-- C2B.1B durable recovery bounds (20260925194322_ingestion_recovery_bounds.sql).
--
-- The per-attempt recovery floor (server-computed, persisted, immutable per
-- attempt, reassigned only by a legitimate new attempt), the advance-only
-- channel checkpoint and its unresolved-upload guard, fresh-machine status,
-- lock-level concurrency between start and checkpoint (a second session via
-- dblink), exact privileges of the five worker commands, and the publication
-- boundary. Fake channel ids only. Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set local search_path = public, extensions;

select plan(81);

create schema tests;
grant usage on schema tests to service_role;

create function tests.fp(p_char text) returns text language sql immutable as $$
  select 'sf1-' || repeat(p_char, 64)
$$;
create function tests.caption(p_fp text) returns text language sql immutable as $$
  select E'John Wick (2014)\nVJ Junior\nMovie\nvelora-src:' || p_fp
$$;
create function tests.record(p_fp text, p_message bigint, p_bot text default 'movie', p_chat bigint default -1001111111111)
returns text language sql as $$
  select public.ingest_upload_record(p_fp, p_bot, p_chat, p_message, 'file-' || p_message, 'uniq-' || p_bot || p_message,
    'document', 'John.Wick.2014.VJ.Junior.mkv', 'video/x-matroska', tests.caption(p_fp), 1000, null, null, null, now())
$$;
create function tests.start(p_fp text, p_bot text default 'movie', p_chat bigint default -1001111111111)
returns bigint language sql as $$
  select upload_floor_message_id from public.ingest_upload_start(p_fp, p_bot, p_chat, 1000)
$$;
create function tests.floor(p_fp text) returns bigint language sql stable as $$
  select upload_floor_message_id from public.ingest_upload_status(p_fp, 'movie')
$$;
create function tests.checkpoint(p_bot text) returns bigint language sql stable security definer set search_path = '' as $$
  select c.checkpoint_message_id from private.telegram_channels c where c.bot_type = p_bot
$$;
grant execute on function tests.checkpoint(text) to service_role;

-- A second, independent database session (committed separately, so it
-- cannot see this transaction's rows, but it does contend for its locks).
create function tests.other_session(p_sql text) returns text language sql as $$
  select r from extensions.dblink(
    'host=' || coalesce(host(inet_server_addr()), '127.0.0.1') || ' dbname=' || current_database()
      || ' user=postgres password=postgres',
    'set lock_timeout = 300; ' || p_sql) as t(r text)
$$;

-- ---------------------------------------------------------------------------
-- Schema (as postgres)
-- ---------------------------------------------------------------------------
select has_column('private', 'telegram_channels', 'checkpoint_message_id', 'channels carry a recovery checkpoint');
select col_not_null('private', 'telegram_channels', 'checkpoint_message_id', 'the checkpoint is never null');
select col_default_is('private', 'telegram_channels', 'checkpoint_message_id', '0', 'the checkpoint starts at 0 (unknown)');
select has_column('private', 'ingestion_events', 'upload_floor_message_id', 'ingestion events carry the attempt floor');

insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111), ('series', -1002222222222);
select is((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'telegram_channels_checkpoint_check'),
  'CHECK (((checkpoint_message_id >= 0) AND (checkpoint_message_id <= 2147483647)))', 'checkpoint: never negative, within Telegram ids (CHECK)');
select throws_ok($q$insert into private.ingestion_events (bot_type, telegram_update_id, update_kind, upload_floor_message_id)
  values ('movie', 900, 'channel_post', 5)$q$, '23514', null, 'floor: webhook rows never carry one');
select throws_ok($q$insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state,
  upload_attempt_count, upload_started_at, upload_floor_message_id) values ('movie', 'uploader', tests.fp('0'), 1000, 'uploading', 1, now(), 0)$q$,
  '23514', null, 'floor: a present floor is a positive message id');
select is(tests.checkpoint('movie'), 0::bigint, 'checkpoint: a newly configured channel has checkpoint 0');

-- ---------------------------------------------------------------------------
-- No floor, no attempt
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok($q$select tests.start(tests.fp('a'))$q$, 'P0001', 'ingest_recovery_floor_unknown',
  'start: refused while the channel has no checkpoint and no recorded message');
reset role;
select is((select count(*)::int from private.ingestion_events where origin = 'uploader'), 0, 'start: the refusal created no row');

-- ---------------------------------------------------------------------------
-- Checkpoint command: validation, scope, monotonicity
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1001111111111, 0)$q$, '22023', 'ingest_invalid_input',
  'checkpoint: message id 0 is refused');
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1001111111111, 2147483648)$q$, '22023', 'ingest_invalid_input',
  'checkpoint: ids beyond Telegram''s range are refused');
select throws_ok($q$select public.ingest_channel_checkpoint('trailer', -1001111111111, 5)$q$, '22023', 'ingest_invalid_input',
  'checkpoint: unknown media type is refused');
select throws_ok($q$select public.ingest_channel_checkpoint('movie', null, 5)$q$, '22023', 'ingest_invalid_input',
  'checkpoint: a channel is required');
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1009999999999, 5)$q$, 'P0001', 'ingest_channel_not_allowed',
  'checkpoint: an unconfigured channel is refused');
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1002222222222, 5)$q$, 'P0001', 'ingest_channel_not_allowed',
  'checkpoint: the Movies checkpoint cannot be set through the Series channel');
select is(public.ingest_channel_checkpoint('movie', -1001111111111, 100), 100::bigint, 'checkpoint: advances to an observed id');
select is(public.ingest_channel_checkpoint('movie', -1001111111111, 90), 100::bigint, 'checkpoint: a lower id is a no-op');
select is(public.ingest_channel_checkpoint('movie', -1001111111111, 100), 100::bigint, 'checkpoint: an equal id is a no-op');
select is(tests.checkpoint('movie'), 100::bigint, 'checkpoint: the stored value never went back');
select is(tests.checkpoint('series'), 0::bigint, 'checkpoint: scoped to its own channel');
select throws_ok($q$update private.telegram_channels set checkpoint_message_id = 1$q$, '42501', null,
  'checkpoint: service_role cannot write the channel table directly');
reset role;
select throws_ok($q$update private.telegram_channels set checkpoint_message_id = 50 where bot_type = 'movie'$q$, 'P0001', 'ingest_checkpoint_regression',
  'checkpoint: even the owner cannot move it backwards');

-- ---------------------------------------------------------------------------
-- Durable attempt floor
-- ---------------------------------------------------------------------------
set local role service_role;
select results_eq($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 1000)$q$,
  $q$values ('uploading'::text, 1, 100::bigint)$q$, 'start: returns the floor it persisted (the checkpoint)');
select results_eq($q$select upload_state, upload_floor_message_id, upload_started_at is not null, upload_age_seconds >= 0
                    from public.ingest_upload_status(tests.fp('a'), 'movie')$q$,
  $q$values ('uploading'::text, 100::bigint, true, true)$q$, 'status: returns floor, start time and age from the database alone');
select is((select pronargs::int from pg_proc where oid = 'public.ingest_upload_start(text, text, bigint, bigint)'::regprocedure), 4,
  'start: takes no floor argument (the server computes it)');
select throws_ok($q$update private.ingestion_events set upload_floor_message_id = 1$q$, '42501', null,
  'floor: service_role cannot write it directly');
select is(tests.record(tests.fp('a'), 150), 'recorded', 'record: a message above the floor is recorded');

select is(tests.start(tests.fp('b')), 150::bigint, 'floor: the highest recorded message in the channel wins over a lower checkpoint');
select is(public.ingest_channel_checkpoint('series', -1002222222222, 5), 5::bigint, 'checkpoint: series advanced independently');
select is(tests.start(tests.fp('5'), 'series', -1002222222222), 5::bigint, 'floor: another channel''s messages do not count');

-- An unresolved attempt keeps its floor.
select is(public.ingest_upload_fail(tests.fp('b'), 'movie', 'uncertain', 'timeout'), 'uncertain', 'b: uncertain');
select throws_ok($q$select tests.start(tests.fp('b'))$q$, 'P0001', 'ingest_illegal_transition', 'b: an uncertain attempt cannot restart');
select is(tests.start(tests.fp('c')), 150::bigint, 'c: starts with floor 150');
select is(tests.record(tests.fp('c'), 200), 'recorded', 'c: recorded at 200');
select is(tests.floor(tests.fp('b')), 150::bigint, 'b: newer messages and restart attempts never moved the unresolved floor');
select is(public.ingest_upload_fail(tests.fp('b'), 'movie', 'uncertain', 'reconcile_incomplete_uninspectable_message'), 'uncertain',
  'b: a recovery hold keeps it uncertain');
select is(tests.floor(tests.fp('b')), 150::bigint, 'b: a hold does not move the floor');
reset role;
select throws_ok($q$update private.ingestion_events set upload_floor_message_id = 999 where source_fingerprint = tests.fp('b')$q$,
  'P0001', 'ingest_recovery_floor_immutable', 'floor: immutable for its attempt, even for the owner');

-- A legitimate new attempt gets a new floor.
set local role service_role;
select is(public.ingest_upload_fail(tests.fp('b'), 'movie', 'abandoned', 'verified_absent'), 'upload_failed', 'b: verified absent');
select is(tests.floor(tests.fp('b')), 150::bigint, 'b: abandoning does not move the floor');
select results_eq($q$select * from public.ingest_upload_start(tests.fp('b'), 'movie', -1001111111111, 1000)$q$,
  $q$values ('uploading'::text, 2, 200::bigint)$q$, 'b: the retry is attempt 2 with a new, higher floor');

-- ---------------------------------------------------------------------------
-- Checkpoint guard: unresolved uploads block advancement
-- ---------------------------------------------------------------------------
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1001111111111, 300)$q$, 'P0001', 'ingest_recovery_unresolved',
  'guard: an uploading attempt blocks advancement');
select is(public.ingest_upload_fail(tests.fp('b'), 'movie', 'uncertain', 'timeout'), 'uncertain', 'b: uncertain again');
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1001111111111, 300)$q$, 'P0001', 'ingest_recovery_unresolved',
  'guard: an uncertain attempt blocks advancement');
select is(public.ingest_channel_checkpoint('movie', -1001111111111, 50), 100::bigint, 'guard: a no-op lower id is still harmless');
select throws_ok($q$select public.ingest_channel_checkpoint('series', -1002222222222, 9)$q$, 'P0001', 'ingest_recovery_unresolved',
  'guard: series is blocked by its own unresolved upload');
select is(tests.checkpoint('movie'), 100::bigint, 'guard: nothing moved');
select is(tests.record(tests.fp('b'), 250), 'recorded', 'b: reconciliation found it at 250');
select is(tests.record(tests.fp('5'), 7, 'series', -1002222222222), 'recorded', '5: recorded');
select is(public.ingest_channel_checkpoint('movie', -1001111111111, 300), 300::bigint, 'guard: once resolved, the checkpoint advances');
select is(tests.start(tests.fp('d')), 300::bigint, 'd: the next attempt starts above the checkpoint');
select is(public.ingest_upload_fail(tests.fp('d'), 'movie', 'permanent', 'reconcile_multiple_matches'), 'blocked', 'd: blocked for review');
select is(public.ingest_channel_checkpoint('movie', -1001111111111, 320), 320::bigint,
  'guard: a blocked (reviewer-owned) source needs no scan and does not block');

-- Evidence at or below the floor proves the floor wrong: review, never recorded.
select is(tests.start(tests.fp('e')), 320::bigint, 'e: floor 320');
select is(tests.record(tests.fp('e'), 320), 'conflict', 'record: a message at the floor is not this attempt''s upload');
select results_eq($q$select upload_state, needs_review from public.ingest_upload_status(tests.fp('e'), 'movie')$q$,
  $q$values ('uploading'::text, true)$q$, 'record: ...it stays unrecorded and goes to review');
select public.ingest_upload_fail(tests.fp('e'), 'movie', 'permanent', 'recovery_floor_not_below_message');
reset role;

-- A row without a floor (none exist on hosted; the migration fabricates none) fails closed.
insert into private.ingestion_events (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
values ('series', 'uploader', tests.fp('9'), 1000, 'uncertain', 1, now());
set local role service_role;
select results_eq($q$select upload_state, upload_floor_message_id from public.ingest_upload_status(tests.fp('9'), 'series')$q$,
  $q$values ('uncertain'::text, null::bigint)$q$, 'legacy: a floorless row reports no floor (the worker holds)');
select throws_ok($q$select public.ingest_channel_checkpoint('series', -1002222222222, 9)$q$, 'P0001', 'ingest_recovery_unresolved',
  'legacy: a floorless unresolved row blocks the checkpoint');
reset role;
select throws_ok($q$update private.telegram_channels set chat_id = -1003333333333 where bot_type = 'series'$q$, 'P0001', 'ingest_recovery_unresolved',
  'channel change: refused while that bot has an unresolved upload');
delete from private.ingestion_events where source_fingerprint = tests.fp('9');
update private.telegram_channels set chat_id = -1003333333333 where bot_type = 'series';
select is(tests.checkpoint('series'), 0::bigint, 'channel change: resets the checkpoint (old ids say nothing about the new channel)');

-- ---------------------------------------------------------------------------
-- Fresh machine: everything recovery needs comes from status alone
-- ---------------------------------------------------------------------------
set local role service_role;
select is(tests.start(tests.fp('f')), 320::bigint, 'f: started with floor 320 (the worker then crashes and loses its journal)');
select is(public.ingest_upload_fail(tests.fp('f'), 'movie', 'uncertain', 'timeout'), 'uncertain', 'f: left uncertain');
select results_eq(
  $q$select upload_state, upload_attempt_count, upload_floor_message_id, upload_started_at <= now(), upload_age_seconds >= 0, message_id
     from public.ingest_upload_status(tests.fp('f'), 'movie')$q$,
  $q$values ('uncertain'::text, 1, 320::bigint, true, true, null::bigint)$q$,
  'fresh machine: status alone gives state, attempt, floor, start and age: a bounded scan from 321, not from 1');
reset role;

-- ---------------------------------------------------------------------------
-- Concurrency: start and checkpoint serialize on the channel lock
-- ---------------------------------------------------------------------------
-- This transaction started uploads for movie and advanced series: it holds
-- the movie lock shared and the series lock exclusively until it ends.
select is((select array_agg(distinct l.mode::text order by l.mode::text) from pg_locks l
           where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.classid = 1001 and l.objsubid = 2),
  array['ExclusiveLock', 'ShareLock'],
  'locks: start takes the channel lock shared, checkpoint exclusively, for the whole transaction');
select throws_ok($q$select tests.other_session('select public.ingest_channel_checkpoint(''movie'', -1001111111111, 999)::text')$q$,
  '55P03', null, 'concurrency: a checkpoint advance waits for an in-flight start (it cannot slip past it)');
select throws_ok($q$select tests.other_session('select upload_floor_message_id::text from public.ingest_upload_start(''' || tests.fp('6') || ''', ''series'', -1003333333333, 1000)')$q$,
  '55P03', null, 'concurrency: a start waits for an in-flight checkpoint advance (it then reads the new value)');
select is(tests.other_session('select pg_try_advisory_xact_lock_shared(1001, 3)::text'), 'true',
  'concurrency: an unrelated lock key is free (the waits above are real contention, not a broken session)');

-- ---------------------------------------------------------------------------
-- Privileges: the five worker commands, trigger functions, private tables
-- ---------------------------------------------------------------------------
create temp table worker_functions (f regprocedure);
insert into worker_functions values
  ('public.ingest_upload_status(text, text)'),
  ('public.ingest_upload_start(text, text, bigint, bigint)'),
  ('public.ingest_upload_record(text, text, bigint, bigint, text, text, text, text, text, text, bigint, integer, integer, integer, timestamptz)'),
  ('public.ingest_upload_fail(text, text, text, text)'),
  ('public.ingest_channel_checkpoint(text, bigint, bigint)');

select is((select array_agg(distinct array_to_string(p.proacl, ',')) from worker_functions w join pg_proc p on p.oid = w.f),
  array['postgres=X/postgres,service_role=X/postgres'], 'ACL: exactly owner and service_role on all five worker commands');
select is((select array_agg(format('%s %s', r, f)) from worker_functions, unnest(array['anon', 'authenticated']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  null, 'ACL: anon and authenticated cannot execute any of them');
select is((select array_agg(f::text) from worker_functions w join pg_proc p on p.oid = w.f
           where not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false) or pg_get_userbyid(p.proowner) <> 'postgres'),
  null, 'definer: all five are SECURITY DEFINER, owned by postgres, search_path empty');
select is((select array_agg(f::text) from worker_functions w join pg_proc p on p.oid = w.f where p.prosrc ~* '\mexecute\M|format\s*\('),
  null, 'definer: no dynamic SQL');
select is((select array_agg(p.oid::regprocedure::text) from pg_proc p
           where p.oid in ('private.guard_upload_floor()'::regprocedure, 'private.guard_channel_checkpoint()'::regprocedure)
             and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false)
                  or has_function_privilege('service_role', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
                  or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  null, 'triggers: invoker functions, empty search_path, callable by no client or worker role');
select is(
  (select array_agg(format('%s %s %s', r, p, t))
   from unnest(array['private.telegram_channels', 'private.ingestion_events', 'private.telegram_media']) t,
        unnest(array['anon', 'authenticated', 'service_role']) r,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where has_table_privilege(r, t, p)),
  null, 'private tables: no table privilege for any client or the worker role');
select is(
  (select array_agg(format('%s %s', r, c))
   from (values ('private.telegram_channels', 'checkpoint_message_id'), ('private.ingestion_events', 'upload_floor_message_id')) cols(t, c),
        unnest(array['anon', 'authenticated', 'service_role']) r
   where has_column_privilege(r, t, c, 'SELECT,INSERT,UPDATE,REFERENCES')),
  null, 'private tables: the new columns are granted to nobody');

set local role anon;
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1001111111111, 999)$q$, '42501', null, 'anon: cannot move a checkpoint');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c0de", "role": "authenticated"}';
select throws_ok($q$select public.ingest_channel_checkpoint('movie', -1001111111111, 999)$q$, '42501', null,
  'authenticated: cannot move a checkpoint');
select throws_ok($q$select upload_floor_message_id from public.ingest_upload_status(tests.fp('f'), 'movie')$q$, '42501', null,
  'authenticated: cannot read a floor');
reset role;

-- ---------------------------------------------------------------------------
-- Publication boundary
-- ---------------------------------------------------------------------------
select is((select array_agg(f::text) from worker_functions w join pg_proc p on p.oid = w.f
           where p.prosrc ~ 'public\.' or p.prosrc ~ '''approved''' or p.prosrc ~* 'publication_status|availability_status|rights_status'),
  null, 'publication: no worker command references a public table, approval, publication, availability or rights');

insert into public.vjs (slug, name, is_active) values ('vj-c2b', 'VJ C2B', true);
insert into public.movies (slug, title, publication_status) values ('c2b-draft', 'C2B Draft', 'draft');
insert into public.movie_versions (movie_id, vj_id)
select m.id, v.id from public.movies m, public.vjs v where m.slug = 'c2b-draft' and v.slug = 'vj-c2b';
set local role service_role;
select tests.start(tests.fp('7'));
select tests.record(tests.fp('7'), 400);
reset role;
select results_eq(
  $q$select m.publication_status, v.availability_status = 'ready', v.telegram_media_id from public.movies m
     join public.movie_versions v on v.movie_id = m.id where m.slug = 'c2b-draft'$q$,
  $q$values ('draft'::text, false, null::bigint)$q$, 'publication: recovery bounds publish, ready and link nothing');
select is((select count(*)::int from private.metadata_match_candidates where decision = 'approved'), 0,
  'publication: nothing was approved');

select * from finish();
rollback;
