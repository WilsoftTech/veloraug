-- E3.8B. Direct PostgreSQL worker identity: no Data API JWT or service_role key.
-- Keep migration 13 immutable and existing service_role callers compatible.
create role velora_discovery_worker nologin nosuperuser nobypassrls
  nocreatedb nocreaterole noreplication noinherit;
alter role velora_discovery_worker set search_path = '';
alter role velora_discovery_worker set statement_timeout = '15s';
alter role velora_discovery_worker set idle_in_transaction_session_timeout = '10s';
grant usage on schema public to velora_discovery_worker;
-- PUBLIC function defaults are inherited even by NOINHERIT roles. Audit below
-- and in pgTAP; the role receives no table, sequence or private schema grants.
grant execute on function
  public.discovery_acquire_consumer(uuid, integer),
  public.discovery_receive(uuid, bigint, jsonb, jsonb),
  public.discovery_claim(integer),
  public.discovery_complete(text, uuid, integer, jsonb),
  public.discovery_fail(text, uuid, integer, text),
  public.discovery_catalogue_lookup(text),
  public.discovery_vjs(),
  public.discovery_health(),
  public.discovery_release_consumer(uuid)
to velora_discovery_worker;
