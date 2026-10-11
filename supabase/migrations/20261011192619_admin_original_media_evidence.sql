-- Depends on original_media_evidence and all six pending admin migrations.
-- No media transfer, publication or deployment is performed by this migration.
begin;
do $$ begin
  if to_regprocedure('private.original_media_assessment_valid(jsonb)') is null
    or to_regprocedure('public.admin_upload_r2_housekeeping(text,jsonb)') is null then
    raise exception 'admin_original_media_requires_r2_visibility_and_original_evidence';
  end if;
end $$;

-- Session.inspection remains the compatible current view. Every new completion,
-- including failures, gets a separate immutable snapshot; older attempts stay.
create table private.admin_upload_media_evidence (
  id bigint generated always as identity primary key,
  upload_id uuid not null references private.admin_upload_sessions(id),
  lease_token uuid not null,
  verified_sha256 text check(verified_sha256 ~ '^[a-f0-9]{64}$'),
  file_key uuid,
  size_bytes bigint not null check(size_bytes between 1 and 2000000000),
  inspection jsonb check(inspection is null or (jsonb_typeof(inspection)='object' and octet_length(inspection::text)<=262144)),
  policy_version integer check(policy_version between 1 and 1000),
  assessment jsonb check(assessment is null or private.original_media_assessment_valid(assessment)),
  container text check(container is null or container in ('mp4','mkv')),
  video_codec text check(video_codec is null or video_codec ~ '^[a-zA-Z0-9_]{1,40}$'),
  audio_codec text check(audio_codec is null or audio_codec ~ '^[a-zA-Z0-9_]{1,40}$'),
  integrity_status text generated always as (case when error_code is not null then 'incomplete' else coalesce(assessment->>'integrity','legacy_unassessed') end) stored,
  streaming_status text generated always as (case when error_code is not null then 'unverified' else coalesce(assessment->>'streaming','legacy_unassessed') end) stored,
  browser_profile jsonb generated always as (assessment->'compatibility') stored,
  download_status text not null default 'not_implemented_authorization_required' check(download_status='not_implemented_authorization_required'),
  tracks jsonb generated always as (assessment->'tracks') stored,
  failure_reasons jsonb generated always as (assessment->'reasons') stored,
  warnings jsonb generated always as (assessment->'warnings') stored,
  error_code text check(error_code ~ '^[a-z][a-z0-9_]{2,80}$'),
  checked_at timestamptz not null default now(),
  unique(upload_id,lease_token),
  constraint admin_upload_media_result check((inspection is null)=(error_code is not null)),
  constraint admin_upload_media_policy check(
    (policy_version is distinct from 3 and assessment is null) or
    (policy_version=3 and assessment is not null and assessment=inspection->'assessment'
      and container is not distinct from assessment->>'container'))
);
create index admin_upload_media_evidence_upload_idx on private.admin_upload_media_evidence(upload_id,id desc);
create trigger admin_upload_media_evidence_append_only before update or delete on private.admin_upload_media_evidence
  for each row execute function private.guard_append_only();
alter table private.admin_upload_media_evidence enable row level security;
revoke all on table private.admin_upload_media_evidence from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
revoke all on sequence private.admin_upload_media_evidence_id_seq from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
alter table private.admin_upload_sessions add column media_evidence_id bigint references private.admin_upload_media_evidence(id);
revoke all on table private.admin_upload_sessions from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;

