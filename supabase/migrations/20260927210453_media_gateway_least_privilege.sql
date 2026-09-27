-- E1.2A: least-privilege database boundary for the media gateway.
--
-- The media gateway (services/media-gateway) must turn an internal movie-version
-- id into the private Telegram location of its file, and only when the version
-- is publicly playable. Until now it did so over the owner connection. This
-- migration gives it a dedicated identity whose only capability is one resolver.
--
-- 1. Role velora_media_gateway: no inherited privileges, no attributes, and no
--    membership in any role. It is created NOLOGIN; enabling login and setting
--    its password is operator configuration outside migrations (a SCRAM
--    verifier), so no credential ever enters SQL history.
-- 2. Schema media_gateway: not exposed through the Data API, usable only by
--    that role.
-- 3. media_gateway.resolve_movie_version(bigint): SECURITY DEFINER, empty
--    search_path, every object schema-qualified, no dynamic SQL, one typed
--    input. It applies the public-playability rule of
--    catalogue_access.movie_is_public (published movie, ready version, cleared
--    rights, active VJ) plus: movie-bot media in the registered Movies channel,
--    with a recorded size. It returns only the five fields the MTProto adapter
--    needs. EXECUTE belongs to velora_media_gateway alone.
--
-- Nothing else is granted. The role keeps only what PostgreSQL gives every role
-- through PUBLIC (CONNECT, TEMP, USAGE on schema public, which holds no
-- PUBLIC-executable function or PUBLIC table privilege). No table, sequence,
-- policy or other role changes.

-- ---------------------------------------------------------------------------
-- 1. Identity (idempotent: roles are cluster-wide and survive a local reset)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'velora_media_gateway') then
    create role velora_media_gateway;
  end if;
end
$$;

-- SUPERUSER, REPLICATION and BYPASSRLS default to off, and only a superuser may
-- even name them in ALTER ROLE; the database tests assert all three are off.
alter role velora_media_gateway
  with nologin noinherit nocreatedb nocreaterole
  connection limit 10;

-- Session defaults. Defence in depth only: privileges below are the boundary.
alter role velora_media_gateway set default_transaction_read_only = on;
alter role velora_media_gateway set statement_timeout = '5s';
alter role velora_media_gateway set idle_in_transaction_session_timeout = '10s';
alter role velora_media_gateway set search_path = '';

comment on role velora_media_gateway is
  'Velora media gateway: may only execute media_gateway.resolve_movie_version. Login and password are operator configuration.';

-- ---------------------------------------------------------------------------
-- 2. Schema
-- ---------------------------------------------------------------------------
create schema media_gateway;
revoke all on schema media_gateway from public, anon, authenticated, service_role;
grant usage on schema media_gateway to velora_media_gateway;

comment on schema media_gateway is
  'Media gateway resolver. Server-to-database only; not exposed through the Data API.';

-- ---------------------------------------------------------------------------
-- 3. Resolver
-- ---------------------------------------------------------------------------
create function media_gateway.resolve_movie_version(p_movie_version_id bigint)
returns table (
  chat_id bigint,
  message_id bigint,
  file_unique_id text,
  file_size_bytes bigint,
  mime_type text
)
language sql
stable
security definer
set search_path = ''
as $$
  select tm.chat_id, tm.message_id, tm.file_unique_id, tm.file_size_bytes, tm.mime_type
    from public.movie_versions mv
    join public.movies m on m.id = mv.movie_id
    join public.vjs v on v.id = mv.vj_id
    join private.telegram_media tm
      on tm.id = mv.telegram_media_id
     and tm.bot_type = 'movie'
    join private.telegram_channels c
      on c.bot_type = 'movie'
     and c.chat_id = tm.chat_id
   where p_movie_version_id > 0
     and mv.id = p_movie_version_id
     and m.publication_status = 'published'
     and m.published_at is not null
     and mv.availability_status = 'ready'
     and mv.rights_status = 'cleared'
     and v.is_active
     and tm.file_size_bytes > 0
$$;

comment on function media_gateway.resolve_movie_version(bigint) is
  'Private Telegram location of a publicly playable movie version, or no row. Executable by velora_media_gateway only.';

revoke all on function media_gateway.resolve_movie_version(bigint) from public, anon, authenticated, service_role;
grant execute on function media_gateway.resolve_movie_version(bigint) to velora_media_gateway;
