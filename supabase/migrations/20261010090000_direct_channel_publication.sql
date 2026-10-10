-- Velora UG E3.8A: movies posted directly to the Telegram Movies channel,
-- from detection to review to publication. Design: docs/E3_8_CHANNEL_DISCOVERY.md
-- ("E3.8A").
--
-- Reuse, not a second registry:
--   private.telegram_media             the delivered document (unchanged table)
--   private.ingestion_events           lifecycle root; new origin 'channel'
--   private.metadata_match_candidates  TMDB candidates; now keep their validated snapshot
--   public.movies / movie_versions     written only by the shared owner materializer
--
-- Provenance. An uploader row is identified by its source fingerprint (sf1-).
-- A channel row has no fingerprint (a CHECK forbids one) and is identified by
-- its document: tg1- = SHA-256 of [chat_id, message_id, "file_unique_id",
-- file_size] (the E3.8 mediaKey digest). Captions and filenames are never
-- identity. One partial unique index lets a document belong to the uploader or
-- to a channel post, never both, so neither origin can stand in for the other.
--
-- Evidence (media verification, rights) is bound to the tg1 identity and, for
-- rights, to the review revision; an edit or replacement makes it stale.
--
-- Privilege tiers (none of them gives a worker publication authority):
--   1. worker      public.discovery_* commands: SECURITY DEFINER, EXECUTE for
--                  service_role only. They record deliveries, inspections and
--                  bounded media evidence. They never write the catalogue,
--                  never clear rights and never approve.
--   2. reviewer    public.discovery_review_* commands (read, correct, clear
--                  rights, reject, retry): SECURITY DEFINER, EXECUTE for
--                  authenticated only, and each one requires a row in
--                  private.catalogue_reviewers with the matching capability
--                  (review, rights, publish are separate). The table ships empty.
--   3. approval    catalogue_review.* (approve, publish): not in the Data API,
--                  as C2B.2H requires; executable only by velora_review_service
--                  (and the owner), still gated on the reviewer's capability.
--   4. owner       private.catalogue_* functions: SECURITY INVOKER, executable by
--                  no API role. Publication of both origins ends in the same
--                  private.catalogue_materialize_movie_version.
--   5. public      unchanged: the B-2 policies decide what anon can read.

-- ---------------------------------------------------------------------------
-- 1. ingestion_events: the 'channel' origin
-- ---------------------------------------------------------------------------
alter table private.ingestion_events drop constraint ingestion_events_status_check;
alter table private.ingestion_events add constraint ingestion_events_status_check
  check (status in (
    'received', 'processing', 'parsed', 'needs_review',
    'matched', 'published', 'rejected', 'ignored', 'failed', 'blocked'));

alter table private.ingestion_events drop constraint ingestion_events_origin_check;
alter table private.ingestion_events add constraint ingestion_events_origin_check
  check (origin in ('webhook', 'uploader', 'channel'));

-- A channel row is a Movies document seen in the channel: always linked media,
-- and none of the uploader's columns (so it can never carry a fingerprint).
alter table private.ingestion_events add constraint ingestion_events_channel_shape_check check (
  origin <> 'channel' or (
    bot_type = 'movie' and telegram_media_id is not null
    and source_fingerprint is null and source_size_bytes is null
    and upload_state is null and upload_attempt_count = 0 and upload_started_at is null
    and upload_failure_code is null and upload_failed_at is null and upload_floor_message_id is null
    and (telegram_update_id is null) = (update_kind is null)));

-- One delivered document has exactly one provenance.
create unique index ingestion_events_media_provenance_key
  on private.ingestion_events (telegram_media_id)
  where origin in ('uploader', 'channel') and telegram_media_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Identity helpers and the media identity guard
-- ---------------------------------------------------------------------------
-- tg1 identity of a channel document. Null when the document is not fully
-- identified (Telegram unique ids are URL-safe base64; size must be known).
create function private.channel_media_identity(p_chat_id bigint, p_message_id bigint, p_file_unique_id text, p_size bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'tg1-' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      '[' || p_chat_id || ',' || p_message_id || ',"' || p_file_unique_id || '",' || p_size || ']', 'UTF8')), 'hex')
  where p_chat_id is not null and p_message_id is not null
    and p_file_unique_id ~ '^[A-Za-z0-9_-]{1,128}$' and p_size is not null and p_size > 0
$$;

-- The review key of a channel message (E3.8 messageKey): SHA-256 of [chat_id, message_id].
create function private.discovery_message_key(p_chat_id bigint, p_message_id bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('[' || p_chat_id || ',' || p_message_id || ']', 'UTF8')), 'hex')
$$;

-- A document's location never changes, and its content identity is frozen once
-- a version or the uploader depends on it. Unlinked channel documents may be
-- replaced by an edit; their evidence then no longer matches.
create function private.guard_telegram_media_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.bot_type <> old.bot_type or new.chat_id <> old.chat_id or new.message_id <> old.message_id then
    raise exception 'telegram_media_identity_immutable' using errcode = 'P0001';
  end if;
  if (new.file_unique_id is distinct from old.file_unique_id or new.file_size_bytes is distinct from old.file_size_bytes)
     and (exists (select 1 from public.movie_versions mv where mv.telegram_media_id = old.id)
          or exists (select 1 from public.episode_versions ev where ev.telegram_media_id = old.id)
          or exists (select 1 from private.ingestion_events e where e.telegram_media_id = old.id and e.origin <> 'channel')) then
    raise exception 'telegram_media_identity_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger telegram_media_guard_identity
  before update on private.telegram_media
  for each row execute function private.guard_telegram_media_identity();

-- ---------------------------------------------------------------------------
-- 3. Review state, evidence, rights, reviewers, audit, deliveries, cursor
-- ---------------------------------------------------------------------------
-- Approved metadata is the validated snapshot the reviewer saw.
alter table private.metadata_match_candidates
  add column snapshot jsonb
    check (snapshot is null or (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 65536));

-- One row per channel ingestion: review revision, worker lease, identity
-- decision, and the current approval. Every change to the reviewed facts
-- increments review_revision; approval and rights name the revision they saw.
create table private.channel_reviews (
  ingestion_event_id bigint primary key references private.ingestion_events (id) on delete restrict,
  discovery_key text not null unique check (discovery_key ~ '^[0-9a-f]{64}$'),
  review_revision integer not null default 1 check (review_revision between 1 and 1000000),
  event_id text not null check (event_id ~ '^[0-9a-f]{64}$'),
  payload_digest text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
  -- Telegram date / edit_date (seconds) of the applied event: edits apply in order.
  observed_at bigint not null check (observed_at > 0),
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz not null default now(),
  title text check (title is null or char_length(title) between 1 and 300),
  release_year integer check (release_year is null or release_year between 1870 and 2200),
  vj_text text check (vj_text is null or char_length(vj_text) between 1 and 100),
  warnings text[] not null default '{}'
    check (cardinality(warnings) <= 50 and pg_catalog.array_to_string(warnings, ',') ~ '^[a-z0-9_,]*$'),
  identity_state text not null default 'unknown'
    check (identity_state in ('unknown', 'ambiguous', 'proposed', 'confirmed')),
  tmdb_id integer check (tmdb_id is null or tmdb_id > 0),
  vj_id bigint references public.vjs (id) on delete restrict,
  relation text not null default 'unknown' check (relation in ('new_movie', 'new_vj', 'replacement', 'unknown')),
  duplicate_of_media_id bigint references private.telegram_media (id) on delete restrict,
  approved_revision integer,
  approved_by uuid,
  approved_at timestamptz,
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_reviews_lease_check check ((lease_token is null) = (lease_until is null)),
  constraint channel_reviews_identity_check check (identity_state not in ('proposed', 'confirmed') or tmdb_id is not null),
  constraint channel_reviews_approval_check check (
    (approved_revision is null) = (approved_by is null) and (approved_by is null) = (approved_at is null)
    and (approved_revision is null or approved_revision = review_revision)),
  constraint channel_reviews_published_check check ((published_at is null) or (approved_revision is not null))
);

