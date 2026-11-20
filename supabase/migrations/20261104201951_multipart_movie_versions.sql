-- Local preparation only. Applying this migration to hosted requires separate authorization.
-- A film keeps one TMDB identity/poster. Each numbered file gets its own VJ version,
-- media evidence, rights decision, approval and playback/download capability.
begin;

-- A suffix is a file part only when its base agrees with the confirmed metadata.
-- Exact metadata titles (including real sequels) always remain whole titles (0).
create function private.movie_file_part(p_name text, p_title text, p_year integer)
returns smallint language plpgsql immutable security invoker set search_path = '' as $$
declare
  v_name text;
  v_match text[];
begin
  if p_name is null or p_title is null then return 0; end if;
  v_name := pg_catalog.lower(pg_catalog.regexp_replace(p_name, '\.[a-zA-Z0-9]{2,5}$', ''));
  v_name := pg_catalog.regexp_replace(v_name, '[._-]+', ' ', 'g');
  v_name := pg_catalog.regexp_replace(v_name, '\s+', ' ', 'g');
  v_name := pg_catalog.regexp_replace(v_name, '\s+vj\s.*$', '', 'i');
  if p_year is not null then
    v_name := pg_catalog.regexp_replace(v_name, '(^| )' || p_year::text || '( |$)', ' ', 'g');
  end if;
  v_name := pg_catalog.btrim(pg_catalog.regexp_replace(v_name, '\s+', ' ', 'g'));
  if private.catalogue_slug(v_name) = private.catalogue_slug(p_title) then return 0; end if;
  v_match := pg_catalog.regexp_match(v_name, '^(.*?)\s+(?:(?:part|pt)\s*)?([1-9][0-9]?)$');
  if v_match is not null and private.catalogue_slug(v_match[1]) = private.catalogue_slug(p_title) then
    return v_match[2]::smallint;
  end if;
  return 0;
end;
$$;

create function private.channel_movie_part(p_event_id bigint)
returns smallint language sql stable security invoker set search_path = '' as $$
  select coalesce((select greatest(
    private.movie_file_part(m.file_name,c.snapshot->>'title',r.release_year),
    private.movie_file_part(m.file_name,c.snapshot->>'original_title',r.release_year))
  from private.channel_reviews r join private.ingestion_events e on e.id=r.ingestion_event_id
  join private.telegram_media m on m.id=e.telegram_media_id
  join private.metadata_match_candidates c on c.ingestion_event_id=e.id and c.tmdb_id=r.tmdb_id and c.tmdb_media_type='movie'
  where e.id=p_event_id and r.identity_state='confirmed' and c.snapshot is not null and c.decision<>'rejected'),0)::smallint
$$;

alter table public.movie_versions add column part_number smallint not null default 0
  constraint movie_versions_part_number_check check (part_number between 0 and 99);
alter table public.movie_versions drop constraint movie_versions_movie_vj_key;
alter table public.movie_versions add constraint movie_versions_movie_vj_part_key unique (movie_id,vj_id,part_number);

-- Recognize existing numbered files without replacing their media, ids, slugs or curated titles.
update public.movie_versions mv set part_number=greatest(
  private.movie_file_part(t.file_name,m.title,extract(year from m.release_date)::integer),
  private.movie_file_part(t.file_name,m.original_title,extract(year from m.release_date)::integer))
from public.movies m, private.telegram_media t where m.id=mv.movie_id and t.id=mv.telegram_media_id;
update public.movie_versions mv set title_override=m.title || ' — Part ' || mv.part_number::text
from public.movies m where m.id=mv.movie_id and mv.part_number>0 and mv.title_override is null;

-- No new client table/column access. Existing column grants and RLS remain authoritative.
revoke all (part_number) on public.movie_versions from public,anon,authenticated;


