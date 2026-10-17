-- Checkpoint 10, local preparation only. Depends on 20261011192618 (original
-- media evidence) and on nothing of the admin upload chain. The Policy 3
-- verification contract: a whole-file inspection may record verified integrity
-- and verified streaming readiness, each from its own evidence. A bounded
-- inspection still cannot. Legacy rows, the legacy `verified` expression and
-- the media gate's predicate (private.media_evidence_publishable) are unchanged.
begin;

do $$ begin
  if to_regprocedure('private.media_evidence_publishable(private.media_evidence)') is null
    or to_regprocedure('private.original_media_assessment_valid(jsonb)') is null then
    raise exception 'original_media_verification_requires_original_media_evidence';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The verification object (contract 1)
-- ---------------------------------------------------------------------------
-- What a whole-file inspection reports: the digest of every byte, a decode of
-- the whole film, decodes after seeking, and whether the original can be served
-- as a download. Each part has its own status and reasons. Nothing here is a
-- rights decision or an approval.
create function private.original_media_verification_valid(p jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v jsonb; s jsonb; d jsonb; x jsonb; v_duration numeric; v_decoded numeric;
begin
  if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>16384
    or (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from
      array['contract','digest','download','finished_at','integrity','started_at','streaming','tools']
    or p->>'contract' is distinct from '1'
    or jsonb_typeof(p->'digest') is distinct from 'object' or jsonb_typeof(p->'integrity') is distinct from 'object'
    or jsonb_typeof(p->'streaming') is distinct from 'object' or jsonb_typeof(p->'download') is distinct from 'object'
    or jsonb_typeof(p->'tools') is distinct from 'object' then return false; end if;
  -- Identity of the bytes: SHA-256 over the whole file and how many bytes that was.
  if (select array_agg(k order by k) from jsonb_object_keys(p->'digest') k) is distinct from array['algorithm','bytes','value']
    or p->'digest'->>'algorithm' is distinct from 'sha256'
    or coalesce(p->'digest'->>'value','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p->'digest'->'bytes') is distinct from 'number'
    or coalesce(p->'digest'->>'bytes','') !~ '^[1-9][0-9]{0,9}$'
    or (p->'digest'->>'bytes')::bigint > 2097152000 then return false; end if;
  -- Provenance: the tools and the worker's own clock. The row's checked_at is the database's.
  if (select array_agg(k order by k) from jsonb_object_keys(p->'tools') k) is distinct from array['ffmpeg','ffprobe']
    or coalesce(p->'tools'->>'ffmpeg','') !~ '^[A-Za-z0-9._+:-]{1,60}$'
    or coalesce(p->'tools'->>'ffprobe','') !~ '^[A-Za-z0-9._+:-]{1,60}$'
    or coalesce(p->>'started_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or coalesce(p->>'finished_at','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or p->>'finished_at' < p->>'started_at' then return false; end if;
  -- Every reason, in every part, is a fixed code.
  for x in select value from jsonb_array_elements(jsonb_build_array(p->'integrity'->'reasons', p->'streaming'->'reasons', p->'download'->'reasons')) loop
    if jsonb_typeof(x) is distinct from 'array' or jsonb_array_length(x)>20
      or exists(select 1 from jsonb_array_elements(x) r where jsonb_typeof(r)<>'string' or r#>>'{}' !~ '^[a-z0-9_]{1,100}$') then return false; end if;
  end loop;

  -- Integrity: the whole film decoded with errors fatal, and the decode reached the end.
  v := p->'integrity';
  if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from array['decoded_seconds','duration_seconds','method','reasons','status']
    or v->>'method' is distinct from 'whole_file_decode_v1'
    or coalesce(v->>'status','') not in ('verified','failed')
    or jsonb_typeof(v->'decoded_seconds') not in ('null','number') or jsonb_typeof(v->'duration_seconds') not in ('null','number')
    or (v->>'status'='verified') is distinct from (jsonb_array_length(v->'reasons')=0) then return false; end if;
  if v->>'status'='verified' then
    v_duration := (v->>'duration_seconds')::numeric; v_decoded := (v->>'decoded_seconds')::numeric;
    if v_duration is null or v_decoded is null or v_duration <= 0 or v_duration > 86400
      or v_decoded < v_duration - greatest(1, v_duration * 0.02) then return false; end if;
  end if;

  -- Streaming readiness: a layout the player can start from, and decodes after seeking to three places.
  -- It is attempted only on bytes whose integrity was verified.
  s := p->'streaming';
  if (select array_agg(k order by k) from jsonb_object_keys(s) k) is distinct from array['layout','method','reasons','samples','status']
    or s->>'method' is distinct from 'sampled_seek_decode_v1'
    or coalesce(s->>'status','') not in ('verified','failed','not_attempted')
    or jsonb_typeof(s->'layout') not in ('null','string')
    or coalesce(s->>'layout','mp4_head_index') not in ('mp4_head_index','mp4_tail_index','matroska')
    or jsonb_typeof(s->'samples') is distinct from 'array' or jsonb_array_length(s->'samples')>3
    or (s->>'status'='not_attempted') is distinct from (v->>'status'<>'verified')
    or (s->>'status'='failed') is distinct from (jsonb_array_length(s->'reasons')>0) then return false; end if;
  for x in select value from jsonb_array_elements(s->'samples') loop
    if jsonb_typeof(x)<>'object'
      or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['decoded','position','seconds']
      or coalesce(x->>'position','') not in ('start','middle','end')
      or jsonb_typeof(x->'decoded') is distinct from 'boolean'
      or jsonb_typeof(x->'seconds') is distinct from 'number' or (x->>'seconds')::numeric < 0 then return false; end if;
  end loop;
  if (select count(distinct e->>'position') from jsonb_array_elements(s->'samples') e) <> jsonb_array_length(s->'samples')
    or (s->>'status'='not_attempted' and jsonb_array_length(s->'samples')>0)
    or (s->>'status'='verified' and (s->>'layout' is null
      or (select count(*) from jsonb_array_elements(s->'samples') e where e->>'decoded'='true') <> 3)) then return false; end if;

  -- Download: whether the original can be served as an attachment. Not a gate, not a rights decision.
  d := p->'download';
  if (select array_agg(k order by k) from jsonb_object_keys(d) k) is distinct from array['reasons','status']
    or coalesce(d->>'status','') not in ('original_servable','not_servable')
    or (d->>'status'='original_servable') is distinct from (jsonb_array_length(d->'reasons')=0) then return false; end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;
revoke all on function private.original_media_verification_valid(jsonb) from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;

-- ---------------------------------------------------------------------------
-- 2. The assessment contract: verified only together with a valid verification
-- ---------------------------------------------------------------------------
create or replace function private.original_media_assessment_valid(p jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_track jsonb; k text;
begin
  if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>131072
    or (select array_agg(x order by x) from jsonb_object_keys(p - 'verification') x) is distinct from
      array['accepted','compatibility','container','download','integrity','reasons','streaming','tracks','warnings']
    or jsonb_typeof(p->'accepted') is distinct from 'boolean'
    or jsonb_typeof(p->'container') not in ('null','string')
    or coalesce(p->>'container','mp4') not in ('mp4','mkv')
    or p->>'integrity' is null or p->>'integrity' not in ('metadata_consistent','incomplete','verified')
    or p->>'streaming' is null or p->>'streaming' not in
      ('unverified','untested','potentially_playable','potentially_playable_startup_warning','verified')
    or coalesce(p->>'download','') not in ('not_implemented_authorization_required','original_servable','not_servable')
    or jsonb_typeof(p->'reasons') is distinct from 'array'
    or jsonb_typeof(p->'warnings') is distinct from 'array'
    or jsonb_typeof(p->'tracks') is distinct from 'array'
    or jsonb_typeof(p->'compatibility') is distinct from 'object' then return false; end if;
  if jsonb_array_length(p->'reasons')>50 or jsonb_array_length(p->'warnings')>50
    or jsonb_array_length(p->'tracks')>64
    or exists(select 1 from jsonb_array_elements((p->'reasons')||(p->'warnings')) r
      where jsonb_typeof(r)<>'string' or r#>>'{}' !~ '^[a-z0-9_]{1,100}$')
    or (p->>'accepted')::boolean is distinct from (jsonb_array_length(p->'reasons')=0)
    or ((p->>'accepted')::boolean and p->>'container' is null) then return false; end if;
  if p ? 'verification' then
    -- Whole-file verification: each status is what the verification object says, and nothing else.
    if not private.original_media_verification_valid(p->'verification')
      or p->>'integrity' is distinct from (case when p->'verification'->'integrity'->>'status'='verified' then 'verified' else 'incomplete' end)
      or p->>'streaming' is distinct from (case when p->'verification'->'streaming'->>'status'='verified' then 'verified' else 'unverified' end)
      or p->>'download' is distinct from p->'verification'->'download'->>'status'
      or (p->>'accepted')::boolean is distinct from (p->>'integrity'='verified' and p->>'streaming'='verified') then return false; end if;
  -- Bounded inspection, exactly as before: it can never say verified.
  elsif p->>'integrity' not in ('metadata_consistent','incomplete') or p->>'streaming'='verified'
    or p->>'download'<>'not_implemented_authorization_required'
    or (p->>'accepted')::boolean is distinct from (p->>'integrity'='metadata_consistent')
    or ((p->>'accepted')::boolean and p->>'streaming'='unverified')
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

-- ---------------------------------------------------------------------------
-- 3. Evidence rows: a second scope, and the digest as a column
-- ---------------------------------------------------------------------------
-- Existing rows keep scope 'bounded' and satisfy every constraint below as they are.
alter table private.media_evidence drop constraint media_evidence_scope_check;
alter table private.media_evidence add constraint media_evidence_scope_check check (scope in ('bounded','whole_file'));
-- A whole-file read is the file once, plus the bounded reads before it.
alter table private.media_evidence drop constraint media_evidence_bytes_read_check;
alter table private.media_evidence add constraint media_evidence_bytes_read_check check (bytes_read between 0 and 4294967296);
alter table private.media_evidence
  add column content_sha256 text generated always as (assessment->'verification'->'digest'->>'value') stored;
alter table private.media_evidence drop constraint media_evidence_original_contract;
alter table private.media_evidence add constraint media_evidence_original_contract check (
  (policy_version<>3 and assessment is null and media_class<>'original' and scope='bounded') or
  (policy_version=3 and not playback_ready and not verified
    and ((scope='bounded' and method='bounded_original_v2' and bytes_read<=16846848)
      or (scope='whole_file' and method='full_original_v1'))
    and ((assessment is null and media_class='unverified' and cardinality(reasons)>0) or
      (assessment is not null and private.original_media_assessment_valid(assessment)
        and (assessment ? 'verification') = (scope='whole_file')
        -- Verified integrity means every byte of the digested file was read.
        and (assessment->>'integrity'<>'verified' or bytes_read >= (assessment->'verification'->'digest'->>'bytes')::bigint)
        and container is not distinct from assessment->>'container'
        and to_jsonb(reasons)=assessment->'reasons'
        and ((media_class='original' and assessment->>'accepted'='true' and accessible
            and video_codec is not distinct from lower(jsonb_path_query_first(assessment,'$.tracks[*] ? (@.type == "video" && @.attachedPicture == false)')->>'codec')
            and audio_codec is not distinct from lower(jsonb_path_query_first(assessment,'$.tracks[*] ? (@.type == "audio")')->>'codec'))
          or (media_class='unverified' and assessment->>'accepted'='false'))))));
create index media_evidence_content_idx on private.media_evidence (telegram_media_id, media_identity) where content_sha256 is not null;
revoke all on table private.media_evidence from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;

-- ---------------------------------------------------------------------------
-- 4. Completion and gates
-- ---------------------------------------------------------------------------
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
      -- Two shapes only. A bounded inspection carries no verification; a whole-file one carries nothing else.
      if not coalesce(
           (v_ev->>'method'='bounded_original_v2' and v_ev->>'inspection_scope'='bounded'
             and not coalesce(v_ev->'assessment' ? 'verification',false))
           or (v_ev->>'method'='full_original_v1' and v_ev->>'inspection_scope'='whole_file'
             and coalesce(v_ev->'assessment' ? 'verification',true)),false)
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
    -- A digest of fewer or more bytes than the document's recorded size is evidence about another file.
    if coalesce(v_ev->'assessment' ? 'verification',false)
       and (v_ev->'assessment'->'verification'->'digest'->>'bytes')::bigint is distinct from v_media.file_size_bytes then
      raise exception 'discovery_evidence_size_mismatch' using errcode = 'P0001';
    end if;
    begin
      insert into private.media_evidence (telegram_media_id, media_identity, method, scope, policy_version, media_class, reasons,
                                          container, video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read, assessment)
      values (v_media.id, v_identity, v_ev->>'method', coalesce(v_ev->>'inspection_scope','bounded'), (v_ev->>'policy_version')::integer, v_ev->>'media_class',
              array(select jsonb_array_elements_text(v_ev->'reasons')),
              v_ev->>'container', v_ev->>'video_codec', v_ev->>'audio_codec', (v_ev->>'accessible')::boolean,
              (v_ev->>'gateway_compatible')::boolean, (v_ev->>'playback_ready')::boolean, (v_ev->>'bytes_read')::bigint, v_ev->'assessment');
    exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
      raise exception 'discovery_invalid_input' using errcode = '22023';
    end;
    -- Whether the media gate opens is derived by the database from the stored row, never asserted by the worker.
    select case when private.media_evidence_publishable(ev) then 'verified' else 'unverified:' || ev.media_class end into v_detail
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
-- 5. A keyed claim for one whole-file verification
-- ---------------------------------------------------------------------------
-- A whole-file read takes far longer than the listener's inspection lease and
-- must not stall its polling. This claims exactly the candidate named, never
-- "the next one due", and only one whose film and VJ a reviewer has confirmed.
-- The result has the shape of discovery_claim, and the verification ends through
-- the same discovery_complete or discovery_fail under the same fenced lease.
-- It does not count as an automatic inspection attempt.
create function public.discovery_claim_verification(p_key text, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_event private.ingestion_events%rowtype;
  v_review private.channel_reviews%rowtype;
  v_media private.telegram_media%rowtype;
  v_token uuid := pg_catalog.gen_random_uuid();
  v_selection jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 14400 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  v_id := private.channel_lock(p_key);
  select e.* into v_event from private.ingestion_events e where e.id = v_id;
  select r.* into v_review from private.channel_reviews r where r.ingestion_event_id = v_id;
  select m.* into v_media from private.telegram_media m where m.id = v_event.telegram_media_id;
  if v_review.identity_state = 'confirmed' and v_review.tmdb_id is not null and v_review.vj_id is not null then
    select jsonb_build_object('title', v_review.title, 'year', v_review.release_year, 'vj_text', v_review.vj_text,
                              'vj_id', v_review.vj_id, 'tmdb_id', v_review.tmdb_id, 'snapshot', c.snapshot)
    into v_selection
    from private.metadata_match_candidates c
    where c.ingestion_event_id = v_id and c.tmdb_media_type = 'movie' and c.tmdb_id = v_review.tmdb_id
      and c.snapshot is not null and c.decision <> 'rejected';
  end if;
  if v_event.origin <> 'channel' or v_event.status <> 'needs_review' or v_selection is null
     or v_review.duplicate_of_media_id is not null
     or private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes) is null then
    raise exception 'discovery_verification_not_claimable' using errcode = 'P0001';
  end if;
  update private.ingestion_events e set status = 'processing' where e.id = v_id;
  update private.channel_reviews r
  set lease_token = v_token, lease_until = now() + make_interval(secs => p_lease_seconds)
  where r.ingestion_event_id = v_id
  returning * into v_review;
  return jsonb_build_object(
    'key', v_review.discovery_key, 'revision', v_review.review_revision, 'lease', v_token,
    'attempts', v_event.attempt_count, 'event_id', v_review.event_id, 'payload_digest', v_review.payload_digest,
    'observed_at', v_review.observed_at, 'update_id', v_event.telegram_update_id, 'kind', v_event.update_kind,
    'chat_id', v_media.chat_id, 'message_id', v_media.message_id, 'file_unique_id', v_media.file_unique_id,
    'size', v_media.file_size_bytes, 'name', v_media.file_name, 'mime', v_media.mime_type, 'caption', v_media.caption,
    'identity', private.channel_media_identity(v_media.chat_id, v_media.message_id, v_media.file_unique_id, v_media.file_size_bytes),
    'confirmed_selection', v_selection);
end;
$$;

-- Same producers as before, and no one else: the worker's own role and the service role.
revoke all on function public.discovery_complete(text,uuid,integer,jsonb),private.channel_review_blockers(bigint),public.discovery_claim_verification(text,integer)
  from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function public.discovery_complete(text,uuid,integer,jsonb),public.discovery_claim_verification(text,integer) to service_role,velora_discovery_worker;
commit;
