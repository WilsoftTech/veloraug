-- Add cloud staging without changing existing disk sessions or discovery.
alter table private.admin_upload_sessions add column upload_request_id uuid;
create unique index admin_upload_request_key on private.admin_upload_sessions(owner_id,upload_request_id) where upload_request_id is not null;
create table private.admin_upload_r2 (
  upload_id uuid primary key references private.admin_upload_sessions(id),
  bucket text not null default 'velora-uploads-staging' check(bucket='velora-uploads-staging'),
  object_key text not null unique check(object_key ~ '^admin-uploads/[a-f0-9-]{36}/[a-f0-9-]{36}/media$'),
  multipart_id text check(char_length(multipart_id) between 1 and 2048),
  state text not null default 'pending' check(state in ('pending','open','completing','complete','cleaning','cleaned')),
  init_token uuid, init_until timestamptz,
  object_etag text check(char_length(object_etag) between 1 and 200),
  cleanup_error text check(cleanup_error ~ '^[a-z][a-z0-9_]{2,80}$'),
  cleanup_attempts integer not null default 0 check(cleanup_attempts>=0),
  cleanup_after timestamptz not null default now(),
  cleaned_at timestamptz,
  constraint r2_init_pair check((init_token is null)=(init_until is null)),
  constraint r2_complete_shape check(state not in ('complete','cleaning') or (multipart_id is not null and object_etag is not null)),
  constraint r2_cleaned_shape check((state='cleaned')=(cleaned_at is not null))
);
create table private.admin_upload_r2_parts (
  upload_id uuid not null references private.admin_upload_r2(upload_id),
  part_number integer not null check(part_number between 1 and 239),
  size_bytes integer not null check(size_bytes between 1 and 8388608),
  expected_sha256 text not null check(expected_sha256 ~ '^[a-f0-9]{64}$'),
  etag text check(char_length(etag) between 1 and 200),
  signed_at timestamptz not null default now(),
  signature_count integer not null default 1 check(signature_count between 1 and 200),
  primary key(upload_id,part_number)
);
alter table private.admin_upload_r2 enable row level security;
alter table private.admin_upload_r2_parts enable row level security;
revoke all on private.admin_upload_r2,private.admin_upload_r2_parts from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;

create function private.admin_upload_r2_view(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('session',private.admin_upload_view(s.id),'reference',jsonb_build_object(
    'id',s.id,'bucket',r.bucket,'key',r.object_key,'upload_id',r.multipart_id,'etag',r.object_etag,'size',s.size_bytes),
    'state',r.state,'init_token',r.init_token,'init_until',r.init_until,
    'parts',coalesce((select jsonb_agg(jsonb_build_object('number',p.part_number,'size',p.size_bytes,'sha256',p.expected_sha256,'etag',p.etag) order by p.part_number)
      from private.admin_upload_r2_parts p where p.upload_id=s.id),'[]'::jsonb))
  from private.admin_upload_sessions s join private.admin_upload_r2 r on r.upload_id=s.id where s.id=p_id
$$;
revoke all on function private.admin_upload_r2_view(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;

create function public.admin_upload_r2_create(p_file_name text,p_size_bytes bigint,p_request_id uuid,p_retention_days integer default 7)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.require_upload_admin(); v_id uuid; v_result jsonb; v_session private.admin_upload_sessions%rowtype;
begin
  if p_request_id is null or p_retention_days is null or p_retention_days not between 1 and 30 then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text||p_request_id::text,716240013));
  select * into v_session from private.admin_upload_sessions where owner_id=v_uid and upload_request_id=p_request_id;
  if found then
    if v_session.file_name is distinct from p_file_name or v_session.size_bytes is distinct from p_size_bytes then raise exception 'upload_request_conflict' using errcode='P0001'; end if;
    return private.admin_upload_view(v_session.id);
  end if;
  v_result:=public.admin_upload_create(p_file_name,p_size_bytes); v_id:=(v_result->>'id')::uuid;
  update private.admin_upload_sessions set upload_request_id=p_request_id,expires_at=now()+make_interval(days=>p_retention_days) where id=v_id returning * into v_session;
  insert into private.admin_upload_r2(upload_id,object_key) values(v_id,'admin-uploads/'||v_uid::text||'/'||v_session.storage_key::text||'/media');
  return private.admin_upload_view(v_id);
