-- Media-only verification for every recorded movie upload, including the
-- backlog, unpublished/unconfirmed channel posts, and published uploader files.
-- Independent leases never edit review identity, rights, approval or publication.
begin;

create table private.media_verification_jobs (
  telegram_media_id bigint primary key references private.telegram_media(id) on delete restrict,
  media_identity text not null check (media_identity ~ '^tg1-[0-9a-f]{64}$'),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null check (attempts between 1 and 5),
  attempted_at timestamptz not null,
  retry_at timestamptz not null,
  completed_at timestamptz,
  evidence_id bigint references private.media_evidence(id) on delete restrict,
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{2,99}$'),
  check ((lease_token is null) = (lease_until is null)),
  check (completed_at is null or (lease_token is null and evidence_id is not null))
);
alter table private.media_verification_jobs enable row level security;
revoke all on table private.media_verification_jobs from public,anon,authenticated,service_role,
  velora_discovery_worker,velora_review_service,velora_media_gateway;

create function public.media_verification_claim(p_token uuid,p_lease_seconds integer,p_retry_seconds integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m private.telegram_media%rowtype; j private.media_verification_jobs%rowtype; identity text;
begin
  if p_token is null or p_lease_seconds is null or p_lease_seconds not between 60 and 14400
    or p_retry_seconds is null or p_retry_seconds not between 60 and 604800 then
    raise exception 'media_verification_invalid_input' using errcode='22023';
  end if;
  -- Different workers cannot claim the same row. Polling never holds a lock while downloading.
  select t.* into m from private.telegram_media t
  left join private.media_verification_jobs q on q.telegram_media_id=t.id
  cross join lateral (select private.channel_media_identity(t.chat_id,t.message_id,t.file_unique_id,t.file_size_bytes) as value) i
  cross join lateral (select coalesce(max(a.created_at),'-infinity'::timestamptz) as at
    from private.channel_review_audit a join private.ingestion_events e on e.id=a.ingestion_event_id
    where e.telegram_media_id=t.id and a.action='reinspection_requested') requested
  where t.bot_type='movie' and t.file_size_bytes between 1 and 2097152000
    and lower(t.file_name) ~ '\.(mp4|mkv)$' and i.value is not null
    and exists(select 1 from private.telegram_channels c where c.bot_type='movie' and c.chat_id=t.chat_id)
    and (q.lease_until is null or q.lease_until<=now())
    and (q.telegram_media_id is null or q.media_identity<>i.value
      or (q.retry_at<=now() and (q.attempts<5 or q.attempted_at<requested.at)
        and (q.completed_at is null or q.completed_at<requested.at)))
    and not exists(select 1 from private.media_evidence ev where ev.telegram_media_id=t.id
      and ev.media_identity=i.value and ev.scope='whole_file' and ev.checked_at>requested.at)
    -- Do not compete with the existing named verifier or bounded inspection.
    and not exists(select 1 from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id=e.id
      where e.telegram_media_id=t.id and r.lease_until>now())
  order by t.created_at,t.id for update of t skip locked limit 1;
  if not found then return null; end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('velora_media_verification:'||m.id,0)) then return null; end if;
  -- Recheck after the shared transaction fence: a named claim may just have committed.
  if exists(select 1 from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id=e.id
    where e.telegram_media_id=m.id and r.lease_until>now()) then return null; end if;
  identity:=private.channel_media_identity(m.chat_id,m.message_id,m.file_unique_id,m.file_size_bytes);
  select * into j from private.media_verification_jobs where telegram_media_id=m.id for update;
  insert into private.media_verification_jobs(telegram_media_id,media_identity,lease_token,lease_until,attempts,attempted_at,retry_at)
    values(m.id,identity,p_token,now()+make_interval(secs=>p_lease_seconds),1,clock_timestamp(),now()+make_interval(secs=>p_retry_seconds))
  on conflict(telegram_media_id) do update set media_identity=excluded.media_identity,lease_token=excluded.lease_token,
    lease_until=excluded.lease_until,
    attempts=case when media_verification_jobs.media_identity<>excluded.media_identity
      or exists(select 1 from private.channel_review_audit a join private.ingestion_events e on e.id=a.ingestion_event_id
        where e.telegram_media_id=m.id and a.action='reinspection_requested' and a.created_at>media_verification_jobs.attempted_at)
      then 1 else media_verification_jobs.attempts+1 end,
    attempted_at=excluded.attempted_at,retry_at=excluded.retry_at,completed_at=null,evidence_id=null,error_code=null;
  return jsonb_build_object('media_id',m.id,'identity',identity,'lease',p_token,
    'chat_id',m.chat_id,'message_id',m.message_id,'file_unique_id',m.file_unique_id,
    'size',m.file_size_bytes,'name',m.file_name,'mime',m.mime_type);
