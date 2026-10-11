-- Admin browser uploads are a new source, not a replacement discovery origin.
-- Staging bytes stay private on disk. The eventual Telegram reference links to
-- the existing uploader event and existing owner publication functions.
create table private.admin_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'admin_upload' check (source = 'admin_upload'),
  owner_id uuid not null references auth.users(id),
  file_name text not null check (char_length(file_name) between 1 and 255 and file_name !~ '[\\/[:cntrl:]]'),
  size_bytes bigint not null check (size_bytes between 1 and 2000000000),
  storage_key uuid not null unique default gen_random_uuid(),
  stage text not null default 'draft' check (stage in (
    'draft','uploading','verifying','uploaded','inspecting','metadata_review','awaiting_rights',
    'awaiting_approval','approved','telegram_queued','telegram_uploading','telegram_uncertain',
    'telegram_stored','publishing','published','failed','cancelled')),
  revision integer not null default 1 check (revision > 0),
  metadata jsonb not null default '{"kind":"movie","title":"","year":null,"vjId":null,"snapshot":null,"season":null,"episode":null,"provenance":""}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 65536),
  field_provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(field_provenance) = 'object'),
  bytes_received bigint not null default 0 check (bytes_received >= 0 and bytes_received <= size_bytes),
  verified_sha256 text check (verified_sha256 ~ '^[a-f0-9]{64}$'),
  source_fingerprint text check (source_fingerprint ~ '^sf1-[a-f0-9]{64}$'),
  inspection jsonb,
  ingestion_event_id bigint unique references private.ingestion_events(id),
  rights_revision integer,
  rights_sha256 text,
  rights_reference text,
  rights_by uuid references auth.users(id),
  rights_at timestamptz,
  approved_revision integer,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  publish_by uuid references auth.users(id),
  lease_token uuid,
  lease_until timestamptz,
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{2,80}$'),
  retryable boolean not null default false,
  resume_stage text,
  staging_cleaned_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_upload_lease_pair check ((lease_token is null) = (lease_until is null)),
  constraint admin_upload_rights_shape check (
    (rights_revision is null and rights_sha256 is null and rights_reference is null and rights_by is null and rights_at is null)
    or (rights_revision is not null and verified_sha256 is not null and rights_sha256 is not null
        and rights_revision = revision and rights_sha256 = verified_sha256 and rights_sha256 ~ '^[a-f0-9]{64}$'
        and rights_reference is not null and char_length(rights_reference) between 1 and 200 and rights_by is not null and rights_at is not null)),
  constraint admin_upload_approval_shape check (
    (approved_revision is null and approved_by is null and approved_at is null and publish_by is null)
    or (approved_revision is not null and approved_revision = revision and approved_by is not null and approved_at is not null and publish_by is not null)),
  constraint admin_upload_verified_stage check (stage in ('draft','uploading','verifying','failed','cancelled')
    or (verified_sha256 is not null and bytes_received = size_bytes)),
  constraint admin_upload_approved_stage check (stage not in ('approved','telegram_queued','telegram_uploading','telegram_uncertain','telegram_stored','publishing','published')
    or (approved_revision is not null and rights_revision is not null)),
  constraint admin_upload_stored_stage check (stage not in ('telegram_stored','publishing','published') or ingestion_event_id is not null)
);
create index admin_upload_sessions_owner_idx on private.admin_upload_sessions(owner_id, created_at desc);
create index admin_upload_sessions_queue_idx on private.admin_upload_sessions(stage, created_at) where stage not in ('published','cancelled');
create index admin_upload_sessions_sha_idx on private.admin_upload_sessions(verified_sha256) where verified_sha256 is not null;
create trigger admin_upload_sessions_updated_at before update on private.admin_upload_sessions
  for each row execute function private.set_updated_at();

create table private.admin_upload_attempts (
  id bigint generated always as identity primary key,
  upload_id uuid not null references private.admin_upload_sessions(id),
  attempt integer not null check (attempt > 0),
  operation text not null check (operation in ('verify','inspect','telegram','publish')),
  lease_token uuid not null unique,
  outcome text not null default 'pending' check (outcome in ('pending','succeeded','failed','uncertain','reconciled')),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{2,80}$'),
  receipt jsonb check (receipt is null or (jsonb_typeof(receipt) = 'object' and pg_column_size(receipt) <= 16384)),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (upload_id, operation, attempt)
);
create unique index admin_upload_attempts_pending_idx on private.admin_upload_attempts(upload_id, operation)
  where outcome in ('pending','uncertain');
create table private.admin_upload_audit (
  id bigint generated always as identity primary key,
  upload_id uuid not null references private.admin_upload_sessions(id),
  revision integer not null check (revision > 0),
  actor uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_]{2,80}$'),
  created_at timestamptz not null default now()
);
create index admin_upload_audit_upload_idx on private.admin_upload_audit(upload_id, id);
create trigger admin_upload_audit_append_only before update or delete on private.admin_upload_audit
  for each row execute function private.guard_append_only();

