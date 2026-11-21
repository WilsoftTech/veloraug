-- Series review queue: Series-channel files that no owner workflow has published wait here for a
-- reviewer, who enters the series details by hand when TMDB has no record (title, description, first
-- air date, genres and an uploaded poster), assigns each file to a season and episode with a VJ, records
-- the rights decision and publishes. Manual details are an explicit reviewer decision, never a
-- fabricated TMDB id: manual series and their episodes keep tmdb_id null.
--
-- Gates are unchanged from owner episode publication: current, publishable whole-file evidence for the
-- exact document, an active VJ, and the Series bot's media in the registered Series channel. Rights are
-- recorded per file at a review revision; any later change to the assignment makes them stale.
--
-- Capabilities (private.require_reviewer): any to list, review to edit details and assign, rights to
-- record the decision, publish to publish (and to edit a series that is already public).
--
-- Privileges are set explicitly below (AGENTS.md migration privilege invariant).
begin;

-- ---------------------------------------------------------------------------
-- Tables (private: no client grants)
-- ---------------------------------------------------------------------------
create table private.series_episode_reviews (
  telegram_media_id bigint primary key references private.telegram_media(id) on delete restrict,
  revision integer not null default 1 check (revision > 0),
  series_id bigint references public.series(id) on delete restrict,
  season_number integer check (season_number between 0 and 999),
  episode_number integer check (episode_number between 1 and 9999),
  episode_title text check (episode_title is null or (episode_title = btrim(episode_title) and char_length(episode_title) between 1 and 300)),
  episode_overview text check (episode_overview is null or char_length(episode_overview) between 1 and 10000),
  vj_id bigint references public.vjs(id) on delete restrict,
  rights_cleared_revision integer,
  rights_cleared_by uuid,
  rights_cleared_at timestamptz,
  episode_version_id bigint unique references public.episode_versions(id) on delete restrict,
  published_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint series_episode_reviews_assignment_check check (
    (series_id is null) = (season_number is null) and (series_id is null) = (episode_number is null) and (series_id is null) = (vj_id is null)),
  constraint series_episode_reviews_rights_check check (
    (rights_cleared_revision is null) = (rights_cleared_by is null) and (rights_cleared_revision is null) = (rights_cleared_at is null)),
  constraint series_episode_reviews_published_check check ((published_at is null) = (episode_version_id is null))
);
create index series_episode_reviews_series_idx on private.series_episode_reviews (series_id) where series_id is not null;

create table private.series_review_audit (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null check (action ~ '^[a-z0-9_]{1,60}$'),
  telegram_media_id bigint,
  series_id bigint,
  revision integer,
  created_at timestamptz not null default now()
);
create index series_review_audit_media_idx on private.series_review_audit (telegram_media_id, id);

