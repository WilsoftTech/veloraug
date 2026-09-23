-- Velora UG Phase B, checkpoint B-1: Telegram media, ingestion events and
-- metadata match review. Decisions: docs/PHASE_B_CATALOGUE_DESIGN.md (D2, D3).
--
-- All three tables hold raw provider data or review evidence, so they live in
-- private (not exposed by the Data API) and are also locked with RLS and no
-- policies, plus explicit revokes. No client role, and not service_role, gets
-- any privilege: Phase C writes through narrow server paths. Nothing here adds
-- client access to the catalogue; public reads arrive in checkpoint B-2.

-- ---------------------------------------------------------------------------
-- private.telegram_media: one delivered channel file.
--
-- file_id is bot-specific and may change; it is only ever meaningful together
-- with bot_type. file_unique_id is stable across bots but cannot download.
-- A delivery is unique per (bot_type, chat_id, message_id). file_unique_id is
-- indexed but NOT unique (D3): a re-upload of the same file is flagged for
-- review by the ingestion code, never merged silently.
-- ---------------------------------------------------------------------------
create table private.telegram_media (
  id bigint generated always as identity primary key,
  bot_type text not null check (bot_type in ('movie', 'series')),
  chat_id bigint not null,
  message_id bigint not null check (message_id > 0),
  file_id text not null check (char_length(file_id) between 1 and 1024),
  file_unique_id text not null check (char_length(file_unique_id) between 1 and 128),
  media_kind text not null check (media_kind in ('video', 'document')),
  file_name text check (file_name is null or char_length(file_name) between 1 and 1024),
  mime_type text check (mime_type is null or char_length(mime_type) between 1 and 255),
  caption text check (caption is null or char_length(caption) <= 4096),
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  telegram_date timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_media_delivery_key unique (bot_type, chat_id, message_id),
  -- Target of the version foreign keys below, which also pin the bot type.
  constraint telegram_media_id_bot_type_key unique (id, bot_type)
);

create index telegram_media_file_unique_id_idx
  on private.telegram_media (bot_type, file_unique_id);

create trigger telegram_media_set_updated_at
  before update on private.telegram_media
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- private.ingestion_events: one received Telegram update and its processing
-- state. Unique per (bot_type, telegram_update_id), so a retried or replayed
-- update is recorded once. No raw payload is stored: only the parsed
-- suggestions and a safe error code.
-- ---------------------------------------------------------------------------
create table private.ingestion_events (
  id bigint generated always as identity primary key,
  bot_type text not null check (bot_type in ('movie', 'series')),
  telegram_update_id bigint not null check (telegram_update_id >= 0),
  update_kind text not null check (update_kind in ('channel_post', 'edited_channel_post')),
  telegram_media_id bigint references private.telegram_media (id) on delete restrict,
  status text not null default 'received'
    check (status in (
      'received', 'processing', 'parsed', 'needs_review',
      'matched', 'published', 'rejected', 'ignored', 'failed'
    )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  parsed jsonb check (parsed is null or jsonb_typeof(parsed) = 'object'),
  error_code text check (error_code is null or char_length(error_code) between 1 and 100),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_events_update_key unique (bot_type, telegram_update_id)
);

create index ingestion_events_telegram_media_id_idx
  on private.ingestion_events (telegram_media_id)
  where telegram_media_id is not null;
-- Work queue and review backlog, oldest first.
create index ingestion_events_status_received_idx
  on private.ingestion_events (status, received_at, id);

create trigger ingestion_events_set_updated_at
  before update on private.ingestion_events
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- private.metadata_match_candidates: scored TMDB candidates for one ingestion
-- event, with the reasons and the decision. At most one approved candidate per
-- event; rejected and superseded rows are kept as audit history. tmdb_media_type
-- uses TMDB's own vocabulary because this is the TMDB adapter boundary.
-- ---------------------------------------------------------------------------
create table private.metadata_match_candidates (
  id bigint generated always as identity primary key,
  ingestion_event_id bigint not null
    references private.ingestion_events (id) on delete restrict,
  tmdb_media_type text not null check (tmdb_media_type in ('movie', 'tv')),
  tmdb_id integer not null check (tmdb_id > 0),
  score numeric(5,4) not null check (score between 0 and 1),
  reasons jsonb not null default '{}'::jsonb check (jsonb_typeof(reasons) = 'object'),
  decision text not null default 'pending'
    check (decision in ('pending', 'approved', 'rejected', 'superseded')),
  -- Null for automatic decisions. Reviewer authorization arrives in Phase C (D4).
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint metadata_match_candidates_candidate_key
    unique (ingestion_event_id, tmdb_media_type, tmdb_id),
  constraint metadata_match_candidates_decided_check
    check ((decision = 'pending') = (decided_at is null))
);

create unique index metadata_match_candidates_one_approved_key
  on private.metadata_match_candidates (ingestion_event_id)
  where decision = 'approved';
create index metadata_match_candidates_decided_by_idx
  on private.metadata_match_candidates (decided_by)
  where decided_by is not null;

-- ---------------------------------------------------------------------------
-- Version -> media links (D2). One delivered file backs at most one version,
-- and the composite foreign key pins the bot: a movie version can only use
-- movie-bot media and an episode version only series-bot media. The bot-type
-- columns are constants that exist only to make that rule declarative.
-- A version cannot be ready without media.
-- ---------------------------------------------------------------------------
alter table public.movie_versions
  add column telegram_media_id bigint unique,
  add column telegram_media_bot_type text not null default 'movie'
    check (telegram_media_bot_type = 'movie'),
  add constraint movie_versions_telegram_media_fkey
    foreign key (telegram_media_id, telegram_media_bot_type)
    references private.telegram_media (id, bot_type) on delete restrict,
  add constraint movie_versions_ready_media_check
    check (availability_status <> 'ready' or telegram_media_id is not null);

alter table public.episode_versions
  add column telegram_media_id bigint unique,
  add column telegram_media_bot_type text not null default 'series'
    check (telegram_media_bot_type = 'series'),
  add constraint episode_versions_telegram_media_fkey
    foreign key (telegram_media_id, telegram_media_bot_type)
    references private.telegram_media (id, bot_type) on delete restrict,
  add constraint episode_versions_ready_media_check
    check (availability_status <> 'ready' or telegram_media_id is not null);

-- ---------------------------------------------------------------------------
-- Privileges (AGENTS.md migration privilege invariant). Deny by default: RLS
-- with no policies, and every privilege revoked from client roles and from
-- service_role, matching the catalogue baseline. The version tables keep the
-- no-client-access posture from 20260922080911; adding columns grants nothing.
-- ---------------------------------------------------------------------------
alter table private.telegram_media enable row level security;
alter table private.ingestion_events enable row level security;
alter table private.metadata_match_candidates enable row level security;

revoke all on table
  private.telegram_media,
  private.ingestion_events,
  private.metadata_match_candidates
from public, anon, authenticated, service_role;

revoke all on sequence
  private.telegram_media_id_seq,
  private.ingestion_events_id_seq,
  private.metadata_match_candidates_id_seq
from public, anon, authenticated, service_role;
