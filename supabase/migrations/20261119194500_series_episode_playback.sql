-- Series support: episodes become playable through the same boundaries as movies.
--
-- 1. media_gateway.resolve_episode_version: the gateway's episode resolver. Same
--    five transport fields and the same publication rule as resolve_movie_version
--    (published title, ready + cleared version, active VJ, media in the
--    registered channel), applied to series -> season -> episode -> version and
--    to Series-bot media in the registered Series channel.
-- 2. public.media_verification_claim_v2: the media-only verification queue,
--    extended to Series-channel media for a worker that says it can read that
--    channel. The original claim is unchanged, so a movie-only worker never
--    receives a document it cannot read.
-- 3. private.catalogue_publish_episode: the owner's episode publication, the
--    series counterpart of catalogue_publish_movie. It requires current,
--    publishable whole-file evidence for the exact media and materializes the
--    series, season, episode and VJ version from reviewed TMDB snapshots.
--
-- No table, column, policy or client grant changes. Every new function's
-- privileges are set explicitly below (AGENTS.md migration privilege invariant).
begin;

-- ---------------------------------------------------------------------------
-- 1. Gateway resolver
-- ---------------------------------------------------------------------------
create function media_gateway.resolve_episode_version(p_episode_version_id bigint)
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
    from public.episode_versions ev
    join public.episodes e on e.id = ev.episode_id
    join public.seasons s on s.id = e.season_id
    join public.series sr on sr.id = s.series_id
    join public.vjs v on v.id = ev.vj_id
    join private.telegram_media tm
      on tm.id = ev.telegram_media_id
     and tm.bot_type = 'series'
    join private.telegram_channels c
      on c.bot_type = 'series'
     and c.chat_id = tm.chat_id
   where p_episode_version_id > 0
     and ev.id = p_episode_version_id
     and sr.publication_status = 'published'
     and sr.published_at is not null
     and ev.availability_status = 'ready'
     and ev.rights_status = 'cleared'
     and v.is_active
     and tm.file_size_bytes > 0
$$;

revoke all on function media_gateway.resolve_episode_version(bigint)
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
grant execute on function media_gateway.resolve_episode_version(bigint) to velora_media_gateway;
comment on function media_gateway.resolve_episode_version(bigint) is
  'Media gateway only: transport fields of a publicly playable episode version in the registered Series channel, else no row.';

-- ---------------------------------------------------------------------------
-- 2. Series-aware media verification claim
-- ---------------------------------------------------------------------------
-- Identical to media_verification_claim (20261018072045) except for the bot
-- types: the caller names the channels its reader can open, and each document
-- must sit in the registered channel of its own bot type.
create function public.media_verification_claim_v2(p_token uuid, p_lease_seconds integer, p_retry_seconds integer, p_bot_types text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare m private.telegram_media%rowtype; j private.media_verification_jobs%rowtype; identity text;
begin
  if p_token is null or p_lease_seconds is null or p_lease_seconds not between 60 and 14400
    or p_retry_seconds is null or p_retry_seconds not between 60 and 604800
    or p_bot_types is null or cardinality(p_bot_types) not between 1 and 2
    or not (p_bot_types <@ array['movie','series']) or array_position(p_bot_types, null) is not null then
    raise exception 'media_verification_invalid_input' using errcode='22023';
  end if;
  select t.* into m from private.telegram_media t
  left join private.media_verification_jobs q on q.telegram_media_id=t.id
  cross join lateral (select private.channel_media_identity(t.chat_id,t.message_id,t.file_unique_id,t.file_size_bytes) as value) i
  cross join lateral (select coalesce(max(a.created_at),'-infinity'::timestamptz) as at
    from private.channel_review_audit a join private.ingestion_events e on e.id=a.ingestion_event_id
    where e.telegram_media_id=t.id and a.action='reinspection_requested') requested
  where t.bot_type = any(p_bot_types) and t.file_size_bytes between 1 and 2097152000
    and lower(t.file_name) ~ '\.(mp4|mkv)$' and i.value is not null
    and exists(select 1 from private.telegram_channels c where c.bot_type=t.bot_type and c.chat_id=t.chat_id)
    and (q.lease_until is null or q.lease_until<=now())
    and (q.telegram_media_id is null or q.media_identity<>i.value
      or (q.retry_at<=now() and (q.attempts<5 or q.attempted_at<requested.at)
        and (q.completed_at is null or q.completed_at<requested.at)))
    and not exists(select 1 from private.media_evidence ev where ev.telegram_media_id=t.id
      and ev.media_identity=i.value and ev.scope='whole_file' and ev.checked_at>requested.at)
    and not exists(select 1 from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id=e.id
      where e.telegram_media_id=t.id and r.lease_until>now())
  order by t.created_at,t.id for update of t skip locked limit 1;
  if not found then return null; end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('velora_media_verification:'||m.id,0)) then return null; end if;
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

