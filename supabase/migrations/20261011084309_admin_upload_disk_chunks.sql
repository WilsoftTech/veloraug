-- Chunk bytes are immutable private files; PostgreSQL holds the authoritative
-- committed manifest/offset. A crashed request leaves an unreferenced chunk,
-- not a partially committed movie. No change to Telegram discovery.
create table private.admin_upload_chunks (
  upload_id uuid not null references private.admin_upload_sessions(id),
  byte_offset bigint not null check (byte_offset >= 0),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  storage_key uuid not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key(upload_id,byte_offset)
);
alter table private.admin_upload_chunks enable row level security;
revoke all on table private.admin_upload_chunks from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;

create function private.admin_upload_worker_owner(p_id uuid,p_owner uuid)
returns void language plpgsql stable security invoker set search_path = '' as $$
begin
  if not private.reviewer_has(p_owner,'review') or not exists(
    select 1 from auth.users u where u.id = p_owner and u.raw_app_meta_data->>'role' = 'admin') then
    raise exception 'upload_not_authorized' using errcode = '42501';
  end if;
  if not exists(select 1 from private.admin_upload_sessions s where s.id = p_id and s.owner_id = p_owner) then
    raise exception 'upload_not_found' using errcode = 'P0001';
  end if;
end;
$$;

create function public.admin_upload_worker_manifest(p_id uuid,p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.admin_upload_worker_owner(p_id,p_owner);
  return jsonb_build_object('session',private.admin_upload_view(p_id),'chunks',coalesce((select jsonb_agg(
    jsonb_build_object('offset',c.byte_offset,'size',c.size_bytes,'key',c.storage_key,'sha256',c.sha256) order by c.byte_offset)
    from private.admin_upload_chunks c where c.upload_id = p_id),'[]'::jsonb));
end;
$$;

create function public.admin_upload_worker_chunk(p_id uuid,p_owner uuid,p_offset bigint,p_size integer,p_key uuid,p_sha256 text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_session private.admin_upload_sessions%rowtype;
begin
  perform private.admin_upload_worker_owner(p_id,p_owner);
  select * into v_session from private.admin_upload_sessions where id = p_id for update;
  if v_session.stage <> 'uploading' or v_session.expires_at <= now() then
    raise exception 'upload_illegal_transition' using errcode = 'P0001';
  end if;
  if p_offset is null or p_size is null or p_size not between 1 and 8388608 or p_key is null
    or p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' or p_offset < 0
    or p_size <> least(8388608,v_session.size_bytes-p_offset) or p_offset + p_size > v_session.size_bytes then
    raise exception 'upload_invalid_chunk' using errcode = '22023';
  end if;
  if p_offset <> v_session.bytes_received then raise exception 'upload_offset_conflict' using errcode = 'P0001'; end if;
  insert into private.admin_upload_chunks(upload_id,byte_offset,size_bytes,storage_key,sha256)
    values(p_id,p_offset,p_size,p_key,p_sha256);
  update private.admin_upload_sessions set bytes_received = bytes_received + p_size where id = p_id;
  return v_session.bytes_received + p_size;
end;
$$;

revoke all on function private.admin_upload_worker_owner(uuid,uuid),
  public.admin_upload_worker_manifest(uuid,uuid),public.admin_upload_worker_chunk(uuid,uuid,bigint,integer,uuid,text)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant usage on schema public to velora_upload_worker;
grant execute on function public.admin_upload_worker_manifest(uuid,uuid),public.admin_upload_worker_chunk(uuid,uuid,bigint,integer,uuid,text)
  to velora_upload_worker;
