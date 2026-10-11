-- Checkpoint 4, local preparation only. Depends on the 17-migration hosted
-- baseline, including inspection recovery; independent of admin upload SQL.
-- Legacy facts and the legacy generated `verified` expression remain intact.
begin;

do $$ begin
  if to_regprocedure('public.discovery_complete(text,uuid,integer,jsonb)') is null
    or position('confirmed_selection' in pg_get_functiondef('public.discovery_claim(integer)'::regprocedure))=0 then
    raise exception 'original_media_requires_inspection_recovery';
  end if;
end $$;

-- Validate the actual CP3 contract, including bounded, incomplete outcomes.
-- No worker can upgrade "potentially playable" into verified streaming.
create function private.original_media_assessment_valid(p jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_track jsonb; k text;
begin
  if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>131072
    or (select array_agg(x order by x) from jsonb_object_keys(p) x) is distinct from
      array['accepted','compatibility','container','download','integrity','reasons','streaming','tracks','warnings']
    or jsonb_typeof(p->'accepted') is distinct from 'boolean'
    or jsonb_typeof(p->'container') not in ('null','string')
    or coalesce(p->>'container','mp4') not in ('mp4','mkv')
    or p->>'integrity' is null or p->>'integrity' not in ('metadata_consistent','incomplete')
    or p->>'streaming' is null or p->>'streaming' not in
      ('unverified','untested','potentially_playable','potentially_playable_startup_warning')
    or p->>'download' is distinct from 'not_implemented_authorization_required'
    or jsonb_typeof(p->'reasons') is distinct from 'array'
    or jsonb_typeof(p->'warnings') is distinct from 'array'
    or jsonb_typeof(p->'tracks') is distinct from 'array'
    or jsonb_typeof(p->'compatibility') is distinct from 'object' then return false; end if;
  if jsonb_array_length(p->'reasons')>50 or jsonb_array_length(p->'warnings')>50
    or jsonb_array_length(p->'tracks')>64
    or exists(select 1 from jsonb_array_elements((p->'reasons')||(p->'warnings')) r
      where jsonb_typeof(r)<>'string' or r#>>'{}' !~ '^[a-z0-9_]{1,100}$')
    or (p->>'accepted')::boolean is distinct from (jsonb_array_length(p->'reasons')=0)
    or (p->>'accepted')::boolean is distinct from (p->>'integrity'='metadata_consistent')
    or ((p->>'accepted')::boolean and (p->>'container' is null or p->>'streaming'='unverified'))
    or (not (p->>'accepted')::boolean and p->>'streaming'<>'unverified') then return false; end if;
  if (select array_agg(x order by x) from jsonb_object_keys(p->'compatibility') x) is distinct from
      array['android','basis','chromium','evidence','firefox','ios','perFile','safari']
    or p->'compatibility'->>'basis' is distinct from 'tested_fixture_combinations'
    or p->'compatibility'->>'perFile' is distinct from 'prediction'
    or p->'compatibility'->>'evidence' is distinct from
      'docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11'
    or p->'compatibility'->>'safari' is distinct from 'real_device_not_tested'
    or p->'compatibility'->>'ios' is distinct from 'real_device_not_tested'
    or p->'compatibility'->>'android' is distinct from 'real_device_not_tested'
    or coalesce(p->'compatibility'->>'chromium','') not in
      ('tested_combination','tested_video_only_silent_audio','device_dependent_or_untested')
    or coalesce(p->'compatibility'->>'firefox','') not in
      ('tested_combination','tested_video_only_silent_audio','device_dependent_or_untested','streaming_unreliable')
    or (p->>'container'='mkv' and p->'compatibility'->>'firefox' is distinct from 'streaming_unreliable')
    then return false; end if;
  for v_track in select value from jsonb_array_elements(p->'tracks') loop
    if jsonb_typeof(v_track)<>'object' or octet_length(v_track::text)>8192
      or exists(select 1 from jsonb_object_keys(v_track) x where x not in
        ('index','type','codec','codecTag','profile','level','width','height','pixelFormat','fieldOrder',
         'frameRate','timeBase','startSeconds','durationSeconds','sampleRate','channels','channelLayout',
         'bitRate','attachedPicture','language','title','defaultTrack','forced'))
      or coalesce(v_track->>'index','') !~ '^[0-9]{1,5}$'
      or coalesce(v_track->>'type','') not in ('video','audio','subtitle','data','attachment','other')
      or jsonb_typeof(v_track->'codec') not in ('string','null') or not v_track ? 'codec'
      or (v_track->>'codec' is not null and v_track->>'codec' !~ '^[a-zA-Z0-9_]{1,40}$')
      or jsonb_typeof(v_track->'attachedPicture') is distinct from 'boolean' then return false; end if;
    foreach k in array array['level','width','height','startSeconds','durationSeconds','sampleRate','channels','bitRate'] loop
      if v_track ? k and jsonb_typeof(v_track->k) not in ('null','number') then return false; end if;
    end loop;
    foreach k in array array['codecTag','profile','pixelFormat','fieldOrder','frameRate','timeBase','channelLayout','language','title'] loop
      if v_track ? k and (jsonb_typeof(v_track->k) not in ('null','string') or char_length(v_track->>k)>512) then return false; end if;
    end loop;
    foreach k in array array['defaultTrack','forced'] loop
      if v_track ? k and jsonb_typeof(v_track->k)<>'boolean' then return false; end if;
    end loop;
  end loop;
  if (select count(distinct t->>'index') from jsonb_array_elements(p->'tracks') t) <> jsonb_array_length(p->'tracks') then return false; end if;
  if (p->>'accepted')::boolean and (
    (select count(*) from jsonb_array_elements(p->'tracks') t where t->>'type'='video' and t->>'attachedPicture'='false')<>1
    or not exists(select 1 from jsonb_array_elements(p->'tracks') t where t->>'type'='audio')
    or exists(select 1 from jsonb_array_elements(p->'tracks') t where t->>'codec' is null
      or (t->>'type'='video' and t->>'attachedPicture'='false' and (coalesce((t->>'width')::numeric,0)<=0 or coalesce((t->>'height')::numeric,0)<=0))
      or (t->>'type'='audio' and (coalesce((t->>'channels')::numeric,0)<=0 or coalesce((t->>'sampleRate')::numeric,0)<=0)))) then return false; end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function private.original_media_assessment_valid(jsonb) from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;

alter table private.media_evidence drop constraint media_evidence_media_class_check;
alter table private.media_evidence add constraint media_evidence_media_class_check check(media_class in
  ('canonical','remux','audio_normalization','video_transcode_required','manual_review','unverified','original'));
alter table private.media_evidence
  add column assessment jsonb,
  add column integrity_status text generated always as (coalesce(assessment->>'integrity',case when policy_version=3 then 'incomplete' else 'legacy_unassessed' end)) stored,
  add column streaming_status text generated always as (coalesce(assessment->>'streaming',case when policy_version=3 then 'unverified' else 'legacy_unassessed' end)) stored,
  add column browser_profile jsonb generated always as (assessment->'compatibility') stored,
  add column download_status text generated always as (coalesce(assessment->>'download','not_implemented_authorization_required')) stored,
  add column tracks jsonb generated always as (assessment->'tracks') stored,
  add column warnings jsonb generated always as (assessment->'warnings') stored,
  add constraint media_evidence_original_contract check (
    (policy_version<>3 and assessment is null and media_class<>'original') or
    (policy_version=3 and method='bounded_original_v2' and not playback_ready and not verified and bytes_read<=16846848
      and ((assessment is null and media_class='unverified' and cardinality(reasons)>0) or
        (assessment is not null and private.original_media_assessment_valid(assessment)
          and container is not distinct from assessment->>'container'
          and to_jsonb(reasons)=assessment->'reasons'
          and ((media_class='original' and assessment->>'accepted'='true' and accessible
              and video_codec is not distinct from lower(jsonb_path_query_first(assessment,'$.tracks[*] ? (@.type == "video" && @.attachedPicture == false)')->>'codec')
              and audio_codec is not distinct from lower(jsonb_path_query_first(assessment,'$.tracks[*] ? (@.type == "audio")')->>'codec'))
            or (media_class='unverified' and assessment->>'accepted'='false'))))));

-- Historical `verified` facts are honored exactly as before, never backfilled.
-- Policy 3 requires both explicit verified states. CP3 cannot produce them:
-- a separately approved verifier/contract will be needed before publication.
create function private.media_evidence_publishable(p private.media_evidence)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(case when p.policy_version<3 then p.verified else
    p.integrity_status='verified' and p.streaming_status='verified'
    and p.accessible and p.gateway_compatible and cardinality(p.reasons)=0
    and p.container in ('mp4','mkv') end,false)
$$;
revoke all on function private.media_evidence_publishable(private.media_evidence) from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;

-- Explicit ACL/RLS audit of the extended table and existing identity sequence.
alter table private.media_evidence enable row level security;
create trigger media_evidence_append_only before update or delete on private.media_evidence
  for each row execute function private.guard_append_only();
revoke all on table private.media_evidence from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;
revoke all on sequence private.media_evidence_id_seq from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;

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
    if v_ev->>'policy_version'='3' then
      if v_ev->>'method' is distinct from 'bounded_original_v2'
        or v_ev->>'inspection_scope' is distinct from 'bounded'
        or v_ev->>'playback_ready' is distinct from 'false'
        or v_ev->>'media_class' not in ('original','unverified')
        or jsonb_typeof(v_ev->'reasons') is distinct from 'array'
        or (v_ev ? 'assessment' and not private.original_media_assessment_valid(v_ev->'assessment'))
        then raise exception 'discovery_invalid_input' using errcode='22023'; end if;
      if jsonb_array_length(v_ev->'reasons')>50 or exists(select 1 from jsonb_array_elements(v_ev->'reasons') r
        where jsonb_typeof(r)<>'string' or r#>>'{}' !~ '^[a-z0-9_]{1,100}$') then
        raise exception 'discovery_invalid_input' using errcode='22023';
      end if;
    elsif v_ev ? 'assessment' or v_ev ? 'inspection_scope' then
      raise exception 'discovery_invalid_input' using errcode='22023';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_ev - 'assessment' - 'inspection_scope') k)
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
                                          container, video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read, assessment)
      values (v_media.id, v_identity, v_ev->>'method', (v_ev->>'policy_version')::integer, v_ev->>'media_class',
              array(select jsonb_array_elements_text(v_ev->'reasons')),
              v_ev->>'container', v_ev->>'video_codec', v_ev->>'audio_codec', (v_ev->>'accessible')::boolean,
              (v_ev->>'gateway_compatible')::boolean, (v_ev->>'playback_ready')::boolean, (v_ev->>'bytes_read')::bigint, v_ev->'assessment');
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
  if v_identity is null or not exists (select 1 from private.channel_current_evidence(v_media.id) ev where private.media_evidence_publishable(ev)) then
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
                   'publishable_media',private.media_evidence_publishable(ev))
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

