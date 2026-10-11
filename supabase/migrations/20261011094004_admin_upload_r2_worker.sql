alter table private.admin_upload_sessions add column rights_expires_at timestamptz;
alter table private.admin_upload_sessions add column rights_rejected_at timestamptz;
alter table private.admin_upload_r2 add column next_attempt_at timestamptz not null default now();

create function private.admin_upload_r2_eligible(p_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from private.admin_upload_sessions s where s.id=p_id
    and s.metadata->>'kind'='movie' and s.verified_sha256 is not null and s.bytes_received=s.size_bytes
    and s.inspection->'classification'->>'class'='canonical' and s.inspection->'classification'->>'policyVersion'='2'
    and s.inspection->>'decoded'='true'
    and s.rights_revision=s.revision and s.rights_sha256=s.verified_sha256 and s.rights_expires_at>now()
    and s.approved_revision=s.revision and private.reviewer_has(s.rights_by,'rights')
    and private.reviewer_has(s.approved_by,'review') and private.reviewer_has(s.publish_by,'publish')
    and private.reviewer_has(s.owner_id,'review')
    and exists(select 1 from auth.users u where u.id=s.owner_id and u.raw_app_meta_data->>'role'='admin')
    and exists(select 1 from public.vjs v where v.id=(s.metadata->>'vjId')::bigint and v.is_active)
    and s.metadata->'snapshot'->>'tmdb_id'=s.inspection->>'proposed_tmdb_id'
    and exists(select 1 from jsonb_array_elements(s.inspection->'choices') c where c=s.metadata->'snapshot'))