create or replace function private.catalogue_materialize_movie_version(p_tmdb_id integer, p_vj_id bigint, p_media_id bigint, p_metadata jsonb)
returns table (movie_id bigint, movie_slug text, version_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_movie public.movies%rowtype;
  v_version public.movie_versions%rowtype;
  v_slug text;
  v_release date;
  v_genre jsonb;
  v_genre_id bigint;
  v_part smallint;
begin
  if p_tmdb_id is null or p_tmdb_id <= 0 or p_vj_id is null or p_media_id is null
     or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;
  if jsonb_typeof(p_metadata->'tmdb_id') is distinct from 'number' or (p_metadata->>'tmdb_id') is distinct from p_tmdb_id::text then
    raise exception 'catalogue_metadata_mismatch' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.vjs v where v.id = p_vj_id and v.is_active) then
    raise exception 'catalogue_vj_not_active' using errcode = 'P0001';
  end if;
  if not exists (select 1 from private.telegram_media m where m.id = p_media_id and m.bot_type = 'movie') then
    raise exception 'catalogue_not_uploaded' using errcode = 'P0001';
  end if;

  -- Snapshot validation. Table CHECKs bound lengths and ranges as well.
  if jsonb_typeof(p_metadata->'title') is distinct from 'string'
     or jsonb_typeof(p_metadata->'original_title') not in ('null', 'string')
     or jsonb_typeof(p_metadata->'overview') not in ('null', 'string')
     or jsonb_typeof(p_metadata->'release_date') not in ('null', 'string')
     or (jsonb_typeof(p_metadata->'release_date') = 'string' and (p_metadata->>'release_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     or jsonb_typeof(p_metadata->'runtime_minutes') not in ('null', 'number')
     or jsonb_typeof(p_metadata->'poster_path') not in ('null', 'string')
     or (jsonb_typeof(p_metadata->'poster_path') = 'string' and (p_metadata->>'poster_path') !~ '^/[A-Za-z0-9_.-]{1,200}$')
     or jsonb_typeof(p_metadata->'backdrop_path') not in ('null', 'string')
     or (jsonb_typeof(p_metadata->'backdrop_path') = 'string' and (p_metadata->>'backdrop_path') !~ '^/[A-Za-z0-9_.-]{1,200}$')
     or jsonb_typeof(p_metadata->'vote_average') not in ('null', 'number')
     or jsonb_typeof(p_metadata->'vote_count') not in ('null', 'number')
     or jsonb_typeof(p_metadata->'genres') is distinct from 'array' or jsonb_array_length(p_metadata->'genres') > 20 then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;
  v_release := (p_metadata->>'release_date')::date;

  -- 1. The movie: one per TMDB id (movies.tmdb_id is unique).
  select m.* into v_movie from public.movies m where m.tmdb_id = p_tmdb_id for update;
  if found then
    if v_movie.publication_status = 'archived' then
      raise exception 'catalogue_title_archived' using errcode = 'P0001';
    end if;
  else
    v_slug := private.catalogue_slug(p_metadata->>'title');
    if v_slug = '' then
      raise exception 'catalogue_slug_unavailable' using errcode = 'P0001';
    end if;
    if v_release is not null then
      v_slug := v_slug || '-' || extract(year from v_release)::integer;
    end if;
    if exists (select 1 from public.movies m where m.slug = v_slug) then
      raise exception 'catalogue_slug_conflict' using errcode = 'P0001';
    end if;
    begin
      insert into public.movies (
        slug, title, original_title, overview, release_date, runtime_minutes, poster_path, backdrop_path,
        tmdb_id, tmdb_vote_average, tmdb_vote_count, metadata_status, metadata_synced_at)
      values (
        v_slug,
        pg_catalog.btrim(p_metadata->>'title'),
        nullif(pg_catalog.btrim(p_metadata->>'original_title'), ''),
        nullif(pg_catalog.btrim(p_metadata->>'overview'), ''),
        v_release,
        nullif((p_metadata->>'runtime_minutes')::integer, 0),
        p_metadata->>'poster_path',
        p_metadata->>'backdrop_path',
        p_tmdb_id,
        round((p_metadata->>'vote_average')::numeric, 1),
        (p_metadata->>'vote_count')::integer,
        'reviewed',
        now())
      returning * into v_movie;
    exception when unique_violation then
      -- A concurrent publication created this title first: refuse, never merge.
      raise exception 'catalogue_publication_conflict' using errcode = 'P0001';
    end;

    for v_genre in select value from jsonb_array_elements(p_metadata->'genres') loop
      if jsonb_typeof(v_genre->'tmdb_id') is distinct from 'number' or (v_genre->>'tmdb_id') !~ '^[1-9][0-9]{0,8}$'
         or jsonb_typeof(v_genre->'name') is distinct from 'string' or private.catalogue_slug(v_genre->>'name') = '' then
        raise exception 'catalogue_invalid_input' using errcode = '22023';
      end if;
      insert into public.genres (slug, name, tmdb_movie_id)
      values (private.catalogue_slug(v_genre->>'name'), pg_catalog.btrim(v_genre->>'name'), (v_genre->>'tmdb_id')::integer)
      on conflict do nothing;
      select g.id into v_genre_id from public.genres g
      where g.tmdb_movie_id = (v_genre->>'tmdb_id')::integer
         or (g.tmdb_movie_id is null and pg_catalog.lower(g.name) = pg_catalog.lower(pg_catalog.btrim(v_genre->>'name')))
      order by (g.tmdb_movie_id is null), g.id
      limit 1;
      if v_genre_id is not null then
        insert into public.movie_genres (movie_id, genre_id) values (v_movie.id, v_genre_id) on conflict do nothing;
      end if;
    end loop;
  end if;

  select greatest(private.movie_file_part(m.file_name,p_metadata->>'title',extract(year from v_release)::integer),
                  private.movie_file_part(m.file_name,p_metadata->>'original_title',extract(year from v_release)::integer))
  into v_part from private.telegram_media m where m.id=p_media_id;
  v_part := coalesce(v_part,0);

  -- 2 + 3. The VJ version, linked to this media. An existing version for this
  -- title and VJ with other media is a replacement decision, never made here.
  select mv.* into v_version from public.movie_versions mv
  where mv.movie_id = v_movie.id and mv.vj_id = p_vj_id and mv.part_number = v_part
  for update;
  if found then
    if v_version.telegram_media_id is distinct from p_media_id then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end if;
    update public.movie_versions mv
    set availability_status = 'ready', rights_status = 'cleared', available_at = coalesce(mv.available_at, now())
    where mv.id = v_version.id
    returning * into v_version;
  else
    if exists (select 1 from public.movie_versions mv where mv.telegram_media_id = p_media_id) then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end if;
    begin
      insert into public.movie_versions (movie_id, vj_id, part_number, title_override, telegram_media_id, availability_status, rights_status, available_at)
      values (v_movie.id, p_vj_id, v_part, case when v_part>0 then v_movie.title || ' — Part ' || v_part::text end, p_media_id, 'ready', 'cleared', now())
      returning * into v_version;
    exception when unique_violation then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end;
  end if;

  update public.movies m
  set publication_status = 'published', published_at = coalesce(m.published_at, now())
  where m.id = v_movie.id
  returning * into v_movie;

  return query select v_movie.id, v_movie.slug, v_version.id;
end;
$$;

create or replace function private.channel_relation(p_tmdb_id integer, p_vj_id bigint, p_part smallint)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when p_tmdb_id is null or p_vj_id is null then 'unknown'
    when not exists (select 1 from public.movies m where m.tmdb_id = p_tmdb_id) then 'new_movie'
    when exists (select 1 from public.movies m join public.movie_versions mv on mv.movie_id = m.id
                 where m.tmdb_id = p_tmdb_id and mv.vj_id = p_vj_id and mv.part_number = p_part) then 'replacement'
    when p_part > 0 and exists (select 1 from public.movies m join public.movie_versions mv on mv.movie_id=m.id where m.tmdb_id=p_tmdb_id and mv.vj_id=p_vj_id) then 'new_part'
    else 'new_vj' end
$$;

-- Preserve the installed media policy: optional-media review is not a prerequisite.
do $multipart_policy$ begin
  if to_regprocedure('private.media_inspection_mode()') is not null then
    execute $multipart_function$create or replace function private.channel_review_blockers(p_event_id bigint)
returns text[]
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
  v_movie public.movies%rowtype;
  v_blockers text[] := array[]::text[];
begin
  select e.* into v_event from private.ingestion_events e where e.id = p_event_id and e.origin = 'channel';
  if not found then
    return array['candidate_not_found'];
  end if;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = p_event_id;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);

  if v_event.status in ('rejected', 'blocked', 'published', 'ignored') then
    v_blockers := v_blockers || 'candidate_closed'::text;
  end if;
  if v_event.status in ('received', 'processing', 'failed') then
    v_blockers := v_blockers || 'inspection_pending'::text;
  end if;
  if v_review.duplicate_of_media_id is not null then
    v_blockers := v_blockers || 'duplicate_media'::text;
  end if;
  if not exists (select 1 from private.telegram_channels c where c.bot_type = 'movie' and c.chat_id = v_media.chat_id) then
    v_blockers := v_blockers || 'channel_not_registered'::text;
  end if;
  if v_identity is null then
    v_blockers := v_blockers || 'media_identity_incomplete'::text;
  end if;
  if v_review.identity_state <> 'confirmed' or v_review.tmdb_id is null then
    v_blockers := v_blockers || 'identity_unconfirmed'::text;
  elsif not exists (
    select 1 from private.metadata_match_candidates c
    where c.ingestion_event_id = p_event_id and c.tmdb_media_type = 'movie' and c.tmdb_id = v_review.tmdb_id
      and c.snapshot is not null and c.decision <> 'rejected'
  ) then
    v_blockers := v_blockers || 'metadata_missing'::text;
  end if;
  if v_review.vj_id is null or not exists (select 1 from public.vjs v where v.id = v_review.vj_id and v.is_active) then
    v_blockers := v_blockers || 'vj_unresolved'::text;
  end if;
  -- Required: verified media (Checkpoint 10, unchanged). Optional or disabled:
  -- unchecked or inconclusive media does not block, a definite failure does.
  if private.media_inspection_mode() = 'required' then
    if v_identity is null or not exists (select 1 from private.channel_current_evidence(v_media.id) ev where private.media_evidence_publishable(ev)) then
      v_blockers := v_blockers || 'media_verification_required'::text;
    end if;
  elsif v_identity is not null and exists (select 1 from private.channel_current_evidence(v_media.id) ev where private.media_evidence_known_failure(ev)) then
    v_blockers := v_blockers || 'media_known_failure'::text;
  end if;
  if v_identity is not null and (select count(distinct ev.content_sha256) from private.media_evidence ev
      where ev.telegram_media_id = v_media.id and ev.media_identity = v_identity and ev.content_sha256 is not null) > 1 then
    v_blockers := v_blockers || 'media_content_conflict'::text;
  end if;
  if v_identity is null or not exists (
    select 1 from private.rights_clearances rc
    where rc.ingestion_event_id = p_event_id and rc.review_revision = v_review.review_revision and rc.media_identity = v_identity
  ) then
    v_blockers := v_blockers || 'rights_clearance_required'::text;
  end if;
  if exists (select 1 from unnest(v_review.warnings) w where w ~ '(conflict|multiple_|series|unsupported|uncertain)') then
    v_blockers := v_blockers || 'unresolved_evidence_conflict'::text;
  end if;
  -- The catalogue relationship, live (never the stored suggestion).
  if v_review.tmdb_id is not null then
    select m.* into v_movie from public.movies m where m.tmdb_id = v_review.tmdb_id;
    if found and v_movie.publication_status = 'archived' then
      v_blockers := v_blockers || 'title_archived'::text;
    end if;
    if found and v_review.vj_id is not null and exists (
      select 1 from public.movie_versions mv where mv.movie_id = v_movie.id and mv.vj_id = v_review.vj_id
        and mv.part_number = private.channel_movie_part(p_event_id)
        and mv.telegram_media_id is distinct from v_media.id
    ) then
      v_blockers := v_blockers || 'existing_version_replacement_requires_separate_workflow'::text;
    end if;
  end if;
  if v_event.status <> 'published' and exists (select 1 from public.movie_versions mv where mv.telegram_media_id = v_media.id) then
    v_blockers := v_blockers || 'media_already_linked'::text;
  end if;
  return v_blockers;
end;
$$;$multipart_function$;
  else
    execute $multipart_function$create or replace function private.channel_review_blockers(p_event_id bigint)
returns text[]
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
  v_movie public.movies%rowtype;
  v_blockers text[] := array[]::text[];
begin
  select e.* into v_event from private.ingestion_events e where e.id = p_event_id and e.origin = 'channel';
  if not found then
    return array['candidate_not_found'];
  end if;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = p_event_id;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);

  if v_event.status in ('rejected', 'blocked', 'published', 'ignored') then
    v_blockers := v_blockers || 'candidate_closed'::text;
  end if;
  if v_event.status in ('received', 'processing', 'failed') then
    v_blockers := v_blockers || 'inspection_pending'::text;
  end if;
  if v_review.duplicate_of_media_id is not null then
    v_blockers := v_blockers || 'duplicate_media'::text;
  end if;
  if not exists (select 1 from private.telegram_channels c where c.bot_type = 'movie' and c.chat_id = v_media.chat_id) then
    v_blockers := v_blockers || 'channel_not_registered'::text;
  end if;
  if v_identity is null then
    v_blockers := v_blockers || 'media_identity_incomplete'::text;
  end if;
  if v_review.identity_state <> 'confirmed' or v_review.tmdb_id is null then
    v_blockers := v_blockers || 'identity_unconfirmed'::text;
  elsif not exists (
    select 1 from private.metadata_match_candidates c
    where c.ingestion_event_id = p_event_id and c.tmdb_media_type = 'movie' and c.tmdb_id = v_review.tmdb_id
      and c.snapshot is not null and c.decision <> 'rejected'
  ) then
    v_blockers := v_blockers || 'metadata_missing'::text;
  end if;
  if v_review.vj_id is null or not exists (select 1 from public.vjs v where v.id = v_review.vj_id and v.is_active) then
    v_blockers := v_blockers || 'vj_unresolved'::text;
  end if;
  if v_identity is null or not exists (select 1 from private.channel_current_evidence(v_media.id) ev where private.media_evidence_publishable(ev)) then
    v_blockers := v_blockers || 'media_verification_required'::text;
  end if;
  if v_identity is not null and (select count(distinct ev.content_sha256) from private.media_evidence ev
      where ev.telegram_media_id = v_media.id and ev.media_identity = v_identity and ev.content_sha256 is not null) > 1 then
    v_blockers := v_blockers || 'media_content_conflict'::text;
  end if;
  if v_identity is null or not exists (
    select 1 from private.rights_clearances rc
    where rc.ingestion_event_id = p_event_id and rc.review_revision = v_review.review_revision and rc.media_identity = v_identity
  ) then
    v_blockers := v_blockers || 'rights_clearance_required'::text;
  end if;
  if exists (select 1 from unnest(v_review.warnings) w where w ~ '(conflict|multiple_|series|unsupported|uncertain)') then
    v_blockers := v_blockers || 'unresolved_evidence_conflict'::text;
  end if;
  -- The catalogue relationship, live (never the stored suggestion).
  if v_review.tmdb_id is not null then
    select m.* into v_movie from public.movies m where m.tmdb_id = v_review.tmdb_id;
    if found and v_movie.publication_status = 'archived' then
      v_blockers := v_blockers || 'title_archived'::text;
    end if;
    if found and v_review.vj_id is not null and exists (
      select 1 from public.movie_versions mv where mv.movie_id = v_movie.id and mv.vj_id = v_review.vj_id
        and mv.part_number = private.channel_movie_part(p_event_id)
        and mv.telegram_media_id is distinct from v_media.id
    ) then
      v_blockers := v_blockers || 'existing_version_replacement_requires_separate_workflow'::text;
    end if;
  end if;
  if v_event.status <> 'published' and exists (select 1 from public.movie_versions mv where mv.telegram_media_id = v_media.id) then
    v_blockers := v_blockers || 'media_already_linked'::text;
  end if;
  return v_blockers;
