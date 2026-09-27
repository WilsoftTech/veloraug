-- Velora UG Phase C, checkpoint C2B.2H: from an uploaded movie to the public
-- catalogue. Design: docs/PHASE_C_INGESTION_DESIGN.md ("C2B.2H").
--
-- The lifecycle follows the C1 storage mapping:
--   evaluated  status 'matched' | 'needs_review', parsed suggestions, pending candidates
--   approved   status 'matched' + exactly one approved candidate
--   published  status 'published'; title published; version ready + cleared + media
--
-- Two privilege tiers, so the C2A threat model holds ("a compromised uploader
-- cannot publish"):
--
-- 1. public.ingest_record_evaluation: a worker command like the five before
--    it. SECURITY DEFINER, EXECUTE for service_role only. It writes parsed
--    suggestions and PENDING candidates only, re-derives the match decision
--    from the candidates instead of trusting the caller, and references no
--    catalogue table.
-- 2. private.catalogue_approve_movie_match and private.catalogue_publish_movie:
--    owner-only. SECURITY INVOKER with EXECUTE granted to no API role, in a
--    schema the Data API does not expose. Only the database owner (psql over
--    the pooler, the boundary used for channel registration and the VJ
--    bootstrap) can approve or publish. Each is keyed by the exact source
--    fingerprint, handles one ingestion, and is idempotent.
--
-- Public visibility is unchanged: the B-2 policies and column grants still
-- decide what anon/authenticated can read. Nothing here grants anything.

-- ---------------------------------------------------------------------------
-- Slug helper (owner-only)
-- ---------------------------------------------------------------------------
-- ASCII slug of a title or genre name; empty when nothing alphanumeric remains
-- (the caller refuses that rather than inventing a slug).
create function private.catalogue_slug(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'), '-')
$$;

-- ---------------------------------------------------------------------------
-- Worker command: record an evaluation
-- ---------------------------------------------------------------------------
-- p_parsed:     { kind, kind_status, title, year, vj_text, vj_status, vj_id, season, episode }
-- p_candidates: [ { tmdb_id, media_type, score, title_match, title_field, year_match, title, year } ]
--               the same-kind TMDB results scored by lib/ingestion/match.ts
-- Returns 'matched', 'needs_review' or 'already_recorded' (an identical replay).
-- Errors (fixed codes, no row data):
--   ingest_invalid_input        malformed argument or inconsistent candidate score
--   ingest_not_registered       no uploader ingestion for this fingerprint
--   ingest_identity_mismatch    bot type differs from the registration
--   ingest_not_uploaded         the source has no recorded Telegram media
--   ingest_illegal_transition   the ingestion is past evaluation or held for review
--   ingest_evaluation_conflict  a different evaluation is already recorded
create function public.ingest_record_evaluation(
  p_source_fingerprint text,
  p_bot_type text,
  p_parsed jsonb,
  p_candidates jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_candidate jsonb;
  v_reasons text[] := array[]::text[];
  v_high integer;
  v_agreeing integer;
  v_expected_type text;
  v_existing jsonb;
  v_incoming jsonb;
  v_status text;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_bot_type is null or p_bot_type not in ('movie', 'series')
     or p_parsed is null or jsonb_typeof(p_parsed) <> 'object'
     or p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) > 20 then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  -- Parsed suggestions: exactly these keys, each typed and bounded.
  if (select array_agg(k order by k) from jsonb_object_keys(p_parsed) k)
       is distinct from array['episode', 'kind', 'kind_status', 'season', 'title', 'vj_id', 'vj_status', 'vj_text', 'year']
     or p_parsed->>'kind' is null or p_parsed->>'kind' not in ('movie', 'series')
     or p_parsed->>'kind_status' is null or p_parsed->>'kind_status' not in ('confirmed', 'inferred', 'conflict')
     or jsonb_typeof(p_parsed->'title') is distinct from 'string' or char_length(p_parsed->>'title') not between 1 and 300
     or jsonb_typeof(p_parsed->'year') not in ('null', 'number')
     or (jsonb_typeof(p_parsed->'year') = 'number' and (p_parsed->>'year') !~ '^(18|19|20|21)[0-9]{2}$')
     or jsonb_typeof(p_parsed->'vj_text') not in ('null', 'string')
     or (jsonb_typeof(p_parsed->'vj_text') = 'string' and char_length(p_parsed->>'vj_text') not between 1 and 100)
     or p_parsed->>'vj_status' is null or p_parsed->>'vj_status' not in ('resolved', 'missing', 'inactive', 'ambiguous', 'unresolved')
     or jsonb_typeof(p_parsed->'vj_id') not in ('null', 'number')
     or (jsonb_typeof(p_parsed->'vj_id') = 'number' and (p_parsed->>'vj_id') !~ '^[1-9][0-9]{0,17}$')
     or ((p_parsed->>'vj_status') = 'resolved') <> (jsonb_typeof(p_parsed->'vj_id') = 'number')
     or jsonb_typeof(p_parsed->'season') not in ('null', 'number')
     or (jsonb_typeof(p_parsed->'season') = 'number' and (p_parsed->>'season') !~ '^[0-9]{1,4}$')
     or jsonb_typeof(p_parsed->'episode') not in ('null', 'number')
     or (jsonb_typeof(p_parsed->'episode') = 'number' and (p_parsed->>'episode') !~ '^[1-9][0-9]{0,4}$') then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  -- Candidates: typed, same media type as the bot, distinct TMDB ids, and a
  -- score that is exactly the tier of its own reasons (MATCH_TIER_SCORE).
  v_expected_type := case p_bot_type when 'movie' then 'movie' else 'tv' end;
  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    if jsonb_typeof(v_candidate) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_candidate) k)
            is distinct from array['media_type', 'score', 'title', 'title_field', 'title_match', 'tmdb_id', 'year', 'year_match']
       or jsonb_typeof(v_candidate->'tmdb_id') <> 'number' or (v_candidate->>'tmdb_id') !~ '^[1-9][0-9]{0,9}$'
       or (v_candidate->>'tmdb_id')::bigint > 2147483647
       or v_candidate->>'media_type' is distinct from v_expected_type
       or jsonb_typeof(v_candidate->'score') <> 'number'
       or v_candidate->>'title_match' is null or v_candidate->>'title_match' not in ('exact', 'mismatch')
       or jsonb_typeof(v_candidate->'title_field') not in ('null', 'string')
       or (v_candidate->>'title_match' = 'exact') <> coalesce(v_candidate->>'title_field' in ('title', 'original_title'), false)
       or v_candidate->>'year_match' is null or v_candidate->>'year_match' not in ('match', 'near', 'conflict', 'unknown')
       or jsonb_typeof(v_candidate->'title') <> 'string' or char_length(v_candidate->>'title') not between 1 and 300
       or jsonb_typeof(v_candidate->'year') not in ('null', 'number')
       or (v_candidate->>'score')::numeric is distinct from (
            case when v_candidate->>'title_match' = 'mismatch' then 0
                 when v_candidate->>'year_match' = 'match' then 1
                 when v_candidate->>'year_match' = 'near' then 0.8
                 when v_candidate->>'year_match' = 'unknown' then 0.6
                 else 0.3 end) then
      raise exception 'ingest_invalid_input' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct value->>'tmdb_id') from jsonb_array_elements(p_candidates)) <> jsonb_array_length(p_candidates) then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  select e.* into v_event from private.ingestion_events e
  where e.origin = 'uploader' and e.source_fingerprint = p_source_fingerprint
  for update;
  if not found then
    raise exception 'ingest_not_registered' using errcode = 'P0001';
  end if;
  if v_event.bot_type <> p_bot_type then
    raise exception 'ingest_identity_mismatch' using errcode = 'P0001';
  end if;
  if v_event.upload_state <> 'uploaded' or v_event.telegram_media_id is null then
    raise exception 'ingest_not_uploaded' using errcode = 'P0001';
  end if;

  -- Replay: the same evaluation again is a no-op; a different one never
  -- replaces the recorded evidence (a correction is a reviewer action).
  select coalesce(jsonb_agg(jsonb_build_object('tmdb_id', c.tmdb_id, 'score', c.score, 'reasons', c.reasons) order by c.tmdb_id), '[]'::jsonb)
    into v_existing
  from private.metadata_match_candidates c where c.ingestion_event_id = v_event.id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'tmdb_id', (value->>'tmdb_id')::integer,
      'score', (value->>'score')::numeric(5,4),
      'reasons', value - 'tmdb_id' - 'media_type' - 'score') order by (value->>'tmdb_id')::integer), '[]'::jsonb)
    into v_incoming
  from jsonb_array_elements(p_candidates);

  if v_event.parsed is not null or v_existing <> '[]'::jsonb then
    if (v_event.parsed - 'review_reasons') = p_parsed and v_existing = v_incoming then
      return 'already_recorded';
    end if;
    raise exception 'ingest_evaluation_conflict' using errcode = 'P0001';
  end if;
  -- Only a fresh upload is evaluated. needs_review from upload evidence
  -- (duplicates, conflicts) stays with the reviewer.
  if v_event.status not in ('received', 'parsed') then
    raise exception 'ingest_illegal_transition' using errcode = 'P0001';
  end if;

  -- The decision is re-derived here, never taken from the caller: automatic
  -- matching needs one declared kind, one resolved VJ, and exactly one
  -- candidate with the same title and year (score 1, "high" confidence).
  if p_parsed->>'kind' <> p_bot_type then
    v_reasons := array_append(v_reasons, 'kind_conflict');
  elsif p_parsed->>'kind_status' = 'conflict' then
    v_reasons := array_append(v_reasons, 'kind_conflict');
  elsif p_parsed->>'kind_status' = 'inferred' then
    v_reasons := array_append(v_reasons, 'kind_not_declared');
  end if;
  if p_parsed->>'vj_status' <> 'resolved' then
    v_reasons := array_append(v_reasons, ('vj_' || (p_parsed->>'vj_status')));
  end if;
  select count(*) filter (where (value->>'score')::numeric = 1),
         count(*) filter (where value->>'title_match' = 'exact' and value->>'year_match' <> 'conflict')
    into v_high, v_agreeing
  from jsonb_array_elements(p_candidates);
  if jsonb_array_length(p_candidates) = 0 then
    v_reasons := array_append(v_reasons, 'match_not_found');
  elsif v_high > 1 or (v_high = 0 and v_agreeing <> 1) then
    v_reasons := array_append(v_reasons, 'match_ambiguous');
  elsif v_high = 0 then
    v_reasons := array_append(v_reasons, 'match_needs_confirmation');
  end if;
  if p_bot_type = 'series' then
    if jsonb_typeof(p_parsed->'season') = 'null' then v_reasons := array_append(v_reasons, 'missing_season'); end if;
    if jsonb_typeof(p_parsed->'episode') = 'null' then v_reasons := array_append(v_reasons, 'missing_episode'); end if;
  end if;

  insert into private.metadata_match_candidates (ingestion_event_id, tmdb_media_type, tmdb_id, score, reasons)
  select v_event.id, v_expected_type, (value->>'tmdb_id')::integer, (value->>'score')::numeric, value - 'tmdb_id' - 'media_type' - 'score'
  from jsonb_array_elements(p_candidates);

  v_status := case when cardinality(v_reasons) = 0 then 'matched' else 'needs_review' end;
  update private.ingestion_events e
  set parsed = p_parsed || jsonb_build_object('review_reasons', to_jsonb(v_reasons)),
      status = v_status,
      processed_at = now()
  where e.id = v_event.id;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner command: approve the automatic match of one uploaded movie
