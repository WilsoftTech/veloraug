-- Velora UG E3.8: media inspection recovery for channel candidates.
-- Audit and runbook: docs/E3_8_MEDIA_RECOVERY.md.
--
-- A reviewer confirms the film and the VJ; the media check is a separate gate.
-- Until now a re-inspection re-ran metadata matching as well, and its completion
-- wrote the worker's suggestion over the reviewer's confirmed choice
-- (identity_state can only be unknown, ambiguous or proposed in a completion).
-- A confirmed candidate therefore could not have its media checked again
-- without losing the confirmation.
--
-- Nothing here adds, removes or relaxes a gate, and nothing widens who may act:
--
-- 1. public.discovery_claim: also returns `confirmed_selection` (the reviewer's
--    film, year and VJ with the validated snapshot) for a confirmed candidate,
--    so the worker inspects the media only.
-- 2. public.discovery_complete: for a confirmed candidate it records the bounded
--    evidence and returns to review. Title, year, VJ, TMDB identity, warnings and
--    the match candidates are the reviewer's and are left untouched, whatever the
--    worker sent. An unconfirmed candidate completes exactly as before.
-- 3. public.discovery_fail: a transient media-reader failure (media_read_*,
--    probe_timeout) backs off 30 s, 60 s, 120 s, 240 s instead of 2 to 16 s, so
--    a short reader outage or a Telegram flood wait (at most 300 s) fits inside
--    the unchanged five-attempt bound. Every other code keeps its schedule.
-- 4. public.discovery_review_retry: unchanged behaviour (new revision, approval
--    invalidated, attempts reset); the audit entry now says whether the request
--    is media-only or a full inspection.
-- 5. private.channel_view: adds `inspection` (the worker's last inspection
--    result and the next scheduled retry) for the dashboard. Fixed codes only.
--
-- A transient failure is recorded with discovery_fail, never as evidence, so an
-- existing passing verification is not superseded by an outage.

-- ---------------------------------------------------------------------------
-- 1. Claim: the confirmed choice travels with the lease
-- ---------------------------------------------------------------------------
create or replace function public.discovery_claim(p_lease_seconds integer)
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
  v_selection jsonb;
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
  -- The reviewer's confirmed choice, from the same rows the publication gates read.
  if v_review.identity_state = 'confirmed' and v_review.tmdb_id is not null and v_review.vj_id is not null then
    select jsonb_build_object('title', v_review.title, 'year', v_review.release_year, 'vj_text', v_review.vj_text,
                              'vj_id', v_review.vj_id, 'tmdb_id', v_review.tmdb_id, 'snapshot', c.snapshot)
    into v_selection
    from private.metadata_match_candidates c
    where c.ingestion_event_id = v_event.id and c.tmdb_media_type = 'movie' and c.tmdb_id = v_review.tmdb_id
      and c.snapshot is not null and c.decision <> 'rejected';
  end if;
  return jsonb_build_object(
    'key', v_review.discovery_key, 'revision', v_review.review_revision, 'lease', v_token,
    'attempts', v_event.attempt_count + 1, 'event_id', v_review.event_id, 'payload_digest', v_review.payload_digest,
    'observed_at', v_review.observed_at, 'update_id', v_event.telegram_update_id, 'kind', v_event.update_kind,
    'chat_id', v_media.chat_id, 'message_id', v_media.message_id, 'file_unique_id', v_media.file_unique_id,
    'size', v_media.file_size_bytes, 'name', v_media.file_name, 'mime', v_media.mime_type, 'caption', v_media.caption,
    'identity', private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes),
    'confirmed_selection', v_selection);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Completion: a confirmed candidate keeps the reviewer's metadata