end;
$$;

-- Browser metadata is an unverified declaration. No command here may establish
-- checksums, media verification, rights, Telegram evidence or publication.
create function public.admin_upload_r2_command(p_id uuid,p_command text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.require_upload_admin(); s private.admin_upload_sessions%rowtype; r private.admin_upload_r2%rowtype;
  v_number integer; v_size integer; v_token uuid; v_part jsonb; v_seen integer[]:='{}'; v_sum bigint;
begin
  select * into s from private.admin_upload_sessions where id=p_id and owner_id=v_uid for update;
  if not found then raise exception 'upload_not_found' using errcode='P0001'; end if;
  select * into r from private.admin_upload_r2 where upload_id=p_id for update;
  if not found then raise exception 'r2_session_missing' using errcode='P0001'; end if;
  if p_input is null or jsonb_typeof(p_input)<>'object' or pg_column_size(p_input)>65536 then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  if p_command='state' then return private.admin_upload_r2_view(p_id); end if;
  if s.stage not in ('draft','uploading') or (s.expires_at<=now() and not (r.state='completing' and p_command in ('observe','complete_requested','completed'))) or s.lease_token is not null then raise exception 'upload_illegal_transition' using errcode='P0001'; end if;
  if p_command='begin' then
    if r.multipart_id is not null then return private.admin_upload_r2_view(p_id); end if;
    if r.init_until>now() then raise exception 'r2_initialization_busy' using errcode='P0001'; end if;
    v_token:=(p_input->>'token')::uuid;
    if v_token is null then raise exception 'upload_invalid_input' using errcode='22023'; end if;
    if s.stage='draft' then perform public.admin_upload_control(p_id,s.revision,'start'); end if;
    update private.admin_upload_r2 set init_token=v_token,init_until=now()+interval '90 seconds' where upload_id=p_id;
  elsif p_command='attach' then
    if (p_input->>'token')::uuid is distinct from r.init_token or r.init_until<=now() or r.multipart_id is not null
      or p_input->>'upload_id' is null or char_length(p_input->>'upload_id') not between 1 and 2048 then raise exception 'r2_initialization_lost' using errcode='P0001'; end if;
    update private.admin_upload_r2 set multipart_id=p_input->>'upload_id',state='open',init_token=null,init_until=null where upload_id=p_id;
  elsif p_command='reserve_part' then
    if r.state<>'open' or p_input->>'number' is null or p_input->>'number' !~ '^[1-9][0-9]{0,2}$'
      or p_input->>'sha256' is null or p_input->>'sha256' !~ '^[a-f0-9]{64}$' then raise exception 'r2_part_invalid' using errcode='22023'; end if;
    v_number:=(p_input->>'number')::integer;
    if v_number>ceil(s.size_bytes::numeric/8388608) then raise exception 'r2_part_invalid' using errcode='22023'; end if;
    v_size:=least(8388608,s.size_bytes-(v_number-1)::bigint*8388608)::integer;
    if exists(select 1 from private.admin_upload_r2_parts p where p.upload_id=p_id and p.part_number=v_number and p.expected_sha256<>p_input->>'sha256') then raise exception 'r2_source_changed' using errcode='P0001'; end if;
    if exists(select 1 from private.admin_upload_r2_parts p where p.upload_id=p_id and p.part_number=v_number and (p.signed_at>now()-interval '2 seconds' or p.signature_count>=200)) then raise exception 'r2_signing_rate_limited' using errcode='P0001'; end if;
    insert into private.admin_upload_r2_parts(upload_id,part_number,size_bytes,expected_sha256) values(p_id,v_number,v_size,p_input->>'sha256')
      on conflict(upload_id,part_number) do update set signed_at=now(),signature_count=private.admin_upload_r2_parts.signature_count+1;
  elsif p_command='observe' then
    if r.state not in ('open','completing') or jsonb_typeof(p_input->'parts') is distinct from 'array' or jsonb_array_length(p_input->'parts')>239 then raise exception 'r2_parts_invalid' using errcode='22023'; end if;
    -- R2 is authoritative for which parts still exist (a failed overwrite can
    -- remove a previously uploaded part). Keep hashes immutable across resumes.
    update private.admin_upload_r2_parts set etag=null where upload_id=p_id;
    for v_part in select value from jsonb_array_elements(p_input->'parts') loop
      if v_part->>'number' is null or v_part->>'number' !~ '^[1-9][0-9]{0,2}$' or v_part->>'size' is null or v_part->>'size' !~ '^[1-9][0-9]{0,7}$'
        or v_part->>'etag' is null or char_length(v_part->>'etag') not between 1 and 200 then raise exception 'r2_parts_invalid' using errcode='22023'; end if;
      v_number:=(v_part->>'number')::integer;
      if v_number=any(v_seen) or not exists(select 1 from private.admin_upload_r2_parts p where p.upload_id=p_id and p.part_number=v_number and p.size_bytes=(v_part->>'size')::integer) then raise exception 'r2_parts_invalid' using errcode='22023'; end if;
      v_seen:=array_append(v_seen,v_number);
      update private.admin_upload_r2_parts set etag=v_part->>'etag' where upload_id=p_id and part_number=v_number;
    end loop;
    select coalesce(sum(size_bytes),0) into v_sum from private.admin_upload_r2_parts where upload_id=p_id and etag is not null;
    update private.admin_upload_sessions set bytes_received=v_sum where id=p_id;
  elsif p_command='complete_requested' then
    if r.state not in ('open','completing') or s.bytes_received<>s.size_bytes
      or (select count(*) from private.admin_upload_r2_parts where upload_id=p_id and etag is not null)<>ceil(s.size_bytes::numeric/8388608) then raise exception 'r2_upload_incomplete' using errcode='P0001'; end if;
    update private.admin_upload_r2 set state='completing' where upload_id=p_id;
  elsif p_command='completed' then
    if r.state<>'completing' or s.bytes_received<>s.size_bytes or p_input->>'etag' is null or char_length(p_input->>'etag') not between 1 and 200 then raise exception 'r2_upload_incomplete' using errcode='P0001'; end if;
    update private.admin_upload_r2 set state='complete',object_etag=p_input->>'etag' where upload_id=p_id;
    update private.admin_upload_sessions set expires_at=greatest(expires_at,now()+interval '7 days') where id=p_id;
    perform public.admin_upload_control(p_id,s.revision,'verify');
  else raise exception 'upload_invalid_input' using errcode='22023'; end if;
  return private.admin_upload_r2_view(p_id);
end;
$$;
revoke all on function public.admin_upload_r2_create(text,bigint,uuid,integer),public.admin_upload_r2_command(uuid,text,jsonb)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_r2_create(text,bigint,uuid,integer),public.admin_upload_r2_command(uuid,text,jsonb) to authenticated;

-- Preserve the safe session contract, adding only the transport discriminator.
create or replace function private.admin_upload_view(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',s.id,'source',s.source,'owner_id',s.owner_id,'file_name',s.file_name,'size_bytes',s.size_bytes,
    'stage',s.stage,'revision',s.revision,'metadata',s.metadata,'verified_sha256',s.verified_sha256,'bytes_received',s.bytes_received,
    'error_code',s.error_code,'retryable',s.retryable,'created_at',s.created_at,'updated_at',s.updated_at,'expires_at',s.expires_at,
    'storage',case when exists(select 1 from private.admin_upload_r2 r where r.upload_id=s.id) then 'r2' else 'disk' end)
  from private.admin_upload_sessions s where s.id=p_id
$$;
revoke all on function private.admin_upload_view(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
