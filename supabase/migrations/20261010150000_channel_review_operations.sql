-- Velora UG E3.8B: operations for the controlled rollout of channel discovery.
-- Design and runbook: docs/E3_8B_PRODUCTION_ROLLOUT.md.
--
-- Nothing here widens who may approve or publish (E3.8A, unchanged):
--
-- 1. catalogue_review.inspect_channel_candidate / reviewer_capabilities:
--    read-only, for velora_review_service only. The operator who runs the
--    approval and publication commands can see the candidate, its gates and a
--    reviewer's capabilities with the same restricted login, and so can
--    reconcile an uncertain publication without the owner credential. The view
--    is private.channel_view (never the bot file_id).
-- 2. public.discovery_review_revoke_rights: a rights reviewer withdraws the
--    clearance of an unpublished candidate. Like every reviewed change it moves
--    to a new revision, so an approval that saw the clearance can no longer
--    publish. (A published version's rights are withdrawn by the owner on
--    public.movie_versions.rights_status, which already hides it and stops the
--    gateway resolver.)
-- 3. public.discovery_release_consumer: the worker gives its consumer lease
--    back on a graceful shutdown, so a restart does not wait for expiry.
-- 4. public.discovery_health: adds heartbeat, last delivery, oldest pending
--    work and lease state, for lag and liveness monitoring. Still no identifiers.

-- ---------------------------------------------------------------------------
-- 1. Restricted, read-only inspection (velora_review_service)
-- ---------------------------------------------------------------------------
create function catalogue_review.inspect_channel_candidate(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  select r.ingestion_event_id into v_id from private.channel_reviews r where r.discovery_key = p_key;
  if not found then
    raise exception 'discovery_not_found' using errcode = 'P0001';
  end if;
  -- The reviewer's view without the selectable lists: state, gates, evidence, rights, approval, publication, audit.
  return private.channel_view(v_id, true) - 'choices' - 'vjs';
end;
$$;

create function catalogue_review.reviewer_capabilities(p_reviewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'review', private.reviewer_has(p_reviewer, 'review'),
    'rights', private.reviewer_has(p_reviewer, 'rights'),
    'publish', private.reviewer_has(p_reviewer, 'publish'))
$$;

-- ---------------------------------------------------------------------------
-- 2. Rights withdrawal before publication (rights capability)
-- ---------------------------------------------------------------------------
create function public.discovery_review_revoke_rights(p_key text, p_revision integer)
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
  if v_event.status not in ('needs_review', 'matched') or not exists (
    select 1 from private.rights_clearances rc
    where rc.ingestion_event_id = v_id and rc.review_revision = v_review.review_revision
  ) then
    raise exception 'review_illegal_transition' using errcode = 'P0001';
  end if;
  -- The clearance row stays as history; the new revision has none.
  update private.metadata_match_candidates c set decision = 'pending', decided_at = null, decided_by = null
  where c.ingestion_event_id = v_id and c.decision = 'approved';
  update private.channel_reviews r
  set review_revision = r.review_revision + 1, approved_revision = null, approved_by = null, approved_at = null
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e set status = 'needs_review' where e.id = v_id;
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'rights_revoked');
  return private.channel_view(v_id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Consumer lease release (worker)
-- ---------------------------------------------------------------------------
-- True when this token held the lease and it is now free. Another consumer's
-- lease is never touched.
create function public.discovery_release_consumer(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token is null then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  update private.discovery_cursors c set consumer_token = null, consumer_until = null
  where c.bot_type = 'movie' and c.consumer_token = p_token;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Health: lag and liveness (worker)
-- ---------------------------------------------------------------------------
create or replace function public.discovery_health()
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
    'oldest_pending_at', min(e.received_at) filter (where e.status in ('received', 'processing', 'failed')),
    'cursor_initialized', exists (select 1 from private.discovery_cursors c where c.bot_type = 'movie'),
    -- The cursor row is touched on every lease renewal: the consumer's heartbeat.
    'consumer_heartbeat_at', (select c.updated_at from private.discovery_cursors c where c.bot_type = 'movie'),
    'consumer_active', coalesce((select c.consumer_until > now() from private.discovery_cursors c where c.bot_type = 'movie'), false),
    'last_delivery_at', (select max(d.last_seen_at) from private.discovery_deliveries d where d.bot_type = 'movie'),
    'reconciliation_incomplete', coalesce((select c.reconciliation_incomplete from private.discovery_cursors c where c.bot_type = 'movie'), true),
    'reconciliation_checked_at', (select c.reconciliation_checked_at from private.discovery_cursors c where c.bot_type = 'movie'))
  from private.ingestion_events e where e.origin = 'channel'
$$;

-- ---------------------------------------------------------------------------
-- 5. Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
revoke all on function
  catalogue_review.inspect_channel_candidate(text),
  catalogue_review.reviewer_capabilities(uuid),
  public.discovery_review_revoke_rights(text, integer),
  public.discovery_release_consumer(uuid),
  public.discovery_health()
from public, anon, authenticated, service_role;

grant execute on function
  catalogue_review.inspect_channel_candidate(text),
  catalogue_review.reviewer_capabilities(uuid)
to velora_review_service;

grant execute on function public.discovery_review_revoke_rights(text, integer) to authenticated;

grant execute on function
  public.discovery_release_consumer(uuid),
  public.discovery_health()
to service_role;
