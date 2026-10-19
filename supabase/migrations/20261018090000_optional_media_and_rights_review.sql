-- Velora UG: optional media verification and a rights review for channel candidates.
--
-- Owner decisions (2026-10-18): media verification may be made optional for
-- publication; rights documentation and the rights reference are optional; and
-- rights do not expire. Distribution authorization is NOT optional: publication
-- still requires an explicit, revision-bound rights clearance recorded by an
-- account with the separate rights capability, exactly as before. Only the
-- reference that documents that decision may now be left out.
--
-- 1. private.catalogue_policy: one owner-only setting, media_inspection_mode.
--    `required` (the default, and today's behaviour) keeps the Checkpoint 10
--    media gate. `optional` and `disabled` let a candidate be approved and
--    published without verified media. A file whose current evidence is a
--    definite failure (the reviewer screen's "Failed") still blocks, as
--    media_known_failure: unchecked media is never treated as verified, and a
--    known failure is never treated as passing. The setting has no API grant;
--    the owner changes it with SQL, and every change is recorded.
-- 2. private.rights_submissions: a rights review request, with an optional
--    reference and an optional SHA-256 of a document kept elsewhere. A pending or
--    rejected submission grants nothing. Only a rights reviewer's decision
--    turns one into a clearance, through the same revision-bound
--    private.rights_clearances row the publication gate already reads.
-- 3. Two reviewer commands (authenticated + capability, like the others):
--    discovery_review_submit_rights (any capability) and
--    discovery_review_decide_rights (rights capability).
-- 4. private.channel_view reports media_inspection_mode, rights_status
--    (not_provided | pending_review | verified | rejected) and the submissions.
--
-- Unchanged: the materializer, the public read policies, the stream and
-- download resolvers (they still require published, ready and rights
-- `cleared`), approval and publication capabilities, and every existing
-- reviewer command. Nothing here records rights, approves or publishes on its own.
-- Depends only on migrations present on the hosted channel chain (no admin-upload chain).

begin;

-- ---------------------------------------------------------------------------
-- 1. The media inspection mode (owner-only setting)
-- ---------------------------------------------------------------------------
create table private.catalogue_policy (
  singleton boolean primary key default true check (singleton),
  media_inspection_mode text not null default 'required'
    check (media_inspection_mode in ('required', 'optional', 'disabled')),
  updated_at timestamptz not null default now()
);
insert into private.catalogue_policy (singleton) values (true);

create trigger catalogue_policy_set_updated_at
  before update on private.catalogue_policy
  for each row execute function private.set_updated_at();

-- Append-only record of every value the setting has had, and which database role set it.
create table private.catalogue_policy_audit (
  id bigint generated always as identity primary key,
  media_inspection_mode text not null,
  changed_by_role text not null,
  changed_at timestamptz not null default now()
);
create trigger catalogue_policy_audit_append_only
  before update or delete on private.catalogue_policy_audit
  for each row execute function private.guard_append_only();

create function private.catalogue_policy_record()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'catalogue_policy_required' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' or new.media_inspection_mode is distinct from old.media_inspection_mode then
    insert into private.catalogue_policy_audit (media_inspection_mode, changed_by_role) values (new.media_inspection_mode, current_user);
  end if;
  return new;
end;
$$;
create trigger catalogue_policy_record
  after insert or update on private.catalogue_policy
  for each row execute function private.catalogue_policy_record();
create trigger catalogue_policy_keep
  before delete on private.catalogue_policy
  for each row execute function private.catalogue_policy_record();
-- The row inserted above predates its trigger: record the initial value.
insert into private.catalogue_policy_audit (media_inspection_mode, changed_by_role) values ('required', current_user);

-- `required` whenever the row is missing or unreadable: fail closed to the strict gate.
create function private.media_inspection_mode()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select p.media_inspection_mode from private.catalogue_policy p where p.singleton), 'required')
$$;

-- A finding against the file itself, under Policy 3: what the reviewer screen
-- shows as "Failed". Not a failure: a check that could not read the file, or a
-- whole-file decode that does not show damage. Earlier policies' refusals are
-- history under Policy 3 and are not counted here.
create function private.media_evidence_known_failure(p private.media_evidence)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(p.policy_version = 3 and not private.media_evidence_publishable(p)
    and exists (select 1 from unnest(p.reasons) r
                where r !~ '^media_read_'
                  and r not in ('media_unreadable', 'probe_timeout', 'moov_over_budget', 'no_evidence',
                                'verification_storage_unavailable', 'decode_timeout', 'decode_tool_failed',
                                'decode_failed', 'decode_error_at_end', 'decode_codec_unsupported')), false)