-- ---------------------------------------------------------------------------
-- p_result and evidence are validated exactly as before (same keys, same checks).
create or replace function public.discovery_complete(p_key text, p_lease uuid, p_revision integer, p_result jsonb)
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
  v_detail text := 'no_evidence';
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
    -- `verified` is derived by the table, never asserted by the worker.
    select case when ev.verified then 'verified' else 'unverified:' || ev.media_class end into v_detail
    from private.channel_current_evidence(v_media.id) ev;
  end if;

  if p_result->>'outcome' = 'blocked' then
    update private.channel_reviews r set lease_token = null, lease_until = null where r.ingestion_event_id = v_id;
    update private.ingestion_events e set status = 'blocked', error_code = p_result->>'error_code', processed_at = now() where e.id = v_id;
    perform private.channel_audit(v_id, p_revision, null, 'inspection_blocked', p_result->>'error_code');
    return 'blocked';
  end if;

  -- A confirmed candidate was re-inspected for its media only. The film, year,
  -- VJ, warnings and match candidates are the reviewer's decision at this
  -- revision: nothing the worker sent replaces them.
  if v_review.identity_state = 'confirmed' then
    update private.channel_reviews r set lease_token = null, lease_until = null where r.ingestion_event_id = v_id;
    v_status := case when v_review.duplicate_of_media_id is not null then 'ignored' else 'needs_review' end;
    update private.ingestion_events e set status = v_status, error_code = null, processed_at = now() where e.id = v_id;
    perform private.channel_audit(v_id, p_revision, null, 'media_inspected', v_detail);
    return v_status;
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

-- ---------------------------------------------------------------------------
-- 3. Failure: transient media-reader failures back off longer, same bound
-- ---------------------------------------------------------------------------
create or replace function public.discovery_fail(p_key text, p_lease uuid, p_revision integer, p_code text)
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
  v_delay integer;
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
  -- Seconds. A reader outage or flood wait needs minutes, a metadata provider seconds.
  v_delay := case when p_code ~ '^(media_read_[a-z0-9_]+|probe_timeout)$'
                  then least(900, 30 * power(2, greatest(v_event.attempt_count, 1) - 1)::integer)
                  else least(60, power(2, v_event.attempt_count)::integer) end;
  update private.channel_reviews r
  set lease_token = null, lease_until = null, retry_at = now() + make_interval(secs => v_delay)
  where r.ingestion_event_id = v_id;
  update private.ingestion_events e
  set status = v_status, error_code = case when v_status = 'blocked' then 'inspection_attempts_exhausted' else p_code end
  where e.id = v_id;
  perform private.channel_audit(v_id, p_revision, null, 'inspection_failed', p_code);
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reviewer re-inspection: the audit names its scope
-- ---------------------------------------------------------------------------
-- Sends a candidate back for inspection (new revision, nothing kept as approved).
-- A confirmed candidate keeps its film and VJ: only its media is checked again.
create or replace function public.discovery_review_retry(p_key text, p_revision integer)
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
  perform private.channel_audit(v_id, p_revision + 1, v_uid, 'reinspection_requested',
                                case when v_review.identity_state = 'confirmed' then 'media_only' else 'full' end);
  return private.channel_view(v_id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reviewer view: the last inspection and the next retry
-- ---------------------------------------------------------------------------
-- Everything a reviewer sees of one candidate. Never the bot file_id.
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
                   'playback_ready', ev.playback_ready, 'bytes_read', ev.bytes_read, 'checked_at', ev.checked_at)
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
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps each function's owner and ACL. They are restated so
-- this migration does not depend on that: the same roles as before, no others.
revoke all on function
  public.discovery_claim(integer),
  public.discovery_complete(text, uuid, integer, jsonb),
  public.discovery_fail(text, uuid, integer, text),
  public.discovery_review_retry(text, integer),
  private.channel_view(bigint, boolean)
from public, anon, authenticated, service_role;

-- Worker commands: service_role and the direct worker login (20261010175410).
grant execute on function
  public.discovery_claim(integer),
  public.discovery_complete(text, uuid, integer, jsonb),
  public.discovery_fail(text, uuid, integer, text)
to service_role, velora_discovery_worker;

-- Reviewer command: authenticated only (it checks catalogue_reviewers).
grant execute on function public.discovery_review_retry(text, integer) to authenticated;