-- Independent disabled worker identity. No inheritance, table access, owner
-- membership, publication authority, or ability to enroll reviewers.
create role velora_upload_worker nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit;
alter role velora_upload_worker set search_path = '';
alter role velora_upload_worker set statement_timeout = '15s';
alter role velora_upload_worker set idle_in_transaction_session_timeout = '10s';

create function private.require_upload_admin()
returns uuid language plpgsql stable security invoker set search_path = '' as $$
declare v_uid uuid := private.require_reviewer('review');
begin
  if not exists (select 1 from auth.users u where u.id = v_uid and u.raw_app_meta_data->>'role' = 'admin') then
    raise exception 'upload_not_authorized' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- This view deliberately excludes disk paths, storage keys, Telegram file IDs,
-- worker receipts, and privileged approval fields from the browser contract.
create function private.admin_upload_view(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'source', s.source, 'owner_id', s.owner_id,
    'file_name', s.file_name, 'size_bytes', s.size_bytes, 'stage', s.stage, 'revision', s.revision,
    'metadata', s.metadata, 'verified_sha256', s.verified_sha256, 'bytes_received', s.bytes_received,
    'error_code', s.error_code, 'retryable', s.retryable,
    'created_at', s.created_at, 'updated_at', s.updated_at, 'expires_at', s.expires_at)
  from private.admin_upload_sessions s where s.id = p_id
$$;

create function public.admin_upload_create(p_file_name text, p_size_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin(); v_id uuid;
begin
  if p_file_name is null or char_length(p_file_name) not between 1 and 255
    or p_file_name <> btrim(p_file_name) or p_file_name ~ '[\\/[:cntrl:]]'
    or lower(p_file_name) !~ '\.(mp4|mkv|avi|mov|m4v|webm|wmv|flv|mpg|mpeg|ts|m2ts|3gp)$'
    or p_size_bytes is null or p_size_bytes not between 1 and 2000000000 then
    raise exception 'upload_invalid_file' using errcode = '22023';
  end if;
  -- Serialize quota reservations, including concurrent sessions from different
  -- owners. Expired/failed files still consume quota until explicitly cleaned.
  perform pg_catalog.pg_advisory_xact_lock(716240011);
  if (select count(*) from private.admin_upload_sessions s where s.owner_id = v_uid and s.staging_cleaned_at is null) >= 5
    or (select coalesce(sum(s.size_bytes),0) from private.admin_upload_sessions s where s.owner_id = v_uid and s.staging_cleaned_at is null) + p_size_bytes > 10000000000
    or (select coalesce(sum(s.size_bytes),0) from private.admin_upload_sessions s where s.staging_cleaned_at is null) + p_size_bytes > 100000000000 then
    raise exception 'upload_quota_exceeded' using errcode = 'P0001';
  end if;
  insert into private.admin_upload_sessions(owner_id,file_name,size_bytes) values(v_uid,p_file_name,p_size_bytes) returning id into v_id;
  insert into private.admin_upload_audit(upload_id,revision,actor,action) values(v_id,1,v_uid,'created');
  return private.admin_upload_view(v_id);
end;
$$;

create function public.admin_upload_list(p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin();
begin
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'upload_invalid_input' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(private.admin_upload_view(s.id) order by s.created_at desc)
    from (select id,created_at from private.admin_upload_sessions where owner_id = v_uid order by created_at desc limit p_limit) s),'[]'::jsonb);
end;
$$;

create function public.admin_upload_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin();
begin
  if not exists(select 1 from private.admin_upload_sessions s where s.id = p_id and s.owner_id = v_uid) then
    raise exception 'upload_not_found' using errcode = 'P0001';
  end if;
  return private.admin_upload_view(p_id);
end;
$$;

