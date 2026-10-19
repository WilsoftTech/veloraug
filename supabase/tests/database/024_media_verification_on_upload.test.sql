-- Media-only queue: raw uploads are checked before identity review, without
-- changing the catalogue or reviewer decisions. Synthetic documents only.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
create schema tests;

create function tests.media(p_message integer,p_name text,p_size bigint default 1000,p_chat bigint default -1001111111111)
returns bigint language sql as $$
  insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,file_name,mime_type,file_size_bytes,telegram_date)
  values('movie',p_chat,p_message,'synthetic-'||p_message,'AgADupload'||p_message,'document',p_name,
    case when p_name like '%.mkv' then 'video/x-matroska' else 'video/mp4' end,p_size,now()) returning id
$$;
create function tests.evidence(p_id bigint,p_container text default 'mp4',p_fail boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object('identity',private.channel_media_identity(m.chat_id,m.message_id,m.file_unique_id,m.file_size_bytes),
    'method','full_original_v1','inspection_scope','whole_file','policy_version',3,
    'media_class',case when p_fail then 'unverified' else 'original' end,
    'reasons',case when p_fail then '["decode_error_at_end"]'::jsonb else '[]'::jsonb end,
    'container',p_container,'video_codec','h264','audio_codec','aac',
    'accessible',true,'gateway_compatible',true,'playback_ready',false,'bytes_read',1100,
    'assessment',jsonb_build_object('accepted',not p_fail,'container',p_container,
      'integrity',case when p_fail then 'incomplete' else 'verified' end,
      'streaming',case when p_fail then 'unverified' else 'verified' end,'download','original_servable',
      'reasons',case when p_fail then '["decode_error_at_end"]'::jsonb else '[]'::jsonb end,'warnings','[]'::jsonb,
      'compatibility',jsonb_build_object('basis','tested_fixture_combinations','perFile','prediction',
        'evidence','docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
        'chromium','tested_combination','firefox',case when p_container='mkv' then 'streaming_unreliable' else 'tested_combination' end,
        'safari','real_device_not_tested','ios','real_device_not_tested','android','real_device_not_tested'),
      'tracks','[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"attachedPicture":false}]'::jsonb,
      'verification',jsonb_build_object('contract',1,'digest',jsonb_build_object('algorithm','sha256','value',repeat('a',64),'bytes',1000),
        'integrity',jsonb_build_object('status',case when p_fail then 'failed' else 'verified' end,'method','whole_file_decode_v1',
          'duration_seconds',5400,'decoded_seconds',5400,'reasons',case when p_fail then '["decode_error_at_end"]'::jsonb else '[]'::jsonb end),
        'streaming',jsonb_build_object('status',case when p_fail then 'not_attempted' else 'verified' end,'method','sampled_seek_decode_v1',
          'layout',case when p_fail then null when p_container='mkv' then 'matroska' else 'mp4_head_index' end,
          'reasons','[]'::jsonb,'samples',case when p_fail then '[]'::jsonb else '[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":2700,"decoded":true},{"position":"end","seconds":4860,"decoded":true}]'::jsonb end),
        'download',jsonb_build_object('status','original_servable','reasons','[]'::jsonb),
        'tools',jsonb_build_object('ffmpeg','9.0.2','ffprobe','9.0.2'),
        'started_at','2026-10-18T07:00:00.000Z','finished_at','2026-10-18T07:10:00.000Z')))
  from private.telegram_media m where m.id=p_id
$$;
create function tests.finish(p_claim jsonb,p_evidence jsonb,p_error text default null) returns text language sql as $$
  select public.media_verification_finish((p_claim->>'media_id')::bigint,(p_claim->>'lease')::uuid,p_claim->>'identity',p_evidence,p_error)
$$;
create temp table claims(label text primary key,value jsonb);
create temp table media(label text primary key,id bigint);
insert into private.telegram_channels(bot_type,chat_id) values('movie',-1001111111111);

-- Client isolation and explicit privileges, including the new table.
select ok(has_function_privilege('velora_discovery_worker','public.media_verification_claim(uuid,integer,integer)','execute'),'worker may claim');
select ok(has_function_privilege('velora_discovery_worker','public.media_verification_finish(bigint,uuid,text,jsonb,text)','execute'),'worker may finish');
select ok(not has_function_privilege(r,'public.media_verification_claim(uuid,integer,integer)','execute'),r||' may not claim')
  from unnest(array['anon','authenticated','service_role','velora_upload_worker','velora_review_service','velora_media_gateway']) r where to_regrole(r) is not null;
select ok(not has_function_privilege(r,'public.media_verification_finish(bigint,uuid,text,jsonb,text)','execute'),r||' may not finish')
  from unnest(array['anon','authenticated','service_role','velora_upload_worker','velora_review_service','velora_media_gateway']) r where to_regrole(r) is not null;
select ok(not has_table_privilege(r,'private.media_verification_jobs','select,insert,update,delete'),r||' has no job table access')
  from unnest(array['anon','authenticated','service_role','velora_discovery_worker']) r;
select ok((select relrowsecurity from pg_class where oid='private.media_verification_jobs'::regclass),'jobs use RLS');
select ok((select bool_and(prosecdef and proconfig=array['search_path=""']) from pg_proc where oid in
  ('public.media_verification_claim(uuid,integer,integer)'::regprocedure,'public.media_verification_finish(bigint,uuid,text,jsonb,text)'::regprocedure)),'definers pin search_path');
select throws_ok($$select public.media_verification_claim(null,600,60)$$,'22023','media_verification_invalid_input','token required');
select throws_ok($$select public.media_verification_claim(gen_random_uuid(),14401,60)$$,'22023','media_verification_invalid_input','lease bounded');
select throws_ok($$select public.media_verification_claim(gen_random_uuid(),600,0)$$,'22023','media_verification_invalid_input','retry bounded');

insert into media values('mp4',tests.media(1,'Unconfirmed.mp4')),
  ('mkv',tests.media(2,'Unknown.mkv')),('large',tests.media(3,'TooLarge.mp4',2097152001)),
  ('other',tests.media(4,'NotMovie.txt')),('unregistered',tests.media(5,'Elsewhere.mp4',1000,-1002222222222));
insert into claims values('mp4',public.media_verification_claim('00000000-0000-4000-8000-000000000001',600,60));
select is((select (value->>'media_id')::bigint from claims where label='mp4'),(select id from media where label='mp4'),'unconfirmed upload is eligible immediately');
insert into claims values('mkv',public.media_verification_claim('00000000-0000-4000-8000-000000000002',600,60));
select is((select (value->>'media_id')::bigint from claims where label='mkv'),(select id from media where label='mkv'),'another worker skips the leased MP4 and claims MKV');
select is(public.media_verification_claim(gen_random_uuid(),600,60),null::jsonb,'leased, oversized, nonvideo and unregistered media are skipped');
select is(public.media_verification_finish((select id from media where label='mp4'),gen_random_uuid(),(select value->>'identity' from claims where label='mp4'),
  tests.evidence((select id from media where label='mp4')),null),'stale','wrong lease cannot record evidence');
select throws_ok($$select tests.finish((select value from claims where label='mp4'),
  jsonb_set(tests.evidence((select id from media where label='mp4')),'{assessment,verification,digest,bytes}','999'))$$,
  '22023','media_verification_size_mismatch','digest byte count must match the source');
select throws_ok($$select tests.finish((select value from claims where label='mp4'),
  tests.evidence((select id from media where label='mp4'))||'{"playback_ready":true}')$$,
  '22023','media_verification_invalid_evidence','cannot assert browser playback');
select throws_ok($$select tests.finish((select value from claims where label='mp4'),
  jsonb_set(tests.evidence((select id from media where label='mp4')),'{assessment,verification,integrity,reasons}','["decode_error_at_end"]'))$$,
  '22023','media_verification_invalid_evidence','an end-of-file error cannot accompany a pass');

select is(tests.finish((select value from claims where label='mp4'),tests.evidence((select id from media where label='mp4'))),'recorded','clean full MP4 decode recorded');
select is(tests.finish((select value from claims where label='mkv'),tests.evidence((select id from media where label='mkv'),'mkv',true)),'recorded','failed full MKV decode is recorded honestly');
select is((select integrity_status from private.media_evidence where telegram_media_id=(select id from media where label='mp4')),'verified','MP4 integrity verified');
select is((select integrity_status from private.media_evidence where telegram_media_id=(select id from media where label='mkv')),'incomplete','error at end does not pass MKV integrity');
select is(public.media_verification_claim(gen_random_uuid(),600,60),null::jsonb,'completed passes and failures are not downloaded again');
select is(tests.finish((select value from claims where label='mp4'),tests.evidence((select id from media where label='mp4'))),'stale','duplicate completion is fenced');
select is((select count(*)::int from private.media_evidence),2,'no duplicate evidence');

-- A new upload is found on the next poll, and transient failures use bounded retries.
insert into media values('new',tests.media(6,'NewUpload.mp4'));
insert into claims values('new',public.media_verification_claim(gen_random_uuid(),600,60));
select is((select (value->>'media_id')::bigint from claims where label='new'),(select id from media where label='new'),'new upload is automatically found after idle');
select is(tests.finish((select value from claims where label='new'),null,'media_read_flood_wait'),'retry','reader outage is retryable without evidence');
select is(public.media_verification_claim(gen_random_uuid(),600,60),null::jsonb,'retry waits instead of spinning');
update private.media_verification_jobs set retry_at=now()-interval '1 second' where telegram_media_id=(select id from media where label='new');
update claims set value=public.media_verification_claim(gen_random_uuid(),600,60) where label='new';
select is((select attempts from private.media_verification_jobs where telegram_media_id=(select id from media where label='new')),2,'retry attempt is counted');
update private.media_verification_jobs set lease_until=now()-interval '1 second',retry_at=now()-interval '1 second'
  where telegram_media_id=(select id from media where label='new');
insert into claims values('reclaimed',public.media_verification_claim(gen_random_uuid(),600,60));
select is(tests.finish((select value from claims where label='new'),null,'media_read_flood_wait'),'stale','expired lease cannot finish after reclaim');
select is(tests.finish((select value from claims where label='reclaimed'),null,'media_read_flood_wait'),'retry','reclaimed lease may finish');
update private.media_verification_jobs set attempts=5,retry_at=now()-interval '1 second' where telegram_media_id=(select id from media where label='new');
select is(public.media_verification_claim(gen_random_uuid(),600,60),null::jsonb,'five transient failures stop automatic retry');

-- No review or publication data was invented to get media verification done.
select is((select count(*)::int from private.channel_reviews),0,'no identity was invented or confirmed');
select is((select count(*)::int from private.rights_clearances),0,'no rights clearance');
select is((select count(*)::int from public.movies),0,'no catalogue write');
select is((select count(*)::int from public.movie_versions),0,'no publication');

-- Published uploader media are also inspected, without changing publication.
insert into media values('published',tests.media(7,'AlreadyPublished.mp4'));
insert into public.vjs(slug,name) values('vj-upload-check','VJ Upload Check');
insert into public.movies(slug,title,publication_status,published_at) values('already-published','Already Published','published',now());
insert into public.movie_versions(movie_id,vj_id,telegram_media_id,availability_status,rights_status,available_at)
  select m.id,v.id,t.id,'ready','cleared',now() from public.movies m,public.vjs v,media t
  where m.slug='already-published' and v.slug='vj-upload-check' and t.label='published';
insert into claims values('published',public.media_verification_claim(gen_random_uuid(),600,60));
select is((select (value->>'media_id')::bigint from claims where label='published'),(select id from media where label='published'),'published file joins the backlog');
select is(tests.finish((select value from claims where label='published'),tests.evidence((select id from media where label='published'))),'recorded','published file is checked');
select is((select publication_status from public.movies where slug='already-published'),'published','publication status untouched');
select is((select rights_status from public.movie_versions where telegram_media_id=(select id from media where label='published')),'cleared','rights status untouched');

-- A replacement document cannot receive the previous document's evidence.
insert into media values('edited',tests.media(8,'Edited.mkv'));
insert into claims values('edited',public.media_verification_claim(gen_random_uuid(),600,60));
update private.telegram_media set file_unique_id='AgADreplacement' where id=(select id from media where label='edited');
select is(tests.finish((select value from claims where label='edited'),null,'media_read_flood_wait'),'stale','source replacement fences old completion');
update private.media_verification_jobs set lease_until=now()-interval '1 second' where telegram_media_id=(select id from media where label='edited');
insert into claims values('replacement',public.media_verification_claim(gen_random_uuid(),600,60));
select isnt((select value->>'identity' from claims where label='replacement'),(select value->>'identity' from claims where label='edited'),'new document receives its own identity');
select is((select attempts from private.media_verification_jobs where telegram_media_id=(select id from media where label='edited')),1,'replacement resets attempts');
select is(tests.finish((select value from claims where label='replacement'),tests.evidence((select id from media where label='edited'),'mkv')),'recorded','replacement can complete under its own lease');

-- Media-only checks preserve review identity and decisions and fence named checks.
insert into media values('reviewed',tests.media(9,'Reviewed.mp4'));
insert into private.ingestion_events(bot_type,origin,telegram_media_id,status)
  select 'movie','channel',id,'needs_review' from media where label='reviewed';
insert into private.channel_reviews(ingestion_event_id,discovery_key,event_id,payload_digest,observed_at,title,identity_state,tmdb_id,vj_id)
  select e.id,repeat('c',64),repeat('d',64),repeat('e',64),1760000000,'Reviewed Movie','confirmed',9990001,v.id
  from private.ingestion_events e join media m on m.id=e.telegram_media_id,public.vjs v where m.label='reviewed' and v.slug='vj-upload-check';
insert into private.metadata_match_candidates(ingestion_event_id,tmdb_media_type,tmdb_id,score,snapshot)
  select r.ingestion_event_id,'movie',r.tmdb_id,1,'{}'::jsonb from private.channel_reviews r where r.discovery_key=repeat('c',64);
create temp table review_before as select to_jsonb(r) as data from private.channel_reviews r where r.discovery_key=repeat('c',64);
insert into claims values('reviewed',public.media_verification_claim(gen_random_uuid(),600,60));
select throws_ok($$select public.discovery_claim_verification(repeat('c',64),600)$$,'P0001','discovery_verification_not_claimable','named verifier respects an active media-only lease');
select is(tests.finish((select value from claims where label='reviewed'),tests.evidence((select id from media where label='reviewed'))),'recorded','reviewed media verification completed');
select is((select to_jsonb(r) from private.channel_reviews r where r.discovery_key=repeat('c',64)),(select data from review_before),'review identity, revision, approval and publication are untouched');
-- A named verification holding the candidate prevents a second automatic read.
select lives_ok($$select public.discovery_claim_verification(repeat('c',64),600)$$,'named check retains its identity prerequisite and can run after the media job');
update private.media_verification_jobs set completed_at=null,attempts=1,retry_at=now()-interval '1 second' where telegram_media_id=(select id from media where label='reviewed');
insert into private.channel_review_audit(ingestion_event_id,review_revision,actor_kind,actor,action,created_at)
  select ingestion_event_id,review_revision,'reviewer','00000000-0000-4000-8000-000000000099','reinspection_requested',clock_timestamp()
  from private.channel_reviews where discovery_key=repeat('c',64);
select is(public.media_verification_claim(gen_random_uuid(),600,60),null::jsonb,'automatic queue does not interfere with an active named verifier');
select * from finish();
rollback;