create function private.admin_upload_record_inspection(p_id uuid,p_token uuid,p_inspection jsonb,p_error text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare s private.admin_upload_sessions%rowtype; a jsonb; v_id bigint; v_policy integer;
begin
  select * into s from private.admin_upload_sessions where id=p_id;
  if s.id is null or p_token is null or s.lease_token is distinct from p_token or s.lease_until<=now()
    or s.stage<>'inspecting' then raise exception 'upload_lease_lost' using errcode='P0001'; end if;
  v_policy:=(p_inspection->'classification'->>'policyVersion')::integer;
  a:=p_inspection->'assessment';
  if v_policy=3 then
    if s.metadata->>'kind' is distinct from 'movie' or not private.original_media_assessment_valid(a)
      or p_inspection->'classification'->>'class' is distinct from
        (case when a->>'accepted'='true' then 'original' else 'manual_review' end)
      or p_inspection->'classification'->'reasons' is distinct from a->'reasons'
      or (a->>'accepted'='true' and lower(s.file_name) not like '%.'||(a->>'container'))
      then raise exception 'upload_invalid_result' using errcode='22023'; end if;
  elsif p_inspection ? 'assessment' and jsonb_typeof(a)<>'null' then
    raise exception 'upload_invalid_result' using errcode='22023';
  end if;
  insert into private.admin_upload_media_evidence(upload_id,lease_token,verified_sha256,file_key,size_bytes,
    inspection,policy_version,assessment,container,video_codec,audio_codec,error_code)
  values(p_id,p_token,s.verified_sha256,s.verified_file_key,s.size_bytes,p_inspection,v_policy,
    case when v_policy=3 then a end,case when v_policy=3 then a->>'container' end,
    (select t->>'codec' from jsonb_array_elements(case when v_policy=3 then a->'tracks' else '[]'::jsonb end) t
      where t->>'type'='video' and t->>'attachedPicture'='false' order by (t->>'index')::integer limit 1),
    (select t->>'codec' from jsonb_array_elements(case when v_policy=3 then a->'tracks' else '[]'::jsonb end) t
      where t->>'type'='audio' order by (t->>'index')::integer limit 1),p_error) returning id into v_id;
  update private.admin_upload_sessions set media_evidence_id=v_id where id=p_id;
end $$;
revoke all on function private.admin_upload_record_inspection(uuid,uuid,jsonb,text) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;

create function private.admin_upload_media_publishable(p_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(case when s.inspection->'classification'->>'policyVersion'='2' then
    s.inspection->'classification'->>'class'='canonical' and s.inspection->>'decoded'='true' and s.verified_sha256 is not null
  when s.inspection->'classification'->>'policyVersion'='3' then exists(
    select 1 from private.admin_upload_media_evidence ev where ev.id=s.media_evidence_id and ev.upload_id=s.id
      and ev.policy_version=3 and ev.verified_sha256=s.verified_sha256 and ev.file_key=s.verified_file_key
      and ev.size_bytes=s.size_bytes and ev.inspection=s.inspection and ev.error_code is null
      and ev.integrity_status='verified' and ev.streaming_status='verified' and ev.container in ('mp4','mkv'))
  else false end,false) from private.admin_upload_sessions s where s.id=p_id
$$;
revoke all on function private.admin_upload_media_publishable(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;

create or replace function public.admin_upload_create(p_file_name text, p_size_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_upload_admin(); v_id uuid;
begin
  if p_file_name is null or char_length(p_file_name) not between 1 and 255
    or p_file_name <> btrim(p_file_name) or p_file_name ~ '[\\/[:cntrl:]]'
    or lower(p_file_name) !~ '\.(mp4|mkv)$'
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

create or replace function public.admin_upload_worker_finish(p_id uuid,p_token uuid,p_result jsonb)
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
    if v_operation='inspect' and v_session.stage='inspecting' then
      perform private.admin_upload_record_inspection(p_id,p_token,null,v_error);
    end if;
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
    perform private.admin_upload_record_inspection(p_id,p_token,p_result->'inspection');
    update private.admin_upload_sessions set stage='metadata_review',inspection=p_result->'inspection',lease_token=null,lease_until=null,error_code=null where id=p_id;
  else raise exception 'upload_invalid_result' using errcode='22023'; end if;
  update private.admin_upload_attempts set outcome='succeeded',finished_at=now() where lease_token=p_token;
  insert into private.admin_upload_audit(upload_id,revision,action) values(p_id,v_session.revision,v_operation||'_completed');
  return (select stage from private.admin_upload_sessions where id=p_id);
end;
$$;

create or replace function public.admin_upload_r2_worker_finish(p_id uuid,p_token uuid,p_operation text,p_result jsonb)
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
    if p_operation='inspect' and s.stage='inspecting' then
      perform private.admin_upload_record_inspection(p_id,p_token,null,v_code);
    end if;
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
    perform private.admin_upload_record_inspection(p_id,p_token,p_result->'inspection');
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

create or replace function private.admin_upload_r2_eligible(p_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from private.admin_upload_sessions s where s.id=p_id
    and s.metadata->>'kind'='movie' and s.verified_sha256 is not null and s.bytes_received=s.size_bytes
    and private.admin_upload_media_publishable(s.id)
    and s.rights_revision=s.revision and s.rights_sha256=s.verified_sha256 and s.rights_expires_at>now()
    and s.approved_revision=s.revision and private.reviewer_has(s.rights_by,'rights')
    and private.reviewer_has(s.approved_by,'review') and private.reviewer_has(s.publish_by,'publish')
    and private.reviewer_has(s.owner_id,'review')
    and exists(select 1 from auth.users u where u.id=s.owner_id and u.raw_app_meta_data->>'role'='admin')
    and exists(select 1 from public.vjs v where v.id=(s.metadata->>'vjId')::bigint and v.is_active)
    and s.metadata->'snapshot'->>'tmdb_id'=s.inspection->>'proposed_tmdb_id'
    and exists(select 1 from jsonb_array_elements(s.inspection->'choices') c where c=s.metadata->'snapshot'))
$$;

create or replace function public.admin_upload_r2_review(p_id uuid,p_revision integer,p_action text,p_reference text default null,p_expires_at timestamptz default null)
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
      if s.metadata->>'kind'<>'movie' or not private.admin_upload_media_publishable(p_id) or s.verified_sha256 is null
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

create or replace function public.admin_upload_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_upload_admin(); s private.admin_upload_sessions%rowtype; r private.admin_upload_r2%rowtype;
begin
  select * into s from private.admin_upload_sessions where id=p_id and owner_id=v_uid;
  if not found then raise exception 'upload_not_found' using errcode='P0001'; end if;
  select * into r from private.admin_upload_r2 where upload_id=p_id;
  return private.admin_upload_view(p_id)||jsonb_build_object('inspection',case when s.inspection is null then null else
    jsonb_build_object('choices',s.inspection->'choices','proposed_tmdb_id',s.inspection->'proposed_tmdb_id',
      'classification',s.inspection->'classification','proposed_vj_id',s.inspection->'proposed_vj_id','assessment',s.inspection->'assessment') end,
    'pipeline',jsonb_build_object('media_verified',coalesce(private.admin_upload_media_publishable(p_id),false),
      'telegram_status',coalesce((select upload_state from private.ingestion_events where id=s.ingestion_event_id),'pending'),
      'rights_rejected',s.rights_rejected_at is not null,'rights_cleared',coalesce(s.rights_revision=s.revision and s.rights_sha256=s.verified_sha256 and s.rights_expires_at>now() and private.reviewer_has(s.rights_by,'rights'),false),
      'rights_expires_at',s.rights_expires_at,'rights_reference',s.rights_reference,'approved',private.admin_upload_r2_eligible(p_id),
      'cleanup_state',r.state,'cleanup_error',r.cleanup_error,'stored',exists(select 1 from private.ingestion_events e where e.id=s.ingestion_event_id and e.upload_state='uploaded' and e.telegram_media_id is not null),
      'publication_slug',(select m.slug from private.ingestion_events e join public.movie_versions mv on mv.telegram_media_id=e.telegram_media_id join public.movies m on m.id=mv.movie_id where e.id=s.ingestion_event_id and s.stage='published'),
      'audit',coalesce((select jsonb_agg(jsonb_build_object('action',a.action,'at',a.created_at,'revision',a.revision) order by a.id desc) from
        (select id,action,created_at,revision from private.admin_upload_audit where upload_id=p_id order by id desc limit 100) a),'[]'::jsonb)));
end;
$$;

revoke all on function public.admin_upload_create(text,bigint),public.admin_upload_get(uuid),
  public.admin_upload_r2_review(uuid,integer,text,text,timestamptz),public.admin_upload_worker_finish(uuid,uuid,jsonb),
  public.admin_upload_r2_worker_finish(uuid,uuid,text,jsonb),private.admin_upload_r2_eligible(uuid)
  from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.admin_upload_create(text,bigint),public.admin_upload_get(uuid),public.admin_upload_r2_review(uuid,integer,text,text,timestamptz) to authenticated;
grant execute on function public.admin_upload_worker_finish(uuid,uuid,jsonb),public.admin_upload_r2_worker_finish(uuid,uuid,text,jsonb) to velora_upload_worker;

-- Same public signature; the selected R2 version must itself have current
-- rights, even when another VJ version keeps the movie visible.
create or replace function public.movie_media_profile(p_version_id bigint)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('container',ev.container,'video_codec',ev.video_codec,'audio_codec',ev.audio_codec,
      'integrity_status',ev.integrity_status,'streaming_status',ev.streaming_status,
      'browser_profile',ev.browser_profile,'download_status',ev.download_status,
      'policy_version',ev.policy_version,'inspection_scope',ev.scope,'checked_at',ev.checked_at)
      from private.channel_current_evidence(mv.telegram_media_id) ev),
    (select jsonb_build_object('container',ev.container,'video_codec',ev.video_codec,'audio_codec',ev.audio_codec,
      'integrity_status',ev.integrity_status,'streaming_status',ev.streaming_status,
      'browser_profile',ev.browser_profile,'download_status',ev.download_status,
      'policy_version',ev.policy_version,'inspection_scope','local_file','checked_at',ev.checked_at)
      from private.admin_upload_sessions s join private.ingestion_events e on e.id=s.ingestion_event_id
      join private.admin_upload_media_evidence ev on ev.id=s.media_evidence_id and ev.upload_id=s.id
      where e.telegram_media_id=mv.telegram_media_id and ev.verified_sha256=s.verified_sha256))
  from public.movie_versions mv join public.movies m on m.id=mv.movie_id join public.vjs v on v.id=mv.vj_id
  where mv.id=p_version_id and m.publication_status='published' and m.published_at is not null
    and mv.availability_status='ready' and mv.rights_status='cleared' and v.is_active
    and catalogue_access.movie_is_public(m.id) and catalogue_access.admin_upload_rights_valid(mv.telegram_media_id)
$$;
revoke all on function public.movie_media_profile(bigint) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.movie_media_profile(bigint) to anon,authenticated;
commit;