$$;

-- ---------------------------------------------------------------------------
-- 2. Rights submissions
-- ---------------------------------------------------------------------------
create table private.rights_submissions (
  id bigint generated always as identity primary key,
  ingestion_event_id bigint not null references private.ingestion_events (id) on delete restrict,
  review_revision integer not null check (review_revision >= 1),
  media_identity text not null check (media_identity ~ '^tg1-[0-9a-f]{64}$'),
  reference text check (reference is null or (
    char_length(reference) between 1 and 200 and reference = pg_catalog.btrim(reference)
    and reference ~ '^[A-Za-z0-9 _.:/-]+$' and position('://' in reference) = 0)),
  document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[a-f0-9]{64}$'),
  submitted_by uuid not null,
  submitted_at timestamptz not null default now(),
  decision text not null default 'pending' check (decision in ('pending', 'verified', 'rejected')),
  decided_by uuid,
  decided_at timestamptz,
  constraint rights_submissions_decided_check check (
    (decision = 'pending') = (decided_by is null) and (decided_by is null) = (decided_at is null))
);
create index rights_submissions_event_idx on private.rights_submissions (ingestion_event_id, id);
-- At most one open submission per candidate revision.
create unique index rights_submissions_pending_key on private.rights_submissions (ingestion_event_id, review_revision)
  where decision = 'pending';

-- A submission is history: it is decided once, and nothing else about it ever changes.
create function private.guard_rights_submission()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.decision <> 'pending' or new.decision = 'pending'
     or (new.id, new.ingestion_event_id, new.review_revision, new.media_identity, new.reference, new.document_sha256, new.submitted_by, new.submitted_at)
        is distinct from (old.id, old.ingestion_event_id, old.review_revision, old.media_identity, old.reference, old.document_sha256, old.submitted_by, old.submitted_at) then
    raise exception 'rights_submission_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rights_submissions_guard
  before update or delete on private.rights_submissions
  for each row execute function private.guard_rights_submission();

-- A clearance made from a submission keeps its document digest and the submission it came from.
-- The reference is optional: the clearance itself (who, when, which revision and document) is the decision.
alter table private.rights_clearances alter column reference drop not null;
alter table private.rights_clearances
  add column document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[a-f0-9]{64}$'),
  add column submission_id bigint references private.rights_submissions (id) on delete restrict;
create index rights_clearances_submission_idx on private.rights_clearances (submission_id) where submission_id is not null;

-- The rights state of a candidate's CURRENT revision and document.
create function private.channel_rights_status(p_event_id bigint)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with current_review as (
    select r.review_revision, private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes) as identity
    from private.channel_reviews r
    join private.ingestion_events e on e.id = r.ingestion_event_id
    join private.telegram_media m on m.id = e.telegram_media_id
    where r.ingestion_event_id = p_event_id)
  select case
    when exists (select 1 from private.rights_clearances rc, current_review c
                 where rc.ingestion_event_id = p_event_id and rc.review_revision = c.review_revision and rc.media_identity = c.identity)
      then 'verified'
    else coalesce((select case s.decision when 'pending' then 'pending_review' when 'rejected' then 'rejected' end
                   from private.rights_submissions s, current_review c
                   where s.ingestion_event_id = p_event_id and s.review_revision = c.review_revision and s.media_identity = c.identity
                     and s.decision <> 'verified'
                   order by s.id desc limit 1), 'not_provided')
  end
$$;

-- ---------------------------------------------------------------------------
-- 3. The gate evaluator: the media gate follows the mode; nothing else changes
-- ---------------------------------------------------------------------------
create or replace function private.channel_review_blockers(p_event_id bigint)
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

-- ---------------------------------------------------------------------------
-- 4. The reviewer view: adds the mode, the rights status and the submissions
-- ---------------------------------------------------------------------------
create or replace function private.channel_view(p_event_id bigint, p_detail boolean)
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
$$;

-- ---------------------------------------------------------------------------
-- 5. Reviewer commands
-- ---------------------------------------------------------------------------
-- A reference is optional. When given (an empty string counts as none) it is a
-- short label, never a URL: the same rule as before.
create function private.rights_reference_valid(p_reference text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_reference is null or p_reference = '' or (
    char_length(p_reference) between 1 and 200 and p_reference = pg_catalog.btrim(p_reference)
    and p_reference ~ '^[A-Za-z0-9 _.:/-]+$' and position('://' in p_reference) = 0)
$$;

-- Records an explicit rights decision for the current document and revision
-- (rights capability). Unchanged from migration 20261010090000 except that the
-- reference may be left out.
create or replace function public.discovery_review_clear_rights(p_key text, p_revision integer, p_reference text)
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
  if p_revision is null or not private.rights_reference_valid(p_reference) then
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
  values (v_id, p_revision + 1, v_identity, nullif(p_reference, ''), v_uid);
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'rights_cleared',
    case when coalesce(p_reference, '') = '' then 'no_reference' end);
  return private.channel_view(v_id, false);