create index channel_reviews_vj_id_idx on private.channel_reviews (vj_id) where vj_id is not null;
create index channel_reviews_duplicate_idx on private.channel_reviews (duplicate_of_media_id) where duplicate_of_media_id is not null;
create index channel_reviews_retry_idx on private.channel_reviews (retry_at, ingestion_event_id);

create trigger channel_reviews_set_updated_at
  before update on private.channel_reviews
  for each row execute function private.set_updated_at();

-- Bounded media verification of one document identity. Never a full-file
-- integrity claim: scope is fixed to 'bounded'. `verified` is derived, so a
-- caller cannot assert it independently of the recorded facts.
create table private.media_evidence (
  id bigint generated always as identity primary key,
  telegram_media_id bigint not null references private.telegram_media (id) on delete restrict,
  media_identity text not null check (media_identity ~ '^tg1-[0-9a-f]{64}$'),
  method text not null check (method ~ '^[a-z0-9_]{1,60}$'),
  scope text not null default 'bounded' check (scope = 'bounded'),
  policy_version integer not null check (policy_version between 1 and 1000),
  media_class text not null check (media_class in (
    'canonical', 'remux', 'audio_normalization', 'video_transcode_required', 'manual_review', 'unverified')),
  reasons text[] not null default '{}'
    check (cardinality(reasons) <= 50 and pg_catalog.array_to_string(reasons, ',') ~ '^[a-z0-9_.,]*$'),
  container text check (container is null or container ~ '^[a-z0-9_]{1,40}$'),
  video_codec text check (video_codec is null or video_codec ~ '^[a-z0-9_]{1,40}$'),
  audio_codec text check (audio_codec is null or audio_codec ~ '^[a-z0-9_]{1,40}$'),
  accessible boolean not null,
  gateway_compatible boolean not null,
  playback_ready boolean not null,
  bytes_read bigint not null check (bytes_read between 0 and 1073741824),
  verified boolean generated always as (
    media_class = 'canonical' and cardinality(reasons) = 0 and accessible and gateway_compatible and playback_ready
    and container = 'mp4' and video_codec = 'h264' and audio_codec in ('aac', 'mp3')) stored,
  checked_at timestamptz not null default now()
);

create index media_evidence_media_idx on private.media_evidence (telegram_media_id, id desc);

-- An explicit, revision-bound rights decision. Never implied by Telegram,
-- TMDB, review approval or publication.
create table private.rights_clearances (
  id bigint generated always as identity primary key,
  ingestion_event_id bigint not null references private.ingestion_events (id) on delete restrict,
  review_revision integer not null check (review_revision >= 1),
  media_identity text not null check (media_identity ~ '^tg1-[0-9a-f]{64}$'),
  reference text not null check (
    char_length(reference) between 1 and 200 and reference = pg_catalog.btrim(reference)
    and reference ~ '^[A-Za-z0-9 _.:/-]+$' and position('://' in reference) = 0),
  cleared_by uuid not null,
  cleared_at timestamptz not null default now(),
  constraint rights_clearances_revision_key unique (ingestion_event_id, review_revision)
);

-- Who may review, clear rights and publish. Ships empty: every reviewer
-- command fails closed until the owner grants a named account a capability.
create table private.catalogue_reviewers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  can_review boolean not null default false,
  can_clear_rights boolean not null default false,
  can_publish boolean not null default false,
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger catalogue_reviewers_set_updated_at
  before update on private.catalogue_reviewers
  for each row execute function private.set_updated_at();

-- Append-only history of every transition. Fixed codes only, no free text.
create table private.channel_review_audit (
  id bigint generated always as identity primary key,
  ingestion_event_id bigint not null references private.ingestion_events (id) on delete restrict,
  review_revision integer not null check (review_revision >= 1),
  actor_kind text not null check (actor_kind in ('worker', 'reviewer', 'owner')),
  actor uuid,
  action text not null check (action ~ '^[a-z0-9_]{1,60}$'),
  detail text check (detail is null or (char_length(detail) between 1 and 300 and detail ~ '^[a-z0-9_,:.-]+$')),
  created_at timestamptz not null default now(),
  constraint channel_review_audit_actor_check check ((actor_kind = 'reviewer') = (actor is not null))
);

create index channel_review_audit_event_idx on private.channel_review_audit (ingestion_event_id, id);

create function private.guard_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'audit_append_only' using errcode = 'P0001';
end;
$$;

create trigger channel_review_audit_append_only
  before update or delete on private.channel_review_audit
  for each row execute function private.guard_append_only();

-- Delivery dedupe: one row per Bot API update (u:<update_id>) or enumerated
-- history entry (r:<event digest>). A replay with a different payload is refused.
create table private.discovery_deliveries (
  bot_type text not null check (bot_type = 'movie'),
  delivery_key text not null check (delivery_key ~ '^(u:[0-9]{1,19}|r:[0-9a-f]{64})$'),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  ingestion_event_id bigint references private.ingestion_events (id) on delete restrict,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  delivery_count integer not null default 1 check (delivery_count >= 1),
  primary key (bot_type, delivery_key)
);

create index discovery_deliveries_event_idx on private.discovery_deliveries (ingestion_event_id)
  where ingestion_event_id is not null;

-- Discovery's own positions, independent of telegram_channels.checkpoint_message_id
-- (the uploader recovery floor). Absent until the owner initializes it, so
-- discovery fails closed before activation. One consumer lease prevents two
-- workers from consuming Bot API updates for the same bot.
create table private.discovery_cursors (
  bot_type text primary key references private.telegram_channels (bot_type) on delete restrict
    check (bot_type = 'movie'),
  update_offset bigint check (update_offset is null or update_offset >= 0),
  reconciliation_cursor text check (reconciliation_cursor is null or char_length(reconciliation_cursor) between 1 and 200),
  reconciliation_checked_at timestamptz,
  reconciliation_incomplete boolean not null default true,
  consumer_token uuid,
  consumer_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_cursors_consumer_check check ((consumer_token is null) = (consumer_until is null))
);

create trigger discovery_cursors_set_updated_at
  before update on private.discovery_cursors
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Shared publication: the owner materializer
-- ---------------------------------------------------------------------------
-- Steps 1-3 of the C2B.2H publisher, unchanged in behaviour and error codes,
-- now shared by both origins: validate the snapshot, create or reuse the movie
-- (never rewriting an existing title's curated fields), create the VJ version
-- linked to this media (never replacing another), set it ready + cleared, and
-- publish the title. Callers hold their own gates and row locks.
create function private.catalogue_materialize_movie_version(p_tmdb_id integer, p_vj_id bigint, p_media_id bigint, p_metadata jsonb)
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

  -- 2 + 3. The VJ version, linked to this media. An existing version for this
  -- title and VJ with other media is a replacement decision, never made here.
  select mv.* into v_version from public.movie_versions mv
  where mv.movie_id = v_movie.id and mv.vj_id = p_vj_id
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
      insert into public.movie_versions (movie_id, vj_id, telegram_media_id, availability_status, rights_status, available_at)
      values (v_movie.id, p_vj_id, p_media_id, 'ready', 'cleared', now())
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

-- The C2B.2H uploader entry point: the same signature, gates, error codes and
-- replay behaviour, now materializing through the shared helper.
create or replace function private.catalogue_publish_movie(p_source_fingerprint text, p_metadata jsonb, p_rights_cleared boolean)
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
  v_result record;
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

  select * into v_result from private.catalogue_materialize_movie_version(v_candidate.tmdb_id, v_vj_id, v_media.id, p_metadata);

  -- 4. The ingestion lifecycle.
  update private.ingestion_events e
  set status = 'published', processed_at = now()
  where e.id = v_event.id;

  return query select 'published'::text, v_result.movie_id, v_result.movie_slug, v_result.version_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Channel gates and the channel publication entry point (owner)
-- ---------------------------------------------------------------------------
-- The latest evidence row for a document's CURRENT identity. A newer failing
-- verification supersedes an older passing one.
create function private.channel_current_evidence(p_media_id bigint)
returns setof private.media_evidence
language sql
stable
security invoker
set search_path = ''
as $$
  select ev.* from private.media_evidence ev
  join private.telegram_media m on m.id = ev.telegram_media_id
  where ev.telegram_media_id = p_media_id
    and ev.media_identity = private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes)
  order by ev.id desc
  limit 1
