begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
grant velora_upload_worker to postgres with set true;
create schema tests;
create function tests.call(p_actor integer,p_sql text) returns text language plpgsql as $$
declare result text;
begin
  if p_actor=0 then set local role velora_upload_worker;
  else
    perform set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-'||lpad(p_actor::text,12,'0'),'role','authenticated','is_anonymous',false)::text,true);
    set local role authenticated;
  end if;
  begin execute p_sql into result;exception when others then reset role;return sqlerrm;end;
  reset role;return coalesce(result,'null');
end;
$$;
insert into auth.users(id,raw_app_meta_data,is_anonymous) values
 ('00000000-0000-4000-8000-000000008401','{"role":"admin"}',false),
 ('00000000-0000-4000-8000-000000008402','{"role":"admin"}',false),
 ('00000000-0000-4000-8000-000000008403','{}',false);
insert into private.catalogue_reviewers(user_id,can_review) select id,true from auth.users where id in ('00000000-0000-4000-8000-000000008401','00000000-0000-4000-8000-000000008402');
create function tests.id() returns uuid language sql as $$select id from private.admin_upload_sessions where upload_request_id='00000000-0000-4000-8000-000000008410'$$;
create function tests.command(p_command text,p_input jsonb default '{}'::jsonb) returns text language sql as $$select tests.call(8401,format('select public.admin_upload_r2_command(%L,%L,%L::jsonb)->>''state''',tests.id(),p_command,p_input))$$;
create function tests.review(p_action text,p_reference text default null,p_expiry timestamptz default null) returns text language sql as $$select tests.call(8401,format('select public.admin_upload_r2_review(%L,%s,%L,%L,%L::timestamptz)->>''stage''',tests.id(),(select revision from private.admin_upload_sessions where id=tests.id()),p_action,p_reference,p_expiry))$$;
create function tests.claim(p_token integer,p_ops text[]) returns text language sql as $$select tests.call(0,format('select public.admin_upload_r2_worker_claim(%L,%L::text[])->>''operation''','00000000-0000-4000-8000-'||lpad(p_token::text,12,'0'),p_ops))$$;
create function tests.finish(p_token integer,p_op text,p_result jsonb) returns text language sql as $$select tests.call(0,format('select public.admin_upload_r2_worker_finish(%L,%L,%L,%L::jsonb)',tests.id(),'00000000-0000-4000-8000-'||lpad(p_token::text,12,'0'),p_op,p_result))$$;
create function tests.ingest(p_token integer,p_fn text,p_args jsonb) returns text language sql as $$select tests.call(0,format('select public.admin_upload_r2_worker_ingest(%L,%L,%L,%L::jsonb)::text',tests.id(),'00000000-0000-4000-8000-'||lpad(p_token::text,12,'0'),p_fn,p_args))$$;


create function tests.assessment(p_container text, p_ok boolean default true, p_tail boolean default false)
returns jsonb language sql as $$
 select jsonb_build_object('accepted',p_ok,'container',p_container,
  'reasons',case when p_ok then '[]'::jsonb else '["audio_metadata_incomplete"]'::jsonb end,
  'warnings',case when p_container='mkv' then '["firefox_mkv_streaming_unreliable"]'::jsonb
    when p_tail then '["mp4_startup_tail_required"]'::jsonb else '[]'::jsonb end,
  'integrity',case when p_ok then 'metadata_consistent' else 'incomplete' end,
  'streaming',case when not p_ok then 'unverified' when p_tail then 'potentially_playable_startup_warning' else 'potentially_playable' end,
  'download','not_implemented_authorization_required',
  'compatibility',jsonb_build_object('basis','tested_fixture_combinations','perFile','prediction',
    'evidence','docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
    'chromium','tested_combination','firefox',case when p_container='mkv' then 'streaming_unreliable' else 'tested_combination' end,
    'safari','real_device_not_tested','ios','real_device_not_tested','android','real_device_not_tested'),
  'tracks','[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"language":"eng","defaultTrack":true,"forced":false,"attachedPicture":false}]'::jsonb)
