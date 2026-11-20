-- Synthetic local fixtures only. Every data change is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(20);
create schema tests;
grant usage on schema tests to authenticated, anon, service_role;
create function tests.as_role(p_role text, p_user text, p_anonymous boolean, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub',p_user,'role',p_role,'is_anonymous',p_anonymous)::text,true);
  execute format('set local role %I',p_role);
  begin execute p_sql into v; exception when others then reset role; return sqlerrm; end;
  reset role; return coalesce(v,'null');
end $$;
revoke all on function tests.as_role(text,text,boolean,text) from public,anon,authenticated,service_role;
insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-0000000000a1','authenticated','authenticated','uploader-review@test.invalid'),
 ('00000000-0000-4000-8000-0000000000a2','authenticated','authenticated','unenrolled@test.invalid');
insert into private.catalogue_reviewers(user_id,can_review) values ('00000000-0000-4000-8000-0000000000a1',true);
create function tests.read(p_sql text) returns text language sql as $$
 select tests.as_role('authenticated','00000000-0000-4000-8000-0000000000a1',false,p_sql) $$;
revoke all on function tests.read(text) from public,anon,authenticated,service_role;
create function tests.upload(n integer, kind text, st text, uploaded boolean) returns void language plpgsql as $$
declare mid bigint;
begin
 if uploaded then
  insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,file_name,file_size_bytes,telegram_date)
  values(kind,-1001111111111,n,'secret-file-handle-'||n,'synthetic'||n,'document','Synthetic.'||n||'.mp4',1024,now()) returning id into mid;
 end if;
 insert into private.ingestion_events(bot_type,origin,status,source_fingerprint,source_size_bytes,upload_state,upload_attempt_count,upload_started_at,telegram_media_id,parsed)
 values(kind,'uploader',st,'sf1-'||repeat('0',62)||lpad(n::text,2,'0'),1024,case when uploaded then 'uploaded' else 'uncertain' end,1,now(),mid,
 jsonb_build_object('title','Synthetic movie '||n,'year',2012,'vj_id',null));
end $$;
revoke all on function tests.upload(integer,text,text,boolean) from public,anon,authenticated,service_role;
select tests.upload(1,'movie','matched',true);
select tests.upload(2,'movie','published',true);
select tests.upload(3,'movie','received',false);
select tests.upload(4,'series','matched',true);
select tests.upload(5,'movie','rejected',true);
select tests.upload(6,'movie','ignored',true);
create temp table before_rows as select jsonb_agg(to_jsonb(e) order by e.id) as data from private.ingestion_events e;
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""'] from pg_proc where oid='public.discovery_upload_list(text,integer)'::regprocedure),'stable security definer with pinned search_path');
select ok(has_function_privilege('authenticated','public.discovery_upload_list(text,integer)','EXECUTE'),'authenticated can reach guarded command');
select ok(not has_function_privilege('anon','public.discovery_upload_list(text,integer)','EXECUTE'),'anon has no execute');
select ok(not has_function_privilege('service_role','public.discovery_upload_list(text,integer)','EXECUTE'),'worker has no execute');
select ok(not exists(select 1 from pg_proc p,aclexplode(p.proacl) a where p.oid='public.discovery_upload_list(text,integer)'::regprocedure and a.grantee=0),'no PUBLIC grant');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000a2',false,'select public.discovery_upload_list(null,200)::text'),'review_not_authorized','unenrolled account is refused');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000a1',true,'select public.discovery_upload_list(null,200)::text'),'review_not_authorized','anonymous signin is refused');
select is(tests.read('select jsonb_array_length(public.discovery_upload_list(null,200))::text'),'1','only complete pending movie upload is visible');
select is(tests.read('select public.discovery_upload_list(null,200)->0->>''title'''),'Synthetic movie 1','evaluated title is shown');
select is(tests.read('select public.discovery_upload_list(null,200)->0->>''status'''),'matched','matched is not relabeled approved');
select is(tests.read('select public.discovery_upload_list(null,200)->0->>''mediaReady'''),'false','missing hosted evidence is not verified');
select is(tests.read('select jsonb_array_length(public.discovery_upload_list(''SYNTHETIC MOVIE 1'',200))::text'),'1','case insensitive title search');
select is(tests.read('select jsonb_array_length(public.discovery_upload_list(''Synthetic.1.mp4'',200))::text'),'1','filename search');
select is(tests.read('select public.discovery_upload_list(''absent'',200)::text'),'[]','empty search result');
select is(tests.read('select public.discovery_upload_list(null,0)::text'),'discovery_invalid_input','invalid limit refused');
select is(tests.read('select public.discovery_upload_list(null,null)::text'),'discovery_invalid_input','null limit refused');
select is(tests.read('select public.discovery_upload_list(repeat(''a'',301),200)::text'),'discovery_invalid_input','long query refused');
select ok(position('secret-file-handle' in tests.read('select public.discovery_upload_list(null,200)::text'))=0,'no bot file handles');
select is((select jsonb_agg(to_jsonb(e) order by e.id) from private.ingestion_events e),(select data from before_rows),'reads preserve provenance and lifecycle');
select is((select count(*)::int from private.channel_reviews),0,'does not fabricate channel review records');
select * from finish();
rollback;