revoke all on function public.media_verification_claim_v2(uuid,integer,integer,text[])
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
grant execute on function public.media_verification_claim_v2(uuid,integer,integer,text[]) to velora_discovery_worker;
comment on function public.media_verification_claim_v2(uuid,integer,integer,text[]) is
  'Verification worker only: media_verification_claim for the named bot types (movie, series), each in its own registered channel.';

-- ---------------------------------------------------------------------------
-- 3. Owner episode publication
-- ---------------------------------------------------------------------------
-- Snapshot shapes (snake_case, validated here and by the table CHECKs):
--   p_series   { tmdb_id, title, original_title, overview, first_air_date, poster_path, backdrop_path, vote_average, vote_count, genres[{tmdb_id,name}] }
--   p_season   { season_number, title, overview, air_date, poster_path }
--   p_episode  { tmdb_id, episode_number, title, overview, air_date, runtime_minutes, still_path }
-- p_rights_cleared must be true: it records the owner's title-specific rights decision.
create function private.catalogue_publish_episode(
  p_media_id bigint, p_vj_id bigint, p_series jsonb, p_season jsonb, p_episode jsonb, p_rights_cleared boolean)
returns table (series_id bigint, series_slug text, season_id bigint, episode_id bigint, episode_version_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_media private.telegram_media%rowtype;
  v_evidence private.media_evidence%rowtype;
  v_series public.series%rowtype;
  v_season public.seasons%rowtype;
  v_episode public.episodes%rowtype;
  v_version public.episode_versions%rowtype;
  v_slug text;
  v_first_air date;
  v_genre jsonb;
  v_genre_id bigint;
  v_tmdb integer;
  v_season_number integer;
  v_episode_number integer;
begin
  if p_media_id is null or p_vj_id is null or p_rights_cleared is distinct from true
     or jsonb_typeof(p_series) is distinct from 'object' or jsonb_typeof(p_season) is distinct from 'object'
     or jsonb_typeof(p_episode) is distinct from 'object' then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;

  -- Snapshot validation.
  if (select array_agg(k order by k) from jsonb_object_keys(p_series) k) is distinct from
       array['backdrop_path','first_air_date','genres','original_title','overview','poster_path','title','tmdb_id','vote_average','vote_count']
     or (select array_agg(k order by k) from jsonb_object_keys(p_season) k) is distinct from
       array['air_date','overview','poster_path','season_number','title']
     or (select array_agg(k order by k) from jsonb_object_keys(p_episode) k) is distinct from
       array['air_date','episode_number','overview','runtime_minutes','still_path','title','tmdb_id']
     or jsonb_typeof(p_series->'tmdb_id') is distinct from 'number' or (p_series->>'tmdb_id') !~ '^[1-9][0-9]{0,8}$'
     or jsonb_typeof(p_series->'title') is distinct from 'string'
     or jsonb_typeof(p_series->'original_title') not in ('null', 'string')
     or jsonb_typeof(p_series->'overview') not in ('null', 'string')
     or jsonb_typeof(p_series->'first_air_date') not in ('null', 'string')
     or (jsonb_typeof(p_series->'first_air_date') = 'string' and (p_series->>'first_air_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     or jsonb_typeof(p_series->'poster_path') not in ('null', 'string')
     or (jsonb_typeof(p_series->'poster_path') = 'string' and (p_series->>'poster_path') !~ '^/[A-Za-z0-9_.-]{1,200}$')
     or jsonb_typeof(p_series->'backdrop_path') not in ('null', 'string')
     or (jsonb_typeof(p_series->'backdrop_path') = 'string' and (p_series->>'backdrop_path') !~ '^/[A-Za-z0-9_.-]{1,200}$')
     or jsonb_typeof(p_series->'vote_average') not in ('null', 'number')
     or jsonb_typeof(p_series->'vote_count') not in ('null', 'number')
     or jsonb_typeof(p_series->'genres') is distinct from 'array' or jsonb_array_length(p_series->'genres') > 20
     or jsonb_typeof(p_season->'season_number') is distinct from 'number' or (p_season->>'season_number') !~ '^[0-9]{1,4}$'
     or jsonb_typeof(p_season->'title') not in ('null', 'string')
     or jsonb_typeof(p_season->'overview') not in ('null', 'string')
     or jsonb_typeof(p_season->'air_date') not in ('null', 'string')
     or (jsonb_typeof(p_season->'air_date') = 'string' and (p_season->>'air_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     or jsonb_typeof(p_season->'poster_path') not in ('null', 'string')
     or (jsonb_typeof(p_season->'poster_path') = 'string' and (p_season->>'poster_path') !~ '^/[A-Za-z0-9_.-]{1,200}$')
     or jsonb_typeof(p_episode->'tmdb_id') is distinct from 'number' or (p_episode->>'tmdb_id') !~ '^[1-9][0-9]{0,9}$'
     or jsonb_typeof(p_episode->'episode_number') is distinct from 'number' or (p_episode->>'episode_number') !~ '^[1-9][0-9]{0,4}$'
     or jsonb_typeof(p_episode->'title') not in ('null', 'string')
     or jsonb_typeof(p_episode->'overview') not in ('null', 'string')
     or jsonb_typeof(p_episode->'air_date') not in ('null', 'string')
     or (jsonb_typeof(p_episode->'air_date') = 'string' and (p_episode->>'air_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     or jsonb_typeof(p_episode->'runtime_minutes') not in ('null', 'number')
     or (jsonb_typeof(p_episode->'runtime_minutes') = 'number' and (p_episode->>'runtime_minutes') !~ '^[1-9][0-9]{0,3}$')
     or jsonb_typeof(p_episode->'still_path') not in ('null', 'string')
     or (jsonb_typeof(p_episode->'still_path') = 'string' and (p_episode->>'still_path') !~ '^/[A-Za-z0-9_.-]{1,200}$') then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;
  v_tmdb := (p_series->>'tmdb_id')::integer;
  v_first_air := (p_series->>'first_air_date')::date;
  v_season_number := (p_season->>'season_number')::integer;
  v_episode_number := (p_episode->>'episode_number')::integer;

  if not exists (select 1 from public.vjs v where v.id = p_vj_id and v.is_active) then
    raise exception 'catalogue_vj_not_active' using errcode = 'P0001';
  end if;

  -- The media: Series-bot media in the registered Series channel, held for the transaction.
  select m.* into v_media from private.telegram_media m where m.id = p_media_id for share;
  if not found or v_media.bot_type <> 'series' or coalesce(v_media.file_size_bytes, 0) <= 0
     or not exists (select 1 from private.telegram_channels c where c.bot_type = 'series' and c.chat_id = v_media.chat_id) then
    raise exception 'catalogue_media_not_registered' using errcode = 'P0001';
  end if;

  -- Current, publishable whole-file evidence for exactly this document.
  lock table private.media_evidence in share mode;
  select ev.* into v_evidence from private.channel_current_evidence(p_media_id) ev;
  if not found or v_evidence.scope <> 'whole_file' or not private.media_evidence_publishable(v_evidence)
     or v_evidence.bytes_read < v_media.file_size_bytes then
    raise exception 'catalogue_media_not_verified' using errcode = 'P0001';
  end if;

  -- The series: one per TMDB id.
  select s.* into v_series from public.series s where s.tmdb_id = v_tmdb for update;
  if found then
    if v_series.publication_status = 'archived' then
      raise exception 'catalogue_title_archived' using errcode = 'P0001';
    end if;
  else
    v_slug := private.catalogue_slug(p_series->>'title');
    if v_slug = '' then
      raise exception 'catalogue_slug_unavailable' using errcode = 'P0001';
    end if;
    if v_first_air is not null then
      v_slug := v_slug || '-' || extract(year from v_first_air)::integer;
    end if;
    if exists (select 1 from public.series s where s.slug = v_slug) then
      raise exception 'catalogue_slug_conflict' using errcode = 'P0001';
    end if;
    begin
      insert into public.series (
        slug, title, original_title, overview, first_air_date, poster_path, backdrop_path,
        tmdb_id, tmdb_vote_average, tmdb_vote_count, metadata_status, metadata_synced_at)
      values (
        v_slug,
        pg_catalog.btrim(p_series->>'title'),
        nullif(pg_catalog.btrim(p_series->>'original_title'), ''),
        nullif(pg_catalog.btrim(p_series->>'overview'), ''),
        v_first_air,
        p_series->>'poster_path',
        p_series->>'backdrop_path',
        v_tmdb,
        round((p_series->>'vote_average')::numeric, 1),
        (p_series->>'vote_count')::integer,
        'reviewed',
        now())
      returning * into v_series;
    exception when unique_violation then
      raise exception 'catalogue_publication_conflict' using errcode = 'P0001';
    end;

    for v_genre in select value from jsonb_array_elements(p_series->'genres') loop
      if jsonb_typeof(v_genre->'tmdb_id') is distinct from 'number' or (v_genre->>'tmdb_id') !~ '^[1-9][0-9]{0,8}$'
         or jsonb_typeof(v_genre->'name') is distinct from 'string' or private.catalogue_slug(v_genre->>'name') = '' then
        raise exception 'catalogue_invalid_input' using errcode = '22023';
      end if;
      insert into public.genres (slug, name, tmdb_tv_id)
      values (private.catalogue_slug(v_genre->>'name'), pg_catalog.btrim(v_genre->>'name'), (v_genre->>'tmdb_id')::integer)
      on conflict do nothing;
      select g.id into v_genre_id from public.genres g
      where g.tmdb_tv_id = (v_genre->>'tmdb_id')::integer
         or (g.tmdb_tv_id is null and pg_catalog.lower(g.name) = pg_catalog.lower(pg_catalog.btrim(v_genre->>'name')))
      order by (g.tmdb_tv_id is null), g.id
      limit 1;
      if v_genre_id is not null then
        insert into public.series_genres (series_id, genre_id) values (v_series.id, v_genre_id) on conflict do nothing;
      end if;
    end loop;
  end if;

  -- The season, by number.
  select s.* into v_season from public.seasons s where s.series_id = v_series.id and s.season_number = v_season_number for update;
  if not found then
    insert into public.seasons (series_id, season_number, title, overview, air_date, poster_path)
    values (v_series.id, v_season_number, nullif(pg_catalog.btrim(p_season->>'title'), ''),
      nullif(pg_catalog.btrim(p_season->>'overview'), ''), (p_season->>'air_date')::date, p_season->>'poster_path')
    returning * into v_season;
  end if;

  -- The episode, by number. A different TMDB episode at the same number is a review decision, never made here.
  select e.* into v_episode from public.episodes e where e.season_id = v_season.id and e.episode_number = v_episode_number for update;
  if found then
    if v_episode.tmdb_id is distinct from (p_episode->>'tmdb_id')::integer then
      raise exception 'catalogue_episode_conflict' using errcode = 'P0001';
    end if;
  else
    begin
      insert into public.episodes (season_id, episode_number, title, overview, air_date, runtime_minutes, still_path, tmdb_id)
      values (v_season.id, v_episode_number, nullif(pg_catalog.btrim(p_episode->>'title'), ''),
        nullif(pg_catalog.btrim(p_episode->>'overview'), ''), (p_episode->>'air_date')::date,
        (p_episode->>'runtime_minutes')::integer, p_episode->>'still_path', (p_episode->>'tmdb_id')::integer)
      returning * into v_episode;
    exception when unique_violation then
      raise exception 'catalogue_episode_conflict' using errcode = 'P0001';
    end;
  end if;

  -- The VJ version, linked to this media. Other media for the same episode and VJ is a replacement decision.
  select ev.* into v_version from public.episode_versions ev where ev.episode_id = v_episode.id and ev.vj_id = p_vj_id for update;
  if found then
    if v_version.telegram_media_id is distinct from p_media_id then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end if;
    update public.episode_versions ev
    set availability_status = 'ready', rights_status = 'cleared', available_at = coalesce(ev.available_at, now()), updated_at = now()
    where ev.id = v_version.id
    returning * into v_version;
  else
    begin
      insert into public.episode_versions (episode_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
      values (v_episode.id, p_vj_id, 'ready', 'cleared', now(), p_media_id)
      returning * into v_version;
    exception when unique_violation then
      -- The media already backs another version.
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end;
  end if;

  if v_series.publication_status = 'draft' then
    update public.series s set publication_status = 'published', published_at = coalesce(s.published_at, now()), updated_at = now()
    where s.id = v_series.id
    returning * into v_series;
  end if;

  return query select v_series.id, v_series.slug, v_season.id, v_episode.id, v_version.id;
end;
$$;

revoke all on function private.catalogue_publish_episode(bigint, bigint, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
comment on function private.catalogue_publish_episode(bigint, bigint, jsonb, jsonb, jsonb, boolean) is
  'Owner only (no API role may execute): publishes one verified Series-channel episode version from reviewed TMDB snapshots.';

-- The admin upload chain (and its role) is optional on the hosted schema. Audit
-- that role explicitly when present, without requiring that separate deployment.
do $$ begin
  if to_regrole('velora_upload_worker') is not null then
    execute 'revoke all on function media_gateway.resolve_episode_version(bigint), public.media_verification_claim_v2(uuid,integer,integer,text[]), private.catalogue_publish_episode(bigint,bigint,jsonb,jsonb,jsonb,boolean) from velora_upload_worker';
  end if;
end $$;

commit;
