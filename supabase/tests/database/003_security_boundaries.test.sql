-- Privilege and function-hardening invariants (AGENTS.md "Migration privilege
-- invariant"): server-only tables stay client-closed, catalogue access stays
-- read-only and column-limited, SECURITY DEFINER functions are the expected
-- set with an empty search_path, and cron / the purge function are unreachable
-- by clients. Catalog checks plus live role probes; rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

-- ---------------------------------------------------------------------------
-- RLS and structure
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind = 'r'),
  18, '18 application tables in public/private (C2A.1 adds private.telegram_channels)');
select is(
  (select array_agg(n.nspname || '.' || c.relname) from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity),
  null, 'RLS is enabled on every application table');
select is(
  (select count(*)::int from pg_policies where schemaname in ('public', 'private')),
  17, '17 policies (7 Phase 2/3 + 10 catalogue read)');
select is(
  (select array_agg(tablename || ': ' || policyname) from pg_policies
   where schemaname in ('public', 'private') and cmd <> 'SELECT'
     and tablename not in ('profiles', 'watchlist_items', 'search_history')),
  null, 'no catalogue policy allows anything but SELECT');

-- ---------------------------------------------------------------------------
-- Server-only tables: no client (or service_role) privilege
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(format('%s %s %s', r, p, t))
   from unnest(array['private.search_events', 'private.telegram_media', 'private.telegram_channels',
                     'private.ingestion_events', 'private.metadata_match_candidates']) t,
        unnest(array['anon', 'authenticated']) r,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where has_table_privilege(r, t, p)),
  null, 'anon/authenticated hold no table privilege on private tables');
select is(
  (select array_agg(format('%s %s %s', r, p, t))
   from unnest(array['private.search_events', 'private.telegram_media',
                     'private.ingestion_events', 'private.metadata_match_candidates']) t,
        unnest(array['anon', 'authenticated']) r,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p
   where has_any_column_privilege(r, t, p)),
  null, 'anon/authenticated hold no column privilege on private tables');
select is(
  (select array_agg(format('%s %s', p, t))
   from unnest(array['private.telegram_media', 'private.ingestion_events',
                     'private.metadata_match_candidates', 'private.telegram_channels']) t,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where has_table_privilege('service_role', t, p)),
  null, 'service_role holds no privilege on ingestion/review tables');
select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no USAGE on private');
select ok(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'authenticated has no USAGE on private');

-- ---------------------------------------------------------------------------
-- Catalogue: read-only, display columns only
-- ---------------------------------------------------------------------------
create temp table catalogue_tables (t text);
insert into catalogue_tables values
  ('public.vjs'), ('public.movies'), ('public.series'), ('public.seasons'), ('public.episodes'),
  ('public.movie_versions'), ('public.episode_versions'), ('public.genres'),
  ('public.movie_genres'), ('public.series_genres');

select is(
  (select array_agg(format('%s %s %s', r, p, t))
   from catalogue_tables, unnest(array['anon', 'authenticated']) r,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
   where has_table_privilege(r, t, p)),
  null, 'no table-level catalogue privilege for clients (reads are column-level)');
select is(
  (select array_agg(format('%s %s %s', r, p, t))
   from catalogue_tables, unnest(array['anon', 'authenticated']) r,
        unnest(array['INSERT', 'UPDATE', 'REFERENCES']) p
   where has_any_column_privilege(r, t, p)),
  null, 'no column-level catalogue write privilege for clients');
select is(
  (select array_agg(t) from catalogue_tables
   where has_any_column_privilege('service_role', t, 'SELECT')
      or has_table_privilege('service_role', t, 'INSERT,UPDATE,DELETE,TRUNCATE')),
  null, 'service_role has no catalogue access');
select is(
  (select array_agg(format('%s %s', r, s))
   from (select n.nspname || '.' || c.relname as s from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'S' and (n.nspname = 'private' or c.relname in (
           'vjs_id_seq', 'movies_id_seq', 'series_id_seq', 'seasons_id_seq', 'episodes_id_seq',
           'movie_versions_id_seq', 'episode_versions_id_seq', 'genres_id_seq'))) seqs,
        unnest(array['anon', 'authenticated']) r
   where has_sequence_privilege(r, s, 'USAGE,SELECT,UPDATE')),
  null, 'no client privilege on catalogue or private sequences');
