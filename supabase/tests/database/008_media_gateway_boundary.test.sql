-- E1.2A media gateway least-privilege boundary
-- (20260927210453_media_gateway_least_privilege.sql).
--
-- Role attributes, resolver hardening and exact output shape, API-role denial,
-- a whole-database audit of what the gateway role can reach, and behavioural
-- denials executed as the role itself. Fake channel ids only. Rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(66);

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
select ok(exists (select 1 from pg_roles where rolname = 'velora_media_gateway'), 'gateway role exists');
select is((select rolcanlogin from pg_roles where rolname = 'velora_media_gateway'), false,
  'migrations create the role NOLOGIN (login is operator configuration)');
select is((select rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls
             from pg_roles where rolname = 'velora_media_gateway'), false,
  'no superuser, createdb, createrole, replication or bypassrls');
select is((select rolinherit from pg_roles where rolname = 'velora_media_gateway'), false, 'NOINHERIT');
select is((select rolconnlimit from pg_roles where rolname = 'velora_media_gateway'), 10, 'connection limit 10');
select is((select count(*)::int from pg_auth_members m join pg_roles r on r.oid = m.member
            where r.rolname = 'velora_media_gateway'), 0, 'the gateway role is a member of no role');
select ok((select setconfig @> array['default_transaction_read_only=on', 'search_path=""']
             from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
            where r.rolname = 'velora_media_gateway' and s.setdatabase = 0),
  'role defaults: read-only transactions and an empty search_path');

-- ---------------------------------------------------------------------------
-- Resolver hardening and shape
-- ---------------------------------------------------------------------------
select has_function('media_gateway', 'resolve_movie_version', array['bigint'], 'resolver exists with one bigint argument');
select is((select prosecdef from pg_proc where oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure), true, 'SECURITY DEFINER');
select is((select proconfig from pg_proc where oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure),
  array['search_path=""'], 'search_path pinned empty');
select is((select pg_get_userbyid(proowner) from pg_proc where oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure),
  'postgres', 'owned by postgres');
select is((select provolatile from pg_proc where oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure), 's', 'STABLE');
select is((select prolang from pg_proc where oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure),
  (select oid from pg_language where lanname = 'sql'), 'plain SQL (no dynamic SQL possible)');
select is(
  (select array_agg(name order by ord) from pg_proc p,
          unnest(p.proargnames, p.proargmodes::text[]) with ordinality as a(name, mode, ord)
    where p.oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure and mode = 't'),
  array['chat_id', 'message_id', 'file_unique_id', 'file_size_bytes', 'mime_type'],
  'returns exactly the five transport fields (no file_id, caption, file name or internal ids)');

-- ---------------------------------------------------------------------------
-- Privileges: only the gateway role may use the schema and execute the resolver
-- ---------------------------------------------------------------------------
select ok(has_schema_privilege('velora_media_gateway', 'media_gateway', 'USAGE'), 'gateway: USAGE on media_gateway');
select ok(not has_schema_privilege('velora_media_gateway', 'media_gateway', 'CREATE'), 'gateway: no CREATE on media_gateway');
select ok(has_function_privilege('velora_media_gateway', 'media_gateway.resolve_movie_version(bigint)', 'EXECUTE'), 'gateway: EXECUTE on the resolver');
select ok(not has_function_privilege('public', 'media_gateway.resolve_movie_version(bigint)', 'EXECUTE'), 'PUBLIC: no EXECUTE');
select ok(not has_function_privilege('anon', 'media_gateway.resolve_movie_version(bigint)', 'EXECUTE'), 'anon: no EXECUTE');
select ok(not has_function_privilege('authenticated', 'media_gateway.resolve_movie_version(bigint)', 'EXECUTE'), 'authenticated: no EXECUTE');
select ok(not has_function_privilege('service_role', 'media_gateway.resolve_movie_version(bigint)', 'EXECUTE'), 'service_role: no EXECUTE');
select ok(not has_schema_privilege('anon', 'media_gateway', 'USAGE'), 'anon: no USAGE on media_gateway');
select ok(not has_schema_privilege('authenticated', 'media_gateway', 'USAGE'), 'authenticated: no USAGE on media_gateway');
select ok(not has_schema_privilege('service_role', 'media_gateway', 'USAGE'), 'service_role: no USAGE on media_gateway');