$$;

create function tests.inspection(p_container text,p_ok boolean default true,p_tail boolean default false)
returns jsonb language sql as $$select jsonb_build_object('choices','[]'::jsonb,'evaluation',jsonb_build_object('p_candidates','[]'::jsonb),
 'classification',jsonb_build_object('class',case when p_ok then 'original' else 'manual_review' end,'policyVersion',3,'reasons',tests.assessment(p_container,p_ok,p_tail)->'reasons'),
 'assessment',tests.assessment(p_container,p_ok,p_tail),'decoded',true)$$;

select is(tests.call(8401,$$select public.admin_upload_create('bad.avi',100)::text$$),'upload_invalid_file','only MP4/MKV accepted by authoritative create');
select is(tests.call(8401,$$select public.admin_upload_create('../bad.mkv',100)::text$$),'upload_invalid_file','traversal checks retained');
select is(tests.call(8401,$$select public.admin_upload_create('bad.mp4',2000000001)::text$$),'upload_invalid_file','size ceiling retained');
select is(tests.call(8403,$$select public.admin_upload_create('movie.mp4',100)::text$$),'review_not_authorized','authentication and admin checks retained');
select is(tests.call(8401,$$select public.admin_upload_r2_create('Original.Movie.MKV',100,'00000000-0000-4000-8000-000000008410')->>'file_name'$$),
 'Original.Movie.MKV','exact original basename/case preserved');
-- Trusted fixture has completed byte/hash verification; no provider or media call.
update private.admin_upload_sessions set stage='uploaded',bytes_received=100,verified_sha256=repeat('a',64),
 verified_file_key='00000000-0000-4000-8000-000000008499',source_fingerprint='sf1-'||repeat('b',64) where id=tests.id();
select is(tests.claim(8420,array['inspect']),'inspect','existing fenced worker claims original MKV');
select is(tests.finish(8420,'inspect',jsonb_build_object('outcome','inspected','inspection',tests.inspection('mkv'))),'metadata_review','policy 3 MKV persists through R2 completion');
select is((select container||':'||video_codec||':'||audio_codec||':'||integrity_status||':'||streaming_status from private.admin_upload_media_evidence),
 'mkv:h264:aac:metadata_consistent:potentially_playable','container/codecs and distinct statuses stored');
select is((select tracks->1->>'language' from private.admin_upload_media_evidence),'eng','audio track language retained');
select is(tests.call(8401,format('select public.admin_upload_get(%L)->''inspection''->''assessment''->''compatibility''->>''firefox''',tests.id())),
 'streaming_unreliable','owner readback preserves tested/predicted compatibility');
select ok(not private.admin_upload_media_publishable(tests.id()),'decoded flag cannot promote bounded policy 3 assessment');
select ok(not private.admin_upload_r2_eligible(tests.id()),'browser fixture predictions cannot authorize transfer/publication');
select is(tests.review('submit'),'upload_review_blocked','potentially playable media cannot submit as verified');
select is(tests.claim(8421,array['telegram','publish']),'null','no transfer/publication claim for incomplete proof');
select is(tests.call(8402,format('select public.admin_upload_get(%L)::text',tests.id())),'upload_not_found','owner boundary remains enforced');
select throws_ok('update private.admin_upload_media_evidence set container=''mp4''','P0001','audit_append_only','inspection snapshot cannot change');
select throws_ok('delete from private.admin_upload_media_evidence','P0001','audit_append_only','inspection snapshot cannot be removed');
update private.admin_upload_sessions set stage='uploaded' where id=tests.id();
select is(tests.claim(8422,array['inspect']),'inspect','new synthetic inspection gets a new fenced attempt');
select is(tests.finish(8422,'inspect','{"outcome":"failed","code":"probe_timeout"}'),'failed','failed inspection recorded');
select is((select count(*)::integer from private.admin_upload_media_evidence),2,'successful and failed history retained');
select is((select error_code from private.admin_upload_media_evidence order by id desc limit 1),'probe_timeout','failure reason persists with provenance');
select is((select count(*)::integer from private.admin_upload_attempts where operation='inspect' and outcome='failed'),1,'historical failure attempts remain');
update private.admin_upload_r2 set next_attempt_at=now() where upload_id=tests.id();
update private.admin_upload_sessions set stage='uploaded' where id=tests.id();
select is(tests.claim(8423,array['inspect']),'inspect','original inspection can retry without editing old evidence');
select is(tests.finish(8423,'inspect',jsonb_build_object('outcome','inspected','inspection',tests.inspection('mp4',true,true))),
 'upload_invalid_result','filename and original container cannot silently disagree');