revoke all on function public.discovery_complete(text,uuid,integer,jsonb),private.channel_review_blockers(bigint),private.channel_view(bigint,boolean)
  from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.discovery_complete(text,uuid,integer,jsonb) to service_role,velora_discovery_worker;

-- Additive public facts only; no Telegram location, inspection identity, paths,
-- rights references, actor IDs or publication authority crosses this boundary.
-- Existing frontend queries and gateway resolver signatures remain unchanged.
create function public.movie_media_profile(p_version_id bigint)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('container',ev.container,'video_codec',ev.video_codec,'audio_codec',ev.audio_codec,
    'integrity_status',ev.integrity_status,'streaming_status',ev.streaming_status,
    'browser_profile',ev.browser_profile,'download_status',ev.download_status,
    'policy_version',ev.policy_version,'inspection_scope',ev.scope,'checked_at',ev.checked_at)
  from public.movie_versions mv join public.movies m on m.id=mv.movie_id
  join public.vjs v on v.id=mv.vj_id
  cross join lateral private.channel_current_evidence(mv.telegram_media_id) ev
  where mv.id=p_version_id and m.publication_status='published' and m.published_at is not null
    and mv.availability_status='ready' and mv.rights_status='cleared' and v.is_active
    and catalogue_access.movie_is_public(m.id)
$$;
revoke all on function public.movie_media_profile(bigint) from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.movie_media_profile(bigint) to anon,authenticated;
commit;
