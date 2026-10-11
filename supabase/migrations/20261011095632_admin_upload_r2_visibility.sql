-- Enforce expiring/revoked R2 attestations at read/playback time as well as
-- during publication. Existing non-R2 media keeps its existing rights rules.
create function catalogue_access.admin_upload_rights_valid(p_media_id bigint)
returns boolean language sql stable security definer set search_path='' as $$
  select not exists(select 1 from private.admin_upload_sessions s
    join private.admin_upload_r2 r on r.upload_id=s.id
    join private.ingestion_events e on e.id=s.ingestion_event_id
    where e.telegram_media_id=p_media_id and not private.admin_upload_r2_eligible(s.id))
$$;
revoke all on function catalogue_access.admin_upload_rights_valid(bigint) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function catalogue_access.admin_upload_rights_valid(bigint) to anon,authenticated;

alter policy "movie_versions: read public" on public.movie_versions
using (availability_status='ready' and rights_status='cleared'
  and catalogue_access.admin_upload_rights_valid(telegram_media_id)
  and catalogue_access.movie_is_public(movie_id)
  and exists(select 1 from public.vjs v where v.id=vj_id));

create or replace function public.admin_upload_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_upload_admin(); s private.admin_upload_sessions%rowtype; r private.admin_upload_r2%rowtype;
begin
  select * into s from private.admin_upload_sessions where id=p_id and owner_id=v_uid;
  if not found then raise exception 'upload_not_found' using errcode='P0001'; end if;
  select * into r from private.admin_upload_r2 where upload_id=p_id;
  return private.admin_upload_view(p_id)||jsonb_build_object('inspection',case when s.inspection is null then null else
    jsonb_build_object('choices',s.inspection->'choices','proposed_tmdb_id',s.inspection->'proposed_tmdb_id',
      'classification',s.inspection->'classification','proposed_vj_id',s.inspection->'proposed_vj_id') end,
    'pipeline',jsonb_build_object('media_verified',coalesce(s.inspection->>'decoded'='true' and s.inspection->'classification'->>'class'='canonical' and s.verified_sha256 is not null,false),
      'telegram_status',coalesce((select upload_state from private.ingestion_events where id=s.ingestion_event_id),'pending'),
      'rights_rejected',s.rights_rejected_at is not null,'rights_cleared',coalesce(s.rights_revision=s.revision and s.rights_sha256=s.verified_sha256 and s.rights_expires_at>now() and private.reviewer_has(s.rights_by,'rights'),false),
      'rights_expires_at',s.rights_expires_at,'rights_reference',s.rights_reference,'approved',private.admin_upload_r2_eligible(p_id),
      'cleanup_state',r.state,'cleanup_error',r.cleanup_error,'stored',exists(select 1 from private.ingestion_events e where e.id=s.ingestion_event_id and e.upload_state='uploaded' and e.telegram_media_id is not null),
      'publication_slug',(select m.slug from private.ingestion_events e join public.movie_versions mv on mv.telegram_media_id=e.telegram_media_id join public.movies m on m.id=mv.movie_id where e.id=s.ingestion_event_id and s.stage='published'),
      'audit',coalesce((select jsonb_agg(jsonb_build_object('action',a.action,'at',a.created_at,'revision',a.revision) order by a.id desc) from
        (select id,action,created_at,revision from private.admin_upload_audit where upload_id=p_id order by id desc limit 100) a),'[]'::jsonb)));
end;
$$;
revoke all on function public.admin_upload_get(uuid) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service;
grant execute on function public.admin_upload_get(uuid) to authenticated;
create or replace function catalogue_access.movie_is_public(p_movie_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.movies m
    join public.movie_versions mv on mv.movie_id = m.id
    join public.vjs v on v.id = mv.vj_id
    where m.id = p_movie_id
      and m.publication_status = 'published'
      and mv.availability_status = 'ready'
      and mv.rights_status = 'cleared' and catalogue_access.admin_upload_rights_valid(mv.telegram_media_id)
      and v.is_active
  );
$$;
create or replace function media_gateway.resolve_movie_version(p_movie_version_id bigint)
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
     and mv.rights_status = 'cleared' and catalogue_access.admin_upload_rights_valid(mv.telegram_media_id)
     and v.is_active
     and tm.file_size_bytes > 0
$$;
revoke all on function catalogue_access.movie_is_public(bigint) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway; grant execute on function catalogue_access.movie_is_public(bigint) to anon,authenticated; revoke all on function media_gateway.resolve_movie_version(bigint) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway; grant execute on function media_gateway.resolve_movie_version(bigint) to velora_media_gateway;
-- Maintenance returns only aggregate health or a database-owned orphan
-- reference. It never authorizes deleting an unknown object or a live MPU.
create function public.admin_upload_r2_housekeeping(p_command text,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.admin_upload_sessions%rowtype; r private.admin_upload_r2%rowtype;
begin
  if p_input is null or jsonb_typeof(p_input)<>'object' or pg_column_size(p_input)>4096 then raise exception 'upload_invalid_input' using errcode='22023'; end if;
  if p_command='metrics' then
    return (select jsonb_build_object('retained_bytes',coalesce(sum(x.size_bytes) filter(where y.state<>'cleaned'),0),'retained_sessions',count(*) filter(where y.state<>'cleaned'),
      'cleanup_failures',count(*) filter(where y.cleanup_error is not null),'failed_jobs',count(*) filter(where x.stage='failed'),'uncertain_transfers',count(*) filter(where x.stage='telegram_uncertain'),
      'expired_leases',count(*) filter(where x.lease_until<now()),'stuck_uploads',count(*) filter(where x.stage='uploading' and x.updated_at<now()-interval '1 day')) from private.admin_upload_sessions x join private.admin_upload_r2 y on y.upload_id=x.id);
  elsif p_command='object_tracked' then
    return to_jsonb(exists(select 1 from private.admin_upload_sessions x join private.admin_upload_r2 y on y.upload_id=x.id
      where y.object_key=p_input->>'key' and y.state<>'cleaned' and x.size_bytes=(p_input->>'size')::bigint));
  elsif p_command='orphan_multipart' then
    select x.* into s from private.admin_upload_sessions x join private.admin_upload_r2 y on y.upload_id=x.id where y.object_key=p_input->>'key' for update of x;
    if not found then return null; end if;
    select * into r from private.admin_upload_r2 where upload_id=s.id for update;
    if p_input->>'uploadId' is null or char_length(p_input->>'uploadId') not between 1 and 2048 or p_input->>'initiated' is null
      or (p_input->>'initiated')::timestamptz>now()-interval '1 day'
      or r.init_until>now() or (s.lease_until>now()) or r.multipart_id=p_input->>'uploadId' then return null; end if;
    return private.admin_upload_r2_view(s.id)->'reference'||jsonb_build_object('upload_id',p_input->>'uploadId');
  elsif p_command='orphan_local' then
    select * into s from private.admin_upload_sessions where id=(p_input->>'id')::uuid;
    if not found or not exists(select 1 from private.admin_upload_r2 where upload_id=s.id) or s.lease_until>now() then return 'false'::jsonb; end if;
    return to_jsonb(s.verified_file_key is distinct from (p_input->>'key')::uuid);
  else raise exception 'upload_invalid_input' using errcode='22023'; end if;
end;
$$;
revoke all on function public.admin_upload_r2_housekeeping(text,jsonb) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.admin_upload_r2_housekeeping(text,jsonb) to velora_upload_worker;
