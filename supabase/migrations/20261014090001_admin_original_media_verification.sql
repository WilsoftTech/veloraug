-- Checkpoint 10, local preparation only. Depends on 20261014090000 (the
-- verification contract) and 20261011192619 (admin original media evidence),
-- and so on the six admin upload migrations. The upload worker may record a
-- whole-file verification of the staged original; it is accepted only when its
-- digest is the session's verified SHA-256 and its byte count the session's size.
-- No media transfer, publication or deployment is performed by this migration.
begin;
do $$ begin
  if to_regprocedure('private.original_media_verification_valid(jsonb)') is null
    or to_regprocedure('private.admin_upload_record_inspection(uuid,uuid,jsonb,text)') is null then
    raise exception 'admin_verification_requires_verification_contract_and_admin_evidence';
  end if;
end $$;

-- The recorded download evidence follows the assessment; it was a constant before.
alter table private.admin_upload_media_evidence drop constraint admin_upload_media_evidence_download_status_check;
alter table private.admin_upload_media_evidence add constraint admin_upload_media_evidence_download_status_check
  check (download_status in ('not_implemented_authorization_required','original_servable','not_servable'));
alter table private.admin_upload_media_evidence
  add column content_sha256 text generated always as (assessment->'verification'->'digest'->>'value') stored;
-- A verification is evidence about this session's verified file, or it is not stored.
alter table private.admin_upload_media_evidence add constraint admin_upload_media_verification check (
  assessment is null or (download_status = assessment->>'download' and (not assessment ? 'verification' or (
    assessment->'verification'->'digest'->>'value' = verified_sha256
    and (assessment->'verification'->'digest'->>'bytes')::bigint = size_bytes))));
revoke all on table private.admin_upload_media_evidence from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;

create or replace function private.admin_upload_record_inspection(p_id uuid,p_token uuid,p_inspection jsonb,p_error text default null)
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
      -- Stale or mismatched verification: another file's digest, or another size.
      or (a ? 'verification' and (s.verified_sha256 is null
        or a->'verification'->'digest'->>'value' is distinct from s.verified_sha256
        or (a->'verification'->'digest'->>'bytes')::bigint is distinct from s.size_bytes))
      then raise exception 'upload_invalid_result' using errcode='22023'; end if;
  elsif p_inspection ? 'assessment' and jsonb_typeof(a)<>'null' then
    raise exception 'upload_invalid_result' using errcode='22023';
  end if;
  insert into private.admin_upload_media_evidence(upload_id,lease_token,verified_sha256,file_key,size_bytes,
    inspection,policy_version,assessment,container,video_codec,audio_codec,download_status,error_code)
  values(p_id,p_token,s.verified_sha256,s.verified_file_key,s.size_bytes,p_inspection,v_policy,
    case when v_policy=3 then a end,case when v_policy=3 then a->>'container' end,
    (select t->>'codec' from jsonb_array_elements(case when v_policy=3 then a->'tracks' else '[]'::jsonb end) t
      where t->>'type'='video' and t->>'attachedPicture'='false' order by (t->>'index')::integer limit 1),
    (select t->>'codec' from jsonb_array_elements(case when v_policy=3 then a->'tracks' else '[]'::jsonb end) t
      where t->>'type'='audio' order by (t->>'index')::integer limit 1),
    coalesce(case when v_policy=3 then a->>'download' end,'not_implemented_authorization_required'),p_error) returning id into v_id;
  update private.admin_upload_sessions set media_evidence_id=v_id where id=p_id;
end $$;
revoke all on function private.admin_upload_record_inspection(uuid,uuid,jsonb,text) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;

-- The same predicate as before, with the digest stated: the verified row is about the session's file.
create or replace function private.admin_upload_media_publishable(p_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(case when s.inspection->'classification'->>'policyVersion'='2' then
    s.inspection->'classification'->>'class'='canonical' and s.inspection->>'decoded'='true' and s.verified_sha256 is not null
  when s.inspection->'classification'->>'policyVersion'='3' then exists(
    select 1 from private.admin_upload_media_evidence ev where ev.id=s.media_evidence_id and ev.upload_id=s.id
      and ev.policy_version=3 and ev.verified_sha256=s.verified_sha256 and ev.file_key=s.verified_file_key
      and ev.size_bytes=s.size_bytes and ev.inspection=s.inspection and ev.error_code is null
      and ev.integrity_status='verified' and ev.streaming_status='verified' and ev.container in ('mp4','mkv')
      and ev.content_sha256=s.verified_sha256)
  else false end,false) from private.admin_upload_sessions s where s.id=p_id
$$;
revoke all on function private.admin_upload_media_publishable(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
commit;