alter table private.series_episode_reviews enable row level security;
alter table private.series_review_audit enable row level security;
revoke all on table private.series_episode_reviews, private.series_review_audit from public, anon, authenticated, service_role;
revoke all on sequence private.series_review_audit_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers (private, SECURITY INVOKER; no API role may execute)
-- ---------------------------------------------------------------------------
-- Manual series details: exactly these keys, with the movie rules for text, dates, genres and artwork.
create function private.manual_series_metadata_valid(p jsonb) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 20000 then return false; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from
     array['backdrop_path','first_air_date','genres','original_title','overview','poster_path','title'] then return false; end if;
  if jsonb_typeof(p->'title') <> 'string' or char_length(btrim(p->>'title')) not between 1 and 300
     or jsonb_typeof(p->'first_air_date') <> 'string' or (p->>'first_air_date') !~ '^(18[7-9][0-9]|19[0-9]{2}|2[01][0-9]{2})-[0-9]{2}-[0-9]{2}$'
     or jsonb_typeof(p->'overview') not in ('null','string') or char_length(coalesce(p->>'overview','')) > 10000
     or jsonb_typeof(p->'original_title') not in ('null','string') or char_length(coalesce(p->>'original_title','')) > 300
     or jsonb_typeof(p->'genres') <> 'array' or jsonb_array_length(p->'genres') > 20 then return false; end if;
  perform (p->>'first_air_date')::date;
  if exists (select 1 from jsonb_array_elements(p->'genres') g where jsonb_typeof(g) <> 'string'
       or char_length(btrim(g #>> '{}')) not between 1 and 80 or private.catalogue_slug(g #>> '{}') = '') then return false; end if;
  if exists (select 1 from (values (p->'poster_path'), (p->'backdrop_path')) x(v) where jsonb_typeof(v) not in ('null','string')
       or (jsonb_typeof(v) = 'string' and (v #>> '{}') !~ '^(/[A-Za-z0-9_.-]{1,200}|/posters/[a-f0-9-]{36}\.webp)$')) then return false; end if;
  return true;
exception when others then return false;
end $$;

create function private.manual_series_metadata(p_id bigint) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('title', s.title, 'original_title', s.original_title, 'overview', s.overview,
    'first_air_date', s.first_air_date, 'poster_path', s.poster_path, 'backdrop_path', s.backdrop_path,
    'genres', coalesce((select jsonb_agg(g.name order by g.name) from public.series_genres sg join public.genres g on g.id = sg.genre_id where sg.series_id = s.id), '[]'::jsonb))
  from public.series s where s.id = p_id
$$;

-- The Series-bot media in the registered Series channel, locked for the transaction, or an error.
create function private.series_review_media(p_media_id bigint) returns private.telegram_media
language plpgsql security invoker set search_path = '' as $$
declare v private.telegram_media%rowtype;
begin
  select m.* into v from private.telegram_media m where m.id = p_media_id for update;
  if not found or v.bot_type <> 'series' or coalesce(v.file_size_bytes, 0) <= 0
     or not exists (select 1 from private.telegram_channels c where c.bot_type = 'series' and c.chat_id = v.chat_id) then
    raise exception 'catalogue_media_not_registered' using errcode = 'P0001';
  end if;
  return v;
end $$;

-- One queue item: file facts (never the chat id or file id), verification, assignment, rights, publication.
create function private.series_review_item(p_media_id bigint) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'media_id', m.id, 'post', m.message_id, 'file_name', m.file_name, 'file_size_bytes', m.file_size_bytes, 'mime_type', m.mime_type,
    'received_at', m.created_at,
    'verification', (select jsonb_build_object('scope', ev.scope, 'integrity', ev.integrity_status, 'streaming', ev.streaming_status,
        'publishable', private.media_evidence_publishable(ev) and ev.scope = 'whole_file' and ev.bytes_read >= m.file_size_bytes,
        'reasons', to_jsonb(ev.reasons), 'checked_at', ev.checked_at)
      from private.channel_current_evidence(m.id) ev),
    'job', (select jsonb_build_object('attempts', j.attempts, 'error', j.error_code, 'running', j.lease_until > now(), 'completed', j.completed_at is not null)
      from private.media_verification_jobs j where j.telegram_media_id = m.id),
    'revision', coalesce(r.revision, 0),
    'series_id', r.series_id, 'season_number', r.season_number, 'episode_number', r.episode_number,
    'episode_title', r.episode_title, 'episode_overview', r.episode_overview, 'vj_id', r.vj_id,
    'rights_cleared', r.rights_cleared_revision is not null and r.rights_cleared_revision = r.revision,
    'published_at', r.published_at, 'episode_version_id', r.episode_version_id)
  from private.telegram_media m left join private.series_episode_reviews r on r.telegram_media_id = m.id
  where m.id = p_media_id
$$;

-- ---------------------------------------------------------------------------
-- Reviewer commands (SECURITY DEFINER; the caller's capability is checked first)
-- ---------------------------------------------------------------------------
-- The queue: every Series-channel file without a published episode version, and every file published
-- through this queue, newest first; plus the manually entered series to assign them to.
create function public.series_review_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_reviewer('any');
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.series_review_item(m.id) order by m.message_id desc)
      from private.telegram_media m
      join private.telegram_channels c on c.bot_type = 'series' and c.chat_id = m.chat_id
      where m.bot_type = 'series'
        and (not exists (select 1 from public.episode_versions v where v.telegram_media_id = m.id)
             or exists (select 1 from private.series_episode_reviews r where r.telegram_media_id = m.id and r.published_at is not null))), '[]'::jsonb),
    'series', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'slug', s.slug, 'publication_status', s.publication_status,
        'updated_at', s.updated_at, 'manual', s.tmdb_id is null, 'metadata', private.manual_series_metadata(s.id)) order by s.title, s.id)
      from public.series s where s.publication_status <> 'archived'), '[]'::jsonb),
    'vjs', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name) order by v.name, v.id) from public.vjs v where v.is_active), '[]'::jsonb));
end $$;