-- Whole-database audit of what the gateway role can reach (outside the system catalogs).
-- An object is reachable only with USAGE on its schema. Supabase platform objects
-- (extensions.pg_stat_statements*, cron.*) carry PUBLIC ACLs, but their schemas grant
-- the gateway no USAGE, so PostgreSQL refuses them; the last audit test proves that.
select is(
  (select array_agg((n.nspname || '.' || p.proname)::text order by (n.nspname || '.' || p.proname)::text collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
      and has_schema_privilege('velora_media_gateway', n.oid, 'USAGE')
      and has_function_privilege('velora_media_gateway', p.oid, 'EXECUTE')),
  array['media_gateway.resolve_movie_version'],
  'the resolver is the only callable function outside the system catalogs');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_schema_privilege('velora_media_gateway', n.oid, 'USAGE')
      and (has_table_privilege('velora_media_gateway', c.oid, 'SELECT')
        or has_table_privilege('velora_media_gateway', c.oid, 'INSERT')
        or has_table_privilege('velora_media_gateway', c.oid, 'UPDATE')
        or has_table_privilege('velora_media_gateway', c.oid, 'DELETE')
        or has_table_privilege('velora_media_gateway', c.oid, 'TRUNCATE')
        or has_table_privilege('velora_media_gateway', c.oid, 'REFERENCES')
        or has_table_privilege('velora_media_gateway', c.oid, 'TRIGGER'))),
  0, 'no reachable table or view privilege outside the system catalogs');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%' and c.relkind = 'S'
      and has_schema_privilege('velora_media_gateway', n.oid, 'USAGE')
      and (has_sequence_privilege('velora_media_gateway', c.oid, 'USAGE')
        or has_sequence_privilege('velora_media_gateway', c.oid, 'SELECT')
        or has_sequence_privilege('velora_media_gateway', c.oid, 'UPDATE'))),
  0, 'no reachable sequence privilege');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
      and has_schema_privilege('velora_media_gateway', n.oid, 'USAGE')
      and n.nspname not in ('media_gateway', 'public')),
  0, 'any object granted through PUBLIC lies in a schema the gateway cannot use');
select is(
  (select array_agg(nspname::text order by nspname::text collate "C") from pg_namespace
    where nspname not like 'pg\_%' and nspname <> 'information_schema'
      and has_schema_privilege('velora_media_gateway', oid, 'USAGE')),
  array['media_gateway', 'public'], 'schema USAGE: media_gateway, and public (every role, through PUBLIC)');
select is(
  (select count(*)::int from pg_namespace where nspname not like 'pg\_%' and has_schema_privilege('velora_media_gateway', oid, 'CREATE')),
  0, 'CREATE on no schema');

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres), then behaviour as the gateway role
-- ---------------------------------------------------------------------------
delete from private.telegram_channels where bot_type = 'movie';
insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1006666666666);
insert into public.vjs (slug, name, is_active) values ('e12a-active', 'E12A Active', true), ('e12a-inactive', 'E12A Inactive', false);
insert into public.movies (slug, title, publication_status, published_at) values
  ('e12a-published', 'E12A Published', 'published', now()),
  ('e12a-draft', 'E12A Draft', 'draft', now());
insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, mime_type, file_size_bytes, telegram_date)
select 'movie', -1006666666666, 7000 + n, 'e12a-file-' || n, 'e12a-unique-' || n, 'document', 'video/x-matroska', 1004462878, now()
from generate_series(1, 3) n;

create temporary table e12a (label text primary key, version_id bigint);
grant select on e12a to velora_media_gateway;
with fixtures(label, movie, vj, media) as (values
  ('published', 'e12a-published', 'e12a-active', 1),
  ('inactive_vj', 'e12a-published', 'e12a-inactive', 2),
  ('draft_movie', 'e12a-draft', 'e12a-active', 3)
), inserted as (
  insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select m.id, v.id, 'ready', 'cleared', now(), (select t.id from private.telegram_media t where t.file_unique_id = 'e12a-unique-' || f.media)
    from fixtures f join public.movies m on m.slug = f.movie join public.vjs v on v.slug = f.vj
  returning id, movie_id, vj_id
)
insert into e12a select f.label, i.id from fixtures f
  join public.movies m on m.slug = f.movie join public.vjs v on v.slug = f.vj
  join inserted i on i.movie_id = m.id and i.vj_id = v.id;

-- Test-only (rolled back): postgres holds ADMIN on the role it created; membership lets
-- it SET ROLE for the API-role checks and hand the probe functions below to the role.
grant velora_media_gateway to postgres;

-- API roles cannot call the resolver even by name.
set local role anon;
select throws_ok($$ select * from media_gateway.resolve_movie_version(1) $$, '42501', null, 'anon cannot call the resolver');
reset role;
set local role authenticated;
select throws_ok($$ select * from media_gateway.resolve_movie_version(1) $$, '42501', null, 'authenticated cannot call the resolver');
reset role;
set local role service_role;
select throws_ok($$ select * from media_gateway.resolve_movie_version(1) $$, '42501', null, 'service_role cannot call the resolver');
reset role;

-- Probes that run with exactly the gateway role's privileges: SECURITY DEFINER
-- functions OWNED by velora_media_gateway (pgTAP itself lives in a schema the role
-- cannot use, so assertions cannot run under SET ROLE). tests.gw returns the
-- SQLSTATE of the statement, or 'ok'. The transaction is read-write, so every
-- 42501 below is a privilege refusal, never read-only mode.
create schema tests;
grant create on schema tests to velora_media_gateway;
create function tests.gw(p_sql text) returns text language plpgsql security definer set search_path = '' as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end
$f$;
create function tests.gw_resolve(p_id bigint)
returns table (chat_id bigint, message_id bigint, file_unique_id text, file_size_bytes bigint, mime_type text)
language sql security definer set search_path = '' as $f$
  select * from media_gateway.resolve_movie_version(p_id)
