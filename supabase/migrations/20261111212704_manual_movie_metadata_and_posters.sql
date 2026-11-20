-- Manual metadata is an explicit reviewer identity decision, never a fabricated TMDB id.
-- Existing Telegram identities, full-file evidence, rights revisions and publication gates stay authoritative.
alter table private.channel_reviews add column manual_movie_id bigint references public.movies(id) on delete restrict;
alter table private.channel_reviews drop constraint channel_reviews_identity_check;
alter table private.channel_reviews add constraint channel_reviews_identity_check check (
  (tmdb_id is null or manual_movie_id is null) and
  (identity_state not in ('proposed','confirmed') or tmdb_id is not null or (identity_state='confirmed' and manual_movie_id is not null)));
create index channel_reviews_manual_movie_idx on private.channel_reviews(manual_movie_id) where manual_movie_id is not null;
revoke all(manual_movie_id) on private.channel_reviews from public,anon,authenticated,service_role;

create function private.manual_movie_metadata(p_id bigint) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('title',m.title,'original_title',m.original_title,'overview',m.overview,
 'release_date',m.release_date,'runtime_minutes',m.runtime_minutes,'poster_path',m.poster_path,'backdrop_path',m.backdrop_path,
 'genres',coalesce((select jsonb_agg(g.name order by g.name) from public.movie_genres mg join public.genres g on g.id=mg.genre_id where mg.movie_id=m.id),'[]'::jsonb))
 from public.movies m where m.id=p_id