end $$;

create function public.media_verification_finish(p_media_id bigint,p_token uuid,p_identity text,p_evidence jsonb,p_error text)
returns text language plpgsql security definer set search_path='' as $$
declare m private.telegram_media%rowtype; j private.media_verification_jobs%rowtype; ev_id bigint; a jsonb;
begin
  if p_media_id is null or p_token is null or p_identity is null or p_identity !~ '^tg1-[0-9a-f]{64}$'
    or (p_error is not null and p_error !~ '^[a-z][a-z0-9_]{2,99}$')
    or (p_evidence is null) = (p_error is null) then
    raise exception 'media_verification_invalid_input' using errcode='22023';
  end if;
  -- Match claim lock order; an edited document cannot receive the old file's result.
  select * into m from private.telegram_media where id=p_media_id for update;
  select * into j from private.media_verification_jobs where telegram_media_id=p_media_id for update;
  if m.id is null or j.lease_token is distinct from p_token or j.lease_until<=now()
    or j.media_identity is distinct from p_identity
    or p_identity is distinct from private.channel_media_identity(m.chat_id,m.message_id,m.file_unique_id,m.file_size_bytes) then
    return 'stale';
  end if;
  if p_error is not null then
    update private.media_verification_jobs set lease_token=null,lease_until=null,error_code=p_error where telegram_media_id=m.id;
    return 'retry';
  end if;
  a:=p_evidence->'assessment';
  if jsonb_typeof(p_evidence) is distinct from 'object'
    or octet_length(p_evidence::text)>135168
    or (select array_agg(k order by k) from jsonb_object_keys(p_evidence-'assessment'-'inspection_scope') k)
      is distinct from array['accessible','audio_codec','bytes_read','container','gateway_compatible','identity',
        'media_class','method','playback_ready','policy_version','reasons','video_codec']
    or p_evidence->>'identity' is distinct from p_identity or p_evidence->>'policy_version' is distinct from '3'
    or p_evidence->>'playback_ready' is distinct from 'false'
    or jsonb_typeof(p_evidence->'accessible') is distinct from 'boolean'
    or jsonb_typeof(p_evidence->'gateway_compatible') is distinct from 'boolean'
    or jsonb_typeof(p_evidence->'bytes_read') is distinct from 'number'
    or jsonb_typeof(p_evidence->'reasons') is distinct from 'array'
    or not coalesce((p_evidence->>'method'='full_original_v1' and p_evidence->>'inspection_scope'='whole_file')
      or (p_evidence->>'method'='bounded_original_v2' and p_evidence->>'inspection_scope'='bounded'
        and p_evidence->>'media_class'='unverified' and jsonb_array_length(p_evidence->'reasons')>0),false)
    or (a is not null and not private.original_media_assessment_valid(a)) then
    raise exception 'media_verification_invalid_evidence' using errcode='22023';
  end if;
  if a ? 'verification' and (a->'verification'->'digest'->>'bytes')::bigint is distinct from m.file_size_bytes then
    raise exception 'media_verification_size_mismatch' using errcode='22023';
  end if;
  -- The existing evidence constraints enforce the full-decode contract and codec/assessment consistency again.
  insert into private.media_evidence(telegram_media_id,media_identity,method,scope,policy_version,media_class,reasons,
    container,video_codec,audio_codec,accessible,gateway_compatible,playback_ready,bytes_read,assessment)
  values(m.id,p_identity,p_evidence->>'method',p_evidence->>'inspection_scope',3,p_evidence->>'media_class',
    array(select jsonb_array_elements_text(p_evidence->'reasons')),p_evidence->>'container',p_evidence->>'video_codec',
    p_evidence->>'audio_codec',(p_evidence->>'accessible')::boolean,(p_evidence->>'gateway_compatible')::boolean,
    false,(p_evidence->>'bytes_read')::bigint,a) returning id into ev_id;
  update private.media_verification_jobs set lease_token=null,lease_until=null,completed_at=clock_timestamp(),evidence_id=ev_id,error_code=null
    where telegram_media_id=m.id;
  return 'recorded';