end;
$$;$multipart_function$;
  end if;
end $multipart_policy$;

-- Both fixed definitions are reviewed code; no caller supplies dynamic SQL.
do $multipart_view$ begin
  if to_regprocedure('private.channel_rights_status(bigint)') is not null then
    execute $multipart_function$create or replace function private.channel_view(p_event_id bigint, p_detail boolean)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
  v_view jsonb;
begin
  select e.* into v_event from private.ingestion_events e where e.id = p_event_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = p_event_id;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);
  v_view := jsonb_build_object(
    'key', v_review.discovery_key,
    'revision', v_review.review_revision,
    'status', v_event.status,
    'error_code', v_event.error_code,
    'attempts', v_event.attempt_count,
    'first_seen', v_event.received_at,
    'last_seen', v_review.updated_at,
    'event', jsonb_build_object(
      'event_id', v_review.event_id, 'payload_digest', v_review.payload_digest,
      'chat_id', v_media.chat_id, 'message_id', v_media.message_id,
      'update_id', v_event.telegram_update_id, 'kind', v_event.update_kind, 'observed_at', v_review.observed_at,
      'file_unique_id', v_media.file_unique_id, 'size', v_media.file_size_bytes, 'name', v_media.file_name,
      'mime', v_media.mime_type, 'caption', v_media.caption),
    'identity', v_identity,
    'identity_state', v_review.identity_state,
    'title', case when private.channel_movie_part(p_event_id)>0 then v_review.title || ' — Part ' || private.channel_movie_part(p_event_id)::text else v_review.title end, 'year', v_review.release_year, 'vj_text', v_review.vj_text,
    'warnings', to_jsonb(v_review.warnings),
    'tmdb_id', v_review.tmdb_id,
    'vj', (select jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.is_active)
           from public.vjs v where v.id = v_review.vj_id),
    'relation', private.channel_relation(v_review.tmdb_id, v_review.vj_id, private.channel_movie_part(p_event_id)),
    'movie_id', (select m.id from public.movies m where m.tmdb_id = v_review.tmdb_id),
    'duplicate_of', (select private.discovery_message_key(d.chat_id, d.message_id) from private.telegram_media d
                     where d.id = v_review.duplicate_of_media_id),
    'snapshot', (select c.snapshot from private.metadata_match_candidates c
                 where c.ingestion_event_id = p_event_id and c.tmdb_id = v_review.tmdb_id and c.tmdb_media_type = 'movie'),
    'evidence', (select jsonb_build_object(
                   'identity', ev.media_identity, 'verified', ev.verified, 'method', ev.method, 'scope', ev.scope,
                   'policy_version', ev.policy_version, 'media_class', ev.media_class, 'reasons', to_jsonb(ev.reasons),
                   'container', ev.container, 'video_codec', ev.video_codec, 'audio_codec', ev.audio_codec,
                   'accessible', ev.accessible, 'gateway_compatible', ev.gateway_compatible,
                   'playback_ready', ev.playback_ready, 'bytes_read', ev.bytes_read, 'checked_at', ev.checked_at,
                   'integrity_status',ev.integrity_status,'streaming_status',ev.streaming_status,
                   'browser_profile',ev.browser_profile,'download_status',ev.download_status,
                   'tracks',ev.tracks,'warnings',ev.warnings,'assessment',ev.assessment,
                   'publishable_media',private.media_evidence_publishable(ev),
                   'known_failure',private.media_evidence_known_failure(ev))
                 from private.channel_current_evidence(v_media.id) ev),
    -- The worker's last inspection result (fixed codes) and, while a failed
    -- inspection waits for its backoff, when it runs again.
    'inspection', jsonb_build_object(
      'retry_at', case when v_event.status = 'failed' then v_review.retry_at end,
      'last', (select jsonb_build_object('at', a.created_at, 'action', a.action, 'detail', a.detail, 'revision', a.review_revision)
               from private.channel_review_audit a
               where a.ingestion_event_id = p_event_id and a.actor_kind = 'worker'
                 and a.action in ('inspected', 'media_inspected', 'inspection_failed', 'inspection_blocked')
               order by a.id desc limit 1)),
    'rights', (select jsonb_build_object('reference', rc.reference, 'cleared_by', rc.cleared_by, 'cleared_at', rc.cleared_at,
                                         'revision', rc.review_revision, 'document_sha256', rc.document_sha256)
               from private.rights_clearances rc
               where rc.ingestion_event_id = p_event_id and rc.review_revision = v_review.review_revision
                 and rc.media_identity = v_identity),
    'rights_status', private.channel_rights_status(p_event_id),
    'media_inspection_mode', private.media_inspection_mode(),
    'approval', case when v_review.approved_revision is null then null else jsonb_build_object(
                  'revision', v_review.approved_revision, 'by', v_review.approved_by, 'at', v_review.approved_at) end,
    'publication', (select jsonb_build_object('movie_slug', m.slug, 'version_id', mv.id, 'published_at', v_review.published_at)
                    from public.movie_versions mv join public.movies m on m.id = mv.movie_id
                    where v_event.status = 'published' and mv.telegram_media_id = v_media.id),
    'blockers', to_jsonb(private.channel_review_blockers(p_event_id)));
  if p_detail then
    v_view := v_view || jsonb_build_object(
      'choices', coalesce((select jsonb_agg(c.snapshot order by c.score desc, c.tmdb_id)
                           from private.metadata_match_candidates c
                           where c.ingestion_event_id = p_event_id and c.snapshot is not null and c.decision <> 'superseded'), '[]'::jsonb),
      'vjs', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.is_active) order by v.sort_order, v.id)
                       from public.vjs v where v.is_active), '[]'::jsonb),
      'rights_submissions', coalesce((select jsonb_agg(jsonb_build_object(
                                        'id', s.id, 'revision', s.review_revision, 'reference', s.reference,
                                        'document_sha256', s.document_sha256, 'submitted_by', s.submitted_by, 'submitted_at', s.submitted_at,
                                        'decision', s.decision, 'decided_by', s.decided_by, 'decided_at', s.decided_at,
                                        'current', s.review_revision = v_review.review_revision and s.media_identity = v_identity) order by s.id desc)
                                      from (select * from private.rights_submissions x where x.ingestion_event_id = p_event_id
                                            order by x.id desc limit 50) s), '[]'::jsonb),
      'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.created_at, 'actor_kind', a.actor_kind, 'actor', a.actor,
                                                             'action', a.action, 'revision', a.review_revision, 'detail', a.detail) order by a.id)
                         from (select * from private.channel_review_audit x where x.ingestion_event_id = p_event_id
                               order by x.id desc limit 200) a), '[]'::jsonb));
  end if;
  return v_view;
