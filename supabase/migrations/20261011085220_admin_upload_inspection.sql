alter table private.admin_upload_sessions add column verified_file_key uuid;

create function public.admin_upload_worker_claim(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session private.admin_upload_sessions%rowtype; v_operation text; v_attempt integer;
begin
  if p_token is null then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  select s.* into v_session from private.admin_upload_sessions s
  where s.stage in ('verifying','uploaded','inspecting') and s.expires_at>now()
    and (s.lease_until is null or s.lease_until<=now())
    and private.reviewer_has(s.owner_id,'review')
    and exists(select 1 from auth.users u where u.id=s.owner_id and u.raw_app_meta_data->>'role'='admin')
  order by s.created_at for update skip locked limit 1;
  if not found then return null; end if;
  v_operation:=case when v_session.stage='verifying' then 'verify' else 'inspect' end;
  -- Inspection has no external side effect. An expired fenced attempt can be
  -- superseded; Telegram uncertainty is deliberately never claimed here.
  update private.admin_upload_attempts set outcome='failed',error_code='upload_lease_expired',finished_at=now()
    where upload_id=v_session.id and operation=v_operation and outcome='pending';
  select coalesce(max(attempt),0)+1 into v_attempt from private.admin_upload_attempts where upload_id=v_session.id and operation=v_operation;
  if v_attempt>5 then
    update private.admin_upload_sessions set stage='failed',error_code='upload_attempts_exhausted',retryable=false,lease_token=null,lease_until=null where id=v_session.id;
    return null;
  end if;
  update private.admin_upload_sessions set lease_token=p_token,lease_until=now()+interval '10 minutes',
    stage=case when v_operation='inspect' then 'inspecting' else stage end where id=v_session.id;
  insert into private.admin_upload_attempts(upload_id,attempt,operation,lease_token) values(v_session.id,v_attempt,v_operation,p_token);
  return jsonb_build_object('manifest',public.admin_upload_worker_manifest(v_session.id,v_session.owner_id),
    'token',p_token,'operation',v_operation,'verified_file_key',v_session.verified_file_key,
    'vjs',case when v_operation='inspect' then public.discovery_vjs() else '[]'::jsonb end);
end;
$$;

create function public.admin_upload_worker_finish(p_id uuid,p_token uuid,p_result jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_session private.admin_upload_sessions%rowtype; v_operation text; v_error text;
begin
  select * into v_session from private.admin_upload_sessions where id=p_id for update;
  if not found or v_session.lease_token is distinct from p_token or v_session.lease_until<=now() or p_token is null then
    raise exception 'upload_lease_lost' using errcode='P0001';
  end if;
  perform private.admin_upload_worker_owner(p_id,v_session.owner_id);
  if p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>262144 then
    raise exception 'upload_invalid_result' using errcode='22023';
  end if;
  v_operation:=case when v_session.stage='verifying' then 'verify' else 'inspect' end;
  if p_result->>'outcome'='failed' then
    v_error:=p_result->>'code';
    if v_error is null or v_error !~ '^[a-z][a-z0-9_]{2,80}$' then raise exception 'upload_invalid_result' using errcode='22023'; end if;
    update private.admin_upload_sessions set stage='failed',error_code=v_error,
      retryable=v_error in ('upload_media_tools_missing','upload_disk_full','probe_timeout','inspection_provider_failed','unexpected_error'),
      resume_stage=case when v_session.stage='verifying' then 'verifying' else 'uploaded' end,
      lease_token=null,lease_until=null where id=p_id;
    update private.admin_upload_attempts set outcome='failed',error_code=v_error,finished_at=now() where lease_token=p_token;
    insert into private.admin_upload_audit(upload_id,revision,action) values(p_id,v_session.revision,v_operation||'_failed');
    return 'failed';
  end if;
  if p_result->>'outcome'='verified' and v_session.stage='verifying' then
    if v_session.bytes_received<>v_session.size_bytes
      or (select coalesce(sum(c.size_bytes),0) from private.admin_upload_chunks c where c.upload_id=p_id)<>v_session.size_bytes
      or p_result->>'sha256' is null or p_result->>'sha256' !~ '^[a-f0-9]{64}$'
      or p_result->>'fingerprint' is null or p_result->>'fingerprint' !~ '^sf1-[a-f0-9]{64}$'
      or p_result->>'file_key' is null then raise exception 'upload_invalid_result' using errcode='22023'; end if;
    -- Different sessions may finish concurrently; serialize the same digest
    -- before checking for an already verified source.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_result->>'sha256',716240012));
    if exists(select 1 from private.admin_upload_sessions s where s.id<>p_id and s.verified_sha256=p_result->>'sha256' and s.stage<>'cancelled') then
      raise exception 'upload_duplicate_file' using errcode='P0001';
    end if;
    update private.admin_upload_sessions set stage='uploaded',verified_sha256=p_result->>'sha256',source_fingerprint=p_result->>'fingerprint',
      verified_file_key=(p_result->>'file_key')::uuid,lease_token=null,lease_until=null,error_code=null where id=p_id;
  elsif p_result->>'outcome'='inspected' and v_session.stage='inspecting' then
    if jsonb_typeof(p_result->'inspection') is distinct from 'object'
      or jsonb_typeof(p_result->'inspection'->'choices') is distinct from 'array'
      or jsonb_array_length(p_result->'inspection'->'choices')>20 then raise exception 'upload_invalid_result' using errcode='22023'; end if;
    update private.admin_upload_sessions set stage='metadata_review',inspection=p_result->'inspection',lease_token=null,lease_until=null,error_code=null where id=p_id;
  else raise exception 'upload_invalid_result' using errcode='22023'; end if;
  update private.admin_upload_attempts set outcome='succeeded',finished_at=now() where lease_token=p_token;
  insert into private.admin_upload_audit(upload_id,revision,action) values(p_id,v_session.revision,v_operation||'_completed');
  return (select stage from private.admin_upload_sessions where id=p_id);
end;
$$;
revoke all on function public.admin_upload_worker_claim(uuid),public.admin_upload_worker_finish(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_worker_claim(uuid),public.admin_upload_worker_finish(uuid,uuid,jsonb) to velora_upload_worker;

-- Own-session detail: bounded suggestions only, never a staging path or key.
create or replace function public.admin_upload_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin(); v_inspection jsonb;
begin
  select s.inspection into v_inspection from private.admin_upload_sessions s where s.id=p_id and s.owner_id=v_uid;
  if not found then raise exception 'upload_not_found' using errcode='P0001'; end if;
  return private.admin_upload_view(p_id)||jsonb_build_object('inspection',case when v_inspection is null then null else
    jsonb_build_object('choices',v_inspection->'choices','proposed_tmdb_id',v_inspection->'proposed_tmdb_id',
      'classification',v_inspection->'classification','proposed_vj_id',v_inspection->'proposed_vj_id') end);
end;
$$;
revoke all on function public.admin_upload_get(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_get(uuid) to authenticated;