-- Creates (p_series_id null) or edits a manually entered series. A TMDB-backed series is never edited here.
create function public.series_review_save_series(p_series_id bigint, p_updated_at timestamptz, p_metadata jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_reviewer('review');
  s public.series%rowtype;
  v_slug text;
  g text;
  gid bigint;
begin
  if not private.manual_series_metadata_valid(p_metadata) then raise exception 'manual_metadata_invalid' using errcode = '22023'; end if;
  if p_series_id is null then
    v_slug := private.catalogue_slug(p_metadata->>'title');
    if v_slug = '' then raise exception 'catalogue_slug_unavailable' using errcode = 'P0001'; end if;
    v_slug := v_slug || '-' || extract(year from (p_metadata->>'first_air_date')::date)::integer;
    if exists (select 1 from public.series x where x.slug = v_slug) then
      v_slug := v_slug || '-' || left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 6);
    end if;
    insert into public.series (slug, title) values (v_slug, btrim(p_metadata->>'title')) returning * into s;
  else
    select x.* into s from public.series x where x.id = p_series_id for update;
    if not found then raise exception 'catalogue_not_found' using errcode = 'P0001'; end if;
    if s.tmdb_id is not null or s.publication_status = 'archived' then raise exception 'manual_metadata_use_catalogue' using errcode = 'P0001'; end if;
    if p_updated_at is null or s.updated_at is distinct from p_updated_at then raise exception 'review_stale_revision' using errcode = 'P0001'; end if;
    -- Changing what the public already sees needs the publish capability.
    if s.publication_status = 'published' then perform private.require_reviewer('publish'); end if;
  end if;
  update public.series x set title = btrim(p_metadata->>'title'), original_title = nullif(btrim(p_metadata->>'original_title'), ''),
    overview = nullif(btrim(p_metadata->>'overview'), ''), first_air_date = (p_metadata->>'first_air_date')::date,
    poster_path = p_metadata->>'poster_path', backdrop_path = p_metadata->>'backdrop_path',
    metadata_status = 'reviewed', metadata_synced_at = now(), updated_at = now()
  where x.id = s.id returning * into s;
  delete from public.series_genres where series_id = s.id;
  for g in select distinct btrim(value) from jsonb_array_elements_text(p_metadata->'genres') loop
    insert into public.genres (slug, name) values (private.catalogue_slug(g), g) on conflict do nothing;
    select id into gid from public.genres where slug = private.catalogue_slug(g);
    insert into public.series_genres (series_id, genre_id) values (s.id, gid) on conflict do nothing;
  end loop;
  insert into private.series_review_audit (actor, action, series_id) values (actor, case when p_series_id is null then 'series_created' else 'series_edited' end, s.id);
  return jsonb_build_object('id', s.id, 'slug', s.slug, 'publication_status', s.publication_status, 'updated_at', s.updated_at, 'manual', true,
    'metadata', private.manual_series_metadata(s.id));
end $$;

