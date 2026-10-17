-- Policy 3 verification contract (Checkpoint 10): fake documents only. Uses nothing
-- of the admin upload chain, so it also runs on the hosted set plus the two
-- channel migrations (20261011192618, 20261014090000).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
create schema tests;

-- A complete, honest verification of a 1,000-byte file; `p_patch` replaces whole top-level parts.
create function tests.verification(p_patch jsonb default '{}'::jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('contract', 1,
    'digest', jsonb_build_object('algorithm', 'sha256', 'value', repeat('a', 64), 'bytes', 1000),
    'integrity', jsonb_build_object('status', 'verified', 'method', 'whole_file_decode_v1', 'duration_seconds', 5400, 'decoded_seconds', 5399.5, 'reasons', '[]'::jsonb),
    'streaming', jsonb_build_object('status', 'verified', 'method', 'sampled_seek_decode_v1', 'layout', 'mp4_head_index', 'reasons', '[]'::jsonb,
      'samples', '[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":2700,"decoded":true},{"position":"end","seconds":4860,"decoded":true}]'::jsonb),
    'download', jsonb_build_object('status', 'original_servable', 'reasons', '[]'::jsonb),
    'tools', jsonb_build_object('ffmpeg', '9.0.2-essentials_build', 'ffprobe', '9.0.2-essentials_build'),
    'started_at', '2026-10-14T08:00:00.000Z', 'finished_at', '2026-10-14T08:20:00.000Z') || p_patch
$$;
create function tests.part(p_part text, p_patch jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(p_part, (tests.verification()->p_part) || p_patch) $$;
create function tests.failed_integrity(p_reason text default 'decode_failed') returns jsonb language sql immutable as $$
  select tests.verification(tests.part('integrity', jsonb_build_object('status', 'failed', 'reasons', jsonb_build_array(p_reason)))
    || jsonb_build_object('streaming', jsonb_build_object('status', 'not_attempted', 'method', 'sampled_seek_decode_v1', 'layout', null, 'reasons', '[]'::jsonb, 'samples', '[]'::jsonb))) $$;
create function tests.failed_streaming() returns jsonb language sql immutable as $$
  select tests.verification(jsonb_build_object('streaming', jsonb_build_object('status', 'failed', 'method', 'sampled_seek_decode_v1', 'layout', null, 'reasons', '["mp4_fragmented_untested"]'::jsonb, 'samples', '[]'::jsonb))) $$;
-- The bounded assessment of an MP4, as migration 20261011192618 already accepts it.
create function tests.bounded() returns jsonb language sql immutable as $$
  select jsonb_build_object('accepted', true, 'container', 'mp4', 'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb,
    'integrity', 'metadata_consistent', 'streaming', 'potentially_playable', 'download', 'not_implemented_authorization_required',
    'compatibility', jsonb_build_object('basis', 'tested_fixture_combinations', 'perFile', 'prediction',
      'evidence', 'docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
      'chromium', 'tested_combination', 'firefox', 'tested_combination', 'safari', 'real_device_not_tested', 'ios', 'real_device_not_tested', 'android', 'real_device_not_tested'),
    'tracks', '[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"attachedPicture":false}]'::jsonb)
$$;
-- The assessment a whole-file inspection records for a given verification.
create function tests.whole(p_verification jsonb, p_reasons jsonb default '[]'::jsonb) returns jsonb language sql immutable as $$
  select tests.bounded() || jsonb_build_object('verification', p_verification, 'reasons', p_reasons, 'accepted', p_reasons = '[]'::jsonb,
    'integrity', case when p_verification->'integrity'->>'status' = 'verified' then 'verified' else 'incomplete' end,
    'streaming', case when p_verification->'streaming'->>'status' = 'verified' then 'verified' else 'unverified' end,
    'download', p_verification->'download'->>'status')
$$;

-- 1. Privileges: the validators are the owner's; the keyed claim is the worker's and the service role's alone.
select ok(not has_function_privilege(r, 'private.original_media_verification_valid(jsonb)', 'EXECUTE')
  and not has_function_privilege(r, 'private.original_media_assessment_valid(jsonb)', 'EXECUTE')
  and not has_function_privilege(r, 'private.channel_review_blockers(bigint)', 'EXECUTE'), r || ' cannot call the contract validators or the gates')
from unnest(array['anon', 'authenticated', 'service_role', 'velora_discovery_worker', 'velora_review_service', 'velora_media_gateway']) r;
select ok(has_function_privilege(r, 'public.discovery_claim_verification(text,integer)', 'EXECUTE') and has_function_privilege(r, 'public.discovery_complete(text,uuid,integer,jsonb)', 'EXECUTE'),
  r || ' is an evidence producer') from unnest(array['service_role', 'velora_discovery_worker']) r;
select ok(not has_function_privilege(r, 'public.discovery_claim_verification(text,integer)', 'EXECUTE') and not has_function_privilege(r, 'public.discovery_complete(text,uuid,integer,jsonb)', 'EXECUTE'),
  r || ' cannot claim a verification or record evidence') from unnest(array['anon', 'authenticated', 'velora_review_service', 'velora_media_gateway']) r;
select ok((select p.prosecdef and p.proconfig = array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres'
  from pg_proc p where p.oid = 'public.discovery_claim_verification(text,integer)'::regprocedure), 'the keyed claim is an owner-defined, search_path-pinned definer');
select ok((select not p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = 'private.original_media_verification_valid(jsonb)'::regprocedure), 'the verification validator is an invoker with a pinned search_path');
select ok(not has_table_privilege(r, 'private.media_evidence', 'SELECT,INSERT,UPDATE,DELETE'), r || ' has no direct access to evidence rows')
from unnest(array['anon', 'authenticated', 'service_role', 'velora_discovery_worker', 'velora_review_service', 'velora_media_gateway']) r;

-- 2. The verification object.
select ok(private.original_media_verification_valid(tests.verification()), 'a complete verified record is valid');
select ok(private.original_media_verification_valid(tests.failed_integrity()), 'failed integrity with streaming not attempted is valid');
select ok(private.original_media_verification_valid(tests.failed_streaming()), 'verified integrity with failed streaming is valid');
select ok(private.original_media_verification_valid(tests.verification(jsonb_build_object('download', jsonb_build_object('status', 'not_servable', 'reasons', '["download_media_type_mismatch"]'::jsonb)))),
  'download evidence is independent of the other findings');
select ok(private.original_media_verification_valid(tests.verification(tests.part('streaming', '{"layout":"matroska"}'))) and private.original_media_verification_valid(tests.verification(tests.part('streaming', '{"layout":"mp4_tail_index"}'))),
  'an MKV and a tail-index MP4 are streamable layouts');
select ok(not private.original_media_verification_valid(v), label) from (values
  (null::jsonb, 'null is not a verification'),
  ('[]'::jsonb, 'an array is not a verification'),
  (tests.verification() - 'download', 'missing download evidence is refused, not defaulted'),
  (tests.verification() - 'streaming', 'missing streaming evidence is refused'),
  (tests.verification() - 'integrity', 'missing integrity evidence is refused'),
  (tests.verification() - 'digest', 'missing digest is refused'),
  (tests.verification() - 'tools', 'missing provenance is refused'),
  (tests.verification('{"approved":true}'), 'an extra key is refused'),
  (tests.verification('{"rights":"cleared"}'), 'a rights claim has no place in it'),
  (tests.verification('{"contract":2}'), 'another contract version is refused'),
  (tests.verification(tests.part('digest', '{"value":"not-a-digest"}')), 'the digest must be a SHA-256'),
  (tests.verification(tests.part('digest', '{"algorithm":"md5"}')), 'the digest algorithm is fixed'),
  (tests.verification(tests.part('digest', '{"bytes":0}')), 'an empty file is not verified'),
  (tests.verification(tests.part('digest', '{"bytes":2097152001}')), 'a file over the ceiling is not verified'),
  (tests.verification(tests.part('digest', '{"bytes":"1000"}')), 'the byte count is a number'),
  (tests.verification(tests.part('integrity', '{"reasons":["decode_failed"]}')), 'verified integrity carries no failure reason'),
  (tests.verification(tests.part('integrity', '{"status":"failed"}')), 'failed integrity names its reason'),
  (tests.verification(tests.part('integrity', '{"decoded_seconds":5200}')), 'a decode that stops short of the duration is not verified'),
  (tests.verification(tests.part('integrity', '{"decoded_seconds":null}')), 'verified integrity needs the decode'),
  (tests.verification(tests.part('integrity', '{"duration_seconds":null}')), 'verified integrity needs a duration'),
  (tests.verification(tests.part('integrity', '{"method":"metadata_consistent"}')), 'a bounded method cannot verify integrity'),
  (tests.verification(tests.part('integrity', '{"status":"potentially_verified"}')), 'an invented status is refused'),
  (tests.verification(tests.part('integrity', '{"reasons":["Not A Code"]}')), 'reasons are fixed codes'),
  (tests.verification(tests.part('streaming', '{"samples":[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":2700,"decoded":true}]}')), 'two samples do not verify streaming'),
  (tests.verification(tests.part('streaming', '{"samples":[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":2700,"decoded":false},{"position":"end","seconds":4860,"decoded":true}]}')), 'a sample that did not decode does not verify streaming'),
  (tests.verification(tests.part('streaming', '{"samples":[{"position":"start","seconds":0,"decoded":true},{"position":"start","seconds":1,"decoded":true},{"position":"end","seconds":4860,"decoded":true}]}')), 'the three samples are three places'),
  (tests.verification(tests.part('streaming', '{"layout":null}')), 'verified streaming names its layout'),
  (tests.verification(tests.part('streaming', '{"layout":"hls"}')), 'an unknown layout is refused'),
  (tests.verification(tests.part('streaming', '{"method":"browser_profile"}')), 'a browser prediction is not a streaming method'),
  (tests.verification(tests.part('streaming', '{"reasons":["seek_decode_failed"]}')), 'verified streaming carries no failure reason'),
  (tests.failed_integrity() || tests.part('streaming', '{}'), 'streaming is not attempted on bytes whose integrity failed'),
  (tests.verification(jsonb_build_object('streaming', jsonb_build_object('status', 'not_attempted', 'method', 'sampled_seek_decode_v1', 'layout', null, 'reasons', '[]'::jsonb, 'samples', '[]'::jsonb))), 'streaming must be attempted once integrity is verified'),
  (tests.verification(tests.part('download', '{"reasons":["download_size_over_limit"]}')), 'a servable download carries no reason'),
  (tests.verification(tests.part('download', '{"status":"not_servable"}')), 'a non-servable download names its reason'),
  (tests.verification(tests.part('download', '{"status":"cleared"}')), 'download evidence is not a rights status'),
  (tests.verification('{"finished_at":"2026-10-14T07:59:59.000Z"}'), 'it cannot finish before it started'),
  (tests.verification('{"started_at":"yesterday"}'), 'timestamps are ISO instants'),
  (tests.verification(tests.part('tools', '{"ffmpeg":"rm -rf /"}')), 'a tool version is a short token')
) as cases(v, label);

-- 3. The assessment: verified only together with a verification that says so.
select ok(private.original_media_assessment_valid(tests.bounded()), 'a bounded assessment is valid exactly as before');
select ok(private.original_media_assessment_valid(tests.whole(tests.verification())), 'a whole-file assessment with a verified record is valid');
select ok(private.original_media_assessment_valid(tests.whole(tests.failed_integrity(), '["decode_failed"]')), 'failed integrity is recorded as not accepted');
select ok(private.original_media_assessment_valid(tests.whole(tests.failed_streaming(), '["mp4_fragmented_untested"]')), 'verified integrity with failed streaming is recorded as not accepted');
select ok(not private.original_media_assessment_valid(a), label) from (values
  (tests.bounded() || '{"integrity":"verified"}', 'a bounded assessment cannot say integrity is verified'),
  (tests.bounded() || '{"streaming":"verified"}', 'a bounded assessment cannot say streaming is verified'),
  (tests.bounded() || '{"integrity":"verified","streaming":"verified"}', 'nor both'),
  (tests.bounded() || '{"download":"original_servable"}', 'a bounded assessment records no download evidence'),
  (tests.whole(tests.verification()) - 'verification', 'verified statuses without their verification are refused'),
  (tests.whole(tests.failed_integrity(), '["decode_failed"]') || '{"integrity":"verified"}', 'the status cannot say more than the verification'),
  (tests.whole(tests.failed_streaming(), '["mp4_fragmented_untested"]') || '{"streaming":"verified"}', 'streaming cannot be called verified against its own evidence'),
  (tests.whole(tests.failed_streaming(), '["mp4_fragmented_untested"]') || '{"accepted":true,"reasons":[]}', 'a file whose streaming failed is not accepted'),
  (tests.whole(tests.failed_integrity(), '[]'), 'a failed finding must appear among the reasons'),
  (tests.whole(tests.verification()) || '{"download":"not_servable"}', 'the download status is the verification''s own'),
  (tests.whole(tests.verification()) || '{"download":"not_implemented_authorization_required"}', 'a whole-file assessment records its download evidence'),
  (tests.whole(tests.verification(tests.part('integrity', '{"decoded_seconds":10}'))), 'an invalid verification invalidates the assessment'),
  (tests.whole(tests.verification()) || jsonb_build_object('compatibility', (tests.bounded()->'compatibility') || '{"chromium":"verified"}'), 'a browser prediction cannot be turned into a verification')
) as cases(a, label);

-- 4. Evidence rows.
insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, file_size_bytes, mime_type, telegram_date)
  values ('movie', -1009990004545, 1, 'synthetic-only', 'synthetic-cp10', 'document', 1000, 'video/mp4', now());
create function tests.media() returns bigint language sql as $$ select id from private.telegram_media where file_unique_id = 'synthetic-cp10' $$;
create function tests.identity() returns text language sql as $$
  select private.channel_media_identity(chat_id, message_id, file_unique_id, file_size_bytes) from private.telegram_media where id = tests.media() $$;
create function tests.row(p_scope text, p_method text, p_class text, p_assessment jsonb, p_bytes bigint default 1100, p_policy integer default 3, p_playback boolean default false)
returns text language plpgsql as $$
begin
  insert into private.media_evidence (telegram_media_id, media_identity, method, scope, policy_version, media_class, reasons, container, video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read, assessment)
  values (tests.media(), tests.identity(), p_method, p_scope, p_policy, p_class,
    case when p_assessment is null then array['probe_failed'] else array(select jsonb_array_elements_text(p_assessment->'reasons')) end, p_assessment->>'container',
    case when p_assessment is not null then 'h264' end, case when p_assessment is not null then 'aac' end, true, true, p_playback, p_bytes, p_assessment);
  return 'stored';
exception when check_violation then return 'refused';
end $$;

select is(tests.row('bounded', 'bounded_original_v2', 'original', tests.bounded(), 70000), 'stored', 'a bounded inspection is stored as before');
select ok(not (select private.media_evidence_publishable(ev) from private.media_evidence ev order by id desc limit 1), 'and does not open the media gate');
select is(tests.row('bounded', 'bounded_original_v2', 'original', tests.whole(tests.verification()), 70000), 'refused', 'a bounded row cannot carry a verification');
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.bounded()), 'refused', 'a whole-file row must carry one');
select is(tests.row('whole_file', 'bounded_original_v2', 'original', tests.whole(tests.verification())), 'refused', 'the method and the scope go together');
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.whole(tests.verification()), 999), 'refused', 'verified integrity needs every digested byte read');
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.whole(tests.verification()), 1100, 3, true), 'refused', 'inspection never asserts browser playback');
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.whole(tests.verification()), 1100, 2), 'refused', 'an earlier policy cannot carry a Policy 3 assessment');
select is(tests.row('whole_file', 'full_original_v1', 'unverified', tests.whole(tests.verification())), 'refused', 'an accepted file is not stored as unverified');
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.whole(tests.failed_integrity(), '["decode_failed"]')), 'refused', 'a refused file is not stored as an original');
select is(tests.row('whole_file', 'full_original_v1', 'unverified', tests.whole(tests.failed_integrity(), '["decode_failed"]')), 'stored', 'a failed verification is stored, with its digest and reasons');
select ok(not (select private.media_evidence_publishable(ev) from private.media_evidence ev order by id desc limit 1), 'a failed verification does not open the gate');
select is(tests.row('whole_file', 'full_original_v1', 'unverified', tests.whole(tests.failed_streaming(), '["mp4_fragmented_untested"]')), 'stored', 'verified integrity with failed streaming is stored');
select is((select integrity_status || ':' || streaming_status || ':' || private.media_evidence_publishable(ev)::text from private.media_evidence ev order by id desc limit 1),
  'verified:unverified:false', 'integrity alone does not open the gate');
