-- Velora UG Phase C, checkpoint C2B.1B: durable Telegram recovery bounds.
-- Design: docs/PHASE_C_INGESTION_DESIGN.md ("C2B.1B").
--
-- Crash recovery scans a channel between a floor (a message id known to
-- precede the upload) and a marker posted afterwards. Until now only the
-- uploader's local journal knew the floor. This migration makes it durable,
-- so a fresh machine can recover from Supabase state alone:
--
-- 1. private.telegram_channels.checkpoint_message_id: an advance-only,
--    per-channel recovery checkpoint.
-- 2. private.ingestion_events.upload_floor_message_id: the floor of the
--    current attempt, computed by the server when the attempt starts and
--    immutable for that attempt.
-- 3. ingest_upload_start computes and returns the floor. ingest_upload_status
--    returns it with the attempt's start time and age. ingest_upload_record
--    refuses evidence at or below the floor. ingest_channel_checkpoint is new.
--
-- Nothing here approves, publishes or touches a public catalogue table.
-- private.ingestion_events stays the single lifecycle root.
--
-- Checkpoint invariant: every message id at or below a channel's checkpoint
-- was posted before every upload attempt that is still unresolved
-- (uploading or uncertain) in that channel, and before every attempt started
-- later. It says nothing about whether those messages still exist.
--
-- Concurrency: ingest_upload_start takes a shared, and
-- ingest_channel_checkpoint an exclusive, transaction-level advisory lock on
-- the channel's bot type (class 1001; movie 1, series 2), before reading any
-- checkpoint or upload state. So a checkpoint advance either commits before a
-- start reads the checkpoint (the start then uses it: the observed message
-- predates the start), or it waits and then sees that start's unresolved
-- attempt and refuses. Starts do not block each other.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table private.telegram_channels
  add column checkpoint_message_id bigint not null default 0;
alter table private.telegram_channels
  add constraint telegram_channels_checkpoint_check
    check (checkpoint_message_id between 0 and 2147483647);

-- Null for webhook rows and for any uploader row that predates this
-- migration: no floor is fabricated, and recovery treats a missing floor as
-- unknown (it holds instead of scanning). Hosted had no ingestion rows.
alter table private.ingestion_events
  add column upload_floor_message_id bigint;
alter table private.ingestion_events
  add constraint ingestion_events_upload_floor_check
    check (upload_floor_message_id is null
           or (origin = 'uploader' and upload_floor_message_id between 1 and 2147483647));

-- A floor belongs to one attempt: it may change only when a new attempt
-- starts (the attempt count increases). Enforced here as well as in the
-- functions, so no later function can silently move an unresolved floor.
create function private.guard_upload_floor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.upload_floor_message_id is distinct from old.upload_floor_message_id
     and new.upload_attempt_count <= old.upload_attempt_count then
    raise exception 'ingest_recovery_floor_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger ingestion_events_guard_upload_floor
  before update on private.ingestion_events
  for each row execute function private.guard_upload_floor();