$$;

-- Every reason a channel candidate cannot be approved or published now, from
-- database state alone. Empty means every mandatory gate passes. The same
-- function decides approval, publication and what the reviewer is shown.
create function private.channel_review_blockers(p_event_id bigint)
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
  if v_identity is null or not exists (select 1 from private.channel_current_evidence(v_media.id) ev where ev.verified) then
    v_blockers := v_blockers || 'media_verification_required'::text;
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
$$;

-- Publishes one approved channel candidate through the shared materializer.
-- p_actor is the reviewer (null when the owner runs it through psql).
-- Idempotent: a replay at the published revision returns 'already_published'.
create function private.catalogue_publish_channel_movie(p_event_id bigint, p_revision integer, p_actor uuid)
returns table (result text, movie_id bigint, movie_slug text, version_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_candidate private.metadata_match_candidates%rowtype;
  v_version public.movie_versions%rowtype;
  v_movie public.movies%rowtype;
  v_blockers text[];
  v_result record;
begin
  if p_event_id is null or p_revision is null or p_revision < 1 then
    raise exception 'catalogue_invalid_input' using errcode = '22023';
  end if;
  select e.* into v_event from private.ingestion_events e where e.id = p_event_id and e.origin = 'channel' for update;
  if not found then
    raise exception 'catalogue_not_registered' using errcode = 'P0001';
  end if;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = p_event_id for update;

  if v_event.status = 'published' then
    select mv.* into v_version from public.movie_versions mv where mv.telegram_media_id = v_event.telegram_media_id;
    select m.* into v_movie from public.movies m where m.id = v_version.movie_id;
    if v_version.id is null or v_movie.tmdb_id is distinct from v_review.tmdb_id then
      raise exception 'catalogue_publication_inconsistent' using errcode = 'P0001';
    end if;
    if p_revision <> v_review.approved_revision then
      raise exception 'catalogue_stale_review' using errcode = 'P0001';
    end if;
    return query select 'already_published'::text, v_movie.id, v_movie.slug, v_version.id;
    return;
  end if;
  if p_revision <> v_review.review_revision then
    raise exception 'catalogue_stale_review' using errcode = 'P0001';
  end if;
  if v_event.status <> 'matched' or v_review.approved_revision is distinct from v_review.review_revision then
    raise exception 'catalogue_not_approved' using errcode = 'P0001';
  end if;
  v_blockers := private.channel_review_blockers(p_event_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'catalogue_gates_not_met' using errcode = 'P0001', detail = pg_catalog.array_to_string(v_blockers, ',');
  end if;
  select c.* into v_candidate from private.metadata_match_candidates c
  where c.ingestion_event_id = p_event_id and c.decision = 'approved';
  if not found or v_candidate.tmdb_id <> v_review.tmdb_id or v_candidate.snapshot is null then
    raise exception 'catalogue_not_approved' using errcode = 'P0001';
  end if;

  select * into v_result from private.catalogue_materialize_movie_version(
    v_candidate.tmdb_id, v_review.vj_id, v_event.telegram_media_id, v_candidate.snapshot);

  update private.ingestion_events e set status = 'published', error_code = null, processed_at = now() where e.id = p_event_id;
  update private.channel_reviews r set published_by = p_actor, published_at = now() where r.ingestion_event_id = p_event_id;
  insert into private.channel_review_audit (ingestion_event_id, review_revision, actor_kind, actor, action, detail)
  values (p_event_id, p_revision, case when p_actor is null then 'owner' else 'reviewer' end, p_actor, 'published',
          'version:' || v_result.version_id);

  return query select 'published'::text, v_result.movie_id, v_result.movie_slug, v_result.version_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Shared internals for the worker and reviewer commands
-- ---------------------------------------------------------------------------
create function private.channel_audit(p_event_id bigint, p_revision integer, p_actor uuid, p_action text, p_detail text default null)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into private.channel_review_audit (ingestion_event_id, review_revision, actor_kind, actor, action, detail)
  values (p_event_id, p_revision, case when p_actor is null then 'worker' else 'reviewer' end, p_actor, p_action, p_detail)
$$;

-- The catalogue relationship of an identity choice: a new title, a new VJ
-- version of an existing title, or a replacement (never made automatically).
create function private.channel_relation(p_tmdb_id integer, p_vj_id bigint)
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
                 where m.tmdb_id = p_tmdb_id and mv.vj_id = p_vj_id) then 'replacement'
    else 'new_vj' end
$$;

-- Whether a (non-anonymous) account holds a reviewer capability.
create function private.reviewer_has(p_user uuid, p_capability text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from private.catalogue_reviewers r join auth.users u on u.id = r.user_id
    where r.user_id = p_user and coalesce(u.is_anonymous, false) = false
      and case p_capability
            when 'review' then r.can_review
            when 'rights' then r.can_clear_rights
            when 'publish' then r.can_publish
            when 'any' then r.can_review or r.can_clear_rights or r.can_publish
            else false end)
$$;

-- The reviewer behind the current Data API request, holding the named
-- capability. Fails closed for anon, service_role, anonymous sign-ins and
-- unlisted users.
create function private.require_reviewer(p_capability text)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := auth.jwt();
begin
  if v_uid is null or v_claims is null or coalesce(v_claims->>'role', '') <> 'authenticated'
     or coalesce(v_claims->>'is_anonymous', 'false') <> 'false'
     or not private.reviewer_has(v_uid, p_capability) then
    raise exception 'review_not_authorized' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- Locks one channel candidate by its review key (both rows, review first).
create function private.channel_lock(p_key text)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  select r.ingestion_event_id into v_id from private.channel_reviews r where r.discovery_key = p_key for update;
  if not found then
    raise exception 'discovery_not_found' using errcode = 'P0001';
  end if;
  perform 1 from private.ingestion_events e where e.id = v_id for update;
  return v_id;
end;
$$;

-- Everything a reviewer sees of one candidate. Never the bot file_id.
create function private.channel_view(p_event_id bigint, p_detail boolean)
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
    'title', v_review.title, 'year', v_review.release_year, 'vj_text', v_review.vj_text,
    'warnings', to_jsonb(v_review.warnings),
    'tmdb_id', v_review.tmdb_id,
    'vj', (select jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.is_active)
           from public.vjs v where v.id = v_review.vj_id),
    'relation', private.channel_relation(v_review.tmdb_id, v_review.vj_id),
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
                   'playback_ready', ev.playback_ready, 'bytes_read', ev.bytes_read, 'checked_at', ev.checked_at)
                 from private.channel_current_evidence(v_media.id) ev),
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
$$;