select is(tests.finish(8423,'inspect',jsonb_build_object('outcome','inspected','inspection',tests.inspection('mkv'))),
 'metadata_review','correct original persists on same still-fenced attempt');
select is((select count(*)::integer from private.admin_upload_media_evidence),3,'retry appends rather than overwrites');
select is((select count(*)::integer from private.admin_upload_media_evidence where error_code='probe_timeout'),1,'retry never rewrites failure into success');

-- Disk completion reuses the same storage validator and immutable history.
select is(tests.call(8401,$$select public.admin_upload_create('Tail.Original.mp4',100)->>'file_name'$$),'Tail.Original.mp4','disk original filename retained');
create function tests.disk_id() returns uuid language sql as $$select id from private.admin_upload_sessions where file_name='Tail.Original.mp4'$$;
update private.admin_upload_sessions set stage='inspecting',bytes_received=100,verified_sha256=repeat('c',64),verified_file_key='00000000-0000-4000-8000-000000008488',
 lease_token='00000000-0000-4000-8000-000000008487',lease_until=now()+interval '1 minute' where id=tests.disk_id();
select is(tests.call(0,format('select public.admin_upload_worker_finish(%L,''00000000-0000-4000-8000-000000008487'',%L::jsonb)',
 tests.disk_id(),jsonb_build_object('outcome','inspected','inspection',tests.inspection('mp4',true,true)))), 'metadata_review','disk worker persists tail-index MP4');
select is((select streaming_status from private.admin_upload_media_evidence where upload_id=tests.disk_id()),'potentially_playable_startup_warning','tail startup warning is not corruption');
select ok(not private.admin_upload_media_publishable(tests.disk_id()),'non-fast-start MP4 still needs verified integrity AND streaming');

select is((select count(*)::integer from pg_class where oid='private.admin_upload_media_evidence'::regclass and relrowsecurity),1,'new private evidence RLS enabled');
select is((select count(*)::integer from unnest(array['anon','authenticated','service_role','velora_upload_worker','velora_discovery_worker','velora_review_service','velora_media_gateway']) r
 where has_table_privilege(r,'private.admin_upload_media_evidence','SELECT,INSERT,UPDATE,DELETE')),0,'no role gains direct evidence access');
select is((select count(*)::integer from unnest(array['anon','authenticated','service_role','velora_upload_worker','velora_discovery_worker','velora_review_service','velora_media_gateway']) r
 where has_function_privilege(r,'private.admin_upload_record_inspection(uuid,uuid,jsonb,text)','EXECUTE')),0,'new persistence helper remains owner-only');
select ok(not has_sequence_privilege('authenticated','private.admin_upload_media_evidence_id_seq','USAGE,SELECT,UPDATE'),'identity sequence not exposed');
select ok(not has_function_privilege('anon','public.admin_upload_create(text,bigint)','EXECUTE'),'unauthenticated cannot create');
select ok(not has_function_privilege('authenticated','public.admin_upload_r2_worker_finish(uuid,uuid,text,jsonb)','EXECUTE'),'client cannot fabricate worker evidence');
select ok(not has_function_privilege('velora_upload_worker','catalogue_review.publish_channel_candidate(text,integer,uuid)','EXECUTE'),'upload worker gains no channel publication privilege');
select is(tests.review('clear_rights','fixture-contract',now()+interval '1 month'),'upload_illegal_transition','media inspection alone grants no rights transition');

select * from finish();
rollback;
