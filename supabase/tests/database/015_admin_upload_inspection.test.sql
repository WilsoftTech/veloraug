begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(15);
grant velora_upload_worker to postgres with set true;
create schema tests;
create function tests.worker(p_sql text) returns text language plpgsql as $$
declare v text;
begin set local role velora_upload_worker;
  begin execute p_sql into v; exception when others then reset role; return sqlerrm; end;
  reset role; return coalesce(v,'null');
end;
$$;
insert into auth.users(id,raw_app_meta_data,is_anonymous) values('00000000-0000-4000-8000-000000008301','{"role":"admin"}',false);
insert into private.catalogue_reviewers(user_id,can_review) values('00000000-0000-4000-8000-000000008301',true);
insert into private.admin_upload_sessions(id,owner_id,file_name,size_bytes,bytes_received,stage)
  values('00000000-0000-4000-8000-000000008302','00000000-0000-4000-8000-000000008301','movie.mp4',3,3,'verifying');
insert into private.admin_upload_chunks(upload_id,byte_offset,size_bytes,storage_key,sha256)
  values('00000000-0000-4000-8000-000000008302',0,3,'00000000-0000-4000-8000-000000008307',repeat('c',64));
create function tests.finish(p_token uuid,p_result jsonb) returns text language sql as $$
  select tests.worker(format('select public.admin_upload_worker_finish(%L,%L,%L::jsonb)',
    '00000000-0000-4000-8000-000000008302',p_token,p_result))
$$;
select is(tests.worker($$select public.admin_upload_worker_claim('00000000-0000-4000-8000-000000008303')->>'operation'$$),'verify','verification claimed');
select is(tests.worker($$select public.admin_upload_worker_claim('00000000-0000-4000-8000-000000008304')::text$$),'null','concurrent worker cannot claim active lease');
select is(tests.finish('00000000-0000-4000-8000-000000008304','{"outcome":"verified"}'),'upload_lease_lost','foreign token refused');
select is(tests.finish('00000000-0000-4000-8000-000000008303','{"outcome":"verified"}'),'upload_invalid_result','missing checksum refuses verification');
update private.admin_upload_sessions set lease_until=now()-interval '1 second';
select is(tests.worker($$select public.admin_upload_worker_claim('00000000-0000-4000-8000-000000008304')->>'operation'$$),'verify','worker restart reclaims expired verification');
select is(tests.finish('00000000-0000-4000-8000-000000008303','{"outcome":"failed","code":"probe_failed"}'),'upload_lease_lost','old worker result fenced');
select is(tests.finish('00000000-0000-4000-8000-000000008304',jsonb_build_object('outcome','verified','sha256',repeat('a',64),'fingerprint','sf1-'||repeat('b',64),'file_key','00000000-0000-4000-8000-000000008305')),'uploaded','verified bytes persisted');
select is((select stage from private.admin_upload_sessions where id='00000000-0000-4000-8000-000000008302'),'uploaded','uploaded remains distinct from inspected');
select is((select rights_revision from private.admin_upload_sessions where id='00000000-0000-4000-8000-000000008302'),null,'verification grants no rights');
select is(tests.worker($$select public.admin_upload_worker_claim('00000000-0000-4000-8000-000000008306')->>'operation'$$),'inspect','separate inspection claimed');
select is(tests.finish('00000000-0000-4000-8000-000000008306','{"outcome":"inspected","inspection":{"choices":[]}}'),'metadata_review','inspection enters review, never approval');
select is((select approved_revision from private.admin_upload_sessions where id='00000000-0000-4000-8000-000000008302'),null,'inspection grants no approval');
select is((select count(*)::int from private.admin_upload_attempts where outcome='succeeded'),2,'verify and inspect have separate successful attempts');
select is((select count(*)::int from private.admin_upload_attempts where error_code='upload_lease_expired'),1,'expired attempt retained');
select is((select count(*)::int from private.admin_upload_audit),2,'persistent completions audited separately');
select * from finish();
rollback;