$f$;
create function tests.gw_user() returns text language sql security definer set search_path = '' as $f$ select current_user::text $f$;
alter function tests.gw(text) owner to velora_media_gateway;
alter function tests.gw_resolve(bigint) owner to velora_media_gateway;
alter function tests.gw_user() owner to velora_media_gateway;

select is(tests.gw_user(), 'velora_media_gateway', 'probes execute as velora_media_gateway');
select is(current_setting('transaction_read_only'), 'off', 'the transaction is read-write, so denials are privilege denials');

select results_eq(
  $$ select * from tests.gw_resolve((select version_id from e12a where label = 'published')) $$,
  $$ values (-1006666666666::bigint, 7001::bigint, 'e12a-unique-1'::text, 1004462878::bigint, 'video/x-matroska'::text) $$,
  'as the gateway: a published version resolves to exactly its transport fields');
select is_empty($$ select * from tests.gw_resolve((select version_id from e12a where label = 'inactive_vj')) $$, 'inactive VJ: no row');
select is_empty($$ select * from tests.gw_resolve((select version_id from e12a where label = 'draft_movie')) $$, 'draft movie: no row');
select is_empty($$ select * from tests.gw_resolve(null) $$, 'null id: no row');
select is_empty($$ select * from tests.gw_resolve(-1) $$, 'negative id: no row');

-- Catalogue writes and reads
select is(tests.gw($$ update public.movies set publication_status = 'draft' where slug = 'e12a-published' $$), '42501', 'cannot unpublish (update movies)');
select is(tests.gw($$ insert into public.movies (slug, title) values ('e12a-x', 'X') $$), '42501', 'cannot insert movies');
select is(tests.gw($$ delete from public.movies where slug = 'e12a-draft' $$), '42501', 'cannot delete movies');
select is(tests.gw($$ update public.movie_versions set rights_status = 'blocked' $$), '42501', 'cannot change rights status (update versions)');
select is(tests.gw($$ update public.vjs set is_active = false $$), '42501', 'cannot alter VJs');
select is(tests.gw($$ select count(*) from public.movies $$), '42501', 'cannot read catalogue tables directly');
-- Private tables
select is(tests.gw($$ select count(*) from private.telegram_media $$), '42501', 'cannot read telegram_media');
select is(tests.gw($$ update private.telegram_media set file_size_bytes = 1 $$), '42501', 'cannot mutate telegram_media');
select is(tests.gw($$ update private.ingestion_events set status = 'published' $$), '42501', 'cannot mutate ingestion events');
select is(tests.gw($$ select count(*) from private.metadata_match_candidates $$), '42501', 'cannot read match candidates');
select is(tests.gw($$ update private.telegram_channels set checkpoint_message_id = checkpoint_message_id + 1 $$), '42501', 'cannot advance checkpoints');
-- Worker, approval and publication commands
select is(tests.gw($$ select public.ingest_channel_checkpoint('movie', -1006666666666, 1) $$), '42501', 'cannot execute the checkpoint command');
select is(tests.gw($$ select public.ingest_upload_status('sf1-' || repeat('a', 64), 'movie') $$), '42501', 'cannot execute worker commands');
select is(tests.gw($$ select private.catalogue_approve_movie_match('sf1-' || repeat('a', 64), 1) $$), '42501', 'cannot approve candidates');
select is(tests.gw($$ select private.catalogue_publish_movie('sf1-' || repeat('a', 64), '{}'::jsonb, true) $$), '42501', 'cannot publish');
-- User and auth data
select is(tests.gw($$ select count(*) from auth.users $$), '42501', 'cannot read auth.users');
select is(tests.gw($$ select count(*) from public.profiles $$), '42501', 'cannot read profiles');
select is(tests.gw($$ select count(*) from public.watchlist_items $$), '42501', 'cannot read watchlists');
-- DDL
select is(tests.gw($$ create table public.e12a_probe (x int) $$), '42501', 'cannot create tables in public');
select is(tests.gw($$ create schema e12a_probe $$), '42501', 'cannot create schemas');
select is(tests.gw($$ alter function media_gateway.resolve_movie_version(bigint) security invoker $$), '42501', 'cannot alter the resolver');
select is(tests.gw($$ drop function media_gateway.resolve_movie_version(bigint) $$), '42501', 'cannot drop the resolver');
-- Escalation: SET ROLE needs membership (this test's own grant is to postgres, not from it)
select ok(not pg_has_role('velora_media_gateway', 'postgres', 'MEMBER'), 'not a member of postgres');
select ok(not pg_has_role('velora_media_gateway', 'service_role', 'MEMBER'), 'not a member of service_role');
select ok(not pg_has_role('velora_media_gateway', 'authenticated', 'MEMBER'), 'not a member of authenticated');
select ok(not pg_has_role('velora_media_gateway', 'anon', 'MEMBER'), 'not a member of anon');

select * from finish();
rollback;
