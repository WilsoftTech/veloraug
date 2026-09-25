-- Velora UG Phase C, checkpoint C2A.1: uploader-origin ingestion and the
-- worker write boundary. Design: docs/PHASE_C_INGESTION_DESIGN.md ("C2A.1").
--
-- 1. private.ingestion_events stays the single ingestion lifecycle root. An
--    `origin` discriminator admits rows created by the Velora uploader, which
--    have no Telegram update (a bot receives none for its own post). Webhook
--    rows keep every original requirement through a CHECK constraint.
-- 2. The C1 source fingerprint becomes a column with a partial unique index:
--    one uploader ingestion per source file.
-- 3. The upload track is its own column, independent of the review track
--    (`status`): uploading never implies approval, approval never implies an
--    upload, and nothing here publishes.
-- 4. private.telegram_channels: the database's own allow-list of the Movies
--    and Series channels. It is empty after this migration; the operator
--    configures it (see the design doc). Until then every upload command
--    fails closed.
-- 5. Four worker commands in public (callable through PostgREST rpc/),
--    SECURITY DEFINER, EXECUTE for service_role only. service_role still has
--    no privilege on any private table: the functions are the only bridge.
--    None touches a public catalogue table.

-- ---------------------------------------------------------------------------
-- Telegram channel allow-list
-- ---------------------------------------------------------------------------
create table private.telegram_channels (
  bot_type text primary key check (bot_type in ('movie', 'series')),
  -- Channel and supergroup ids are -100 followed by the internal id.
  chat_id bigint not null unique check (chat_id < -1000000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger telegram_channels_set_updated_at
  before update on private.telegram_channels
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- private.ingestion_events: origin discriminator and upload track
-- ---------------------------------------------------------------------------
alter table private.ingestion_events
  add column origin text not null default 'webhook',
  add column source_fingerprint text,
  add column source_size_bytes bigint,
  add column upload_state text,
  add column upload_attempt_count integer not null default 0,
  add column upload_started_at timestamptz,
  add column upload_failure_code text,
  add column upload_failed_at timestamptz;

-- Required for webhook rows by ingestion_events_webhook_shape_check instead.
alter table private.ingestion_events
  alter column telegram_update_id drop not null,
  alter column update_kind drop not null;

alter table private.ingestion_events
  add constraint ingestion_events_origin_check
    check (origin in ('webhook', 'uploader')),
  add constraint ingestion_events_source_fingerprint_check
    check (source_fingerprint is null or source_fingerprint ~ '^sf1-[0-9a-f]{64}$'),
  -- 2000 MiB: the self-hosted Bot API upload ceiling (TELEGRAM_MAX_FILE_BYTES).
  add constraint ingestion_events_source_size_check
    check (source_size_bytes is null or source_size_bytes between 1 and 2097152000),
  -- No "not started" value: a source is not started until a row exists.
  add constraint ingestion_events_upload_state_check
    check (upload_state is null or upload_state in ('uploading', 'uncertain', 'uploaded', 'upload_failed', 'blocked')),
  -- MAX_UPLOAD_ATTEMPTS in lib/ingestion/state.ts.
  add constraint ingestion_events_upload_attempt_count_check
    check (upload_attempt_count between 0 and 5),
  add constraint ingestion_events_upload_failure_code_check
    check (upload_failure_code is null or upload_failure_code ~ '^[a-z0-9_]{1,100}$'),
  -- A webhook row is exactly the original B-1 shape.
  add constraint ingestion_events_webhook_shape_check check (
    origin <> 'webhook' or (
      telegram_update_id is not null and update_kind is not null
      and source_fingerprint is null and source_size_bytes is null
      and upload_state is null and upload_attempt_count = 0 and upload_started_at is null
      and upload_failure_code is null and upload_failed_at is null)),
  -- An uploader row has no Telegram update, always has its source identity,
  -- and links media exactly when (and only when) it is uploaded.
  add constraint ingestion_events_uploader_shape_check check (
    origin <> 'uploader' or (
      telegram_update_id is null and update_kind is null
      and source_fingerprint is not null and source_size_bytes is not null
      and upload_state is not null and upload_attempt_count >= 1 and upload_started_at is not null
      and (upload_state = 'uploaded') = (telegram_media_id is not null)
      and (upload_failure_code is null) = (upload_failed_at is null)));

-- The idempotency identity of an uploaded source file.
create unique index ingestion_events_source_fingerprint_key
  on private.ingestion_events (source_fingerprint)
  where origin = 'uploader';
-- One delivered file backs at most one uploader ingestion.
create unique index ingestion_events_uploader_media_key
  on private.ingestion_events (telegram_media_id)
  where origin = 'uploader' and telegram_media_id is not null;

-- ---------------------------------------------------------------------------
-- Worker commands
--
-- Errors carry a fixed code and no row data:
--   ingest_invalid_input        malformed argument
--   ingest_channel_not_allowed  chat is not the allow-listed channel for the bot
--                               (also raised while the allow-list is empty)
--   ingest_not_registered       no uploader ingestion for this fingerprint
--   ingest_identity_mismatch    bot type or size differs from the registration
--   ingest_already_uploaded     start on an uploaded source
--   ingest_attempts_exhausted   start after the fifth attempt
--   ingest_illegal_transition   any other disallowed upload-state change
-- Upload-state machine (mirrors lib/ingestion/state.ts):
--   (none)        -start->  uploading
--   upload_failed -start->  uploading          (attempt + 1, at most 5)
--   uploading     -record-> uploaded
--   uncertain     -record-> uploaded           (reconciliation found it)
--   upload_failed -record-> uploaded           (found after abandonment)
--   uploading     -fail->   upload_failed | uncertain | blocked
--   uncertain     -fail->   upload_failed (abandoned) | blocked | uncertain
-- There is deliberately no uploading/uncertain -> start: an interrupted
-- upload is reconciled first, never retried blindly. `uploaded` is final for
-- the upload track; a later failure or a different message cannot replace it.
-- ---------------------------------------------------------------------------

-- What the uploader needs to decide what to do next. `new` means no ingestion
-- exists. Media columns are set only once uploaded (for resume and adoption).
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
  telegram_date timestamptz
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
      null::timestamptz;
    return;
  end if;
  if v_event.bot_type <> p_bot_type then
    raise exception 'ingest_identity_mismatch' using errcode = 'P0001';
  end if;

  return query
    select v_event.upload_state, v_event.upload_attempt_count, v_event.upload_failure_code,
      v_event.status = 'needs_review',
      m.chat_id, m.message_id, m.file_id, m.file_unique_id, m.media_kind, m.file_name, m.mime_type,
      m.caption, m.file_size_bytes, m.duration_seconds, m.width, m.height, m.telegram_date
    from (select 1) one
    left join private.telegram_media m on m.id = v_event.telegram_media_id;
end;
$$;

-- Registers the source (idempotent by fingerprint) and starts one attempt.
-- The chat must be the allow-listed channel for the bot, so an upload cannot
-- start towards the wrong channel or while no channel is configured.
create function public.ingest_upload_start(
  p_source_fingerprint text,
  p_bot_type text,
  p_chat_id bigint,
  p_source_size_bytes bigint
)
returns table (upload_state text, upload_attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_bot_type is null or p_bot_type not in ('movie', 'series')
     or p_chat_id is null
     or p_source_size_bytes is null or p_source_size_bytes not between 1 and 2097152000 then
    raise exception 'ingest_invalid_input' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.telegram_channels c where c.bot_type = p_bot_type and c.chat_id = p_chat_id
  ) then
    raise exception 'ingest_channel_not_allowed' using errcode = 'P0001';
  end if;

  insert into private.ingestion_events
    (bot_type, origin, source_fingerprint, source_size_bytes, upload_state, upload_attempt_count, upload_started_at)
  values (p_bot_type, 'uploader', p_source_fingerprint, p_source_size_bytes, 'uploading', 1, now())
  on conflict (source_fingerprint) where origin = 'uploader' do nothing
  returning * into v_event;
  if found then
    return query select v_event.upload_state, v_event.upload_attempt_count;
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
      upload_started_at = now()
  where e.id = v_event.id
  returning * into v_event;
  return query select v_event.upload_state, v_event.upload_attempt_count;
end;
$$;

-- Records the channel message from a sendDocument reply (or a confirmed
-- reconciliation) as private.telegram_media and links it. Returns
-- 'recorded', 'already_recorded' (exact replay) or 'conflict' (different or
-- foreign evidence: nothing is overwritten and the ingestion goes to review).
create function public.ingest_upload_record(
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

-- Records a failed or unresolved attempt. p_outcome:
--   retryable  definite failure, nothing posted     -> upload_failed
--   uncertain  may have been posted                 -> uncertain (reconcile first)
--   abandoned  reconciliation verified it absent    -> upload_failed
--   permanent  cannot proceed without a reviewer    -> blocked (+ needs_review)
-- An uploaded source can never be moved back.
create function public.ingest_upload_fail(
  p_source_fingerprint text,
  p_bot_type text,
  p_outcome text,
  p_failure_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.ingestion_events%rowtype;
  v_next text;
begin
  if p_source_fingerprint is null or p_source_fingerprint !~ '^sf1-[0-9a-f]{64}$'
     or p_bot_type is null or p_bot_type not in ('movie', 'series')
     or p_outcome is null or p_outcome not in ('retryable', 'uncertain', 'abandoned', 'permanent')
     or p_failure_code is null or p_failure_code !~ '^[a-z0-9_]{1,100}$' then
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

  v_next := case
    when v_event.upload_state = 'uploading' then
      case p_outcome when 'retryable' then 'upload_failed' when 'abandoned' then 'upload_failed'
                     when 'uncertain' then 'uncertain' else 'blocked' end
    when v_event.upload_state = 'uncertain' then
      -- Once it may have been posted, a definite failure is no longer possible.
      case p_outcome when 'uncertain' then 'uncertain' when 'abandoned' then 'upload_failed'
                     when 'permanent' then 'blocked' end
    when v_event.upload_state = 'upload_failed' and p_outcome = 'retryable' then 'upload_failed'
    when v_event.upload_state = 'blocked' and p_outcome = 'permanent' then 'blocked'
  end;
  if v_next is null then
    raise exception 'ingest_illegal_transition' using errcode = 'P0001';
  end if;

  update private.ingestion_events e
  set upload_state = v_next,
      upload_failure_code = p_failure_code,
      upload_failed_at = now(),
      status = case when p_outcome = 'permanent' and e.status not in ('published', 'rejected', 'ignored')
                    then 'needs_review' else e.status end,
      error_code = case when p_outcome = 'permanent' then p_failure_code else e.error_code end
  where e.id = v_event.id;
  return v_next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
-- The allow-list is private configuration: RLS with no policies, and no
-- privilege for any client role or service_role (only the definer reads it).
alter table private.telegram_channels enable row level security;
revoke all on table private.telegram_channels from public, anon, authenticated, service_role;

-- ingestion_events keeps its B-1 posture: adding columns grants nothing, and
-- the revoke is repeated so the invariant is explicit in this migration.
revoke all on table private.ingestion_events, private.telegram_media from public, anon, authenticated, service_role;

-- Supabase's default privileges grant EXECUTE on new public functions to
-- anon, authenticated and service_role. Revoke all, then grant the worker only.
revoke all on function
  public.ingest_upload_status(text, text),
  public.ingest_upload_start(text, text, bigint, bigint),
  public.ingest_upload_record(text, text, bigint, bigint, text, text, text, text, text, text, bigint, integer, integer, integer, timestamptz),
  public.ingest_upload_fail(text, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.ingest_upload_status(text, text),
  public.ingest_upload_start(text, text, bigint, bigint),
  public.ingest_upload_record(text, text, bigint, bigint, text, text, text, text, text, text, bigint, integer, integer, integer, timestamptz),
  public.ingest_upload_fail(text, text, text, text)
to service_role;