-- ---------------------------------------------------------------------------
-- 7. Worker commands (service_role)
-- ---------------------------------------------------------------------------
-- Takes or renews the single consumer lease for the Movies bot. Returns the
-- current cursor when held; raises discovery_consumer_busy otherwise.
create function public.discovery_acquire_consumer(p_token uuid, p_lease_seconds integer)
returns table (update_offset bigint, reconciliation_cursor text, reconciliation_checked_at timestamptz, reconciliation_incomplete boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor private.discovery_cursors%rowtype;
begin
  if p_token is null or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  select c.* into v_cursor from private.discovery_cursors c where c.bot_type = 'movie' for update;
  if not found then
    raise exception 'discovery_not_initialized' using errcode = 'P0001';
  end if;
  if v_cursor.consumer_token is not null and v_cursor.consumer_token <> p_token and v_cursor.consumer_until > now() then
    raise exception 'discovery_consumer_busy' using errcode = 'P0001';
  end if;
  update private.discovery_cursors c
  set consumer_token = p_token, consumer_until = now() + make_interval(secs => p_lease_seconds)
  where c.bot_type = 'movie';
  return query select v_cursor.update_offset, v_cursor.reconciliation_cursor, v_cursor.reconciliation_checked_at, v_cursor.reconciliation_incomplete;
end;
$$;

-- Records one batch (at most 100) of detected deliveries and advances the
-- update offset or the reconciliation cursor in the same transaction, so a
-- batch is acknowledged only after it is durable. Only the consumer holding
-- the lease may record. Returns counts.
--
-- p_deliveries: [{ key, digest, update_id, withdrawn_message_id, event }]
--   event: null | { event_id, payload_digest, kind, message_id, observed_at, date,
--                   file_id, file_unique_id, size, name, mime, caption }
-- p_reconciliation: null for Bot API updates; { cursor, incomplete } for a history page.
create function public.discovery_receive(p_token uuid, p_chat_id bigint, p_deliveries jsonb, p_reconciliation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor private.discovery_cursors%rowtype;
  v_item jsonb;
  v_ev jsonb;
  v_key text;
  v_digest text;
  v_update bigint;
  v_offset bigint;
  v_kind text;
  v_message bigint;
  v_observed bigint;
  v_unique text;
  v_size bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_other private.telegram_media%rowtype;
  v_event_id bigint;
  v_media_id bigint;
  v_status text;
  v_error text;
  v_dup bigint;
  v_detected integer := 0;
  v_duplicates integer := 0;
  v_ignored integer := 0;
  v_reconciling boolean := p_reconciliation is not null;
begin
  if p_token is null or p_chat_id is null or p_deliveries is null or jsonb_typeof(p_deliveries) <> 'array'
     or jsonb_array_length(p_deliveries) > 100
     or (v_reconciling and (jsonb_typeof(p_reconciliation) <> 'object'
         or (select array_agg(k order by k) from jsonb_object_keys(p_reconciliation) k) is distinct from array['cursor', 'incomplete']
         or jsonb_typeof(p_reconciliation->'cursor') not in ('null', 'string')
         or char_length(coalesce(p_reconciliation->>'cursor', 'x')) not between 1 and 200
         or jsonb_typeof(p_reconciliation->'incomplete') <> 'boolean')) then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  select c.* into v_cursor from private.discovery_cursors c where c.bot_type = 'movie' for update;
  if not found then
    raise exception 'discovery_not_initialized' using errcode = 'P0001';
  end if;
  if v_cursor.consumer_token is distinct from p_token or v_cursor.consumer_until <= now() then
    raise exception 'discovery_consumer_lease_lost' using errcode = 'P0001';
  end if;
  if not exists (select 1 from private.telegram_channels c where c.bot_type = 'movie' and c.chat_id = p_chat_id) then
    raise exception 'discovery_channel_not_allowed' using errcode = 'P0001';
  end if;
  v_offset := v_cursor.update_offset;

  for v_item in select value from jsonb_array_elements(p_deliveries) loop
    if jsonb_typeof(v_item) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_item) k)
            is distinct from array['digest', 'event', 'key', 'update_id', 'withdrawn_message_id']
       or v_item->>'key' is null or v_item->>'digest' is null or (v_item->>'digest') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_item->'update_id') not in ('null', 'number')
       or jsonb_typeof(v_item->'withdrawn_message_id') not in ('null', 'number')
       or jsonb_typeof(v_item->'event') not in ('null', 'object') then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end if;
    v_key := v_item->>'key';
    v_digest := v_item->>'digest';
    v_update := (v_item->>'update_id')::bigint;
    if v_reconciling then
      if v_key !~ '^r:[0-9a-f]{64}$' or v_update is not null then
        raise exception 'discovery_invalid_input' using errcode = '22023';
      end if;
    elsif v_update is null or v_update < 0 or v_key <> 'u:' || v_update then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end if;

    -- Delivery dedupe: identical replay is a no-op; a different payload under
    -- the same delivery is refused (the whole batch rolls back).
    perform 1 from private.discovery_deliveries d where d.bot_type = 'movie' and d.delivery_key = v_key for update;
    if found then
      update private.discovery_deliveries d set delivery_count = d.delivery_count + 1, last_seen_at = now()
      where d.bot_type = 'movie' and d.delivery_key = v_key and d.digest = v_digest;
      if not found then
        raise exception 'discovery_update_payload_conflict' using errcode = 'P0001';
      end if;
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    insert into private.discovery_deliveries (bot_type, delivery_key, digest) values ('movie', v_key, v_digest);
    if not v_reconciling then
      v_offset := greatest(coalesce(v_offset, 0), v_update);
    end if;

    v_ev := v_item->'event';
    if jsonb_typeof(v_ev) = 'null' then
      -- Not a document. An edit that removed the document blocks review of that message.
      if jsonb_typeof(v_item->'withdrawn_message_id') = 'number' then
        select r.* into v_review from private.channel_reviews r
        where r.discovery_key = private.discovery_message_key(p_chat_id, (v_item->>'withdrawn_message_id')::bigint)
        for update;
        if found then
          select e.* into v_event from private.ingestion_events e where e.id = v_review.ingestion_event_id for update;
          if v_event.status = 'published' then
            -- The catalogue is never changed from here; the gateway refuses a document that no longer matches.
            update private.ingestion_events e set error_code = 'published_message_changed' where e.id = v_event.id;
            perform private.channel_audit(v_event.id, v_review.review_revision, null, 'edited_media_unavailable');
          else
            update private.channel_reviews r
            set review_revision = r.review_revision + 1, approved_revision = null, approved_by = null, approved_at = null,
                lease_token = null, lease_until = null
            where r.ingestion_event_id = v_event.id;
            update private.ingestion_events e set status = 'blocked', error_code = 'edited_media_unavailable', processed_at = now()
            where e.id = v_event.id;
            perform private.channel_audit(v_event.id, v_review.review_revision + 1, null, 'edited_media_unavailable');
          end if;
        end if;
      end if;
      v_ignored := v_ignored + 1;
      continue;
    end if;

    if (select array_agg(k order by k) from jsonb_object_keys(v_ev) k)
         is distinct from array['caption', 'date', 'event_id', 'file_id', 'file_unique_id', 'kind', 'message_id', 'mime', 'name', 'observed_at', 'payload_digest', 'size']
       or (v_ev->>'event_id') !~ '^[0-9a-f]{64}$' or (v_ev->>'payload_digest') !~ '^[0-9a-f]{64}$'
       or v_ev->>'kind' is null or v_ev->>'kind' not in ('channel_post', 'edited_channel_post', 'reconciliation')
       or (v_ev->>'kind' = 'reconciliation') <> v_reconciling
       or jsonb_typeof(v_ev->'message_id') <> 'number' or (v_ev->>'message_id') !~ '^[1-9][0-9]{0,18}$'
       or jsonb_typeof(v_ev->'observed_at') <> 'number' or (v_ev->>'observed_at') !~ '^[1-9][0-9]{0,11}$'
       or jsonb_typeof(v_ev->'date') <> 'number' or (v_ev->>'date') !~ '^[1-9][0-9]{0,11}$'
       or jsonb_typeof(v_ev->'file_id') <> 'string' or char_length(v_ev->>'file_id') not between 1 and 1024
       or jsonb_typeof(v_ev->'file_unique_id') <> 'string' or (v_ev->>'file_unique_id') !~ '^[A-Za-z0-9_-]{1,128}$'
       or jsonb_typeof(v_ev->'size') not in ('null', 'number')
       or (jsonb_typeof(v_ev->'size') = 'number' and (v_ev->>'size') !~ '^[0-9]{1,15}$')
       or jsonb_typeof(v_ev->'name') not in ('null', 'string') or char_length(coalesce(v_ev->>'name', 'x')) not between 1 and 1024
       or jsonb_typeof(v_ev->'mime') not in ('null', 'string') or char_length(coalesce(v_ev->>'mime', 'x')) not between 1 and 255
       or jsonb_typeof(v_ev->'caption') not in ('null', 'string') or char_length(coalesce(v_ev->>'caption', '')) > 4096 then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end if;
    v_kind := case when v_ev->>'kind' = 'reconciliation' then null else v_ev->>'kind' end;
    v_message := (v_ev->>'message_id')::bigint;
    v_observed := (v_ev->>'observed_at')::bigint;
    v_unique := v_ev->>'file_unique_id';
    v_size := (v_ev->>'size')::bigint;

    select m.* into v_media from private.telegram_media m
    where m.bot_type = 'movie' and m.chat_id = p_chat_id and m.message_id = v_message
    for update;
    if found then
      select e.* into v_event from private.ingestion_events e where e.telegram_media_id = v_media.id and e.origin in ('uploader', 'channel');
      if not found or v_event.origin = 'uploader' then
        -- The uploader's own post (or unowned media): its provenance is the uploader's, never a channel candidate's.
        update private.discovery_deliveries d set ingestion_event_id = v_event.id where d.bot_type = 'movie' and d.delivery_key = v_key;
        v_ignored := v_ignored + 1;
        continue;
      end if;
      select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_event.id for update;
      perform 1 from private.ingestion_events e where e.id = v_event.id for update;
      update private.discovery_deliveries d set ingestion_event_id = v_event.id where d.bot_type = 'movie' and d.delivery_key = v_key;
      if v_review.event_id = v_ev->>'event_id' then
        v_duplicates := v_duplicates + 1;
        continue;
      end if;
      -- Edits apply in order; an older or equal-time event never overwrites a newer one.
      if v_observed < v_review.observed_at
         or (v_observed = v_review.observed_at and coalesce(v_update, -1) <= coalesce(v_event.telegram_update_id, -1)) then
        v_ignored := v_ignored + 1;
        continue;
      end if;

      if v_event.status = 'published' then
        -- A published message never reopens and the catalogue is untouched. The
        -- media row keeps the published identity; an operator must review the change.
        update private.channel_reviews r
        set event_id = v_ev->>'event_id', payload_digest = v_ev->>'payload_digest', observed_at = v_observed
        where r.ingestion_event_id = v_event.id;
        update private.ingestion_events e set error_code = 'published_message_changed' where e.id = v_event.id;
        perform private.channel_audit(v_event.id, v_review.review_revision, null, 'message_changed_after_publication');
        continue;
      end if;
      if v_event.status = 'rejected' then
        update private.channel_reviews r
        set review_revision = r.review_revision + 1, event_id = v_ev->>'event_id', payload_digest = v_ev->>'payload_digest',
            observed_at = v_observed, lease_token = null, lease_until = null
        where r.ingestion_event_id = v_event.id;
        update private.ingestion_events e set status = 'blocked', error_code = 'rejected_message_changed' where e.id = v_event.id;
        perform private.channel_audit(v_event.id, v_review.review_revision + 1, null, 'message_changed_after_rejection');
        continue;
      end if;

      -- An unpublished document may be edited or replaced: update it, invalidate
      -- the approval (and, through the revision and identity, rights and evidence).
      update private.telegram_media m
      set file_id = v_ev->>'file_id', file_unique_id = v_unique, file_size_bytes = v_size,
          file_name = v_ev->>'name', mime_type = v_ev->>'mime', caption = v_ev->>'caption'
      where m.id = v_media.id;
      v_dup := null;
      select o.* into v_other from private.telegram_media o
      where o.bot_type = 'movie' and o.file_unique_id = v_unique and o.id <> v_media.id
      order by o.id limit 1;
      if found then v_dup := v_other.id; end if;
      update private.channel_reviews r
      set review_revision = r.review_revision + 1, event_id = v_ev->>'event_id', payload_digest = v_ev->>'payload_digest',
          observed_at = v_observed, lease_token = null, lease_until = null, retry_at = now(),
          identity_state = 'unknown', tmdb_id = null, vj_id = null, relation = 'unknown',
          title = null, release_year = null, vj_text = null, warnings = '{}',
          duplicate_of_media_id = v_dup,
          approved_revision = null, approved_by = null, approved_at = null
      where r.ingestion_event_id = v_event.id;
      update private.metadata_match_candidates c set decision = 'superseded', decided_at = now(), decided_by = null
      where c.ingestion_event_id = v_event.id and c.decision in ('pending', 'approved');
      update private.ingestion_events e
      set status = case when v_dup is null then 'received' when v_other.file_size_bytes is not distinct from v_size then 'ignored' else 'blocked' end,
          error_code = case when v_dup is null then null when v_other.file_size_bytes is not distinct from v_size then 'duplicate_media' else 'document_identity_conflict' end,
          telegram_update_id = v_update, update_kind = v_kind, attempt_count = 0, parsed = null, processed_at = null
      where e.id = v_event.id;
      perform private.channel_audit(v_event.id, v_review.review_revision + 1, null, 'message_changed_approval_invalidated');
      v_detected := v_detected + 1;
      continue;
    end if;

    -- A new channel document.
    insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind,
                                        file_name, mime_type, caption, file_size_bytes, telegram_date)
    values ('movie', p_chat_id, v_message, v_ev->>'file_id', v_unique, 'document',
            v_ev->>'name', v_ev->>'mime', v_ev->>'caption', v_size, pg_catalog.to_timestamp((v_ev->>'date')::bigint))
    returning id into v_media_id;
    v_dup := null;
    select o.* into v_other from private.telegram_media o
    where o.bot_type = 'movie' and o.file_unique_id = v_unique and o.id <> v_media_id
    order by o.id limit 1;
    if found then v_dup := v_other.id; end if;
    v_status := case when v_dup is null then 'received' when v_other.file_size_bytes is not distinct from v_size then 'ignored' else 'blocked' end;
    v_error := case when v_dup is null then null when v_status = 'ignored' then 'duplicate_media' else 'document_identity_conflict' end;
    insert into private.ingestion_events (bot_type, origin, telegram_update_id, update_kind, telegram_media_id, status, error_code)
    values ('movie', 'channel', v_update, v_kind, v_media_id, v_status, v_error)
    returning id into v_event_id;
    insert into private.channel_reviews (ingestion_event_id, discovery_key, event_id, payload_digest, observed_at, duplicate_of_media_id)
    values (v_event_id, private.discovery_message_key(p_chat_id, v_message), v_ev->>'event_id', v_ev->>'payload_digest', v_observed, v_dup);
    update private.discovery_deliveries d set ingestion_event_id = v_event_id where d.bot_type = 'movie' and d.delivery_key = v_key;
    perform private.channel_audit(v_event_id, 1, null, case when v_dup is null then 'detected' else v_error end);
    v_detected := v_detected + 1;
  end loop;

  if v_reconciling then
    -- Exhaustion never resets a durable position to the start of history.
    update private.discovery_cursors c
    set reconciliation_cursor = coalesce(p_reconciliation->>'cursor', c.reconciliation_cursor),
        reconciliation_checked_at = now(),
        reconciliation_incomplete = (p_reconciliation->>'incomplete')::boolean
    where c.bot_type = 'movie';
  else
    update private.discovery_cursors c set update_offset = v_offset where c.bot_type = 'movie';
  end if;
  return jsonb_build_object('detected', v_detected, 'duplicates', v_duplicates, 'ignored', v_ignored, 'update_offset', v_offset);