select is(tests.row('whole_file', 'full_original_v1', 'unverified', null), 'stored', 'a whole-file read that failed early is stored with its reason and no findings');
select is((select integrity_status || ':' || streaming_status || ':' || coalesce(content_sha256, 'none') from private.media_evidence order by id desc limit 1), 'incomplete:unverified:none', 'and reads as incomplete, with no digest');
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.whole(tests.verification())), 'stored', 'a verified whole-file inspection is stored');
select is((select scope || ':' || integrity_status || ':' || streaming_status || ':' || download_status || ':' || verified::text || ':' || content_sha256 from private.media_evidence order by id desc limit 1),
  'whole_file:verified:verified:original_servable:false:' || repeat('a', 64), 'its facts are separate columns, and the earlier `verified` flag stays false');
select ok((select private.media_evidence_publishable(ev) from private.media_evidence ev order by id desc limit 1), 'verified integrity and verified streaming open the media gate');
select ok((select private.media_evidence_publishable(ev) from private.channel_current_evidence(tests.media()) ev), 'the current evidence of the document is the verified row');
-- Download evidence does not gate, and a later failure supersedes an earlier success.
select is(tests.row('whole_file', 'full_original_v1', 'original', tests.whole(tests.verification(jsonb_build_object('download', jsonb_build_object('status', 'not_servable', 'reasons', '["download_media_type_mismatch"]'::jsonb))))), 'stored', 'a verified original that cannot be downloaded is stored');
select is((select download_status || ':' || private.media_evidence_publishable(ev)::text from private.channel_current_evidence(tests.media()) ev), 'not_servable:true', 'download evidence is not a publication gate');
select is(tests.row('whole_file', 'full_original_v1', 'unverified', tests.whole(tests.failed_integrity('content_truncated'), '["content_truncated"]')), 'stored', 'a later failed verification is stored');
select ok(not (select private.media_evidence_publishable(ev) from private.channel_current_evidence(tests.media()) ev), 'and supersedes the earlier verified row');
select is((select count(*)::integer from private.media_evidence where telegram_media_id = tests.media()), 7, 'every inspection is kept');
select throws_ok('update private.media_evidence set media_class = ''original''', 'P0001', 'audit_append_only', 'evidence cannot be rewritten');
select throws_ok('delete from private.media_evidence', 'P0001', 'audit_append_only', 'evidence cannot be removed');

