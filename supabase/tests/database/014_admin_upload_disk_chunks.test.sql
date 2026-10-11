begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(18);
-- Test harness only; rolled back. The application worker remains NOLOGIN.
grant velora_upload_worker to postgres with set true;
create schema tests;
create function tests.worker(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  set local role velora_upload_worker;
  begin execute p_sql into v; exception when others then reset role; return sqlerrm; end;
  reset role; return coalesce(v,'null');
end;
$$;
insert into auth.users(id,raw_app_meta_data,is_anonymous) values('00000000-0000-4000-8000-000000008201','{"role":"admin"}',false);
insert into private.catalogue_reviewers(user_id,can_review) values('00000000-0000-4000-8000-000000008201',true);
insert into private.admin_upload_sessions(id,owner_id,file_name,size_bytes,stage) values('00000000-0000-4000-8000-000000008202','00000000-0000-4000-8000-000000008201','movie.mp4',3,'uploading');
create function tests.chunk(p_offset bigint,p_size integer,p_key uuid) returns text language sql as $$
  select tests.worker(format('select public.admin_upload_worker_chunk(%L,%L,%s,%s,%L,%L)::text',
    '00000000-0000-4000-8000-000000008202','00000000-0000-4000-8000-000000008201',p_offset,p_size,p_key,repeat('a',64)))
$$;
select ok((select relrowsecurity from pg_class where oid='private.admin_upload_chunks'::regclass),'chunk manifest has RLS');
select is((select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname like 'admin_upload_worker_%' and has_function_privilege('velora_upload_worker',oid,'EXECUTE')),4,'worker gets only storage and inspection commands');
select ok(not has_table_privilege('velora_upload_worker','private.admin_upload_chunks','SELECT,INSERT,UPDATE,DELETE'),'worker has no raw table access');
select ok(not has_function_privilege('authenticated','public.admin_upload_worker_chunk(uuid,uuid,bigint,integer,uuid,text)','EXECUTE'),'browser cannot report durable chunks');
select ok(not has_function_privilege('service_role','public.admin_upload_worker_chunk(uuid,uuid,bigint,integer,uuid,text)','EXECUTE'),'service_role does not inherit upload worker commands');
select ok(not has_function_privilege('velora_upload_worker','public.discovery_review_approve(text,integer)','EXECUTE'),'worker cannot approve');
select ok(not has_function_privilege('velora_upload_worker','private.catalogue_publish_movie(text,jsonb,boolean)','EXECUTE'),'worker cannot publish');
select is(tests.worker($$select public.admin_upload_worker_manifest('00000000-0000-4000-8000-000000008202','00000000-0000-4000-8000-000000008201')->'session'->>'stage'$$),'uploading','worker reads owner-bound manifest');
select is(tests.worker($$select public.admin_upload_worker_manifest('00000000-0000-4000-8000-000000008202','00000000-0000-4000-8000-000000008203')::text$$),'upload_not_authorized','unknown owner refused');
select is(tests.chunk(0,4,'00000000-0000-4000-8000-000000008204'),'upload_invalid_chunk','overflow refused');
select is(tests.chunk(0,2,'00000000-0000-4000-8000-000000008204'),'upload_invalid_chunk','noncanonical chunk size refused');
select is(tests.chunk(1,2,'00000000-0000-4000-8000-000000008204'),'upload_offset_conflict','offset mismatch refused');
select is(tests.chunk(0,3,'00000000-0000-4000-8000-000000008204'),'3','complete chunk advances durable offset');
select is(tests.chunk(0,3,'00000000-0000-4000-8000-000000008205'),'upload_offset_conflict','duplicate commit refused');
select is((select count(*)::int from private.admin_upload_chunks),1,'single committed chunk');
select is((select stage from private.admin_upload_sessions where id='00000000-0000-4000-8000-000000008202'),'uploading','chunk completion never verifies, approves or publishes');
update private.catalogue_reviewers set can_review=false where user_id='00000000-0000-4000-8000-000000008201';
select is(tests.worker($$select public.admin_upload_worker_manifest('00000000-0000-4000-8000-000000008202','00000000-0000-4000-8000-000000008201')::text$$),'upload_not_authorized','revoked capability immediately blocks storage access');
select is((select count(*)::int from private.admin_upload_attempts),0,'storage transport creates no Telegram attempts');
select * from finish();
rollback;
