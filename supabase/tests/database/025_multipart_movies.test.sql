begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

create schema tests;
grant usage on schema tests to service_role, authenticated, velora_review_service;

-- Synthetic 64-hex digests.
create function tests.hex(p text) returns text language sql immutable as $$ select md5(p) || md5(p || '#') $$;
-- One Bot API delivery of a channel document (key u:<update>).
create function tests.doc(p_update bigint, p_message bigint, p_unique text, p_size bigint, p_observed bigint,
                          p_name text default 'Example.Movie.2024.VJ.Test.mp4', p_kind text default 'channel_post')
returns jsonb language sql immutable as $$
  select jsonb_build_object('key', 'u:' || p_update, 'digest', tests.hex('d' || p_update || p_unique || p_observed),
    'update_id', p_update, 'withdrawn_message_id', null,
    'event', jsonb_build_object('event_id', tests.hex('e' || p_message || p_unique || p_observed),
      'payload_digest', tests.hex('p' || p_message || p_unique || p_observed), 'kind', p_kind,
      'message_id', p_message, 'observed_at', p_observed, 'date', 1760000000, 'file_id', 'synthetic-file-' || p_message,
      'file_unique_id', p_unique, 'size', p_size, 'name', p_name, 'mime', 'video/mp4', 'caption', null))
$$;
create function tests.key(p_message bigint) returns text language sql as $$
  select private.discovery_message_key(-1001111111111, p_message) $$;
create function tests.ev_id(p_message bigint) returns bigint language sql as $$
  select r.ingestion_event_id from private.channel_reviews r where r.discovery_key = tests.key(p_message) $$;
create function tests.status(p_message bigint) returns text language sql as $$
  select e.status from private.ingestion_events e where e.id = tests.ev_id(p_message) $$;
create function tests.rev(p_message bigint) returns integer language sql as $$
  select r.review_revision from private.channel_reviews r where r.ingestion_event_id = tests.ev_id(p_message) $$;
create function tests.identity(p_message bigint) returns text language sql as $$
  select private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes)
  from private.telegram_media m where m.chat_id = -1001111111111 and m.message_id = p_message $$;
create function tests.snapshot(p_tmdb integer, p_title text) returns jsonb language sql immutable as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'original_title', p_title, 'overview', 'Synthetic.',
    'release_date', '2024-05-01', 'runtime_minutes', 100, 'poster_path', '/shared-poster.jpg', 'backdrop_path', null,
    'vote_average', 7.1, 'vote_count', 10, 'genres', jsonb_build_array(jsonb_build_object('tmdb_id', 18, 'name', 'Drama'))) $$;
create function tests.evidence(p_identity text, p_class text default 'canonical', p_video text default 'h264') returns jsonb language sql immutable as $$
  select jsonb_build_object('identity', p_identity, 'method', 'bounded_mtproto_v1', 'policy_version', 2, 'media_class', p_class,
    'reasons', case when p_class = 'canonical' then '[]'::jsonb else jsonb_build_array('video_codec_' || p_video) end,
    'container', 'mp4', 'video_codec', p_video, 'audio_codec', 'aac',
    'accessible', true, 'gateway_compatible', true, 'playback_ready', p_class = 'canonical', 'bytes_read', 3072) $$;