end;
$$;
-- Submits a rights reference for review. Grants nothing: the publication gate
-- reads only clearances. Does not change the reviewed facts, so no new revision.
create function public.discovery_review_submit_rights(p_key text, p_revision integer, p_reference text, p_document_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('any');
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_identity text;
  v_submission bigint;
begin
  if p_revision is null or not private.rights_reference_valid(p_reference)
     or (p_document_sha256 is not null and p_document_sha256 !~ '^[a-f0-9]{64}$') then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status <> 'needs_review' or private.channel_rights_status(v_id) in ('verified', 'pending_review') then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);
  if v_identity is null then
    raise exception 'review_media_identity_incomplete' using errcode = 'P0001';
  end if;
  insert into private.rights_submissions (ingestion_event_id, review_revision, media_identity, reference, document_sha256, submitted_by)
  values (v_id, p_revision, v_identity, nullif(p_reference, ''), p_document_sha256, v_uid)
  returning id into v_submission;
  perform private.channel_audit(v_id, p_revision, v_uid, 'rights_submitted', 'submission:' || v_submission);
  return private.channel_view(v_id, false);
end;
$$;

-- Decides a pending submission at the current revision (rights capability).
-- `verified` records the clearance exactly as discovery_review_clear_rights does
-- (new revision, approval cleared); `rejected` records the decision only.
create function public.discovery_review_decide_rights(p_key text, p_revision integer, p_submission bigint, p_decision text)
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
  v_submission private.rights_submissions%rowtype;
begin
  if p_revision is null or p_submission is null or p_decision is null or p_decision not in ('verified', 'rejected') then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  if v_review.review_revision <> p_revision then
    raise exception 'review_stale_revision' using errcode = 'P0001';
  end if;
  if v_event.status <> 'needs_review' then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  v_identity := private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes);
  select s.* into v_submission from private.rights_submissions s
  where s.id = p_submission and s.ingestion_event_id = v_id and s.decision = 'pending'
    and s.review_revision = p_revision and s.media_identity = v_identity
  for update;
  if not found then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  update private.rights_submissions s set decision = p_decision, decided_by = v_uid, decided_at = now() where s.id = p_submission;
  if p_decision = 'rejected' then
    perform private.channel_audit(v_id, p_revision, v_uid, 'rights_rejected', 'submission:' || p_submission);
    return private.channel_view(v_id, false);
  end if;
  update private.channel_reviews r
  set review_revision = r.review_revision + 1, approved_revision = null, approved_by = null, approved_at = null
  where r.ingestion_event_id = v_id;
  update private.metadata_match_candidates c set decision = 'pending', decided_at = null, decided_by = null
  where c.ingestion_event_id = v_id and c.decision = 'approved';
  insert into private.rights_clearances (ingestion_event_id, review_revision, media_identity, reference, cleared_by, document_sha256, submission_id)
  values (v_id, p_revision + 1, v_identity, v_submission.reference, v_uid, v_submission.document_sha256, p_submission);
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'rights_cleared', 'submission:' || p_submission);
  return private.channel_view(v_id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
alter table private.catalogue_policy enable row level security;
alter table private.catalogue_policy_audit enable row level security;
alter table private.rights_submissions enable row level security;

revoke all on table private.catalogue_policy, private.catalogue_policy_audit, private.rights_submissions
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
revoke all on sequence private.catalogue_policy_audit_id_seq, private.rights_submissions_id_seq
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;

revoke all on function
  private.rights_reference_valid(text),
  private.catalogue_policy_record(),
  private.media_inspection_mode(),
  private.media_evidence_known_failure(private.media_evidence),
  private.guard_rights_submission(),
  private.channel_rights_status(bigint),
  private.channel_review_blockers(bigint),
  private.channel_view(bigint, boolean)
from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;

revoke all on function
  public.discovery_review_submit_rights(text, integer, text, text),
  public.discovery_review_decide_rights(text, integer, bigint, text),
  public.discovery_review_clear_rights(text, integer, text)
from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
grant execute on function
  public.discovery_review_submit_rights(text, integer, text, text),
  public.discovery_review_decide_rights(text, integer, bigint, text),
  public.discovery_review_clear_rights(text, integer, text)
to authenticated;

commit;