-- The checkpoint never decreases. Moving a bot to another channel resets it
-- (the old channel's ids say nothing about the new one) and is refused while
-- that bot has an unresolved upload.
create function private.guard_channel_checkpoint()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.chat_id is distinct from old.chat_id then
    if exists (
      select 1 from private.ingestion_events e
      where e.origin = 'uploader' and e.bot_type = old.bot_type and e.upload_state in ('uploading', 'uncertain')
    ) then
      raise exception 'ingest_recovery_unresolved' using errcode = 'P0001';
    end if;
    new.checkpoint_message_id := 0;
  elsif new.checkpoint_message_id < old.checkpoint_message_id then
    raise exception 'ingest_checkpoint_regression' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger telegram_channels_guard_checkpoint
  before update on private.telegram_channels
  for each row execute function private.guard_channel_checkpoint();

-- ---------------------------------------------------------------------------
-- Worker commands
--
-- New error codes:
--   ingest_recovery_floor_unknown  no checkpoint and no recorded message for
--                                  the channel: an attempt would have no floor
--   ingest_recovery_unresolved     checkpoint advance while an upload in that
--                                  channel is uploading or uncertain
-- ---------------------------------------------------------------------------

-- Return type changes (new columns), so drop and recreate; privileges are
-- re-established below.
drop function public.ingest_upload_status(text, text);
drop function public.ingest_upload_start(text, text, bigint, bigint);

-- What the uploader needs to decide what to do next, now including the
-- current attempt's floor, start time and age (on the database clock, so the
-- grace period does not depend on the uploader's clock).
create function public.ingest_upload_status(p_source_fingerprint text, p_bot_type text)
returns table (
  upload_state text,
  upload_attempt_count integer,
  upload_failure_code text,
  needs_review boolean,
  chat_id bigint,
  message_id bigint,
  file_id text,
  file_unique_id text,
  media_kind text,
  file_name text,
  mime_type text,
  caption text,
  file_size_bytes bigint,
  duration_seconds integer,
  width integer,
  height integer,
  telegram_date timestamptz,
  upload_started_at timestamptz,
  upload_age_seconds bigint,
  upload_floor_message_id bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_bot_type is null or p_bot_type not in ('movie', 'series') then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  select e.* into v_event from private.ingestion_events e
  where e.origin = 'uploader' and e.source_fingerprint = p_source_fingerprint;

  if not found then
    return query select 'new'::text, 0, null::text, false, null::bigint, null::bigint, null::text, null::text,
      null::text, null::text, null::text, null::text, null::bigint, null::integer, null::integer, null::integer,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint;
    return;
  end if;
  if v_event.bot_type <> p_bot_type then
    raise exception 'ingest_identity_mismatch' using errcode = 'P0001';
  end if;

  return query
    select v_event.upload_state, v_event.upload_attempt_count, v_event.upload_failure_code,
      v_event.status = 'needs_review',
      m.chat_id, m.message_id, m.file_id, m.file_unique_id, m.media_kind, m.file_name, m.mime_type,
      m.caption, m.file_size_bytes, m.duration_seconds, m.width, m.height, m.telegram_date,
      v_event.upload_started_at,
      floor(extract(epoch from (now() - v_event.upload_started_at)))::bigint,
      v_event.upload_floor_message_id
    from (select 1) one
    left join private.telegram_media m on m.id = v_event.telegram_media_id;
end;
$$;

-- Registers the source (idempotent by fingerprint) and starts one attempt,
-- as in migration 9, and now assigns the attempt's recovery floor. The floor
-- is computed here and never taken from the caller: the larger of the
-- channel checkpoint and the highest message already recorded for that
-- channel. Every such message was posted before this transaction, so the
-- file (sent only after this returns) gets a larger id. A new floor is
-- assigned only when a new attempt starts; an uploading or uncertain attempt
-- is refused a restart and keeps its floor.
create function public.ingest_upload_start(
  p_source_fingerprint text,
  p_bot_type text,
  p_chat_id bigint,
  p_source_size_bytes bigint
)
returns table (upload_state text, upload_attempt_count integer, upload_floor_message_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_floor bigint;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_bot_type is null or p_bot_type not in ('movie', 'series')
     or p_chat_id is null
     or p_source_size_bytes is null or p_source_size_bytes not between 1 and 2097152000 then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  -- Serializes with ingest_channel_checkpoint; starts share the lock.
  perform pg_catalog.pg_advisory_xact_lock_shared(1001, case p_bot_type when 'movie' then 1 else 2 end);

  select greatest(c.checkpoint_message_id, coalesce(
           (select max(m.message_id) from private.telegram_media m
            where m.bot_type = p_bot_type and m.chat_id = p_chat_id), 0))
    into v_floor
  from private.telegram_channels c
  where c.bot_type = p_bot_type and c.chat_id = p_chat_id;
  if not found then
    raise exception 'ingest_channel_not_allowed' using errcode = 'P0001';
  end if;
  -- Without a floor, recovery would have to scan from message 1: refuse.
  if v_floor < 1 then
    raise exception 'ingest_recovery_floor_unknown' using errcode = 'P0001';
  end if;

  insert into private.ingestion_events
    (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at,
     upload_floor_message_id)
  values (p_bot_type, 'uploader', p_source_fingerprint, p_source_size_bytes, 'uploading', 1, now(), v_floor)
  on conflict (source_fingerprint) where origin = 'uploader' do nothing
  returning * into v_event;
  if found then
    return query select v_event.upload_state, v_event.upload_attempt_count, v_event.upload_floor_message_id;
    return;
  end if;

  -- Already registered: reuse that row, never a second one.
  select e.* into v_event from private.ingestion_events e
  where e.origin = 'uploader' and e.source_fingerprint = p_source_fingerprint
  for update;
  if v_event.bot_type <> p_bot_type or v_event.source_size_bytes <> p_source_size_bytes then
    raise exception 'ingest_identity_mismatch' using errcode = 'P0001';
  end if;
  if v_event.upload_state = 'uploaded' then
    raise exception 'ingest_already_uploaded' using errcode = 'P0001';
  end if;
  if v_event.upload_state <> 'upload_failed' or v_event.status in ('rejected', 'ignored', 'published') then
    raise exception 'ingest_illegal_transition' using errcode = 'P0001';
  end if;
  if v_event.upload_attempt_count >= 5 then
    raise exception 'ingest_attempts_exhausted' using errcode = 'P0001';
  end if;

  update private.ingestion_events e
  set upload_state = 'uploading',
      upload_attempt_count = e.upload_attempt_count + 1,
      upload_started_at = now(),
      upload_floor_message_id = v_floor
  where e.id = v_event.id
  returning * into v_event;
  return query select v_event.upload_state, v_event.upload_attempt_count, v_event.upload_floor_message_id;
end;
$$;

-- As in migration 9, plus one rule: a message at or below the attempt's
-- floor cannot be this attempt's upload. That proves the floor wrong (for
-- example, a checkpoint reported too high), so the evidence goes to review
-- instead of being recorded. Same signature and result: privileges persist.
create or replace function public.ingest_upload_record(
  p_source_fingerprint text,
  p_bot_type text,
  p_chat_id bigint,
  p_message_id bigint,
  p_file_id text,
  p_file_unique_id text,
  p_media_kind text,
  p_file_name text,
  p_mime_type text,
  p_caption text,
  p_file_size_bytes bigint,
  p_duration_seconds integer,
  p_width integer,
  p_height integer,
  p_telegram_date timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_media private.telegram_media%rowtype;
  v_tokens text[];
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_bot_type is null or p_bot_type not in ('movie', 'series')
     or p_chat_id is null or p_message_id is null or p_message_id <= 0
     or p_file_id is null or char_length(p_file_id) not between 1 and 1024
     or p_file_unique_id is null or char_length(p_file_unique_id) not between 1 and 128
     or p_media_kind is null or p_media_kind not in ('video', 'document')
     or (p_file_name is not null and char_length(p_file_name) not between 1 and 1024)
     or (p_mime_type is not null and char_length(p_mime_type) not between 1 and 255)
     or p_caption is null or char_length(p_caption) > 4096
     or (p_file_size_bytes is not null and p_file_size_bytes < 0)
     or (p_duration_seconds is not null and p_duration_seconds < 0)
     or (p_width is not null and p_width <= 0)
     or (p_height is not null and p_height <= 0)
     or p_telegram_date is null then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.telegram_channels c where c.bot_type = p_bot_type and c.chat_id = p_chat_id
  ) then
    raise exception 'ingest_channel_not_allowed' using errcode = 'P0001';
  end if;
  -- The caption must carry exactly this source's token (lib/ingestion/telegram.ts).
  select array_agg(distinct t.groups[2]) into v_tokens
  from regexp_matches(p_caption, '(^|\s)velora-src:(sf1-[0-9a-f]{64})(?=\s|$)', 'g') as t(groups);
  if v_tokens is distinct from array[p_source_fingerprint] then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  select e.* into v_event from private.ingestion_events e
  where e.origin = 'uploader' and e.source_fingerprint = p_source_fingerprint
  for update;
  if not found then
    raise exception 'ingest_not_registered' using errcode = 'P0001';
  end if;
  if v_event.bot_type <> p_bot_type
     or (p_file_size_bytes is not null and p_file_size_bytes <> v_event.source_size_bytes) then
    raise exception 'ingest_identity_mismatch' using errcode = 'P0001';
  end if;
  if v_event.upload_state = 'blocked' then
    raise exception 'ingest_illegal_transition' using errcode = 'P0001';
  end if;

  select m.* into v_media from private.telegram_media m
  where m.bot_type = p_bot_type and m.chat_id = p_chat_id and m.message_id = p_message_id
  for update;

  if v_event.upload_state = 'uploaded' then
    if found and v_media.id = v_event.telegram_media_id and v_media.file_unique_id = p_file_unique_id then
      return 'already_recorded';
    end if;
    -- A second channel message for an uploaded source: a duplicate post.
    update private.ingestion_events e
    set status = 'needs_review', error_code = 'duplicate_upload_evidence'
    where e.id = v_event.id and e.status not in ('published', 'rejected', 'ignored');
    return 'conflict';
  end if;

  -- The attempt's file was posted after its floor was fixed, so its id is larger.
  if v_event.upload_floor_message_id is not null and p_message_id <= v_event.upload_floor_message_id then
    update private.ingestion_events e
    set status = 'needs_review', error_code = 'recovery_floor_not_below_message'
    where e.id = v_event.id and e.status not in ('published', 'rejected', 'ignored');
    return 'conflict';
  end if;

  if found then
    -- The delivery exists already: adopt it only if it is the same file and
    -- no other ingestion claims it.
    if v_media.file_unique_id <> p_file_unique_id
       or exists (select 1 from private.ingestion_events o where o.telegram_media_id = v_media.id) then
      update private.ingestion_events e
      set status = 'needs_review', error_code = 'telegram_message_conflict'
      where e.id = v_event.id and e.status not in ('published', 'rejected', 'ignored');
      return 'conflict';
    end if;
  else
    insert into private.telegram_media
      (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, file_name, mime_type,
       caption, file_size_bytes, duration_seconds, width, height, telegram_date)
    values
      (p_bot_type, p_chat_id, p_message_id, p_file_id, p_file_unique_id, p_media_kind, p_file_name, p_mime_type,
       p_caption, p_file_size_bytes, p_duration_seconds, p_width, p_height, p_telegram_date)
    returning * into v_media;
  end if;

  update private.ingestion_events e
  set upload_state = 'uploaded', telegram_media_id = v_media.id
  where e.id = v_event.id;

  -- D3: the same Telegram file already delivered elsewhere is recorded, but
  -- flagged for review, never merged.
  if exists (
    select 1 from private.telegram_media m
    where m.bot_type = p_bot_type and m.file_unique_id = p_file_unique_id and m.id <> v_media.id
  ) then
    update private.ingestion_events e
    set status = 'needs_review', error_code = 'duplicate_telegram_file'
    where e.id = v_event.id and e.status not in ('published', 'rejected', 'ignored');
  end if;
  return 'recorded';
end;
$$;

-- Advances a channel's recovery checkpoint to a message id the worker has
-- observed there (normally the marker that closed a recovery scan, or one
-- the operator read in the channel when configuring it). Trust boundary:
-- the id itself cannot be verified here. The database decides only whether
-- advancing is safe: never backwards, only for the allow-listed channel, and
-- never while an upload in that channel is unresolved, so a wrong id can
-- never skip an existing unresolved upload. An id reported too high can only
-- make later attempts' floors too high. Recovery then fails closed (a marker
-- at or below the floor), and a recorded upload at or below its floor goes
-- to review (ingest_upload_record). Returns the checkpoint after the call; a
-- lower or equal id changes nothing.
create function public.ingest_channel_checkpoint(p_bot_type text, p_chat_id bigint, p_message_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel private.telegram_channels%rowtype;
begin
  if p_bot_type is null or p_bot_type not in ('movie', 'series')
     or p_chat_id is null
     or p_message_id is null or p_message_id not between 1 and 2147483647 then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;

  -- Exclusive: waits for in-flight starts; later starts wait for this.
  perform pg_catalog.pg_advisory_xact_lock(1001, case p_bot_type when 'movie' then 1 else 2 end);

  select c.* into v_channel from private.telegram_channels c
  where c.bot_type = p_bot_type and c.chat_id = p_chat_id
  for update;
  if not found then
    raise exception 'ingest_channel_not_allowed' using errcode = 'P0001';
  end if;
  if p_message_id <= v_channel.checkpoint_message_id then
    return v_channel.checkpoint_message_id;
  end if;
  if exists (
    select 1 from private.ingestion_events e
    where e.origin = 'uploader' and e.bot_type = p_bot_type and e.upload_state in ('uploading', 'uncertain')
  ) then
    raise exception 'ingest_recovery_unresolved' using errcode = 'P0001';
  end if;

  update private.telegram_channels c
  set checkpoint_message_id = p_message_id
  where c.bot_type = p_bot_type;
  return p_message_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
-- Private tables keep their deny-all posture: new columns grant nothing.
revoke all on table private.telegram_channels, private.ingestion_events, private.telegram_media
from public, anon, authenticated, service_role;

-- Trigger functions are internal: nobody calls them directly.
revoke all on function private.guard_upload_floor(), private.guard_channel_checkpoint()
from public, anon, authenticated, service_role;

-- The five worker commands: owner and service_role only. Supabase's default
-- privileges grant new public functions to anon/authenticated/service_role.
revoke all on function
  public.ingest_upload_status(text, text),
  public.ingest_upload_start(text, text, bigint, bigint),
  public.ingest_upload_record(text, text, bigint, bigint, text, text, text, text, text, text, bigint, integer, integer, integer, timestamptz),
  public.ingest_upload_fail(text, text, text, text),
  public.ingest_channel_checkpoint(text, bigint, bigint)
from public, anon, authenticated, service_role;

grant execute on function
  public.ingest_upload_status(text, text),
  public.ingest_upload_start(text, text, bigint, bigint),
  public.ingest_upload_record(text, text, bigint, bigint, text, text, text, text, text, text, bigint, integer, integer, integer, timestamptz),
  public.ingest_upload_fail(text, text, text, text),
  public.ingest_channel_checkpoint(text, bigint, bigint)
to service_role;