end;
$$;

-- Claims the next candidate for inspection under a fenced lease. Returns null
-- when nothing is due. Candidates that exhausted five attempts are blocked.
create function public.discovery_claim(p_lease_seconds integer)
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
  return jsonb_build_object(
    'key', v_review.discovery_key, 'revision', v_review.review_revision, 'lease', v_token,
    'attempts', v_event.attempt_count + 1, 'event_id', v_review.event_id, 'payload_digest', v_review.payload_digest,
    'observed_at', v_review.observed_at, 'update_id', v_event.telegram_update_id, 'kind', v_event.update_kind,
    'chat_id', v_media.chat_id, 'message_id', v_media.message_id, 'file_unique_id', v_media.file_unique_id,
    'size', v_media.file_size_bytes, 'name', v_media.file_name, 'mime', v_media.mime_type, 'caption', v_media.caption,
    'identity', private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes));
end;
$$;

-- Records one inspection under its lease. A lost lease or a newer revision
-- returns 'stale' and changes nothing (a slow worker cannot overwrite an edit).
--
-- p_result: { outcome: 'review' | 'blocked', error_code, title, year, vj_text, vj_id, warnings,
--             identity_state, proposed_tmdb_id, candidates: [{ tmdb_id, score, reasons, snapshot }], evidence }
-- evidence: null | { identity, method, policy_version, media_class, reasons, container, video_codec,
--                    audio_codec, accessible, gateway_compatible, playback_ready, bytes_read }
create function public.discovery_complete(p_key text, p_lease uuid, p_revision integer, p_result jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
  v_candidate jsonb;
  v_ev jsonb;
  v_vj bigint;
  v_tmdb integer;
  v_state text;
  v_status text;
begin
  if p_lease is null or p_revision is null or p_result is null or jsonb_typeof(p_result) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_result) k)
          is distinct from array['candidates', 'error_code', 'evidence', 'identity_state', 'outcome', 'proposed_tmdb_id',
                                 'title', 'vj_id', 'vj_text', 'warnings', 'year']
     or p_result->>'outcome' is null or p_result->>'outcome' not in ('review', 'blocked')
     or jsonb_typeof(p_result->'error_code') not in ('null', 'string')
     or (jsonb_typeof(p_result->'error_code') = 'string' and (p_result->>'error_code') !~ '^[a-z0-9_]{1,100}$')
     or ((p_result->>'outcome' = 'blocked') <> (jsonb_typeof(p_result->'error_code') = 'string'))
     or jsonb_typeof(p_result->'title') not in ('null', 'string') or char_length(coalesce(p_result->>'title', 'x')) not between 1 and 300
     or jsonb_typeof(p_result->'year') not in ('null', 'number')
     or (jsonb_typeof(p_result->'year') = 'number' and (p_result->>'year') !~ '^(18[7-9][0-9]|19[0-9]{2}|2[01][0-9]{2})$')
     or jsonb_typeof(p_result->'vj_text') not in ('null', 'string') or char_length(coalesce(p_result->>'vj_text', 'x')) not between 1 and 100
     or jsonb_typeof(p_result->'vj_id') not in ('null', 'number')
     or (jsonb_typeof(p_result->'vj_id') = 'number' and (p_result->>'vj_id') !~ '^[1-9][0-9]{0,17}$')
     or jsonb_typeof(p_result->'warnings') <> 'array' or jsonb_array_length(p_result->'warnings') > 50
     or exists (select 1 from jsonb_array_elements(p_result->'warnings') w where jsonb_typeof(w) <> 'string' or (w #>> '{}') !~ '^[a-z0-9_]{1,100}$')
     or p_result->>'identity_state' is null or p_result->>'identity_state' not in ('unknown', 'ambiguous', 'proposed')
     or jsonb_typeof(p_result->'proposed_tmdb_id') not in ('null', 'number')
     or ((p_result->>'identity_state' = 'proposed') <> (jsonb_typeof(p_result->'proposed_tmdb_id') = 'number'))
     or jsonb_typeof(p_result->'candidates') <> 'array' or jsonb_array_length(p_result->'candidates') > 20
     or jsonb_typeof(p_result->'evidence') not in ('null', 'object') then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  for v_candidate in select value from jsonb_array_elements(p_result->'candidates') loop
    if jsonb_typeof(v_candidate) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_candidate) k) is distinct from array['reasons', 'score', 'snapshot', 'tmdb_id']
       or jsonb_typeof(v_candidate->'tmdb_id') <> 'number' or (v_candidate->>'tmdb_id') !~ '^[1-9][0-9]{0,9}$'
       or (v_candidate->>'tmdb_id')::bigint > 2147483647
       or jsonb_typeof(v_candidate->'score') <> 'number' or (v_candidate->>'score')::numeric not between 0 and 1
       or jsonb_typeof(v_candidate->'reasons') <> 'object'
       or jsonb_typeof(v_candidate->'snapshot') not in ('null', 'object')
       or (jsonb_typeof(v_candidate->'snapshot') = 'object' and (
             (v_candidate->'snapshot'->>'tmdb_id') is distinct from (v_candidate->>'tmdb_id')
             or jsonb_typeof(v_candidate->'snapshot'->'title') <> 'string'
             or octet_length((v_candidate->'snapshot')::text) > 65536)) then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct value->>'tmdb_id') from jsonb_array_elements(p_result->'candidates')) <> jsonb_array_length(p_result->'candidates') then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_tmdb := (p_result->>'proposed_tmdb_id')::integer;
  if v_tmdb is not null and not exists (
    select 1 from jsonb_array_elements(p_result->'candidates') c
    where (c->>'tmdb_id')::integer = v_tmdb and jsonb_typeof(c->'snapshot') = 'object') then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;

  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.lease_token is distinct from p_lease or v_review.review_revision <> p_revision or v_event.status <> 'processing' then
    return 'stale';
  end if;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);

  -- Media evidence: recorded only for the identity this lease inspected.
  v_ev := p_result->'evidence';
  if jsonb_typeof(v_ev) = 'object' then
    if (select array_agg(k order by k) from jsonb_object_keys(v_ev) k)
         is distinct from array['accessible', 'audio_codec', 'bytes_read', 'container', 'gateway_compatible', 'identity',
                                'media_class', 'method', 'playback_ready', 'policy_version', 'reasons', 'video_codec']
       or jsonb_typeof(v_ev->'reasons') <> 'array'
       or jsonb_typeof(v_ev->'accessible') <> 'boolean' or jsonb_typeof(v_ev->'gateway_compatible') <> 'boolean'
       or jsonb_typeof(v_ev->'playback_ready') <> 'boolean'
       or jsonb_typeof(v_ev->'bytes_read') <> 'number' or jsonb_typeof(v_ev->'policy_version') <> 'number' then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end if;
    if v_identity is null or v_ev->>'identity' is distinct from v_identity then
      raise exception 'discovery_evidence_identity_mismatch' using errcode = 'P0001';
    end if;
    begin
      insert into private.media_evidence (telegram_media_id, media_identity, method, policy_version, media_class, reasons,
                                          container, video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read)
      values (v_media.id, v_identity, v_ev->>'method', (v_ev->>'policy_version')::integer, v_ev->>'media_class',
              array(select jsonb_array_elements_text(v_ev->'reasons')),
              v_ev->>'container', v_ev->>'video_codec', v_ev->>'audio_codec', (v_ev->>'accessible')::boolean,
              (v_ev->>'gateway_compatible')::boolean, (v_ev->>'playback_ready')::boolean, (v_ev->>'bytes_read')::bigint);
    exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end;
  end if;

  if p_result->>'outcome' = 'blocked' then
    update private.channel_reviews r set lease_token = null, lease_until = null where r.ingestion_event_id = v_id;
    update private.ingestion_events e set status = 'blocked', error_code = p_result->>'error_code', processed_at = now() where e.id = v_id;
    perform private.channel_audit(v_id, p_revision, null, 'inspection_blocked', p_result->>'error_code');
    return 'blocked';
  end if;

  -- Only an active, existing VJ is kept as a suggestion; never created here.
  v_vj := (p_result->>'vj_id')::bigint;
  if v_vj is not null and not exists (select 1 from public.vjs v where v.id = v_vj and v.is_active) then
    v_vj := null;
  end if;
  v_state := p_result->>'identity_state';

  -- Candidates: refreshed in place; ones no longer suggested become superseded (kept).
  update private.metadata_match_candidates c set decision = 'superseded', decided_at = now(), decided_by = null
  where c.ingestion_event_id = v_id and c.decision in ('pending', 'approved')
    and not exists (select 1 from jsonb_array_elements(p_result->'candidates') x where (x->>'tmdb_id')::integer = c.tmdb_id);
  insert into private.metadata_match_candidates (ingestion_event_id, tmdb_media_type, tmdb_id, score, reasons, snapshot)
  select v_id, 'movie', (x->>'tmdb_id')::integer, (x->>'score')::numeric, x->'reasons',
         case when jsonb_typeof(x->'snapshot') = 'object' then x->'snapshot' end
  from jsonb_array_elements(p_result->'candidates') x
  on conflict (ingestion_event_id, tmdb_media_type, tmdb_id) do update
    set score = excluded.score, reasons = excluded.reasons, snapshot = excluded.snapshot,
        decision = 'pending', decided_at = null, decided_by = null;

  update private.channel_reviews r
  set lease_token = null, lease_until = null,
      title = p_result->>'title', release_year = (p_result->>'year')::integer, vj_text = p_result->>'vj_text',
      warnings = array(select jsonb_array_elements_text(p_result->'warnings')),
      identity_state = v_state, tmdb_id = v_tmdb, vj_id = v_vj,
      relation = private.channel_relation(v_tmdb, v_vj)
  where r.ingestion_event_id = v_id;
  v_status := case when v_review.duplicate_of_media_id is not null then 'ignored' else 'needs_review' end;
  update private.ingestion_events e
  set status = v_status, error_code = null, processed_at = now(),
      parsed = jsonb_build_object('title', p_result->'title', 'year', p_result->'year', 'vj_text', p_result->'vj_text',
                                  'vj_id', to_jsonb(v_vj), 'warnings', p_result->'warnings')
  where e.id = v_id;
  perform private.channel_audit(v_id, p_revision, null, 'inspected', v_state);
  return v_status;