-- Earlier policies are untouched.
create function tests.earlier(p_scope text) returns text language plpgsql as $$
begin
  insert into private.media_evidence (telegram_media_id, media_identity, method, scope, policy_version, media_class, reasons, container, video_codec, audio_codec, accessible, gateway_compatible, playback_ready, bytes_read)
  values (tests.media(), tests.identity(), 'bounded_mtproto_v1', p_scope, 2, 'canonical', '{}', 'mp4', 'h264', 'aac', true, true, true, 3072);
  return 'stored';
exception when check_violation then return 'refused';
end $$;
select is(tests.earlier('whole_file'), 'refused', 'an earlier-policy row cannot claim the whole-file scope');
select is(tests.earlier('bounded'), 'stored', 'an earlier-policy row is stored as before');
select is((select verified::text || ':' || integrity_status || ':' || scope || ':' || private.media_evidence_publishable(ev)::text from private.media_evidence ev order by id desc limit 1),
  'true:legacy_unassessed:bounded:true', 'and is judged by its own verdict');

-- 5. The keyed claim refuses what it must before touching anything.
select throws_ok($$select public.discovery_claim_verification('not-a-key', 600)$$, '22023', 'discovery_invalid_input', 'a malformed key is refused');
select throws_ok(format($$select public.discovery_claim_verification(%L, 600)$$, repeat('0', 64)), 'P0001', 'discovery_not_found', 'an unknown candidate is refused');
select throws_ok(format($$select public.discovery_claim_verification(%L, 59)$$, repeat('0', 64)), '22023', 'discovery_invalid_input', 'a lease under a minute is refused');
select throws_ok(format($$select public.discovery_claim_verification(%L, 14401)$$, repeat('0', 64)), '22023', 'discovery_invalid_input', 'a lease over four hours is refused');

select * from finish();
rollback;