$$;
revoke all on function private.admin_upload_r2_eligible(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;

create function public.admin_upload_r2_review(p_id uuid,p_revision integer,p_action text,p_reference text default null,p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.require_upload_admin(); s private.admin_upload_sessions%rowtype;
begin
  select * into s from private.admin_upload_sessions where id=p_id and owner_id=v_uid for update;
  if not found or not exists(select 1 from private.admin_upload_r2 r where r.upload_id=p_id) then raise exception 'upload_not_found' using errcode='P0001'; end if;
  if p_revision is distinct from s.revision then raise exception 'upload_stale_revision' using errcode='P0001'; end if;
  if p_action='revoke_rights' then
    perform private.require_reviewer('rights');
    update private.admin_upload_sessions set rights_expires_at=now() where id=p_id;
  else
    if s.lease_token is not null then raise exception 'upload_worker_busy' using errcode='P0001'; end if;
    if p_action='submit' and s.stage='metadata_review' then
      if s.metadata->>'kind'<>'movie' or s.inspection->'classification'->>'class' is distinct from 'canonical'
        or s.inspection->'classification'->>'policyVersion' is distinct from '2' or s.inspection->>'decoded' is distinct from 'true' or s.verified_sha256 is null
        or s.metadata->'snapshot'->>'tmdb_id' is null or s.metadata->'snapshot'->>'tmdb_id' is distinct from s.inspection->>'proposed_tmdb_id'
        or not exists(select 1 from jsonb_array_elements(s.inspection->'choices') c where c=s.metadata->'snapshot')
        or not exists(select 1 from public.vjs v where v.id=(s.metadata->>'vjId')::bigint and v.is_active)
        or char_length(btrim(s.metadata->>'provenance'))=0
        or coalesce(nullif(s.metadata->>'title',''),s.inspection->'parsed'->>'title') is distinct from s.inspection->'query'->>'title'
        or coalesce(s.metadata->>'year',s.inspection->'parsed'->>'year') is distinct from s.inspection->'query'->>'year'
        then raise exception 'upload_review_blocked' using errcode='P0001'; end if;
      if exists(select 1 from public.movie_versions mv join public.movies m on m.id=mv.movie_id
        where m.tmdb_id=(s.metadata->'snapshot'->>'tmdb_id')::integer and mv.vj_id=(s.metadata->>'vjId')::bigint) then raise exception 'catalogue_version_conflict' using errcode='P0001'; end if;
      update private.admin_upload_sessions set stage='awaiting_rights' where id=p_id;
    elsif p_action='reinspect' and s.stage='metadata_review' then
      update private.admin_upload_sessions set stage='uploaded',inspection=null where id=p_id;
    elsif p_action='reject_rights' and s.stage in ('awaiting_rights','awaiting_approval') then
      perform private.require_reviewer('rights');
      update private.admin_upload_sessions set stage='cancelled',rights_rejected_at=now(),rights_revision=null,rights_sha256=null,rights_reference=null,rights_by=null,rights_at=null,rights_expires_at=null,approved_revision=null,approved_by=null,approved_at=null,publish_by=null where id=p_id;
    elsif p_action='clear_rights' and (s.stage in ('awaiting_rights','awaiting_approval','telegram_stored','published') or (s.stage='failed' and s.resume_stage='telegram_stored' and exists(select 1 from private.ingestion_events x where x.id=s.ingestion_event_id and x.upload_state='uploaded' and x.telegram_media_id is not null))) then
      perform private.require_reviewer('rights');
      if p_reference is null or char_length(p_reference) not between 1 and 200 or p_reference<>btrim(p_reference)
        or p_reference !~ '^[A-Za-z0-9 _.:/-]+$' or position('://' in p_reference)>0
        or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '1 year' then raise exception 'upload_rights_invalid' using errcode='22023'; end if;
      update private.admin_upload_sessions set stage=case when s.stage='failed' then 'telegram_stored' when s.stage in ('telegram_stored','published') then s.stage else 'awaiting_approval' end,rights_revision=revision,rights_sha256=verified_sha256,
        rights_reference=p_reference,rights_by=v_uid,rights_at=now(),rights_expires_at=p_expires_at where id=p_id;
      update private.admin_upload_r2 set next_attempt_at=now() where upload_id=p_id;
    elsif p_action='approve' and s.stage='awaiting_approval' then
      perform private.require_reviewer('publish');
      if s.rights_revision is distinct from s.revision or s.rights_sha256 is distinct from s.verified_sha256 or s.rights_expires_at is null or s.rights_expires_at<=now() or not private.reviewer_has(s.rights_by,'rights') then raise exception 'upload_rights_required' using errcode='P0001'; end if;
      update private.admin_upload_sessions set stage='approved',approved_revision=revision,approved_by=v_uid,approved_at=now(),publish_by=v_uid,error_code=null,retryable=false where id=p_id;
      update private.admin_upload_r2 set next_attempt_at=now() where upload_id=p_id;
    elsif p_action='retry' and s.stage='failed' and s.retryable then
      if s.resume_stage not in ('verifying','uploaded','approved','telegram_stored') or (s.resume_stage in ('approved','telegram_stored') and not private.admin_upload_r2_eligible(p_id)) then raise exception 'upload_retry_blocked' using errcode='P0001'; end if;
      update private.admin_upload_sessions set stage=resume_stage,error_code=null,retryable=false where id=p_id;
      update private.admin_upload_r2 set next_attempt_at=now() where upload_id=p_id;
    else raise exception 'upload_illegal_transition' using errcode='P0001'; end if;
  end if;
  insert into private.admin_upload_audit(upload_id,revision,actor,action) values(p_id,s.revision,v_uid,'r2_'||p_action);
  return private.admin_upload_view(p_id);
end;
$$;
revoke all on function public.admin_upload_r2_review(uuid,integer,text,text,timestamptz) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_r2_review(uuid,integer,text,text,timestamptz) to authenticated;

create function public.admin_upload_r2_worker_claim(p_token uuid,p_operations text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.admin_upload_sessions%rowtype; r private.admin_upload_r2%rowtype; v_operation text; v_attempt integer;
begin
  if p_token is null or p_operations is null or cardinality(p_operations)>6 or not p_operations<@array['verify','inspect','telegram','recover','publish','cleanup'] then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  select x.* into s from private.admin_upload_sessions x join private.admin_upload_r2 y on y.upload_id=x.id
  where (x.lease_until is null or x.lease_until<=now()) and y.next_attempt_at<=now() and (
    (x.stage in ('verifying','uploaded','inspecting') and private.reviewer_has(x.owner_id,'review') and exists(select 1 from auth.users u where u.id=x.owner_id and u.raw_app_meta_data->>'role'='admin') and case when x.stage='verifying' then 'verify' else 'inspect' end=any(p_operations))
    or (x.stage='approved' and private.admin_upload_r2_eligible(x.id) and 'telegram'=any(p_operations))
    or ((x.stage in ('telegram_uploading','telegram_uncertain') or (x.stage='failed' and exists(select 1 from private.ingestion_events e where e.origin='uploader' and e.source_fingerprint=x.source_fingerprint and e.upload_state in ('uploading','uncertain','uploaded')))) and 'recover'=any(p_operations))
    or (x.stage in ('telegram_stored','publishing') and private.admin_upload_r2_eligible(x.id) and 'publish'=any(p_operations))
    or (x.stage='failed' and x.retryable and
      (case x.resume_stage when 'verifying' then 'verify' when 'uploaded' then 'inspect' when 'approved' then 'telegram' when 'telegram_stored' then 'publish' end)=any(p_operations)
      and (x.resume_stage in ('verifying','uploaded') or private.admin_upload_r2_eligible(x.id))
      and not exists(select 1 from private.ingestion_events e where e.origin='uploader' and e.source_fingerprint=x.source_fingerprint and e.upload_state in ('uploading','uncertain','uploaded')))
    or (y.state<>'cleaned' and y.cleanup_after<=now() and (y.init_until is null or y.init_until<now()-interval '5 minutes') and 'cleanup'=any(p_operations) and (
      (x.stage in ('telegram_stored','published') and exists(select 1 from private.ingestion_events e where e.id=x.ingestion_event_id and e.upload_state='uploaded' and e.telegram_media_id is not null)) or x.stage='cancelled'
      or (x.expires_at<=now() and x.stage in ('draft','uploading') and y.state in ('pending','open') and x.ingestion_event_id is null
        and not exists(select 1 from private.ingestion_events e where e.origin='uploader' and e.source_fingerprint=x.source_fingerprint and e.upload_state in ('uploading','uncertain','uploaded'))))))
  order by x.created_at for update of x skip locked limit 1;
  if not found then return null; end if;
  select * into r from private.admin_upload_r2 where upload_id=s.id for update;
  if s.stage='failed' and s.retryable and not exists(select 1 from private.ingestion_events e where e.origin='uploader' and e.source_fingerprint=s.source_fingerprint and e.upload_state in ('uploading','uncertain','uploaded')) then
    update private.admin_upload_sessions set stage=resume_stage where id=s.id returning * into s;
  end if;
  v_operation:=case when s.stage='verifying' then 'verify' when s.stage in ('uploaded','inspecting') then 'inspect'
    when s.stage='approved' then 'telegram' when s.stage in ('telegram_uploading','telegram_uncertain','failed') and 'recover'=any(p_operations) then 'recover'
    when s.stage in ('telegram_stored','publishing') and 'publish'=any(p_operations) and private.admin_upload_r2_eligible(s.id) then 'publish' else 'cleanup' end;
  -- A cleanup-only claim can target transferred or expired inspection states.
  if not v_operation=any(p_operations) then v_operation:='cleanup'; end if;
  if s.stage='cancelled' or (s.expires_at<=now() and s.stage in ('draft','uploading') and r.state in ('pending','open')) then v_operation:='cleanup'; end if;
  if v_operation='cleanup' then
    if s.stage not in ('telegram_stored','published','cancelled') then
      update private.admin_upload_sessions set stage='cancelled',rights_revision=null,rights_sha256=null,rights_reference=null,rights_by=null,rights_at=null,approved_revision=null,approved_by=null,approved_at=null,publish_by=null where id=s.id;
    end if;
    update private.admin_upload_r2 set cleanup_attempts=cleanup_attempts+1 where upload_id=s.id;
  else
    update private.admin_upload_attempts set outcome='failed',error_code='upload_lease_expired',finished_at=now() where upload_id=s.id and operation=case when v_operation='recover' then 'telegram' else v_operation end and outcome in ('pending','uncertain');
    select coalesce(max(attempt),0)+1 into v_attempt from private.admin_upload_attempts where upload_id=s.id and operation=case when v_operation='recover' then 'telegram' else v_operation end;
    if v_attempt>5 and v_operation in ('verify','inspect','telegram') then
      update private.admin_upload_sessions set stage='failed',error_code='upload_attempts_exhausted',retryable=false,lease_token=null,lease_until=null where id=s.id; return null;
    end if;
    insert into private.admin_upload_attempts(upload_id,attempt,operation,lease_token) values(s.id,v_attempt,case when v_operation='recover' then 'telegram' else v_operation end,p_token);
  end if;
  update private.admin_upload_sessions set lease_token=p_token,lease_until=now()+case when v_operation in ('telegram','recover') then interval '6 hours' else interval '3 hours' end,
    stage=case when v_operation='telegram' then 'telegram_uploading' when v_operation='recover' then 'telegram_uncertain' when v_operation='inspect' then 'inspecting' when v_operation='publish' then 'publishing' else stage end where id=s.id;
  return private.admin_upload_r2_view(s.id)||jsonb_build_object('token',p_token,'operation',v_operation,'file_key',s.verified_file_key,'fingerprint',s.source_fingerprint,'inspection',s.inspection,
    'vjs',case when v_operation='inspect' then public.discovery_vjs() else '[]'::jsonb end);
end;
$$;

-- Narrow bridge to the existing upload/recovery commands. No broad grants,
-- arbitrary SQL, arbitrary source, channel consumer or reviewer enrollment.
create function public.admin_upload_r2_worker_ingest(p_id uuid,p_token uuid,p_function text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.admin_upload_sessions%rowtype; v_result jsonb; v_scalar text;
begin
  select * into s from private.admin_upload_sessions where id=p_id for update;
  if not found or s.lease_token is distinct from p_token or p_token is null or s.lease_until<=now() or s.stage not in ('telegram_uploading','telegram_uncertain')
    or p_args is null or jsonb_typeof(p_args)<>'object' or pg_column_size(p_args)>16384 then raise exception 'upload_lease_lost' using errcode='P0001'; end if;
  if p_function<>'ingest_channel_checkpoint' and p_args->>'p_source_fingerprint' is distinct from s.source_fingerprint then raise exception 'ingest_identity_mismatch' using errcode='P0001'; end if;
  if p_args->>'p_bot_type' is distinct from s.metadata->>'kind' then raise exception 'ingest_identity_mismatch' using errcode='P0001'; end if;
  if s.ingestion_event_id is null and exists(select 1 from private.ingestion_events e where e.origin='uploader' and e.source_fingerprint=s.source_fingerprint) then raise exception 'upload_duplicate_file' using errcode='P0001'; end if;
  if p_function='ingest_upload_status' then
    select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into v_result from public.ingest_upload_status(s.source_fingerprint,s.metadata->>'kind') x; return v_result;
  elsif p_function='ingest_upload_start' then
    if not private.admin_upload_r2_eligible(p_id) then raise exception 'upload_approval_required' using errcode='42501'; end if;
    select jsonb_agg(to_jsonb(x)) into v_result from public.ingest_upload_start(s.source_fingerprint,s.metadata->>'kind',(p_args->>'p_chat_id')::bigint,s.size_bytes) x;
    update private.admin_upload_sessions set ingestion_event_id=(select id from private.ingestion_events where origin='uploader' and source_fingerprint=s.source_fingerprint) where id=p_id;
    return v_result;
  elsif p_function='ingest_upload_record' then
    if p_args->>'p_file_size_bytes' is null or (p_args->>'p_file_size_bytes')::bigint<>s.size_bytes then raise exception 'ingest_identity_mismatch' using errcode='P0001'; end if;
    v_scalar:=public.ingest_upload_record(s.source_fingerprint,s.metadata->>'kind',(p_args->>'p_chat_id')::bigint,(p_args->>'p_message_id')::bigint,
      p_args->>'p_file_id',p_args->>'p_file_unique_id',p_args->>'p_media_kind',p_args->>'p_file_name',p_args->>'p_mime_type',p_args->>'p_caption',
      (p_args->>'p_file_size_bytes')::bigint,(p_args->>'p_duration_seconds')::integer,(p_args->>'p_width')::integer,(p_args->>'p_height')::integer,(p_args->>'p_telegram_date')::timestamptz);
    return to_jsonb(v_scalar);
  elsif p_function='ingest_upload_fail' then return to_jsonb(public.ingest_upload_fail(s.source_fingerprint,s.metadata->>'kind',p_args->>'p_outcome',p_args->>'p_failure_code'));
  elsif p_function='ingest_channel_checkpoint' then return to_jsonb(public.ingest_channel_checkpoint(s.metadata->>'kind',(p_args->>'p_chat_id')::bigint,(p_args->>'p_message_id')::bigint));
  else raise exception 'upload_invalid_input' using errcode='22023'; end if;
end;
$$;

create function public.admin_upload_r2_worker_finish(p_id uuid,p_token uuid,p_operation text,p_result jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare s private.admin_upload_sessions%rowtype; r private.admin_upload_r2%rowtype; e private.ingestion_events%rowtype;
  v_stage text; v_code text; v_retry boolean; v_publication record; v_parsed jsonb;
begin
  select * into s from private.admin_upload_sessions where id=p_id for update;
  if not found or s.lease_token is distinct from p_token or p_token is null or s.lease_until<=now() then raise exception 'upload_lease_lost' using errcode='P0001'; end if;
  select * into r from private.admin_upload_r2 where upload_id=p_id for update;
  if not found or p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>262144 then raise exception 'upload_invalid_result' using errcode='22023'; end if;
  if p_operation not in ('verify','inspect','telegram','recover','publish','cleanup') then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  if p_operation<>'cleanup' and not exists(select 1 from private.admin_upload_attempts a where a.upload_id=p_id and a.lease_token=p_token and a.outcome='pending' and a.operation=case when p_operation='recover' then 'telegram' else p_operation end) then raise exception 'upload_lease_lost' using errcode='P0001'; end if;
  if p_result->>'outcome'='failed' then
    v_code:=p_result->>'code';
    if v_code is null or v_code !~ '^[a-z][a-z0-9_]{2,80}$' then raise exception 'upload_invalid_result' using errcode='22023'; end if;
    v_retry:=v_code in ('r2_storage_unavailable','upload_disk_full','upload_media_tools_missing','probe_timeout','inspection_provider_failed','unexpected_error','server_unavailable','store_error','store_unavailable','telegram_rate_limited','server_refused_start','upload_local_recovery_wait') or coalesce(p_operation in ('telegram','recover') and p_result->>'retryable'='true',false);
    if p_operation='cleanup' then
      update private.admin_upload_r2 set cleanup_error=v_code,cleanup_after=now()+make_interval(secs=>least(86400,60*power(2,least(cleanup_attempts,10)))::integer) where upload_id=p_id;
      v_stage:=s.stage;
    else
      if p_operation in ('telegram','recover') and exists(select 1 from private.ingestion_events x where x.origin='uploader' and x.source_fingerprint=s.source_fingerprint and x.upload_state in ('uploading','uncertain')) then v_stage:='telegram_uncertain';
      else v_stage:='failed'; end if;
      update private.admin_upload_sessions set stage=v_stage,error_code=v_code,retryable=v_retry,
        resume_stage=case p_operation when 'verify' then 'verifying' when 'inspect' then 'uploaded' when 'publish' then 'telegram_stored' else 'approved' end where id=p_id;
      update private.admin_upload_attempts set outcome=case when v_stage='telegram_uncertain' then 'uncertain' else 'failed' end,error_code=v_code,finished_at=now() where lease_token=p_token;
      update private.admin_upload_r2 set next_attempt_at=now()+make_interval(secs=>least(3600,60*power(2,least((select count(*) from private.admin_upload_attempts where upload_id=p_id and operation=case when p_operation='recover' then 'telegram' else p_operation end),6)))::integer) where upload_id=p_id;
    end if;
  elsif p_operation='verify' and s.stage='verifying' and p_result->>'outcome'='verified' then
    if r.state<>'complete' or s.bytes_received<>s.size_bytes or p_result->>'sha256' is null or p_result->>'sha256' !~ '^[a-f0-9]{64}$'
      or p_result->>'fingerprint' is null or p_result->>'fingerprint' !~ '^sf1-[a-f0-9]{64}$' or p_result->>'file_key' is null
      or (p_result->>'size')::bigint is distinct from s.size_bytes then raise exception 'upload_invalid_result' using errcode='22023'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_result->>'sha256',716240012));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_result->>'fingerprint',716240014));
    if exists(select 1 from private.admin_upload_sessions x where x.id<>p_id and (x.verified_sha256=p_result->>'sha256' or x.source_fingerprint=p_result->>'fingerprint') and x.stage<>'cancelled')
      or exists(select 1 from private.ingestion_events existing_event where existing_event.origin='uploader' and existing_event.source_fingerprint=p_result->>'fingerprint') then raise exception 'upload_duplicate_file' using errcode='P0001'; end if;
    update private.admin_upload_sessions set stage='uploaded',verified_sha256=p_result->>'sha256',source_fingerprint=p_result->>'fingerprint',verified_file_key=(p_result->>'file_key')::uuid where id=p_id;
    v_stage:='uploaded';
  elsif p_operation='inspect' and s.stage='inspecting' and p_result->>'outcome'='inspected' then
    if jsonb_typeof(p_result->'inspection') is distinct from 'object' or jsonb_typeof(p_result->'inspection'->'choices') is distinct from 'array'
      or jsonb_array_length(p_result->'inspection'->'choices')>20 or jsonb_typeof(p_result->'inspection'->'evaluation'->'p_candidates') is distinct from 'array'
      or p_result->'inspection'->'classification'->>'class' is null then raise exception 'upload_invalid_result' using errcode='22023'; end if;
    update private.admin_upload_sessions set stage='metadata_review',inspection=p_result->'inspection' where id=p_id;
    v_stage:='metadata_review';
  elsif p_operation in ('telegram','recover') and s.stage in ('telegram_uploading','telegram_uncertain') and p_result->>'outcome'='stored' then
    select * into e from private.ingestion_events where origin='uploader' and source_fingerprint=s.source_fingerprint and upload_state='uploaded' and telegram_media_id is not null;
    if not found or e.source_size_bytes<>s.size_bytes then raise exception 'upload_storage_not_persisted' using errcode='P0001'; end if;
    update private.admin_upload_sessions set stage='telegram_stored',ingestion_event_id=e.id where id=p_id;
    v_stage:='telegram_stored';
  elsif p_operation='publish' and s.stage='publishing' and p_result->>'outcome'='publish' then
    if not private.admin_upload_r2_eligible(p_id) then raise exception 'upload_approval_required' using errcode='42501'; end if;
    v_parsed:=s.inspection->'evaluation'->'p_parsed'||jsonb_build_object('vj_status','resolved','vj_id',(s.metadata->>'vjId')::bigint,'kind','movie','kind_status','confirmed');
    perform public.ingest_record_evaluation(s.source_fingerprint,'movie',v_parsed,s.inspection->'evaluation'->'p_candidates');
    perform private.catalogue_approve_movie_match(s.source_fingerprint,(s.metadata->'snapshot'->>'tmdb_id')::integer);
    select * into v_publication from private.catalogue_publish_movie(s.source_fingerprint,s.metadata->'snapshot',true);
    if v_publication.result not in ('published','already_published') or not exists(select 1 from private.ingestion_events x join public.movie_versions mv on mv.telegram_media_id=x.telegram_media_id where x.id=s.ingestion_event_id and x.status='published' and mv.id=v_publication.version_id and mv.rights_status='cleared' and mv.availability_status='ready') then raise exception 'upload_publication_not_persisted' using errcode='P0001'; end if;
    update private.admin_upload_sessions set stage='published' where id=p_id;
    v_stage:='published';
  elsif p_operation='cleanup' and p_result->>'outcome'='cleaned' then
    if s.stage in ('telegram_stored','published') then
      if not exists(select 1 from private.ingestion_events x where x.id=s.ingestion_event_id and x.upload_state='uploaded' and x.telegram_media_id is not null) then raise exception 'upload_cleanup_blocked' using errcode='P0001'; end if;
    elsif s.stage<>'cancelled' then raise exception 'upload_cleanup_blocked' using errcode='P0001'; end if;
    update private.admin_upload_r2 set state='cleaned',cleaned_at=now(),cleanup_error=null where upload_id=p_id;
    update private.admin_upload_sessions set staging_cleaned_at=now() where id=p_id;
    v_stage:=s.stage;
  else raise exception 'upload_invalid_result' using errcode='22023'; end if;
  if p_operation<>'cleanup' and p_result->>'outcome'<>'failed' then
    update private.admin_upload_attempts set outcome='succeeded',finished_at=now() where lease_token=p_token;
    update private.admin_upload_sessions set error_code=null,retryable=false where id=p_id;
  end if;
  update private.admin_upload_sessions set lease_token=null,lease_until=null where id=p_id;
  insert into private.admin_upload_audit(upload_id,revision,action) values(p_id,s.revision,'r2_'||p_operation||'_'||case when p_result->>'outcome'='failed' then 'failed' else 'completed' end);
  return v_stage;
end;
$$;
revoke all on function public.admin_upload_r2_worker_claim(uuid,text[]),public.admin_upload_r2_worker_ingest(uuid,uuid,text,jsonb),public.admin_upload_r2_worker_finish(uuid,uuid,text,jsonb)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_r2_worker_claim(uuid,text[]),public.admin_upload_r2_worker_ingest(uuid,uuid,text,jsonb),public.admin_upload_r2_worker_finish(uuid,uuid,text,jsonb) to velora_upload_worker;

-- Keep the original disk worker isolated from R2 sessions.
create or replace function public.admin_upload_worker_claim(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session private.admin_upload_sessions%rowtype; v_operation text; v_attempt integer;
begin
  if p_token is null then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  select s.* into v_session from private.admin_upload_sessions s
  where not exists(select 1 from private.admin_upload_r2 r where r.upload_id=s.id) and s.stage in ('verifying','uploaded','inspecting') and s.expires_at>now()
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
revoke all on function public.admin_upload_worker_claim(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_worker_claim(uuid) to velora_upload_worker;

create or replace function public.admin_upload_control(p_id uuid, p_revision integer, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin(); v_session private.admin_upload_sessions%rowtype; v_stage text;
begin
  select * into v_session from private.admin_upload_sessions where id = p_id and owner_id = v_uid for update;
  if not found then raise exception 'upload_not_found' using errcode = 'P0001'; end if;
  if p_revision is distinct from v_session.revision then raise exception 'upload_stale_revision' using errcode = 'P0001'; end if;
  if v_session.lease_token is not null then raise exception 'upload_worker_busy' using errcode = 'P0001'; end if;
  if p_action='cancel' and exists(select 1 from private.admin_upload_r2 r join private.ingestion_events e on e.source_fingerprint=v_session.source_fingerprint and e.origin='uploader' where r.upload_id=p_id and e.upload_state in ('uploading','uncertain','uploaded')) then raise exception 'upload_reconciliation_required' using errcode='P0001'; end if;
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
revoke all on function public.admin_upload_control(uuid,integer,text) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_control(uuid,integer,text) to authenticated;
