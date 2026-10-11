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

select is((select count(*)::int from pg_class where oid in ('private.admin_upload_r2'::regclass,'private.admin_upload_r2_parts'::regclass) and relrowsecurity),2,'R2 tables are protected by RLS');
select is((select count(*)::int from pg_class c cross join unnest(array['anon','authenticated','service_role','velora_upload_worker','velora_discovery_worker']) r where c.oid in ('private.admin_upload_r2'::regclass,'private.admin_upload_r2_parts'::regclass) and has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE')),0,'no direct R2 table access');
select ok(not has_function_privilege('authenticated','public.admin_upload_r2_worker_finish(uuid,uuid,text,jsonb)','EXECUTE'),'browser cannot finish worker jobs');
select ok(not has_function_privilege('velora_upload_worker','public.ingest_upload_record(text,text,bigint,bigint,text,text,text,text,text,text,bigint,integer,integer,integer,timestamptz)','EXECUTE'),'worker cannot invoke unscoped Telegram recording');
select is(tests.call(8403,$$select public.admin_upload_r2_create('movie.mp4',3,'00000000-0000-4000-8000-000000008410')::text$$),'review_not_authorized','non-admin cannot create');
select is(tests.call(8401,$$select public.admin_upload_r2_create('movie.mp4',2000000001,'00000000-0000-4000-8000-000000008410')::text$$),'upload_invalid_file','decimal maximum is enforced');
select is(tests.call(8401,$$select public.admin_upload_r2_create('movie.exe',3,'00000000-0000-4000-8000-000000008410')::text$$),'upload_invalid_file','unsupported container is rejected');
select is(tests.call(8401,$$select public.admin_upload_r2_create('movie.mp4',3,'00000000-0000-4000-8000-000000008410')->>'storage'$$),'r2','admin can create R2 session');
select is(tests.call(8401,$$select public.admin_upload_r2_create('movie.mp4',3,'00000000-0000-4000-8000-000000008410')->>'id'$$),tests.id()::text,'duplicate create request returns same session');
select is((select count(*)::int from private.admin_upload_r2),1,'duplicate request cannot create another object');
select is(tests.call(8401,$$select public.admin_upload_r2_create('other.mp4',3,'00000000-0000-4000-8000-000000008410')::text$$),'upload_request_conflict','request identity cannot change');
select is(tests.call(8402,format('select public.admin_upload_r2_command(%L,''state'',''{}'')::text',tests.id())),'upload_not_found','cross-owner controls are refused');
select is(tests.command('begin','{"token":"00000000-0000-4000-8000-000000008411"}'),'pending','multipart initialization is durably leased');
select is(tests.command('begin','{"token":"00000000-0000-4000-8000-000000008412"}'),'r2_initialization_busy','parallel initialization cannot create a duplicate');
select is(tests.command('attach','{"token":"00000000-0000-4000-8000-000000008412","upload_id":"fake-mpu"}'),'r2_initialization_lost','foreign initialization token refused');
select is(tests.command('attach','{"token":"00000000-0000-4000-8000-000000008411","upload_id":"fake-mpu"}'),'open','multipart identity persists');
select is(tests.command('reserve_part',jsonb_build_object('number',2,'sha256',repeat('a',64))),'r2_part_invalid','out of range part refused');
select is(tests.command('reserve_part',jsonb_build_object('number',1,'sha256',repeat('a',64))),'open','part source hash reserved');
select is(tests.command('reserve_part',jsonb_build_object('number',1,'sha256',repeat('b',64))),'r2_source_changed','part source identity is immutable');
select is(tests.command('reserve_part',jsonb_build_object('number',1,'sha256',repeat('a',64))),'r2_signing_rate_limited','signing is rate limited');
select is(tests.command('observe','{"parts":[{"number":1,"size":2,"etag":"opaque"}]}'),'r2_parts_invalid','wrong provider part size refused');
select is(tests.command('complete_requested'),'r2_upload_incomplete','incomplete upload cannot complete');
select is(tests.command('observe','{"parts":[{"number":1,"size":3,"etag":"opaque"}]}'),'open','provider part progress persists');
select is((select bytes_received::int from private.admin_upload_sessions where id=tests.id()),3,'committed byte count is durable');
select is(tests.command('complete_requested'),'completing','uncertain completion is recoverable');
select is(tests.command('completed','{"etag":"opaque-final"}'),'complete','completion queues independent verification');
select is(tests.command('state'),'complete','completed state survives reconnect');
select is(tests.call(0,format('select public.admin_upload_r2_housekeeping(''object_tracked'',%L::jsonb)::text',jsonb_build_object('key',(select object_key from private.admin_upload_r2 where upload_id=tests.id()),'size',3))),'true','inventory recognizes retained declared object');
select is(tests.call(0,format('select public.admin_upload_r2_housekeeping(''object_tracked'',%L::jsonb)::text',jsonb_build_object('key',(select object_key from private.admin_upload_r2 where upload_id=tests.id()),'size',4))),'false','unexpected object size requires review');
select is(tests.call(0,$$select public.admin_upload_r2_housekeeping('object_tracked','{"key":"unknown","size":3}')::text$$),'false','unrecognized completed objects require review');
select is((select verified_sha256 from private.admin_upload_sessions where id=tests.id()),null,'browser completion cannot establish verified SHA');
select is(tests.call(0,$$select public.admin_upload_worker_claim('00000000-0000-4000-8000-000000008420')->>'operation'$$),'null','legacy disk worker never claims R2 sessions');
select is(tests.claim(8420,array['verify']),'verify','R2 verification worker claims');
select is(tests.claim(8421,array['verify']),'null','concurrent worker cannot claim live lease');
select is(tests.finish(8421,'verify','{"outcome":"verified"}'),'upload_lease_lost','foreign completion token refused');
select is(tests.finish(8420,'verify','{"outcome":"verified"}'),'upload_invalid_result','missing integrity evidence refused');
update private.admin_upload_sessions set lease_until=now()-interval '1 second' where id=tests.id();
select is(tests.claim(8421,array['verify']),'verify','application restart reclaims expired lease');
select is(tests.finish(8420,'verify','{"outcome":"failed","code":"unexpected_error"}'),'upload_lease_lost','old worker cannot overwrite new claim');
select is(tests.finish(8421,'verify',jsonb_build_object('outcome','verified','sha256',repeat('c',64),'fingerprint','sf1-'||repeat('d',64),'size',3,'file_key','00000000-0000-4000-8000-000000008430')),'uploaded','worker integrity result is durable');
select is(tests.claim(8422,array['inspect']),'inspect','media inspection is independent');
select is(tests.finish(8422,'inspect','{"outcome":"failed","code":"upload_media_corrupt"}'),'failed','corrupted media remains blocked');
select is(tests.review('retry'),'upload_illegal_transition','corruption is not automatically retryable');
select is(tests.claim(8423,array['telegram','publish']),'null','unverified media cannot transfer or publish');
-- Trusted inspection fixture, with exact match and full decode evidence.
insert into public.vjs(slug,name,is_active) values('r2-test-vj','R2 Test VJ',true);
create function tests.snapshot() returns jsonb language sql as $$select '{"tmdb_id":98401,"title":"R2 Test Movie","original_title":null,"overview":"Test","release_date":"2026-01-01","runtime_minutes":90,"poster_path":null,"backdrop_path":null,"vote_average":6,"vote_count":10,"genres":[]}'::jsonb$$;
update private.admin_upload_sessions set stage='metadata_review',error_code=null,metadata=jsonb_build_object('kind','movie','title','R2 Test Movie','year',2026,'vjId',(select id from public.vjs where slug='r2-test-vj'),'snapshot',tests.snapshot(),'season',null,'episode',null,'provenance','Contract source'),
 inspection=jsonb_build_object('choices',jsonb_build_array(tests.snapshot()),'proposed_tmdb_id',98401,'classification',jsonb_build_object('class','canonical','policyVersion',2,'reasons','[]'::jsonb),'decoded',true,
 'query',jsonb_build_object('title','R2 Test Movie','year',2026),'evaluation',jsonb_build_object('p_parsed',jsonb_build_object('kind','movie','kind_status','confirmed','title','R2 Test Movie','year',2026,'vj_text',null,'vj_status','resolved','vj_id',(select id from public.vjs where slug='r2-test-vj'),'season',null,'episode',null),
 'p_candidates',jsonb_build_array(jsonb_build_object('tmdb_id',98401,'media_type','movie','score',1,'title_match','exact','title_field','title','year_match','match','title','R2 Test Movie','year',2026)))) where id=tests.id();
select is(tests.review('submit'),'awaiting_rights','verified metadata enters rights review');
select is(tests.review('clear_rights','contract-001',now()+interval '1 month'),'review_not_authorized','review capability cannot grant rights');
update private.catalogue_reviewers set can_clear_rights=true where user_id='00000000-0000-4000-8000-000000008401';
select is(tests.review('clear_rights','contract-001',now()-interval '1 second'),'upload_rights_invalid','expired rights attestation rejected');
select is(tests.review('clear_rights','contract-001',now()+interval '1 month'),'awaiting_approval','rights are tied to current bytes and revision');
select is(tests.review('approve'),'review_not_authorized','publisher capability is independently required');
update private.catalogue_reviewers set can_publish=true where user_id='00000000-0000-4000-8000-000000008401';
update private.admin_upload_sessions set rights_expires_at=now()-interval '1 second' where id=tests.id();
select is(tests.review('approve'),'upload_rights_required','expired clearance blocks approval');
select is(tests.review('clear_rights','contract-001',now()+interval '1 month'),'awaiting_approval','renewed clearance can proceed');
select is(tests.review('approve'),'approved','authorized reviewer approves transfer and publication');
select is(tests.claim(8424,array['publish']),'null','approval cannot publish before Telegram storage');
select is(tests.claim(8424,array['telegram']),'telegram','approved media transfer claimed');
insert into private.telegram_channels(bot_type,chat_id,checkpoint_message_id) values('movie',-1001111111111,10);
select is(tests.ingest(8424,'ingest_upload_status',jsonb_build_object('p_source_fingerprint','sf1-'||repeat('e',64),'p_bot_type','movie')),'ingest_identity_mismatch','worker cannot access another fingerprint');
select is(tests.ingest(8424,'ingest_record_evaluation',jsonb_build_object('p_source_fingerprint','sf1-'||repeat('d',64),'p_bot_type','movie')),'upload_invalid_input','bridge rejects unrelated worker commands');
select matches(tests.ingest(8424,'ingest_upload_start',jsonb_build_object('p_source_fingerprint','sf1-'||repeat('d',64),'p_bot_type','movie','p_chat_id',-1001111111111)),'uploading','existing durable uploader start reused');
select is(tests.finish(8424,'telegram','{"outcome":"failed","code":"telegram_outcome_uncertain"}'),'telegram_uncertain','Telegram outage is uncertain, never blindly re-sent');
select is(tests.call(8401,format('select public.admin_upload_control(%L,%s,''cancel'')::text',tests.id(),(select revision from private.admin_upload_sessions where id=tests.id()))),'upload_reconciliation_required','uncertain transfer cannot be cancelled');
update private.admin_upload_r2 set next_attempt_at=now() where upload_id=tests.id();
select is(tests.claim(8425,array['recover']),'recover','restart claims reconciliation rather than a new send');
select is(tests.finish(8425,'recover','{"outcome":"stored"}'),'upload_storage_not_persisted','Telegram success without durable DB receipt cannot release staging');
select is(tests.ingest(8425,'ingest_upload_record',jsonb_build_object('p_source_fingerprint','sf1-'||repeat('d',64),'p_bot_type','movie','p_file_size_bytes',4)),'ingest_identity_mismatch','wrong receipt size refused');
select is(tests.ingest(8425,'ingest_upload_record',jsonb_build_object('p_source_fingerprint','sf1-'||repeat('d',64),'p_bot_type','movie','p_chat_id',-1001111111111,'p_message_id',11,'p_file_id','r2-test-file','p_file_unique_id','r2-test-unique','p_media_kind','document','p_file_name','movie.mp4','p_mime_type','video/mp4','p_caption','R2 Test Movie'||chr(10)||'velora-src:sf1-'||repeat('d',64),'p_file_size_bytes',3,'p_telegram_date',now())),'"recorded"','recovered Telegram receipt is durably recorded');
select is(tests.finish(8425,'recover','{"outcome":"stored"}'),'telegram_stored','recorded receipt advances storage lifecycle');
select is(tests.claim(8426,array['publish']),'publish','publication claimed only after storage');
select is(tests.review('revoke_rights'),'publishing','rights can be revoked during an active publication lease');
select is(tests.finish(8426,'publish','{"outcome":"publish"}'),'upload_approval_required','publication rechecks revoked rights at commit');
select is(tests.finish(8426,'publish','{"outcome":"failed","code":"upload_approval_required"}'),'failed','blocked publication keeps durable storage');
select is(tests.review('clear_rights','contract-renewed',now()+interval '1 month'),'telegram_stored','stored media can renew rights without retransmission');
update private.admin_upload_r2 set next_attempt_at=now() where upload_id=tests.id();
select is(tests.claim(8427,array['publish']),'publish','renewed rights allow existing publication lifecycle');
select is(tests.finish(8427,'publish','{"outcome":"publish"}'),'published','existing catalogue materializer publishes verified stored movie');
-- Safe additive facts, using a synthetic legacy snapshot. No private upload
-- reference or new full-file verification claim reaches the public profile.
insert into private.admin_upload_media_evidence(upload_id,lease_token,verified_sha256,file_key,size_bytes,inspection,policy_version)
select id,'00000000-0000-4000-8000-000000008499',verified_sha256,verified_file_key,size_bytes,inspection,2
from private.admin_upload_sessions where id=tests.id();
update private.admin_upload_sessions set media_evidence_id=(select id from private.admin_upload_media_evidence where upload_id=tests.id() order by id desc limit 1) where id=tests.id();
select is((select public.movie_media_profile(mv.id)->>'integrity_status' from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=98401),
 'legacy_unassessed','public profile does not reinterpret legacy verification');
select ok((select public.movie_media_profile(mv.id) is not null and not (public.movie_media_profile(mv.id) ?| array['identity','chat_id','message_id','file_key','verified_sha256','rights_reference','owner_id','tracks','inspection'])
 from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=98401),'public profile excludes private provenance and raw track titles');
select is((select count(*)::int from media_gateway.resolve_movie_version((select mv.id from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=98401))),1,'published legacy MP4 resolver unchanged');
select is((select count(*)::int from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=98401),1,'exactly one catalogue version created');
select ok(catalogue_access.admin_upload_rights_valid((select telegram_media_id from private.ingestion_events where id=(select ingestion_event_id from private.admin_upload_sessions where id=tests.id()))),'published attestation is valid');
select is(tests.review('revoke_rights'),'published','published rights can be revoked');
select is((select public.movie_media_profile(mv.id)::text from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=98401),null,'revoked selected-version rights suppress public profile');
select is((select count(*)::int from media_gateway.resolve_movie_version((select mv.id from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=98401))),0,'playback resolver blocks revoked rights');
select ok(not catalogue_access.movie_is_public((select id from public.movies where tmdb_id=98401)),'catalogue hides revoked R2 publication');
select is(tests.review('clear_rights','contract-renewed',now()+interval '1 month'),'published','rights restoration needs authorized attestation');
select is(tests.claim(8428,array['cleanup']),'cleanup','only durable stored media enters cleanup');
select is(tests.finish(8428,'cleanup','{"outcome":"failed","code":"r2_storage_unavailable"}'),'published','cleanup failure preserves publication and staging');
select is((select state from private.admin_upload_r2 where upload_id=tests.id()),'complete','cleanup failure never falsely releases quota');
select is(tests.claim(8429,array['cleanup']),'null','cleanup retry obeys backoff');
update private.admin_upload_r2 set cleanup_after=now() where upload_id=tests.id();
select is(tests.claim(8429,array['cleanup']),'cleanup','cleanup retry is durable');
select is(tests.finish(8429,'cleanup','{"outcome":"cleaned"}'),'published','confirmed idempotent deletion persists');
select is(tests.call(0,format('select public.admin_upload_r2_housekeeping(''object_tracked'',%L::jsonb)::text',jsonb_build_object('key',(select object_key from private.admin_upload_r2 where upload_id=tests.id()),'size',3))),'false','object remaining after acknowledged cleanup requires review');
select ok((select staging_cleaned_at is not null from private.admin_upload_sessions where id=tests.id()),'quota releases only after confirmed cleanup');
select is(tests.claim(8430,array['cleanup']),'null','completed cleanup cannot run twice');
select is(tests.call(0,$$select public.admin_upload_r2_housekeeping('orphan_multipart','{"key":"unknown","uploadId":"old","initiated":"2020-01-01"}')::text$$),'null','unknown orphan objects are retained for manual review');
select is(tests.call(0,format('select public.admin_upload_r2_housekeeping(''orphan_multipart'',%L::jsonb)::text',jsonb_build_object('key',(select object_key from private.admin_upload_r2 where upload_id=tests.id()),'uploadId','fake-mpu','initiated','2020-01-01'))),'null','current multipart identity is never orphan-aborted');
select matches(tests.call(0,format('select public.admin_upload_r2_housekeeping(''orphan_multipart'',%L::jsonb)::text',jsonb_build_object('key',(select object_key from private.admin_upload_r2 where upload_id=tests.id()),'uploadId','lost-init-mpu','initiated','2020-01-01'))),'lost-init-mpu','old unattached database-owned multipart upload can be aborted');
-- Retention is conservative: only unfinished uploads expire automatically.
select is(tests.call(8401,$$select public.admin_upload_r2_create('abandoned.mp4',3,'00000000-0000-4000-8000-000000008450',1)->>'stage'$$),'draft','configurable one-day multipart deadline');
update private.admin_upload_sessions set expires_at=now()-interval '1 second' where upload_request_id='00000000-0000-4000-8000-000000008450';
select is(tests.claim(8451,array['cleanup']),'cleanup','expired unfinished upload is claimed for abandonment');
select is(tests.call(0,format('select public.admin_upload_r2_worker_finish(%L,''00000000-0000-4000-8000-000000008451'',''cleanup'',''{"outcome":"cleaned"}'')',(select id from private.admin_upload_sessions where upload_request_id='00000000-0000-4000-8000-000000008450'))),'cancelled','abandoned cleanup is durably cancelled');
select is(tests.call(8401,$$select public.admin_upload_r2_create('review.mp4',3,'00000000-0000-4000-8000-000000008452')->>'stage'$$),'draft','another independent upload can coexist');
update private.admin_upload_sessions set stage='metadata_review',bytes_received=3,verified_sha256=repeat('f',64),expires_at=now()-interval '1 day' where upload_request_id='00000000-0000-4000-8000-000000008452';
select is(tests.claim(8453,array['cleanup']),'null','expired media awaiting manual review is never deleted');
select is(tests.call(8401,$$select public.admin_upload_r2_create('lost-completion.mp4',3,'00000000-0000-4000-8000-000000008454')->>'stage'$$),'draft','lost completion fixture created');
update private.admin_upload_sessions set stage='uploading',expires_at=now()-interval '1 day' where upload_request_id='00000000-0000-4000-8000-000000008454';
update private.admin_upload_r2 set state='completing' where upload_id=(select id from private.admin_upload_sessions where upload_request_id='00000000-0000-4000-8000-000000008454');
select is(tests.claim(8455,array['cleanup']),'null','uncertain completion is retained after browser deadline');
select is(tests.call(8401,$$select public.admin_upload_r2_create('too-long.mp4',3,'00000000-0000-4000-8000-000000008456',31)::text$$),'upload_invalid_input','retention is bounded to thirty days');
update private.admin_upload_sessions set stage='awaiting_rights' where upload_request_id='00000000-0000-4000-8000-000000008452';
select is(tests.call(8401,format('select public.admin_upload_r2_review(%L,1,''reject_rights'')->>''stage''',(select id from private.admin_upload_sessions where upload_request_id='00000000-0000-4000-8000-000000008452'))),'cancelled','rights-capable owner may explicitly reject');
select is(tests.call(8401,format('select public.admin_upload_get(%L)->''pipeline''->>''rights_rejected''',(select id from private.admin_upload_sessions where upload_request_id='00000000-0000-4000-8000-000000008452'))),'true','rights rejection appears in admin status');
select * from finish();
rollback;