end $$;

revoke all on function public.media_verification_claim(uuid,integer,integer),
  public.media_verification_finish(bigint,uuid,text,jsonb,text) from public,anon,authenticated,service_role,
  velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.media_verification_claim(uuid,integer,integer),
  public.media_verification_finish(bigint,uuid,text,jsonb,text) to velora_discovery_worker;

-- The existing named verifier keeps every identity/review prerequisite. It also
-- respects the independent media-only lease, so the two entry points cannot
-- download a document concurrently. Same signature and narrowly audited ACL.
create or replace function public.discovery_claim_verification(p_key text,p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_event private.ingestion_events%rowtype; v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype; v_token uuid:=pg_catalog.gen_random_uuid(); v_selection jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 14400 then
    raise exception 'discovery_invalid_input' using errcode='22023';
  end if;
  v_id:=private.channel_lock(p_key);
  select * into v_event from private.ingestion_events where id=v_id;
  select * into v_review from private.channel_reviews where ingestion_event_id=v_id;
  select * into v_media from private.telegram_media where id=v_event.telegram_media_id;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('velora_media_verification:'||v_media.id,0))
    or exists(select 1 from private.media_verification_jobs j where j.telegram_media_id=v_media.id and j.lease_until>now()) then
    raise exception 'discovery_verification_not_claimable' using errcode='P0001';
  end if;
  if v_review.identity_state='confirmed' and v_review.tmdb_id is not null and v_review.vj_id is not null then
    select jsonb_build_object('title',v_review.title,'year',v_review.release_year,'vj_text',v_review.vj_text,
      'vj_id',v_review.vj_id,'tmdb_id',v_review.tmdb_id,'snapshot',c.snapshot) into v_selection
      from private.metadata_match_candidates c where c.ingestion_event_id=v_id and c.tmdb_media_type='movie'
        and c.tmdb_id=v_review.tmdb_id and c.snapshot is not null and c.decision<>'rejected';
  end if;
  if v_event.origin<>'channel' or v_event.status<>'needs_review' or v_selection is null
    or v_review.duplicate_of_media_id is not null
    or private.channel_media_identity(v_media.chat_id,v_media.message_id,v_media.file_unique_id,v_media.file_size_bytes) is null then
    raise exception 'discovery_verification_not_claimable' using errcode='P0001';
  end if;
  update private.ingestion_events set status='processing' where id=v_id;
  update private.channel_reviews set lease_token=v_token,lease_until=now()+make_interval(secs=>p_lease_seconds)
    where ingestion_event_id=v_id returning * into v_review;
  return jsonb_build_object('key',v_review.discovery_key,'revision',v_review.review_revision,'lease',v_token,
    'attempts',v_event.attempt_count,'event_id',v_review.event_id,'payload_digest',v_review.payload_digest,
    'observed_at',v_review.observed_at,'update_id',v_event.telegram_update_id,'kind',v_event.update_kind,
    'chat_id',v_media.chat_id,'message_id',v_media.message_id,'file_unique_id',v_media.file_unique_id,
    'size',v_media.file_size_bytes,'name',v_media.file_name,'mime',v_media.mime_type,'caption',v_media.caption,
    'identity',private.channel_media_identity(v_media.chat_id,v_media.message_id,v_media.file_unique_id,v_media.file_size_bytes),
    'confirmed_selection',v_selection);
end $$;
revoke all on function public.discovery_claim_verification(text,integer) from public,anon,authenticated,service_role,
  velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.discovery_claim_verification(text,integer) to service_role,velora_discovery_worker;
-- The admin upload chain is optional on the hosted channel schema. Audit its
-- role explicitly when present, without requiring that separate deployment.
do $$ begin
  if to_regrole('velora_upload_worker') is not null then
    execute 'revoke all on table private.media_verification_jobs from velora_upload_worker';
    execute 'revoke all on function public.media_verification_claim(uuid,integer,integer), public.media_verification_finish(bigint,uuid,text,jsonb,text), public.discovery_claim_verification(text,integer) from velora_upload_worker';
  end if;
end $$;
commit;