end;
$$;

-- Records a failed inspection under its lease with bounded exponential retry.
create function public.discovery_fail(p_key text, p_lease uuid, p_revision integer, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_status text;
begin
  if p_lease is null or p_revision is null or p_code is null or p_code !~ '^[a-z0-9_]{1,100}$' then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.lease_token is distinct from p_lease or v_review.review_revision <> p_revision or v_event.status <> 'processing' then
    return 'stale';
  end if;
  v_status := case when v_event.attempt_count >= 5 then 'blocked' else 'failed' end;
  update private.channel_reviews r
  set lease_token = null, lease_until = null,
      retry_at = now() + make_interval(secs => least(60, power(2, v_event.attempt_count)::integer))
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e
  set status = v_status, error_code = case when v_status = 'blocked' then 'inspection_attempts_exhausted' else p_code end
  where e.id = v_id;
  perform private.channel_audit(v_id, p_revision, null, 'inspection_failed', p_code);
  return v_status;
end;
$$;

-- Restricted catalogue lookup for catalogue-first matching: titles whose slug
-- equals the parsed title's (any publication state, so relations are known).
create function public.discovery_catalogue_lookup(p_title text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'movie_id', m.id, 'tmdb_id', m.tmdb_id, 'title', m.title, 'original_title', m.original_title,
      'year', extract(year from m.release_date)::integer,
      'vj_ids', coalesce((select jsonb_agg(mv.vj_id order by mv.vj_id) from public.movie_versions mv where mv.movie_id = m.id), '[]'::jsonb))
    order by m.id), '[]'::jsonb)
  from (select * from public.movies x
        where p_title is not null and char_length(p_title) between 1 and 300 and private.catalogue_slug(p_title) <> ''
          and x.tmdb_id is not null
          and (private.catalogue_slug(x.title) = private.catalogue_slug(p_title)
               or private.catalogue_slug(x.original_title) = private.catalogue_slug(p_title))
        order by x.id limit 20) m