create function public.admin_upload_edit(p_id uuid, p_revision integer, p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin(); v_session private.admin_upload_sessions%rowtype;
begin
  select * into v_session from private.admin_upload_sessions where id = p_id and owner_id = v_uid for update;
  if not found then raise exception 'upload_not_found' using errcode = 'P0001'; end if;
  if p_revision is distinct from v_session.revision then raise exception 'upload_stale_revision' using errcode = 'P0001'; end if;
  if v_session.stage not in ('draft','uploading','metadata_review','awaiting_rights','awaiting_approval','approved')
    or v_session.lease_token is not null or v_session.expires_at <= now() then
    raise exception 'upload_illegal_transition' using errcode = 'P0001';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or pg_column_size(p_metadata) > 65536
    or (select count(*) from jsonb_object_keys(p_metadata)) <> 8
    or exists(select 1 from jsonb_object_keys(p_metadata) k where k not in ('kind','title','year','vjId','snapshot','season','episode','provenance'))
    or coalesce(p_metadata->>'kind','') not in ('movie','series')
    or jsonb_typeof(p_metadata->'title') is distinct from 'string' or char_length(p_metadata->>'title') > 300
    or jsonb_typeof(p_metadata->'provenance') is distinct from 'string' or char_length(p_metadata->>'provenance') > 2000
    or jsonb_typeof(p_metadata->'year') not in ('number','null')
    or jsonb_typeof(p_metadata->'vjId') not in ('number','null')
    or jsonb_typeof(p_metadata->'season') not in ('number','null')
    or jsonb_typeof(p_metadata->'episode') not in ('number','null')
    or jsonb_typeof(p_metadata->'snapshot') not in ('object','null') then
    raise exception 'upload_invalid_metadata' using errcode = '22023';
  end if;
  if (p_metadata->>'year' is not null and (p_metadata->>'year' !~ '^[0-9]{4}$' or (p_metadata->>'year')::integer not between 1870 and 2199))
    or (p_metadata->>'vjId' is not null and p_metadata->>'vjId' !~ '^[1-9][0-9]{0,14}$')
    or (p_metadata->>'season' is not null and p_metadata->>'season' !~ '^[0-9]{1,3}$')
    or (p_metadata->>'episode' is not null and p_metadata->>'episode' !~ '^[1-9][0-9]{0,3}$') then
    raise exception 'upload_invalid_metadata' using errcode = '22023';
  end if;
  update private.admin_upload_sessions set metadata = p_metadata, revision = revision + 1,
    stage = case when stage in ('draft','uploading') then stage else 'metadata_review' end,
    rights_revision = null,rights_sha256 = null,rights_reference = null,rights_by = null,rights_at = null,
    approved_revision = null,approved_by = null,approved_at = null,publish_by = null
  where id = p_id;
  insert into private.admin_upload_audit(upload_id,revision,actor,action) values(p_id,p_revision+1,v_uid,'metadata_edited');
  return private.admin_upload_view(p_id);
end;
$$;

-- Only unprivileged browser transitions. 'verifying' means a request to verify,
-- never proof that the file is complete. No caller chooses an arbitrary stage.
create function public.admin_upload_control(p_id uuid, p_revision integer, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin(); v_session private.admin_upload_sessions%rowtype; v_stage text;
begin
  select * into v_session from private.admin_upload_sessions where id = p_id and owner_id = v_uid for update;
  if not found then raise exception 'upload_not_found' using errcode = 'P0001'; end if;
  if p_revision is distinct from v_session.revision then raise exception 'upload_stale_revision' using errcode = 'P0001'; end if;
  if v_session.lease_token is not null then raise exception 'upload_worker_busy' using errcode = 'P0001'; end if;
  if p_action = 'start' and v_session.stage = 'draft' and v_session.expires_at > now() then v_stage := 'uploading';
  elsif p_action = 'verify' and v_session.stage = 'uploading' and v_session.bytes_received=v_session.size_bytes and v_session.expires_at > now() then v_stage := 'verifying';
  elsif p_action = 'retry' and v_session.stage = 'failed' and v_session.retryable and v_session.resume_stage in ('verifying','uploaded') and v_session.expires_at>now() then v_stage:=v_session.resume_stage;
  elsif p_action = 'cancel' and v_session.stage in ('draft','uploading','verifying','uploaded','metadata_review','awaiting_rights','awaiting_approval','approved','telegram_queued','failed') then v_stage := 'cancelled';
  else raise exception 'upload_illegal_transition' using errcode = 'P0001'; end if;
  update private.admin_upload_sessions set stage = v_stage, revision = revision + 1,error_code=null,retryable=false,
    rights_revision = null,rights_sha256 = null,rights_reference = null,rights_by = null,rights_at = null,
    approved_revision = null,approved_by = null,approved_at = null,publish_by = null where id = p_id;
  insert into private.admin_upload_audit(upload_id,revision,actor,action) values(p_id,p_revision+1,v_uid,p_action);
  return private.admin_upload_view(p_id);
end;
$$;

alter table private.admin_upload_sessions enable row level security;
alter table private.admin_upload_attempts enable row level security;
alter table private.admin_upload_audit enable row level security;
revoke all on table private.admin_upload_sessions,private.admin_upload_attempts,private.admin_upload_audit
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
revoke all on sequence private.admin_upload_attempts_id_seq,private.admin_upload_audit_id_seq
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
revoke all on function private.require_upload_admin(),private.admin_upload_view(uuid)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
revoke all on function public.admin_upload_create(text,bigint),public.admin_upload_list(integer),public.admin_upload_get(uuid),
  public.admin_upload_edit(uuid,integer,jsonb),public.admin_upload_control(uuid,integer,text)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_create(text,bigint),public.admin_upload_list(integer),public.admin_upload_get(uuid),
  public.admin_upload_edit(uuid,integer,jsonb),public.admin_upload_control(uuid,integer,text) to authenticated;