select is(
  (select array_agg(format('%s %s.%s', r, t, c))
   from (values
     ('public.vjs', 'is_active'), ('public.vjs', 'created_at'),
     ('public.movies', 'publication_status'), ('public.movies', 'metadata_status'),
     ('public.movies', 'metadata_synced_at'), ('public.movies', 'updated_at'),
     ('public.series', 'publication_status'), ('public.series', 'metadata_status'),
     ('public.series', 'metadata_synced_at'),
     ('public.movie_versions', 'availability_status'), ('public.movie_versions', 'rights_status'),
     ('public.movie_versions', 'telegram_media_id'), ('public.movie_versions', 'telegram_media_bot_type'),
     ('public.episode_versions', 'availability_status'), ('public.episode_versions', 'rights_status'),
     ('public.episode_versions', 'telegram_media_id'), ('public.episode_versions', 'telegram_media_bot_type')
   ) hidden(t, c), unnest(array['anon', 'authenticated']) r
   where has_column_privilege(r, t, c, 'SELECT')),
  null, 'workflow, is_active and Telegram columns are not granted to clients');

-- ---------------------------------------------------------------------------
-- Functions: definer set, search_path, EXECUTE
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private', 'catalogue_access') and p.prosecdef),
  array['catalogue_access.episode_is_public', 'catalogue_access.movie_is_public',
        'catalogue_access.season_is_public', 'catalogue_access.series_is_public',
        'private.enforce_watchlist_limit', 'private.handle_new_user',
        'public.ingest_upload_fail', 'public.ingest_upload_record',
        'public.ingest_upload_start', 'public.ingest_upload_status',
        'public.record_search', 'public.trending_searches'],
  'SECURITY DEFINER functions are exactly the reviewed set');
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private', 'catalogue_access')
     and not coalesce(p.proconfig @> array['search_path=""'], false)),
  null, 'every application function pins search_path to empty');
select is(
  (select array_agg(format('%s %s', r, f))
   from unnest(array['private.handle_new_user()', 'private.enforce_watchlist_limit()',
                     'private.purge_search_events(interval, integer)',
                     'private.normalize_search_query(text)']) f,
        unnest(array['anon', 'authenticated']) r
   where has_function_privilege(r, f, 'EXECUTE')),
  null, 'privileged private helpers are not executable by clients');
select is(
  (select array_agg(format('%s %s', r, f))
   from unnest(array['catalogue_access.movie_is_public(bigint)', 'catalogue_access.series_is_public(bigint)',
                     'catalogue_access.season_is_public(bigint)', 'catalogue_access.episode_is_public(bigint)']) f,
        unnest(array['anon', 'authenticated']) r
   where not has_function_privilege(r, f, 'EXECUTE')),
  null, 'catalogue predicates are executable by anon/authenticated (used inside policies)');
select is(
  (select array_agg(p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'catalogue_access'
     and (has_function_privilege('service_role', p.oid, 'EXECUTE')
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  null, 'catalogue predicates grant nothing to PUBLIC or service_role');
select ok(not has_schema_privilege('service_role', 'catalogue_access', 'USAGE'),
  'service_role has no USAGE on catalogue_access');
select is(
  (select array_agg(format('%s %s', r, f))
   from unnest(array['public.record_search(text, text, integer)', 'public.trending_searches(integer)']) f,
        unnest(array['anon', 'authenticated']) r
   where not has_function_privilege(r, f, 'EXECUTE')),
  null, 'documented Phase 3 RPCs remain executable by clients');

-- ---------------------------------------------------------------------------
-- Retention job and cron isolation
-- ---------------------------------------------------------------------------
select results_eq(
  $q$select jobname, schedule, command, username, active from cron.job$q$,
  $q$values ('velora-purge-search-events'::text, '17 0 * * *'::text,
            $c$select private.purge_search_events(interval '30 days', 5000)$c$::text, 'postgres'::text, true)$q$,
  'exactly one retention job with the reviewed definition');
select ok(not has_schema_privilege('anon', 'cron', 'USAGE'), 'anon has no USAGE on cron');
select ok(not has_schema_privilege('authenticated', 'cron', 'USAGE'), 'authenticated has no USAGE on cron');

set local role anon;
select throws_ok($q$select jobid from cron.job$q$, '42501', null, 'anon: cannot read cron.job');
select throws_ok($q$select cron.schedule('x', '* * * * *', 'select 1')$q$, '42501', null, 'anon: cannot schedule cron jobs');
select throws_ok($q$select private.purge_search_events(interval '1 day', 1)$q$, '42501', null, 'anon: cannot call the purge function');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c0de", "role": "authenticated"}';
select throws_ok($q$select jobid from cron.job_run_details$q$, '42501', null, 'authenticated: cannot read cron.job_run_details');
select throws_ok($q$select cron.unschedule('velora-purge-search-events')$q$, '42501', null, 'authenticated: cannot unschedule cron jobs');
select throws_ok($q$select private.purge_search_events(interval '1 day', 1)$q$, '42501', null, 'authenticated: cannot call the purge function');
reset role;

select * from finish();
rollback;