$$;

-- Active VJs for resolution (existing names and slugs only; nothing is created).
create function public.discovery_vjs()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.is_active) order by v.id), '[]'::jsonb)
  from public.vjs v where v.is_active
$$;

-- Health counters for logs and alerts (no identifiers).
create function public.discovery_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'candidates', count(*),
    'pending', count(*) filter (where e.status in ('received', 'processing', 'failed')),
    'awaiting_review', count(*) filter (where e.status = 'needs_review'),
    'approved', count(*) filter (where e.status = 'matched'),
    'published', count(*) filter (where e.status = 'published'),
    'blocked', count(*) filter (where e.status = 'blocked'),
    'duplicates', count(*) filter (where e.status = 'ignored'),
    'failed', count(*) filter (where e.status = 'failed'),
    -- Gate counts over the review backlog only (bounded by it).
    'media_blocked', count(*) filter (where e.status = 'needs_review'
                       and 'media_verification_required' = any (private.channel_review_blockers(e.id))),
    'rights_blocked', count(*) filter (where e.status = 'needs_review'
                       and 'rights_clearance_required' = any (private.channel_review_blockers(e.id))),
    'reconciliation_incomplete', coalesce((select c.reconciliation_incomplete from private.discovery_cursors c where c.bot_type = 'movie'), true),
    'reconciliation_checked_at', (select c.reconciliation_checked_at from private.discovery_cursors c where c.bot_type = 'movie'))
  from private.ingestion_events e where e.origin = 'channel'
$$;

-- ---------------------------------------------------------------------------
-- 8. Reviewer commands (authenticated + catalogue_reviewers capability)
-- ---------------------------------------------------------------------------
create function public.discovery_review_list(p_status text, p_query text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_reviewer('any');
  if (p_status is not null and p_status !~ '^[a-z_]{1,30}$') or char_length(coalesce(p_query, '')) > 300
     or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(private.channel_view(x.id, false) order by x.received_at desc, x.id desc)
    from (select e.id, e.received_at from private.ingestion_events e
          join private.channel_reviews r on r.ingestion_event_id = e.id
          join private.telegram_media m on m.id = e.telegram_media_id
          where e.origin = 'channel' and (p_status is null or e.status = p_status)
            and (coalesce(p_query, '') = '' or pg_catalog.strpos(pg_catalog.lower(coalesce(r.title, m.file_name, '')), pg_catalog.lower(p_query)) > 0)
          order by e.received_at desc, e.id desc limit p_limit) x), '[]'::jsonb);
end;
$$;

create function public.discovery_review_get(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform private.require_reviewer('any');
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  select r.ingestion_event_id into v_id from private.channel_reviews r where r.discovery_key = p_key;
  if not found then
    return null;
  end if;
  return private.channel_view(v_id, true);
end;
$$;

-- Confirms the movie identity and VJ from the recorded, validated choices.
create function public.discovery_review_correct(p_key text, p_revision integer, p_tmdb_id integer, p_year integer, p_vj_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('review');
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_snapshot jsonb;
begin
  if p_revision is null or p_tmdb_id is null or p_tmdb_id <= 0 or p_vj_id is null or p_year is null then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status not in ('needs_review', 'matched') then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  select c.snapshot into v_snapshot from private.metadata_match_candidates c
  where c.ingestion_event_id = v_id and c.tmdb_media_type = 'movie' and c.tmdb_id = p_tmdb_id
    and c.snapshot is not null and c.decision <> 'superseded';
  if not found or not exists (select 1 from public.vjs v where v.id = p_vj_id and v.is_active) then
    raise exception 'review_selection_unavailable' using errcode = 'P0001';
  end if;
  if substr(coalesce(v_snapshot->>'release_date', ''), 1, 4) is distinct from p_year::text then
    raise exception 'review_year_mismatch' using errcode = 'P0001';
  end if;
  update private.metadata_match_candidates c set decision = 'pending', decided_at = null, decided_by = null
  where c.ingestion_event_id = v_id and c.decision = 'approved';
  update private.channel_reviews r
  set review_revision = r.review_revision + 1, identity_state = 'confirmed', tmdb_id = p_tmdb_id, vj_id = p_vj_id,
      title = pg_catalog.left(v_snapshot->>'title', 300), release_year = p_year,
      relation = private.channel_relation(p_tmdb_id, p_vj_id),
      warnings = array(select w from unnest(r.warnings) w
                       where w !~ '^(caption_|missing_vj|multiple_years|vj_boundary_uncertain|multiple_vjs)'),
      approved_revision = null, approved_by = null, approved_at = null
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e set status = 'needs_review' where e.id = v_id;
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'identity_confirmed', 'tmdb:' || p_tmdb_id || ',vj:' || p_vj_id);
  return private.channel_view(v_id, false);
end;
$$;

-- Records an explicit rights decision for the current document and revision.
create function public.discovery_review_clear_rights(p_key text, p_revision integer, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('rights');
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
begin
  if p_revision is null or p_reference is null or char_length(p_reference) not between 1 and 200
     or p_reference <> pg_catalog.btrim(p_reference) or p_reference !~ '^[A-Za-z0-9 _.:/-]+$' or position('://' in p_reference) > 0 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status not in ('needs_review', 'matched') then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);
  if v_identity is null then
    raise exception 'review_media_identity_incomplete' using errcode = 'P0001';
  end if;
  update private.channel_reviews r
  set review_revision = r.review_revision + 1, approved_revision = null, approved_by = null, approved_at = null
  where r.ingestion_event_id = v_id;
  update private.metadata_match_candidates c set decision = 'pending', decided_at = null, decided_by = null
  where c.ingestion_event_id = v_id and c.decision = 'approved';
  update private.ingestion_events e set status = 'needs_review' where e.id = v_id;
  insert into private.rights_clearances (ingestion_event_id, review_revision, media_identity, reference, cleared_by)
  values (v_id, p_revision + 1, v_identity, p_reference, v_uid);
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'rights_cleared');
  return private.channel_view(v_id, false);