end;
$$;$multipart_function$;
  else
    execute $multipart_function$create or replace function private.channel_view(p_event_id bigint, p_detail boolean)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
  v_view jsonb;
begin
  select e.* into v_event from private.ingestion_events e where e.id = p_event_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = p_event_id;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);
  v_view := jsonb_build_object(
    'key', v_review.discovery_key,
    'revision', v_review.review_revision,
    'status', v_event.status,
    'error_code', v_event.error_code,
    'attempts', v_event.attempt_count,
    'first_seen', v_event.received_at,
    'last_seen', v_review.updated_at,
    'event', jsonb_build_object(
      'event_id', v_review.event_id, 'payload_digest', v_review.payload_digest,
      'chat_id', v_media.chat_id, 'message_id', v_media.message_id,
      'update_id', v_event.telegram_update_id, 'kind', v_event.update_kind, 'observed_at', v_review.observed_at,
      'file_unique_id', v_media.file_unique_id, 'size', v_media.file_size_bytes, 'name', v_media.file_name,
      'mime', v_media.mime_type, 'caption', v_media.caption),
    'identity', v_identity,
    'identity_state', v_review.identity_state,
    'title', case when private.channel_movie_part(p_event_id)>0 then v_review.title || ' — Part ' || private.channel_movie_part(p_event_id)::text else v_review.title end, 'year', v_review.release_year, 'vj_text', v_review.vj_text,
    'warnings', to_jsonb(v_review.warnings),
    'tmdb_id', v_review.tmdb_id,
    'vj', (select jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.is_active)
           from public.vjs v where v.id = v_review.vj_id),
    'relation', private.channel_relation(v_review.tmdb_id, v_review.vj_id, private.channel_movie_part(p_event_id)),
    'movie_id', (select m.id from public.movies m where m.tmdb_id = v_review.tmdb_id),
    'duplicate_of', (select private.discovery_message_key(d.chat_id, d.message_id) from private.telegram_media d
                     where d.id = v_review.duplicate_of_media_id),
    'snapshot', (select c.snapshot from private.metadata_match_candidates c
                 where c.ingestion_event_id = p_event_id and c.tmdb_id = v_review.tmdb_id and c.tmdb_media_type = 'movie'),
    'evidence', (select jsonb_build_object(
                   'identity', ev.media_identity, 'verified', ev.verified, 'method', ev.method, 'scope', ev.scope,
                   'policy_version', ev.policy_version, 'media_class', ev.media_class, 'reasons', to_jsonb(ev.reasons),
                   'container', ev.container, 'video_codec', ev.video_codec, 'audio_codec', ev.audio_codec,
                   'accessible', ev.accessible, 'gateway_compatible', ev.gateway_compatible,
                   'playback_ready', ev.playback_ready, 'bytes_read', ev.bytes_read, 'checked_at', ev.checked_at,
                   'integrity_status',ev.integrity_status,'streaming_status',ev.streaming_status,
                   'browser_profile',ev.browser_profile,'download_status',ev.download_status,
                   'tracks',ev.tracks,'warnings',ev.warnings,'assessment',ev.assessment,
                   'publishable_media',private.media_evidence_publishable(ev))
                 from private.channel_current_evidence(v_media.id) ev),
    -- The worker's last inspection result (fixed codes) and, while a failed
    -- inspection waits for its backoff, when it runs again.
    'inspection', jsonb_build_object(
      'retry_at', case when v_event.status = 'failed' then v_review.retry_at end,
      'last', (select jsonb_build_object('at', a.created_at, 'action', a.action, 'detail', a.detail, 'revision', a.review_revision)
               from private.channel_review_audit a
               where a.ingestion_event_id = p_event_id and a.actor_kind = 'worker'
                 and a.action in ('inspected', 'media_inspected', 'inspection_failed', 'inspection_blocked')
               order by a.id desc limit 1)),
    'rights', (select jsonb_build_object('reference', rc.reference, 'cleared_by', rc.cleared_by, 'cleared_at', rc.cleared_at,
                                         'revision', rc.review_revision)
               from private.rights_clearances rc
               where rc.ingestion_event_id = p_event_id and rc.review_revision = v_review.review_revision
                 and rc.media_identity = v_identity),
    'approval', case when v_review.approved_revision is null then null else jsonb_build_object(
                  'revision', v_review.approved_revision, 'by', v_review.approved_by, 'at', v_review.approved_at) end,
    'publication', (select jsonb_build_object('movie_slug', m.slug, 'version_id', mv.id, 'published_at', v_review.published_at)
                    from public.movie_versions mv join public.movies m on m.id = mv.movie_id
                    where v_event.status = 'published' and mv.telegram_media_id = v_media.id),
    'blockers', to_jsonb(private.channel_review_blockers(p_event_id)));
  if p_detail then
    v_view := v_view || jsonb_build_object(
      'choices', coalesce((select jsonb_agg(c.snapshot order by c.score desc, c.tmdb_id)
                           from private.metadata_match_candidates c
                           where c.ingestion_event_id = p_event_id and c.snapshot is not null and c.decision <> 'superseded'), '[]'::jsonb),
      'vjs', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.is_active) order by v.sort_order, v.id)
                       from public.vjs v where v.is_active), '[]'::jsonb),
      'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.created_at, 'actor_kind', a.actor_kind, 'actor', a.actor,
                                                             'action', a.action, 'revision', a.review_revision, 'detail', a.detail) order by a.id)
                         from (select * from private.channel_review_audit x where x.ingestion_event_id = p_event_id
                               order by x.id desc limit 200) a), '[]'::jsonb));
  end if;
  return v_view;