$$;
create function private.manual_movie_metadata_valid(p jsonb) returns boolean language plpgsql immutable security invoker set search_path='' as $$
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>20000 then return false;end if;
 if (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from array['backdrop_path','genres','original_title','overview','poster_path','release_date','runtime_minutes','title'] then return false;end if;
 if jsonb_typeof(p->'title')<>'string' or char_length(btrim(p->>'title')) not between 1 and 300
 or jsonb_typeof(p->'release_date')<>'string' or (p->>'release_date')!~'^(18[7-9][0-9]|19[0-9]{2}|2[01][0-9]{2})-[0-9]{2}-[0-9]{2}$'
 or jsonb_typeof(p->'overview') not in ('null','string') or char_length(coalesce(p->>'overview',''))>10000
 or jsonb_typeof(p->'original_title') not in ('null','string') or char_length(coalesce(p->>'original_title',''))>300
 or jsonb_typeof(p->'runtime_minutes') not in ('null','number')
 or (jsonb_typeof(p->'runtime_minutes')='number' and ((p->>'runtime_minutes')!~'^[1-9][0-9]{0,3}$' or (p->>'runtime_minutes')::integer>1440))
 or jsonb_typeof(p->'genres')<>'array' or jsonb_array_length(p->'genres')>20 then return false;end if;
 perform (p->>'release_date')::date;
 if exists(select 1 from jsonb_array_elements(p->'genres') g where jsonb_typeof(g)<>'string' or char_length(btrim(g#>>'{}')) not between 1 and 80 or private.catalogue_slug(g#>>'{}')='') then return false;end if;
 if exists(select 1 from (values(p->'poster_path'),(p->'backdrop_path')) x(v) where jsonb_typeof(v) not in ('null','string') or (jsonb_typeof(v)='string' and (v#>>'{}')!~'^(/[A-Za-z0-9_.-]{1,200}|/posters/[a-f0-9-]{36}\.webp)$')) then return false;end if;
 return true;
exception when others then return false;
end $$;
create function private.write_manual_movie_metadata(p_id bigint,p jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare g text;gid bigint;
begin
 if not private.manual_movie_metadata_valid(p) then raise exception 'manual_metadata_invalid' using errcode='22023';end if;
 if exists(select 1 from private.channel_reviews where manual_movie_id=p_id and published_at is null and lease_until>now()) then raise exception 'review_inspection_active';end if;
 update public.movies set title=btrim(p->>'title'),original_title=nullif(btrim(p->>'original_title'),''),overview=nullif(btrim(p->>'overview'),''),release_date=(p->>'release_date')::date,runtime_minutes=(p->>'runtime_minutes')::integer,poster_path=p->>'poster_path',backdrop_path=p->>'backdrop_path',metadata_status='reviewed',metadata_synced_at=now() where id=p_id;
 if not found then raise exception 'catalogue_not_found';end if;
 delete from public.movie_genres where movie_id=p_id;
 for g in select distinct btrim(value) from jsonb_array_elements_text(p->'genres') loop
  insert into public.genres(slug,name) values(private.catalogue_slug(g),g) on conflict do nothing;
  select id into gid from public.genres where slug=private.catalogue_slug(g);
  insert into public.movie_genres(movie_id,genre_id) values(p_id,gid) on conflict do nothing;
 end loop;
 -- A draft's shared metadata may be used by several part/VJ reviews. Invalidate every open approval.
 update private.channel_reviews r set review_revision=review_revision+1,title=p->>'title',release_year=extract(year from (p->>'release_date')::date)::integer,approved_revision=null,approved_by=null,approved_at=null
 where manual_movie_id=p_id and published_at is null;
 update private.ingestion_events e set status='needs_review' from private.channel_reviews r
 where r.ingestion_event_id=e.id and r.manual_movie_id=p_id and r.published_at is null and e.status not in ('rejected','ignored','blocked');
end $$;

create function public.catalogue_admin_movie_metadata(p_id bigint) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_reviewer('any');
 return (select jsonb_build_object('id',m.id,'slug',m.slug,'updated_at',m.updated_at,'metadata',private.manual_movie_metadata(m.id)) from public.movies m where m.id=p_id);
end $$;
create function public.catalogue_admin_manual_movies() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_reviewer('any');
 return coalesce((select jsonb_agg(x order by x.title,x.id) from (select id,title,extract(year from release_date)::integer as year from public.movies where tmdb_id is null and metadata_status='reviewed' and publication_status<>'archived' order by title,id limit 200) x),'[]'::jsonb);
end $$;
create function public.catalogue_admin_save_metadata(p_id bigint,p_updated_at timestamptz,p_metadata jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_reviewer('publish');m public.movies%rowtype;
begin
 select * into m from public.movies where id=p_id for update;
 if not found then raise exception 'catalogue_not_found';end if;
 if p_updated_at is null or m.updated_at is distinct from p_updated_at then raise exception 'review_stale_revision';end if;
 if exists(select 1 from private.channel_reviews r where r.manual_movie_id=p_id and r.published_at is null and r.lease_until>now()) then raise exception 'review_inspection_active';end if;
 perform private.write_manual_movie_metadata(p_id,p_metadata);
 insert into private.catalogue_admin_audit(actor,action,subject_kind,subject_id) values(actor,'edit_metadata','movie',p_id);
 return public.catalogue_admin_movie_metadata(p_id);
end $$;
create function public.discovery_review_manual_metadata(p_key text,p_revision integer,p_vj_id bigint,p_metadata jsonb,p_existing_movie_id bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_reviewer('review');eid bigint;r private.channel_reviews%rowtype;e private.ingestion_events%rowtype;m public.movies%rowtype;mid bigint;meta jsonb;
begin
 eid:=private.channel_lock(p_key);select * into r from private.channel_reviews where ingestion_event_id=eid;select * into e from private.ingestion_events where id=eid;
 if r.review_revision is distinct from p_revision then raise exception 'review_stale_revision';end if;
 if e.status not in ('received','failed','needs_review','matched') or r.published_at is not null or r.lease_until>now() then raise exception 'review_illegal_transition';end if;
 if not exists(select 1 from public.vjs where id=p_vj_id and is_active) then raise exception 'catalogue_vj_not_active';end if;
 if p_existing_movie_id is not null then
  if p_metadata is not null then raise exception 'manual_metadata_invalid';end if;
  select * into m from public.movies where id=p_existing_movie_id and tmdb_id is null and metadata_status='reviewed' and publication_status<>'archived' for share;
  if not found then raise exception 'review_selection_unavailable';end if;
  mid:=m.id;
 else
  if not private.manual_movie_metadata_valid(p_metadata) then raise exception 'manual_metadata_invalid' using errcode='22023';end if;
  if r.manual_movie_id is not null then
   select * into m from public.movies where id=r.manual_movie_id and tmdb_id is null and publication_status='draft' for update;
   if not found then raise exception 'manual_metadata_use_catalogue';end if;mid:=m.id;
  else
   insert into public.movies(slug,title) values(private.catalogue_slug(p_metadata->>'title')||'-manual-'||left(pg_catalog.gen_random_uuid()::text,8),p_metadata->>'title') returning id into mid;
  end if;
  perform private.write_manual_movie_metadata(mid,p_metadata);
 end if;
 meta:=private.manual_movie_metadata(mid);
 if not private.manual_movie_metadata_valid(meta) then raise exception 'manual_metadata_invalid';end if;
 -- read current revision: saving a shared draft may have invalidated it above.
 select * into r from private.channel_reviews where ingestion_event_id=eid;
 update private.metadata_match_candidates set decision='superseded',decided_at=now(),decided_by=actor where ingestion_event_id=eid and decision in ('pending','approved');
 update private.channel_reviews set review_revision=r.review_revision+1,manual_movie_id=mid,tmdb_id=null,identity_state='confirmed',title=meta->>'title',release_year=extract(year from (meta->>'release_date')::date)::integer,vj_id=p_vj_id,
 warnings=array(select w from unnest(warnings) w where w!~'^(caption_|missing_vj|multiple_years|vj_boundary_uncertain|multiple_vjs)'),approved_revision=null,approved_by=null,approved_at=null,lease_token=null,lease_until=null where ingestion_event_id=eid;
 update private.ingestion_events set status='needs_review',error_code=null where id=eid;
 perform private.channel_audit(eid,r.review_revision+1,actor,'manual_identity_confirmed','movie:'||mid);
 return private.channel_view(eid,false);
end $$;

-- Preserve the exact TMDB path. Manual branches wrap, rather than copy, legacy gate logic.
alter function private.channel_movie_part(bigint) rename to channel_movie_part_tmdb;
create function private.channel_movie_part(p_event_id bigint) returns smallint language sql stable security invoker set search_path='' as $$
 select case when r.manual_movie_id is null then private.channel_movie_part_tmdb(p_event_id) else greatest(private.movie_file_part(t.file_name,m.title,r.release_year),private.movie_file_part(t.file_name,m.original_title,r.release_year)) end
 from private.channel_reviews r join private.ingestion_events e on e.id=r.ingestion_event_id join private.telegram_media t on t.id=e.telegram_media_id left join public.movies m on m.id=r.manual_movie_id where e.id=p_event_id
$$;
alter function private.channel_review_blockers(bigint) rename to channel_review_blockers_tmdb;
create function private.channel_review_blockers(p_event_id bigint) returns text[] language plpgsql stable security invoker set search_path='' as $$
declare r private.channel_reviews%rowtype;e private.ingestion_events%rowtype;m public.movies%rowtype;b text[];
begin
 select * into r from private.channel_reviews where ingestion_event_id=p_event_id;
 if r.manual_movie_id is null then return private.channel_review_blockers_tmdb(p_event_id);end if;
 b:=array_remove(array_remove(private.channel_review_blockers_tmdb(p_event_id),'identity_unconfirmed'),'metadata_missing');
 select * into e from private.ingestion_events where id=p_event_id;select * into m from public.movies where id=r.manual_movie_id;
 if r.identity_state<>'confirmed' or m.id is null or m.tmdb_id is not null then b:=array_append(b,'identity_unconfirmed');end if;
 if not private.manual_movie_metadata_valid(private.manual_movie_metadata(r.manual_movie_id)) then b:=array_append(b,'metadata_missing');end if;
 if m.publication_status='archived' then b:=array_append(b,'title_archived');end if;
 if exists(select 1 from public.movie_versions where movie_id=m.id and vj_id=r.vj_id and part_number=private.channel_movie_part(p_event_id) and telegram_media_id is distinct from e.telegram_media_id) then b:=array_append(b,'existing_version_replacement_requires_separate_workflow');end if;
 return b;
end $$;
alter function private.channel_view(bigint,boolean) rename to channel_view_tmdb;
create function private.channel_view(p_event_id bigint,p_detail boolean) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v jsonb;r private.channel_reviews%rowtype;m public.movies%rowtype;meta jsonb;relation text;
begin
 v:=private.channel_view_tmdb(p_event_id,p_detail);select * into r from private.channel_reviews where ingestion_event_id=p_event_id;
 if r.manual_movie_id is null then return v;end if;
 select * into m from public.movies where id=r.manual_movie_id;meta:=private.manual_movie_metadata(m.id);
 relation:=case when exists(select 1 from public.movie_versions where movie_id=m.id and vj_id=r.vj_id and part_number=private.channel_movie_part(p_event_id)) then 'replacement' when exists(select 1 from public.movie_versions where movie_id=m.id and vj_id=r.vj_id) and private.channel_movie_part(p_event_id)>0 then 'new_part' when exists(select 1 from public.movie_versions where movie_id=m.id) then 'new_vj' else 'new_movie' end;
 return v||jsonb_build_object('manual_movie_id',m.id,'choices','[]'::jsonb,'manual_metadata',meta,'movie_id',m.id,'title',r.title,'relation',relation,
 'snapshot',(meta-'genres')||jsonb_build_object('tmdb_id',null,'vote_average',null,'vote_count',null,'genres','[]'::jsonb),'blockers',private.channel_review_blockers(p_event_id));
end $$;

alter function catalogue_review.approve_channel_candidate(text,integer,uuid) rename to approve_channel_candidate_tmdb;
create function catalogue_review.approve_channel_candidate(p_key text,p_revision integer,p_reviewer uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare eid bigint;r private.channel_reviews%rowtype;e private.ingestion_events%rowtype;b text[];
begin
 if not private.reviewer_has(p_reviewer,'review') then raise exception 'review_not_authorized' using errcode='42501';end if;
 eid:=private.channel_lock(p_key);select * into r from private.channel_reviews where ingestion_event_id=eid;
 if r.manual_movie_id is null then return catalogue_review.approve_channel_candidate_tmdb(p_key,p_revision,p_reviewer);end if;
 select * into e from private.ingestion_events where id=eid;
 if r.review_revision is distinct from p_revision then raise exception 'review_stale_revision';end if;
 if e.status='matched' and r.approved_revision=p_revision then return private.channel_view(eid,false);end if;
 if e.status<>'needs_review' then raise exception 'review_illegal_transition';end if;
 b:=private.channel_review_blockers(eid);if cardinality(b)>0 then raise exception 'review_gates_not_met' using detail=pg_catalog.array_to_string(b,',');end if;
 update private.channel_reviews set approved_revision=p_revision,approved_by=p_reviewer,approved_at=now() where ingestion_event_id=eid;
 update private.ingestion_events set status='matched' where id=eid;
 perform private.channel_audit(eid,p_revision,p_reviewer,'approved_manual_metadata');return private.channel_view(eid,false);
end $$;
alter function catalogue_review.publish_channel_candidate(text,integer,uuid) rename to publish_channel_candidate_tmdb;
create function catalogue_review.publish_channel_candidate(p_key text,p_revision integer,p_reviewer uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare eid bigint;r private.channel_reviews%rowtype;e private.ingestion_events%rowtype;m public.movies%rowtype;ver public.movie_versions%rowtype;b text[];part smallint;
begin
 if not private.reviewer_has(p_reviewer,'publish') then raise exception 'review_not_authorized' using errcode='42501';end if;
 eid:=private.channel_lock(p_key);select * into r from private.channel_reviews where ingestion_event_id=eid;
 if r.manual_movie_id is null then return catalogue_review.publish_channel_candidate_tmdb(p_key,p_revision,p_reviewer);end if;
 select * into e from private.ingestion_events where id=eid;select * into m from public.movies where id=r.manual_movie_id for update;
 if e.status='published' and r.approved_revision=p_revision then
  select * into ver from public.movie_versions where telegram_media_id=e.telegram_media_id;
  if ver.movie_id is distinct from m.id then raise exception 'catalogue_publication_inconsistent';end if;
  return jsonb_build_object('result','already_published','movie_slug',m.slug,'version_id',ver.id,'vj_slug',(select slug from public.vjs where id=r.vj_id));
 end if;
 if r.review_revision is distinct from p_revision then raise exception 'review_stale_revision';end if;
 if e.status<>'matched' or r.approved_revision is distinct from p_revision then raise exception 'catalogue_not_approved';end if;
 b:=private.channel_review_blockers(eid);if cardinality(b)>0 then raise exception 'review_gates_not_met' using detail=pg_catalog.array_to_string(b,',');end if;
 part:=private.channel_movie_part(eid);
 if exists(select 1 from public.movie_versions where movie_id=m.id and vj_id=r.vj_id and part_number=part) or exists(select 1 from public.movie_versions where telegram_media_id=e.telegram_media_id) then raise exception 'catalogue_version_conflict';end if;
 insert into public.movie_versions(movie_id,vj_id,part_number,title_override,telegram_media_id,availability_status,rights_status,available_at)
 values(m.id,r.vj_id,part,case when part>0 then m.title||' - Part '||part end,e.telegram_media_id,'ready','cleared',now()) returning * into ver;
 update public.movies set publication_status='published',published_at=coalesce(published_at,now()) where id=m.id;
 update private.ingestion_events set status='published',error_code=null,processed_at=now() where id=eid;
 update private.channel_reviews set published_by=p_reviewer,published_at=now() where ingestion_event_id=eid;
 perform private.channel_audit(eid,p_revision,p_reviewer,'published_manual_metadata','version:'||ver.id);
 return jsonb_build_object('result','published','movie_slug',m.slug,'version_id',ver.id,'vj_slug',(select slug from public.vjs where id=r.vj_id));
end $$;

-- A TMDB correction must explicitly leave the manual branch, including its stale approval.
alter function public.discovery_review_correct(text,integer,integer,integer,bigint) rename to discovery_review_correct_tmdb;
create function public.discovery_review_correct(p_key text,p_revision integer,p_tmdb_id integer,p_year integer,p_vj_id bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare eid bigint;
begin
 perform private.require_reviewer('review');eid:=private.channel_lock(p_key);
 if (select review_revision from private.channel_reviews where ingestion_event_id=eid) is distinct from p_revision then raise exception 'review_stale_revision';end if;
 update private.channel_reviews set manual_movie_id=null,identity_state='unknown' where ingestion_event_id=eid and manual_movie_id is not null;
 return public.discovery_review_correct_tmdb(p_key,p_revision,p_tmdb_id,p_year,p_vj_id);
end $$;

revoke all on function private.manual_movie_metadata(bigint),private.manual_movie_metadata_valid(jsonb),private.write_manual_movie_metadata(bigint,jsonb),private.channel_movie_part(bigint),private.channel_movie_part_tmdb(bigint),private.channel_review_blockers(bigint),private.channel_review_blockers_tmdb(bigint),private.channel_view(bigint,boolean),private.channel_view_tmdb(bigint,boolean)
from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
revoke all on function catalogue_review.approve_channel_candidate_tmdb(text,integer,uuid),catalogue_review.publish_channel_candidate_tmdb(text,integer,uuid),public.discovery_review_correct_tmdb(text,integer,integer,integer,bigint)
from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
revoke all on function catalogue_review.approve_channel_candidate(text,integer,uuid),catalogue_review.publish_channel_candidate(text,integer,uuid)
from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
grant execute on function catalogue_review.approve_channel_candidate(text,integer,uuid),catalogue_review.publish_channel_candidate(text,integer,uuid) to velora_review_service;
revoke all on function public.catalogue_admin_movie_metadata(bigint),public.catalogue_admin_manual_movies(),public.catalogue_admin_save_metadata(bigint,timestamptz,jsonb),public.discovery_review_manual_metadata(text,integer,bigint,jsonb,bigint),public.discovery_review_correct(text,integer,integer,integer,bigint)
from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
grant execute on function public.catalogue_admin_movie_metadata(bigint),public.catalogue_admin_manual_movies(),public.catalogue_admin_save_metadata(bigint,timestamptz,jsonb),public.discovery_review_manual_metadata(text,integer,bigint,jsonb,bigint),public.discovery_review_correct(text,integer,integer,integer,bigint) to authenticated;

-- Confirmed manual identity is preserved during media-only inspection as well.
create or replace function public.discovery_claim(p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_token uuid := pg_catalog.gen_random_uuid();
  v_selection jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds not between 5 and 600 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  update private.ingestion_events e set status = 'blocked', error_code = 'inspection_attempts_exhausted'
  from private.channel_reviews r
  where r.ingestion_event_id = e.id and e.origin = 'channel' and e.status = 'processing'
    and r.lease_until <= now() and e.attempt_count >= 5;

  select e.* into v_event from private.ingestion_events e
  join private.channel_reviews r on r.ingestion_event_id = e.id
  where e.origin = 'channel'
    and ((e.status in ('received', 'failed') and r.retry_at <= now()) or (e.status = 'processing' and r.lease_until <= now()))
  order by r.retry_at, e.id
  limit 1
  for update of e, r skip locked;
  if not found then
    return null;
  end if;
  update private.ingestion_events e set status = 'processing', attempt_count = e.attempt_count + 1 where e.id = v_event.id;
  update private.channel_reviews r
  set lease_token = v_token, lease_until = now() + make_interval(secs => p_lease_seconds)
  where r.ingestion_event_id = v_event.id
  returning * into v_review;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  -- The reviewer's confirmed choice, from the same rows the publication gates read.
  if v_review.identity_state = 'confirmed' and v_review.vj_id is not null then
    if v_review.manual_movie_id is not null then
      v_selection:=jsonb_build_object('title',v_review.title,'year',v_review.release_year,'vj_text',v_review.vj_text,'vj_id',v_review.vj_id,'tmdb_id',null,'manual_movie_id',v_review.manual_movie_id,'snapshot',(private.manual_movie_metadata(v_review.manual_movie_id)-'genres')||jsonb_build_object('tmdb_id',null,'vote_average',null,'vote_count',null,'genres','[]'::jsonb));
    else

    select jsonb_build_object('title', v_review.title, 'year', v_review.release_year, 'vj_text', v_review.vj_text,
                              'vj_id', v_review.vj_id, 'tmdb_id', v_review.tmdb_id, 'snapshot', c.snapshot)
    into v_selection
    from private.metadata_match_candidates c
    where c.ingestion_event_id = v_event.id and c.tmdb_media_type = 'movie' and c.tmdb_id = v_review.tmdb_id
      and c.snapshot is not null and c.decision <> 'rejected';
  end if;
  end if;
  return jsonb_build_object(
    'key', v_review.discovery_key, 'revision', v_review.review_revision, 'lease', v_token,
    'attempts', v_event.attempt_count + 1, 'event_id', v_review.event_id, 'payload_digest', v_review.payload_digest,
    'observed_at', v_review.observed_at, 'update_id', v_event.telegram_update_id, 'kind', v_event.update_kind,
    'chat_id', v_media.chat_id, 'message_id', v_media.message_id, 'file_unique_id', v_media.file_unique_id,
    'size', v_media.file_size_bytes, 'name', v_media.file_name, 'mime', v_media.mime_type, 'caption', v_media.caption,
    'identity', private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes),
    'confirmed_selection', v_selection);
end;
$$;

-- Confirmed manual identity is preserved during media-only inspection as well.
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
  if v_review.identity_state='confirmed' and v_review.vj_id is not null then
    if v_review.manual_movie_id is not null then
      v_selection:=jsonb_build_object('title',v_review.title,'year',v_review.release_year,'vj_text',v_review.vj_text,'vj_id',v_review.vj_id,'tmdb_id',null,'manual_movie_id',v_review.manual_movie_id,'snapshot',(private.manual_movie_metadata(v_review.manual_movie_id)-'genres')||jsonb_build_object('tmdb_id',null,'vote_average',null,'vote_count',null,'genres','[]'::jsonb));
    else

    select jsonb_build_object('title',v_review.title,'year',v_review.release_year,'vj_text',v_review.vj_text,
      'vj_id',v_review.vj_id,'tmdb_id',v_review.tmdb_id,'snapshot',c.snapshot) into v_selection
      from private.metadata_match_candidates c where c.ingestion_event_id=v_id and c.tmdb_media_type='movie'
        and c.tmdb_id=v_review.tmdb_id and c.snapshot is not null and c.decision<>'rejected';
  end if;
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

revoke all on function public.discovery_claim(integer),public.discovery_claim_verification(text,integer) from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.discovery_claim(integer),public.discovery_claim_verification(text,integer) to service_role,velora_discovery_worker;