end;
$$;

create function public.discovery_review_reject(p_key text, p_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('review');
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
begin
  if p_revision is null then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status in ('published', 'rejected', 'processing') then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  update private.metadata_match_candidates c set decision = 'rejected', decided_at = now(), decided_by = v_uid
  where c.ingestion_event_id = v_id and c.decision in ('pending', 'approved');
  update private.channel_reviews r set approved_revision = null, approved_by = null, approved_at = null
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e set status = 'rejected' where e.id = v_id;
  perform private.channel_audit(v_id, p_revision, v_uid, 'rejected');
  return private.channel_view(v_id, false);
end;
$$;

-- Sends a candidate back for a fresh inspection (new revision, nothing kept as approved).
create function public.discovery_review_retry(p_key text, p_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('review');
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
begin
  if p_revision is null then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status not in ('needs_review', 'failed', 'matched')
     and not (v_event.status = 'blocked' and v_event.error_code = 'inspection_attempts_exhausted') then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  update private.metadata_match_candidates c set decision = 'pending', decided_at = null, decided_by = null
  where c.ingestion_event_id = v_id and c.decision = 'approved';
  update private.channel_reviews r
  set review_revision = r.review_revision + 1, retry_at = now(), lease_token = null, lease_until = null,
      approved_revision = null, approved_by = null, approved_at = null
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e set status = 'received', error_code = null, attempt_count = 0 where e.id = v_id;
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'reinspection_requested');
  return private.channel_view(v_id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Approval and publication: not in the Data API
-- ---------------------------------------------------------------------------
-- As for uploader media (C2B.2H), no approval or publication command exists in
-- an exposed schema. These two live in catalogue_review, which the Data API
-- does not expose, and only velora_review_service can execute them: the
-- restricted server identity of the admin review action (created NOLOGIN;
-- login and password are operator configuration, as for velora_media_gateway).
-- The server passes the reviewer whose fresh session it verified; the database
-- still decides whether that account holds the capability, and re-checks every
-- gate. The owner may run them through psql as well.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'velora_review_service') then
    create role velora_review_service;
  end if;
end
$$;

alter role velora_review_service
  with nologin noinherit nocreatedb nocreaterole
  connection limit 5;
alter role velora_review_service set statement_timeout = '15s';
alter role velora_review_service set idle_in_transaction_session_timeout = '10s';
alter role velora_review_service set search_path = '';

comment on role velora_review_service is
  'Velora admin review action: may only execute catalogue_review.approve_channel_candidate and publish_channel_candidate. Login and password are operator configuration.';

create schema catalogue_review;
revoke all on schema catalogue_review from public, anon, authenticated, service_role;
grant usage on schema catalogue_review to velora_review_service;

comment on schema catalogue_review is
  'Owner-tier channel review commands. Server-to-database only; not exposed through the Data API.';

-- Approves the current revision only when every gate passes. An identical
-- replay returns the approved view; it never approves another revision.
create function catalogue_review.approve_channel_candidate(p_key text, p_revision integer, p_reviewer uuid)
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
  if private.channel_relation(v_review.tmdb_id, v_review.vj_id) not in ('new_movie', 'new_vj') then
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

-- Publishes an approved candidate through the shared owner boundary. Requires
-- the separate publish capability; the gates are re-evaluated inside.
create function catalogue_review.publish_channel_candidate(p_key text, p_revision integer, p_reviewer uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_result record;
begin
  if p_revision is null then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  if not private.reviewer_has(p_reviewer, 'publish') then
    raise exception 'review_not_authorized' using errcode = '42501';
  end if;
  v_id := private.channel_lock(p_key);
  select * into v_result from private.catalogue_publish_channel_movie(v_id, p_revision, p_reviewer);
  return jsonb_build_object('result', v_result.result, 'movie_slug', v_result.movie_slug, 'version_id', v_result.version_id,
                            'vj_slug', (select v.slug from public.vjs v join private.channel_reviews r on r.vj_id = v.id
                                        where r.ingestion_event_id = v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
alter table private.channel_reviews enable row level security;
alter table private.media_evidence enable row level security;
alter table private.rights_clearances enable row level security;
alter table private.catalogue_reviewers enable row level security;
alter table private.channel_review_audit enable row level security;
alter table private.discovery_deliveries enable row level security;
alter table private.discovery_cursors enable row level security;

revoke all on table
  private.channel_reviews, private.media_evidence, private.rights_clearances, private.catalogue_reviewers,
  private.channel_review_audit, private.discovery_deliveries, private.discovery_cursors,
  private.ingestion_events, private.telegram_media, private.metadata_match_candidates
from public, anon, authenticated, service_role;

revoke all on sequence
  private.media_evidence_id_seq, private.rights_clearances_id_seq, private.channel_review_audit_id_seq
from public, anon, authenticated, service_role;

-- Owner-only internals and the owner publication functions: no API role.
revoke all on function
  private.channel_media_identity(bigint, bigint, text, bigint),
  private.discovery_message_key(bigint, bigint),
  private.guard_telegram_media_identity(),
  private.guard_append_only(),
  private.catalogue_materialize_movie_version(integer, bigint, bigint, jsonb),
  private.catalogue_publish_movie(text, jsonb, boolean),
  private.channel_current_evidence(bigint),
  private.channel_review_blockers(bigint),
  private.catalogue_publish_channel_movie(bigint, integer, uuid),
  private.channel_audit(bigint, integer, uuid, text, text),
  private.channel_relation(integer, bigint),
  private.reviewer_has(uuid, text),
  private.require_reviewer(text),
  private.channel_lock(text),
  private.channel_view(bigint, boolean)
from public, anon, authenticated, service_role;

-- Worker commands: service_role only.
revoke all on function
  public.discovery_acquire_consumer(uuid, integer),
  public.discovery_receive(uuid, bigint, jsonb, jsonb),
  public.discovery_claim(integer),
  public.discovery_complete(text, uuid, integer, jsonb),
  public.discovery_fail(text, uuid, integer, text),
  public.discovery_catalogue_lookup(text),
  public.discovery_vjs(),
  public.discovery_health()
from public, anon, authenticated, service_role;

grant execute on function
  public.discovery_acquire_consumer(uuid, integer),
  public.discovery_receive(uuid, bigint, jsonb, jsonb),
  public.discovery_claim(integer),
  public.discovery_complete(text, uuid, integer, jsonb),
  public.discovery_fail(text, uuid, integer, text),
  public.discovery_catalogue_lookup(text),
  public.discovery_vjs(),
  public.discovery_health()
to service_role;

-- Reviewer commands: authenticated only (each checks catalogue_reviewers).
revoke all on function
  public.discovery_review_list(text, text, integer),
  public.discovery_review_get(text),
  public.discovery_review_correct(text, integer, integer, integer, bigint),
  public.discovery_review_clear_rights(text, integer, text),
  public.discovery_review_reject(text, integer),
  public.discovery_review_retry(text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.discovery_review_list(text, text, integer),
  public.discovery_review_get(text),
  public.discovery_review_correct(text, integer, integer, integer, bigint),
  public.discovery_review_clear_rights(text, integer, text),
  public.discovery_review_reject(text, integer),
  public.discovery_review_retry(text, integer)
to authenticated;

-- Approval and publication: velora_review_service only (the owner keeps its own rights).
revoke all on function
  catalogue_review.approve_channel_candidate(text, integer, uuid),
  catalogue_review.publish_channel_candidate(text, integer, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  catalogue_review.approve_channel_candidate(text, integer, uuid),
  catalogue_review.publish_channel_candidate(text, integer, uuid)
to velora_review_service;