create function tests.result(p_tmdb integer, p_title text, p_vj bigint, p_evidence jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('outcome', 'review', 'error_code', null, 'title', p_title, 'year', 2024, 'vj_text', 'Test',
    'vj_id', p_vj, 'warnings', '[]'::jsonb, 'identity_state', 'proposed', 'proposed_tmdb_id', p_tmdb,
    'candidates', jsonb_build_array(jsonb_build_object('tmdb_id', p_tmdb, 'score', 1, 'reasons', '{"title_match":"exact"}'::jsonb,
                                                       'snapshot', tests.snapshot(p_tmdb, p_title))),
    'evidence', p_evidence) $$;
-- Error code of a statement run as a role (or the result text).
create function tests.as_role(p_role text, p_claims jsonb, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    return sqlerrm;
  end;
  reset role;
  return coalesce(v, 'null');
end $$;
create function tests.claims(p_user uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', false) $$;

-- Fixtures: registered Movies channel, an active VJ, reviewer accounts.
insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into public.vjs (slug, name, is_active) values ('vj-e38a-test', 'VJ E38A Test', true), ('vj-e38a-off', 'VJ E38A Off', false);
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'review@e38a.invalid'),
  ('00000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'rights@e38a.invalid'),
  ('00000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'publish@e38a.invalid'),
  ('00000000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'nobody@e38a.invalid');
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000a1', true, false, false),
  ('00000000-0000-4000-8000-0000000000a2', false, true, false),
  ('00000000-0000-4000-8000-0000000000a3', false, false, true);
create function tests.vj() returns bigint language sql as $$ select id from public.vjs where slug = 'vj-e38a-test' $$;
grant execute on all functions in schema tests to service_role, authenticated, velora_review_service;
-- Lets this (rolled-back) session assume the restricted roles, as suite 008 does.
grant velora_review_service to postgres;
grant velora_media_gateway to postgres;

-- Synthetic only; every publication is rolled back.
select is(private.movie_file_part('Vedaa A.VJ TEST.mp4','Vedaa',2024),1::smallint,'bare A aliases Part 1');
select is(private.movie_file_part('Vedaa PartB (2024).VJ TEST.mkv','Vedaa',2024),2::smallint,'compact PartB with bracketed year');
select is(private.movie_file_part('Vedaa.PT.B.2024.VJ.Test.mp4','Vedaa',2024),2::smallint,'PT B aliases Part 2');
select is(private.movie_file_part('Vedaa Part Z.VJ TEST.mp4','Vedaa',2024),26::smallint,'lettered parts extend through Z');
select is(private.movie_file_part('Vedaa 02.VJ TEST.mp4','Vedaa',2024),2::smallint,'zero-padded numeric part');
select is(private.movie_file_part('Plan B.VJ TEST.mp4','Plan B',2024),0::smallint,'exact lettered movie title stays intact');
select is(private.movie_file_part('Other Film B.VJ TEST.mp4','Vedaa',2024),0::smallint,'letter suffix cannot override a different film');
select is(private.movie_file_part('TEHRAN 1.VJ ICE P.mkv','Tehran',2025),1::smallint,'bare part suffix');
select is(private.movie_file_part('Vedaa Part2 2024 VJ Test.mp4','Vedaa',2024),2::smallint,'compact suffix');
select is(private.movie_file_part('Vedaa.PT.2.2024.VJ.Test.mp4','Vedaa',2024),2::smallint,'PT suffix');
select is(private.movie_file_part('Movie 2.VJ Test.mp4','Movie 2',2024),0::smallint,'exact sequel title');
select is(private.movie_file_part('Other Part 2.VJ Test.mp4','Tehran',2024),0::smallint,'unrelated base');
select is(private.movie_file_part('1917.VJ Test.mp4','1917',2019),0::smallint,'numeric title');
select ok(not has_function_privilege(r,'private.movie_file_part(text,text,integer)','EXECUTE')
 and not has_function_privilege(r,'private.channel_movie_part(bigint)','EXECUTE')
 and not has_function_privilege(r,'private.channel_relation(integer,bigint,smallint)','EXECUTE'),r || ' cannot bypass commands')
from unnest(array['anon','authenticated','service_role','velora_review_service','velora_discovery_worker','velora_media_gateway']) r;
select ok(not has_column_privilege('anon','public.movie_versions','part_number','SELECT') and not has_column_privilege('authenticated','public.movie_versions','part_number','UPDATE'),'part key remains internal');
insert into private.discovery_cursors(bot_type) values('movie');
select public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000c1',60);
create function tests.detect_part(p_message bigint,p_name text) returns void language plpgsql as $$
begin
 perform public.discovery_receive('00000000-0000-4000-8000-0000000000c1',-1001111111111,
 jsonb_build_array(tests.doc(p_message,p_message,'part-'||p_message,1048576,1760000000+p_message,p_name)),null);
end $$;
create function tests.inspect_part(p_message bigint,p_tmdb integer,p_title text,p_evidence boolean default true) returns void language plpgsql as $$
declare c jsonb;
begin
 c:=public.discovery_claim(60);
 if c->>'key' is distinct from tests.key(p_message) then raise exception 'wrong_claim'; end if;
 perform public.discovery_complete(tests.key(p_message),(c->>'lease')::uuid,tests.rev(p_message),tests.result(p_tmdb,p_title,tests.vj(),case when p_evidence then tests.evidence(tests.identity(p_message)) end));
 perform set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a1')::text,true);
 perform public.discovery_review_correct(tests.key(p_message),tests.rev(p_message),p_tmdb,2024,tests.vj());
 perform set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a2')::text,true);
 perform public.discovery_review_clear_rights(tests.key(p_message),tests.rev(p_message),'synthetic-parts-license');
end $$;
select tests.detect_part(100,'TEHRAN 1.VJ TEST.mp4');
select tests.inspect_part(100,9800001,'Tehran');
select is(private.channel_movie_part(tests.ev_id(100)),1::smallint,'confirmed Part 1');
select is(private.channel_view(tests.ev_id(100),false)->>'title','Tehran — Part 1','review part label');
select is(cardinality(private.channel_review_blockers(tests.ev_id(100))),0,'Part 1 ready');
select is(catalogue_review.approve_channel_candidate(tests.key(100),tests.rev(100),'00000000-0000-4000-8000-0000000000a1')->>'status','matched','approve first part');
select is(catalogue_review.publish_channel_candidate(tests.key(100),tests.rev(100),'00000000-0000-4000-8000-0000000000a3')->>'result','published','publish first part');
create temp table first_part as select mv.* from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=9800001;
select tests.detect_part(101,'TEHRAN 2.VJ TEST.mp4');
select tests.inspect_part(101,9800001,'Tehran',false);
select is(private.channel_view(tests.ev_id(101),false)->>'title','Tehran — Part 2','review shows second part');
select ok('media_verification_required'=any(private.channel_review_blockers(tests.ev_id(101))),'cannot borrow Part 1 evidence');
select ok(not ('existing_version_replacement_requires_separate_workflow'=any(private.channel_review_blockers(tests.ev_id(101)))),'Part 2 is not a replacement');
select throws_ok(format('select catalogue_review.approve_channel_candidate(%L,%s,%L)',tests.key(101),tests.rev(101),'00000000-0000-4000-8000-0000000000a1'),'P0001','review_gates_not_met','unchecked part cannot be approved');
create temp table verification_claim as select public.discovery_claim_verification(tests.key(101),60) as c;
select public.discovery_complete(tests.key(101),(select (c->>'lease')::uuid from verification_claim),tests.rev(101),tests.result(9800001,'Tehran',tests.vj(),tests.evidence(tests.identity(101))));
select is(cardinality(private.channel_review_blockers(tests.ev_id(101))),0,'own evidence clears Part 2');
select is(private.channel_view(tests.ev_id(101),false)->>'relation','new_part','live relation accepts new part');
select is(catalogue_review.approve_channel_candidate(tests.key(101),tests.rev(101),'00000000-0000-4000-8000-0000000000a1')->>'status','matched','approve Part 2');
select is(catalogue_review.publish_channel_candidate(tests.key(101),tests.rev(101),'00000000-0000-4000-8000-0000000000a3')->>'result','published','publish Part 2 independently');
select is((select count(*)::integer from public.movies where tmdb_id=9800001),1,'one film and poster');
select is((select array_agg(mv.part_number order by mv.part_number) from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=9800001),array[1,2]::smallint[],'both parts coexist');
select is((select title_override from public.movie_versions where part_number=2),'Tehran — Part 2','player part label');
select is((select mv.telegram_media_id from public.movie_versions mv join first_part f on f.id=mv.id),(select telegram_media_id from first_part),'first part file preserved');
select is(catalogue_review.publish_channel_candidate(tests.key(101),tests.rev(101),'00000000-0000-4000-8000-0000000000a3')->>'result','already_published','idempotent retry');
select is(tests.as_role('anon',null,$q$select count(*)::text from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=9800001$q$),'2','both published parts publicly visible');
select is(tests.as_role('velora_media_gateway',null,format('select message_id::text from media_gateway.resolve_movie_version(%s)',(select mv.id from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=9800001 and mv.part_number=2))),'101','gateway binds Part 2 to own file');
select tests.detect_part(102,'TEHRAN PART 2.VJ TEST.mp4');
select tests.inspect_part(102,9800001,'Tehran');
select ok('existing_version_replacement_requires_separate_workflow'=any(private.channel_review_blockers(tests.ev_id(102))),'same part different file remains a replacement');
select tests.detect_part(103,'Other Film.VJ TEST.mp4');
select tests.inspect_part(103,9800002,'Other Film');
select is(cardinality(private.channel_review_blockers(tests.ev_id(103))),0,'distinct TMDB title remains independent');
select catalogue_review.approve_channel_candidate(tests.key(103),tests.rev(103),'00000000-0000-4000-8000-0000000000a1');
select is(catalogue_review.publish_channel_candidate(tests.key(103),tests.rev(103),'00000000-0000-4000-8000-0000000000a3')->>'result','published','different title can publish with an identical poster');
select is((select count(*)::integer from public.movies where poster_path='/shared-poster.jpg'),2,'shared poster is never a uniqueness key');
-- Admin uploads use the same part-aware collision rule before any transfer.
update auth.users set raw_app_meta_data='{"role":"admin"}' where id='00000000-0000-4000-8000-0000000000a1';
select set_config('request.jwt.claims',tests.claims('00000000-0000-4000-8000-0000000000a1')::text,true);
create function tests.upload_part(p_name text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
 v_id := (public.admin_upload_r2_create(p_name,1048576,gen_random_uuid())->>'id')::uuid;
 update private.admin_upload_sessions set stage='metadata_review',bytes_received=size_bytes,verified_sha256=repeat('a',64),
 metadata=jsonb_build_object('kind','movie','title','Tehran','year',2024,'vjId',tests.vj(),'snapshot',tests.snapshot(9800001,'Tehran'),'provenance','Synthetic source'),
 inspection=jsonb_build_object('choices',jsonb_build_array(tests.snapshot(9800001,'Tehran')),'proposed_tmdb_id',9800001,
 'classification',jsonb_build_object('class','canonical','policyVersion',2),'decoded',true,'query',jsonb_build_object('title','Tehran','year',2024))
 where id=v_id;
 return v_id;
end $$;
create temp table upload_parts as select tests.upload_part('TEHRAN 3.VJ TEST.mp4') as fresh,tests.upload_part('TEHRAN 2.VJ TEST.mp4') as replacement;
select is((select public.admin_upload_r2_review(u.fresh,s.revision,'submit')->>'stage' from upload_parts u join private.admin_upload_sessions s on s.id=u.fresh),'awaiting_rights','admin upload accepts a new part before rights/approval/transfer');
select throws_ok((select format('select public.admin_upload_r2_review(%L,%s,''submit'')',u.replacement,s.revision) from upload_parts u join private.admin_upload_sessions s on s.id=u.replacement),'P0001','catalogue_version_conflict','admin upload still refuses replacement of an existing part');

-- Future lettered uploads use the shared gates/materializer and share the base artwork.
select tests.detect_part(104,'Lettered Film A 2024 VJ TEST.mp4');
select tests.inspect_part(104,9800003,'Lettered Film');
select is(private.channel_movie_part(tests.ev_id(104)),1::smallint,'future A upload occupies first part');
select catalogue_review.approve_channel_candidate(tests.key(104),tests.rev(104),'00000000-0000-4000-8000-0000000000a1');
select is(catalogue_review.publish_channel_candidate(tests.key(104),tests.rev(104),'00000000-0000-4000-8000-0000000000a3')->>'result','published','lettered A publishes independently');
select tests.detect_part(105,'Lettered Film Part B (2024) VJ TEST.mp4');
select tests.inspect_part(105,9800003,'Lettered Film');
select is(private.channel_view(tests.ev_id(105),false)->>'relation','new_part','future B is a new part alongside A');
select is(cardinality(private.channel_review_blockers(tests.ev_id(105))),0,'lettered B can progress after its own checks');
select catalogue_review.approve_channel_candidate(tests.key(105),tests.rev(105),'00000000-0000-4000-8000-0000000000a1');
select is(catalogue_review.publish_channel_candidate(tests.key(105),tests.rev(105),'00000000-0000-4000-8000-0000000000a3')->>'result','published','lettered B publishes independently');
select is((select array_agg(mv.part_number order by mv.part_number) from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.tmdb_id=9800003),array[1,2]::smallint[],'lettered parts share the film and canonical part slots');
select tests.detect_part(106,'Lettered Film 2 2024 VJ TEST.mp4');
select tests.inspect_part(106,9800003,'Lettered Film');
select ok('existing_version_replacement_requires_separate_workflow'=any(private.channel_review_blockers(tests.ev_id(106))),'numeric 2 cannot replace the existing B file');

select * from finish();
rollback;