end;
$$;$multipart_function$;
  end if;
end $multipart_view$;


-- Every helper is owner-only: commands remain behind the existing reviewer capabilities.
revoke all on function private.movie_file_part(text,text,integer),private.channel_movie_part(bigint),
  private.channel_relation(integer,bigint,smallint),private.catalogue_materialize_movie_version(integer,bigint,bigint,jsonb),
  private.channel_review_blockers(bigint),private.channel_view(bigint,boolean)
from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
-- Older callers without a file context refer to the whole-film version (0).
create or replace function private.channel_relation(p_tmdb_id integer,p_vj_id bigint)
returns text language sql stable security invoker set search_path = '' as $$
 select private.channel_relation(p_tmdb_id,p_vj_id,0::smallint)
$$;
revoke all on function private.channel_relation(integer,bigint) from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
create or replace function catalogue_review.approve_channel_candidate(p_key text, p_revision integer, p_reviewer uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_blockers text[];
begin
  if p_revision is null then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  if not private.reviewer_has(p_reviewer, 'review') then
    raise exception 'review_not_authorized' using errcode = '42501';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status = 'matched' and v_review.approved_revision = p_revision then
    return private.channel_view(v_id, false);
  end if;
  if v_event.status <> 'needs_review' then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  v_blockers := private.channel_review_blockers(v_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'review_gates_not_met' using errcode = 'P0001', detail = pg_catalog.array_to_string(v_blockers, ',');
  end if;
  if private.channel_relation(v_review.tmdb_id, v_review.vj_id, private.channel_movie_part(v_id)) not in ('new_movie', 'new_vj', 'new_part') then
    raise exception 'review_gates_not_met' using errcode = 'P0001', detail = 'catalogue_relationship_unconfirmed';
  end if;
  -- Other choices stay pending, so a later correction can still select them.
  update private.metadata_match_candidates c set decision = 'approved', decided_at = now(), decided_by = p_reviewer
  where c.ingestion_event_id = v_id and c.decision = 'pending' and c.tmdb_media_type = 'movie' and c.tmdb_id = v_review.tmdb_id;
  update private.channel_reviews r
  set approved_revision = p_revision, approved_by = p_reviewer, approved_at = now()
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e set status = 'matched' where e.id = v_id;
  perform private.channel_audit(v_id, p_revision, p_reviewer, 'approved');
  return private.channel_view(v_id, false);
end;
$$;
revoke all on function catalogue_review.approve_channel_candidate(text,integer,uuid) from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;
grant execute on function catalogue_review.approve_channel_candidate(text,integer,uuid) to velora_review_service;
-- Admin uploads are optional and must not be introduced by this migration.
do $multipart_admin$ begin
  if to_regprocedure('public.admin_upload_r2_review(uuid,integer,text,text,timestamptz)') is not null then
    execute $multipart_function$create or replace function public.admin_upload_r2_review(p_id uuid,p_revision integer,p_action text,p_reference text default null,p_expires_at timestamptz default null)
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
        where m.tmdb_id=(s.metadata->'snapshot'->>'tmdb_id')::integer and mv.vj_id=(s.metadata->>'vjId')::bigint and mv.part_number=greatest(private.movie_file_part(s.file_name,s.metadata->'snapshot'->>'title',extract(year from (s.metadata->'snapshot'->>'release_date')::date)::integer),private.movie_file_part(s.file_name,s.metadata->'snapshot'->>'original_title',extract(year from (s.metadata->'snapshot'->>'release_date')::date)::integer))) then raise exception 'catalogue_version_conflict' using errcode='P0001'; end if;
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
revoke all on function public.admin_upload_r2_review(uuid,integer,text,text,timestamptz) from public,anon,authenticated,service_role,velora_upload_worker,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.admin_upload_r2_review(uuid,integer,text,text,timestamptz) to authenticated;
$multipart_function$;
  end if;
end $multipart_admin$;
commit;