-- Assigns a file to a series, season, episode and VJ (or clears the assignment with p_series_id null).
-- Every change is a new revision, so a rights decision recorded earlier no longer applies.
create function public.series_review_assign(p_media_id bigint, p_revision integer, p_series_id bigint, p_season_number integer,
  p_episode_number integer, p_episode_title text, p_episode_overview text, p_vj_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_reviewer('review');
  r private.series_episode_reviews%rowtype;
begin
  perform private.series_review_media(p_media_id);
  if exists (select 1 from public.episode_versions v where v.telegram_media_id = p_media_id) then raise exception 'review_already_published' using errcode = 'P0001'; end if;
  select x.* into r from private.series_episode_reviews x where x.telegram_media_id = p_media_id for update;
  if coalesce(r.revision, 0) is distinct from p_revision then raise exception 'review_stale_revision' using errcode = 'P0001'; end if;
  if p_series_id is not null then
    if p_season_number is null or p_season_number not between 0 and 999 or p_episode_number is null or p_episode_number not between 1 and 9999
       or (p_episode_title is not null and (p_episode_title <> btrim(p_episode_title) or char_length(p_episode_title) not between 1 and 300))
       or (p_episode_overview is not null and char_length(p_episode_overview) not between 1 and 10000) then
      raise exception 'catalogue_invalid_input' using errcode = '22023';
    end if;
    if not exists (select 1 from public.series s where s.id = p_series_id and s.publication_status <> 'archived') then raise exception 'review_selection_unavailable' using errcode = 'P0001'; end if;
    if not exists (select 1 from public.vjs v where v.id = p_vj_id and v.is_active) then raise exception 'catalogue_vj_not_active' using errcode = 'P0001'; end if;
    -- One file per episode and VJ, in the queue and in the catalogue.
    if exists (select 1 from private.series_episode_reviews x where x.telegram_media_id <> p_media_id and x.series_id = p_series_id
                 and x.season_number = p_season_number and x.episode_number = p_episode_number and x.vj_id = p_vj_id)
       or exists (select 1 from public.episode_versions v join public.episodes e on e.id = v.episode_id join public.seasons s on s.id = e.season_id
                 where s.series_id = p_series_id and s.season_number = p_season_number and e.episode_number = p_episode_number and v.vj_id = p_vj_id) then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end if;
  elsif p_season_number is not null or p_episode_number is not null or p_episode_title is not null or p_episode_overview is not null or p_vj_id is not null then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;
  insert into private.series_episode_reviews as x (telegram_media_id, revision, series_id, season_number, episode_number, episode_title, episode_overview, vj_id, updated_by, updated_at)
  values (p_media_id, 1, p_series_id, p_season_number, p_episode_number, p_episode_title, p_episode_overview, p_vj_id, actor, now())
  on conflict (telegram_media_id) do update set revision = x.revision + 1, series_id = excluded.series_id, season_number = excluded.season_number,
    episode_number = excluded.episode_number, episode_title = excluded.episode_title, episode_overview = excluded.episode_overview,
    vj_id = excluded.vj_id, updated_by = actor, updated_at = now();
  insert into private.series_review_audit (actor, action, telegram_media_id, series_id, revision)
  values (actor, case when p_series_id is null then 'assignment_cleared' else 'assigned' end, p_media_id, p_series_id, p_revision + 1);
  return private.series_review_item(p_media_id);
end $$;

-- Records (true) or withdraws (false) the rights decision for the file at its current revision.
create function public.series_review_rights(p_media_id bigint, p_revision integer, p_cleared boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_reviewer('rights');
  r private.series_episode_reviews%rowtype;
begin
  perform private.series_review_media(p_media_id);
  select x.* into r from private.series_episode_reviews x where x.telegram_media_id = p_media_id for update;
  if not found or r.revision is distinct from p_revision then raise exception 'review_stale_revision' using errcode = 'P0001'; end if;
  if r.published_at is not null then raise exception 'review_already_published' using errcode = 'P0001'; end if;
  if p_cleared is null or (p_cleared and r.series_id is null) then raise exception 'review_illegal_transition' using errcode = 'P0001'; end if;
  update private.series_episode_reviews x set
    rights_cleared_revision = case when p_cleared then r.revision end,
    rights_cleared_by = case when p_cleared then actor end,
    rights_cleared_at = case when p_cleared then now() end
  where x.telegram_media_id = p_media_id;
  insert into private.series_review_audit (actor, action, telegram_media_id, series_id, revision)
  values (actor, case when p_cleared then 'rights_cleared' else 'rights_withdrawn' end, p_media_id, r.series_id, r.revision);
  return private.series_review_item(p_media_id);
end $$;

-- Publishes one assigned, rights-cleared, verified file as an episode version; publishes its series.
create function public.series_review_publish(p_media_id bigint, p_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := private.require_reviewer('publish');
  r private.series_episode_reviews%rowtype;
  m private.telegram_media%rowtype;
  ev private.media_evidence%rowtype;
  s public.series%rowtype;
  v_season public.seasons%rowtype;
  v_episode public.episodes%rowtype;
  v_version public.episode_versions%rowtype;
begin
  m := private.series_review_media(p_media_id);
  select x.* into r from private.series_episode_reviews x where x.telegram_media_id = p_media_id for update;
  if not found or r.revision is distinct from p_revision then raise exception 'review_stale_revision' using errcode = 'P0001'; end if;
  if r.published_at is not null then raise exception 'review_already_published' using errcode = 'P0001'; end if;
  if r.series_id is null then raise exception 'review_illegal_transition' using errcode = 'P0001'; end if;
  if r.rights_cleared_revision is distinct from r.revision then raise exception 'rights_not_cleared' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.vjs v where v.id = r.vj_id and v.is_active) then raise exception 'catalogue_vj_not_active' using errcode = 'P0001'; end if;
  if exists (select 1 from public.episode_versions v where v.telegram_media_id = p_media_id) then raise exception 'catalogue_version_conflict' using errcode = 'P0001'; end if;

  -- Current, publishable whole-file evidence for exactly this document.
  lock table private.media_evidence in share mode;
  select e.* into ev from private.channel_current_evidence(p_media_id) e;
  if not found or ev.scope <> 'whole_file' or not private.media_evidence_publishable(ev) or ev.bytes_read < m.file_size_bytes then
    raise exception 'catalogue_media_not_verified' using errcode = 'P0001';
  end if;

  select x.* into s from public.series x where x.id = r.series_id for update;
  if not found or s.publication_status = 'archived' then raise exception 'catalogue_title_archived' using errcode = 'P0001'; end if;

  select x.* into v_season from public.seasons x where x.series_id = s.id and x.season_number = r.season_number for update;
  if not found then
    insert into public.seasons (series_id, season_number) values (s.id, r.season_number) returning * into v_season;
  end if;
  select x.* into v_episode from public.episodes x where x.season_id = v_season.id and x.episode_number = r.episode_number for update;
  if not found then
    insert into public.episodes (season_id, episode_number, title, overview)
    values (v_season.id, r.episode_number, r.episode_title, r.episode_overview) returning * into v_episode;
  elsif v_episode.tmdb_id is null and (r.episode_title is not null or r.episode_overview is not null) then
    -- A manual episode takes the reviewer's latest title and description; a TMDB episode keeps TMDB's.
    update public.episodes x set title = coalesce(r.episode_title, x.title), overview = coalesce(r.episode_overview, x.overview), updated_at = now()
    where x.id = v_episode.id returning * into v_episode;
  end if;
  begin
    insert into public.episode_versions (episode_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
    values (v_episode.id, r.vj_id, 'ready', 'cleared', now(), p_media_id) returning * into v_version;
  exception when unique_violation then
    raise exception 'catalogue_version_conflict' using errcode = 'P0001';
  end;
  if s.publication_status = 'draft' then
    update public.series x set publication_status = 'published', published_at = coalesce(x.published_at, now()), updated_at = now() where x.id = s.id;
  end if;
  update private.series_episode_reviews x set episode_version_id = v_version.id, published_at = now(), updated_by = actor, updated_at = now()
  where x.telegram_media_id = p_media_id;
  insert into private.series_review_audit (actor, action, telegram_media_id, series_id, revision) values (actor, 'published', p_media_id, s.id, r.revision);
  return private.series_review_item(p_media_id) || jsonb_build_object('series_slug', s.slug);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function private.manual_series_metadata_valid(jsonb), private.manual_series_metadata(bigint),
  private.series_review_media(bigint), private.series_review_item(bigint)
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
revoke all on function public.series_review_queue(), public.series_review_save_series(bigint, timestamptz, jsonb),
  public.series_review_assign(bigint, integer, bigint, integer, integer, text, text, bigint),
  public.series_review_rights(bigint, integer, boolean), public.series_review_publish(bigint, integer)
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
-- Signed-in reviewers only: each command checks the caller's capability before anything else.
grant execute on function public.series_review_queue(), public.series_review_save_series(bigint, timestamptz, jsonb),
  public.series_review_assign(bigint, integer, bigint, integer, integer, text, text, bigint),
  public.series_review_rights(bigint, integer, boolean), public.series_review_publish(bigint, integer)
  to authenticated;

do $$ begin
  if to_regrole('velora_upload_worker') is not null then
    execute 'revoke all on table private.series_episode_reviews, private.series_review_audit from velora_upload_worker';
    execute 'revoke all on function private.manual_series_metadata_valid(jsonb), private.manual_series_metadata(bigint), private.series_review_media(bigint), private.series_review_item(bigint), public.series_review_queue(), public.series_review_save_series(bigint, timestamptz, jsonb), public.series_review_assign(bigint, integer, bigint, integer, integer, text, text, bigint), public.series_review_rights(bigint, integer, boolean), public.series_review_publish(bigint, integer) from velora_upload_worker';
  end if;
end $$;

comment on table private.series_episode_reviews is 'Reviewer assignment, rights decision and publication of Series-channel files outside owner workflows.';
comment on function public.series_review_publish(bigint, integer) is
  'Publish capability: publishes one assigned, rights-cleared Series-channel file with current publishable whole-file evidence as an episode version.';

commit;