-- ---------------------------------------------------------------------------
-- Approves p_tmdb_id only if it is the unique score-1 candidate the
-- evaluation recorded, the ingestion is 'matched', the file is uploaded and
-- the VJ is still active. The other candidates become 'superseded' (kept as
-- audit history). Returns 'approved' or 'already_approved'.
create function private.catalogue_approve_movie_match(p_source_fingerprint text, p_tmdb_id integer)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_approved private.metadata_match_candidates%rowtype;
  v_unique_high integer;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_tmdb_id is null or p_tmdb_id <= 0 then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;

  select e.* into v_event from private.ingestion_events e
  where e.origin = 'uploader' and e.source_fingerprint = p_source_fingerprint
  for update;
  if not found then
    raise exception 'catalogue_not_registered' using errcode = 'P0001';
  end if;
  if v_event.bot_type <> 'movie' then
    raise exception 'catalogue_not_a_movie' using errcode = 'P0001';
  end if;
  if v_event.upload_state <> 'uploaded' or v_event.telegram_media_id is null then
    raise exception 'catalogue_not_uploaded' using errcode = 'P0001';
  end if;

  select c.* into v_approved from private.metadata_match_candidates c
  where c.ingestion_event_id = v_event.id and c.decision = 'approved';
  if found then
    if v_approved.tmdb_id = p_tmdb_id and v_approved.tmdb_media_type = 'movie' and v_event.status in ('matched', 'published') then
      return 'already_approved';
    end if;
    raise exception 'catalogue_approval_conflict' using errcode = 'P0001';
  end if;
  if v_event.status <> 'matched' then
    raise exception 'catalogue_not_matched' using errcode = 'P0001';
  end if;

  -- Re-check the recorded evidence: exactly one score-1 candidate, and it is
  -- the one named. Anything else is ambiguous and needs a reviewer.
  select count(*) into v_unique_high from private.metadata_match_candidates c
  where c.ingestion_event_id = v_event.id and c.score = 1;
  if v_unique_high <> 1 or not exists (
    select 1 from private.metadata_match_candidates c
    where c.ingestion_event_id = v_event.id and c.score = 1 and c.tmdb_media_type = 'movie'
      and c.tmdb_id = p_tmdb_id and c.decision = 'pending'
  ) then
    raise exception 'catalogue_match_not_unique' using errcode = 'P0001';
  end if;

  if (v_event.parsed->>'vj_status') is distinct from 'resolved' or not exists (
    select 1 from public.vjs v where v.id = (v_event.parsed->>'vj_id')::bigint and v.is_active
  ) then
    raise exception 'catalogue_vj_not_active' using errcode = 'P0001';
  end if;

  update private.metadata_match_candidates c
  set decision = case when c.tmdb_id = p_tmdb_id then 'approved' else 'superseded' end,
      decided_at = now()
  where c.ingestion_event_id = v_event.id and c.decision = 'pending';
  return 'approved';
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner command: publish one approved, uploaded movie
-- ---------------------------------------------------------------------------
-- One transaction, as the C1 publication boundary requires:
--   1. create the movie (or reuse the one with this TMDB id);
--   2. create its version for the ingestion's VJ, linked to the uploaded media;
--   3. set the version ready + cleared, then the movie published;
--   4. mark the ingestion published.
-- p_metadata is the TMDB snapshot of the approved id:
--   { tmdb_id, title, original_title, overview, release_date, runtime_minutes,
--     poster_path, backdrop_path, vote_average, vote_count, genres: [{ tmdb_id, name }] }
-- p_rights_cleared is the operator's explicit rights attestation.
-- A replay after publication returns 'already_published' and changes nothing.
create function private.catalogue_publish_movie(p_source_fingerprint text, p_metadata jsonb, p_rights_cleared boolean)
returns table (result text, movie_id bigint, movie_slug text, version_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_media private.telegram_media%rowtype;
  v_candidate private.metadata_match_candidates%rowtype;
  v_movie public.movies%rowtype;
  v_version public.movie_versions%rowtype;
  v_vj_id bigint;
  v_slug text;
  v_release date;
  v_genre jsonb;
  v_genre_id bigint;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;

  select e.* into v_event from private.ingestion_events e
  where e.origin = 'uploader' and e.source_fingerprint = p_source_fingerprint
  for update;
  if not found then
    raise exception 'catalogue_not_registered' using errcode = 'P0001';
  end if;
  if v_event.bot_type <> 'movie' then
    raise exception 'catalogue_not_a_movie' using errcode = 'P0001';
  end if;
  if v_event.upload_state <> 'uploaded' or v_event.telegram_media_id is null then
    raise exception 'catalogue_not_uploaded' using errcode = 'P0001';
  end if;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  if not found or v_media.bot_type <> 'movie' then
    raise exception 'catalogue_not_uploaded' using errcode = 'P0001';
  end if;

  select c.* into v_candidate from private.metadata_match_candidates c
  where c.ingestion_event_id = v_event.id and c.decision = 'approved';
  if not found or v_candidate.tmdb_media_type <> 'movie' then
    raise exception 'catalogue_not_approved' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_metadata->'tmdb_id') is distinct from 'number'
     or (p_metadata->>'tmdb_id') is distinct from v_candidate.tmdb_id::text then
    raise exception 'catalogue_metadata_mismatch' using errcode = 'P0001';
  end if;

  -- Replay: the published result of this ingestion, unchanged.
  if v_event.status = 'published' then
    select mv.* into v_version from public.movie_versions mv where mv.telegram_media_id = v_media.id;
    select m.* into v_movie from public.movies m where m.id = v_version.movie_id;
    if v_version.id is null or v_movie.tmdb_id is distinct from v_candidate.tmdb_id then
      raise exception 'catalogue_publication_inconsistent' using errcode = 'P0001';
    end if;
    return query select 'already_published'::text, v_movie.id, v_movie.slug, v_version.id;
    return;
  end if;
  if v_event.status <> 'matched' then
    raise exception 'catalogue_not_approved' using errcode = 'P0001';
  end if;
  if p_rights_cleared is not true then
    raise exception 'catalogue_rights_not_cleared' using errcode = 'P0001';
  end if;

  v_vj_id := case when (v_event.parsed->>'vj_status') = 'resolved' then (v_event.parsed->>'vj_id')::bigint end;
  if v_vj_id is null or not exists (select 1 from public.vjs v where v.id = v_vj_id and v.is_active) then
    raise exception 'catalogue_vj_not_active' using errcode = 'P0001';
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
  select m.* into v_movie from public.movies m where m.tmdb_id = v_candidate.tmdb_id for update;
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
      v_candidate.tmdb_id,
      round((p_metadata->>'vote_average')::numeric, 1),
      (p_metadata->>'vote_count')::integer,
      'reviewed',
      now())
    returning * into v_movie;

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

  -- 2 + 3. The VJ version, linked to this ingestion's media. An existing
  -- version for this title and VJ with other media is a replacement decision
  -- (same_title_same_vj), never made here.
  select mv.* into v_version from public.movie_versions mv
  where mv.movie_id = v_movie.id and mv.vj_id = v_vj_id
  for update;
  if found then
    if v_version.telegram_media_id is distinct from v_media.id then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end if;
    update public.movie_versions mv
    set availability_status = 'ready', rights_status = 'cleared', available_at = coalesce(mv.available_at, now())
    where mv.id = v_version.id
    returning * into v_version;
  else
    if exists (select 1 from public.movie_versions mv where mv.telegram_media_id = v_media.id) then
      raise exception 'catalogue_version_conflict' using errcode = 'P0001';
    end if;
    insert into public.movie_versions (movie_id, vj_id, telegram_media_id, availability_status, rights_status, available_at)
    values (v_movie.id, v_vj_id, v_media.id, 'ready', 'cleared', now())
    returning * into v_version;
  end if;

  update public.movies m
  set publication_status = 'published', published_at = coalesce(m.published_at, now())
  where m.id = v_movie.id
  returning * into v_movie;

  -- 4. The ingestion lifecycle.
  update private.ingestion_events e
  set status = 'published', processed_at = now()
  where e.id = v_event.id;

  return query select 'published'::text, v_movie.id, v_movie.slug, v_version.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on new functions to anon,
-- authenticated and service_role. Revoke all everywhere; then grant the one
-- worker command to service_role. The owner commands and the slug helper get
-- no grant at all: only the owner (postgres) can run them.
revoke all on function
  private.catalogue_slug(text),
  public.ingest_record_evaluation(text, text, jsonb, jsonb),
  private.catalogue_approve_movie_match(text, integer),
  private.catalogue_publish_movie(text, jsonb, boolean)
from public, anon, authenticated, service_role;

grant execute on function public.ingest_record_evaluation(text, text, jsonb, jsonb) to service_role;
