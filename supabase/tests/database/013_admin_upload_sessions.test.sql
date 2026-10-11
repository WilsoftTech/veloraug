begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
select plan(33);
create schema tests;
create function tests.upload_call(p_user integer,p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',('00000000-0000-4000-8000-' || lpad(p_user::text,12,'0'))::uuid,'role','authenticated','is_anonymous',false)::text,true);
  set local role authenticated;
  begin execute p_sql into v; exception when others then reset role; return sqlerrm; end;
  reset role;
  return coalesce(v,'null');
end;
$$;
insert into auth.users(id,raw_app_meta_data,raw_user_meta_data,is_anonymous)
select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  case when n in (8101,8102,8104) then '{"role":"admin"}'::jsonb else '{}'::jsonb end,
  '{"role":"admin"}'::jsonb,false from generate_series(8101,8104) n;
insert into private.catalogue_reviewers(user_id,can_review,can_clear_rights,can_publish)
select id,true,false,false from auth.users where id in ('00000000-0000-4000-8000-000000008101','00000000-0000-4000-8000-000000008102','00000000-0000-4000-8000-000000008103');
create function tests.upload_id() returns uuid language sql as $$
  select id from private.admin_upload_sessions where owner_id='00000000-0000-4000-8000-000000008101' order by created_at limit 1
$$;
create function tests.upload_control(p_actor integer,p_action text,p_revision integer) returns text language sql as $$
  select tests.upload_call(p_actor,format('select public.admin_upload_control(%L,%s,%L)->>''stage''',tests.upload_id(),p_revision,p_action))
$$;
create function tests.upload_edit(p_extra jsonb) returns text language sql as $$
  select tests.upload_call(8101,format('select public.admin_upload_edit(%L,1,%L::jsonb)->>''revision''',tests.upload_id(),
    '{"kind":"movie","title":"Draft","year":2024,"vjId":null,"snapshot":null,"season":null,"episode":null,"provenance":"Local source"}'::jsonb || p_extra))
$$;

select is((select count(*)::int from pg_class where oid in ('private.admin_upload_sessions'::regclass,'private.admin_upload_attempts'::regclass,'private.admin_upload_audit'::regclass) and relrowsecurity),3,'all upload tables have RLS');
select is((select count(*)::int from pg_class c cross join unnest(array['anon','authenticated','service_role','velora_upload_worker','velora_discovery_worker','velora_review_service']) r
  where c.oid in ('private.admin_upload_sessions'::regclass,'private.admin_upload_attempts'::regclass,'private.admin_upload_audit'::regclass)
    and has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),0,'no application identity has direct upload table privileges');
select is((select count(*)::int from pg_proc p where p.proname like 'admin_upload_%' and p.pronamespace='public'::regnamespace
  and p.prosecdef and p.proconfig @> array['search_path=""'] and has_function_privilege('authenticated',p.oid,'EXECUTE')),8,'eight pinned session-bound RPCs');
select is((select count(*)::int from pg_proc p cross join unnest(array['anon','service_role','velora_discovery_worker','velora_upload_worker']) r
  where p.proname like 'admin_upload_%' and p.proname not like 'admin_upload_worker_%' and p.proname not like 'admin_upload_r2_worker_%' and p.proname<>'admin_upload_r2_housekeeping' and p.pronamespace='public'::regnamespace and has_function_privilege(r,p.oid,'EXECUTE')),0,'other roles cannot invoke browser commands');
select ok((select not (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication or rolinherit) from pg_roles where rolname='velora_upload_worker'),'worker ships disabled and unprivileged');
select ok(not pg_has_role('velora_upload_worker','postgres','MEMBER') and not pg_has_role('velora_upload_worker','service_role','MEMBER'),'worker has no elevated memberships');
select is(tests.upload_call(8103,$$select public.admin_upload_create('Movie.mp4',100)::text$$),'upload_not_authorized','user metadata cannot grant admin');
select is(tests.upload_call(8104,$$select public.admin_upload_create('Movie.mp4',100)::text$$),'review_not_authorized','admin role without reviewer capability cannot create');
select is(tests.upload_call(8101,$$select public.admin_upload_create('Movie.mp4',2000000001)::text$$),'upload_invalid_file','decimal size limit enforced by database');
select is(tests.upload_call(8101,$$select public.admin_upload_create('Movie.mp4',0)::text$$),'upload_invalid_file','zero size rejected');
select is(tests.upload_call(8101,$$select public.admin_upload_create('../Movie.mp4',100)::text$$),'upload_invalid_file','path traversal rejected');
select is(tests.upload_call(8101,$$select public.admin_upload_create('Movie.exe',100)::text$$),'upload_invalid_file','unsupported container rejected');
select is(tests.upload_call(8101,$$select public.admin_upload_create('Movie.mp4',2000000000)->>'stage'$$),'draft','boundary size creates a private draft');
select is((select count(*)::int from private.admin_upload_audit),1,'creation audited');
select ok(not (private.admin_upload_view(tests.upload_id()) ?| array['storage_key','approved_by','rights_by','lease_token','ingestion_event_id']),'browser view excludes privileged fields and storage key');
select is(tests.upload_call(8102,format('select public.admin_upload_get(%L)::text',tests.upload_id())),'upload_not_found','cross-user read refused');
select is(tests.upload_call(8102,$$select jsonb_array_length(public.admin_upload_list(200))::text$$),'0','list is owner scoped');
select is(tests.upload_call(8101,$$select public.admin_upload_list(201)::text$$),'upload_invalid_input','list bounded');
select is(tests.upload_edit('{"approved":true}'),'upload_invalid_metadata','forged approval field rejected');
select is(tests.upload_edit('{"rights":{"cleared":true}}'),'upload_invalid_metadata','forged rights rejected');
select is(tests.upload_edit('{"year":1.5}'),'upload_invalid_metadata','fractional year rejected');
select is(tests.upload_edit('{}'),'2','metadata edit advances revision');
select is(tests.upload_control(8101,'start',1),'upload_stale_revision','stale browser mutation refused');
select is(tests.upload_control(8102,'start',2),'upload_not_found','cross-user mutation refused');
select is(tests.upload_control(8101,'published',2),'upload_illegal_transition','browser cannot publish');
select is(tests.upload_control(8101,'start',2),'uploading','owner starts transfer');
select is(tests.upload_control(8101,'verify',3),'upload_illegal_transition','incomplete committed transfer cannot queue verification');
-- Trusted setup only; browsers cannot set the committed byte count.
update private.admin_upload_sessions set bytes_received=size_bytes where id=tests.upload_id();
select is(tests.upload_control(8101,'verify',3),'verifying','browser can request verification only');
select is((select verified_sha256 from private.admin_upload_sessions where id=tests.upload_id()),null,'completion request does not establish verification');
select throws_ok(format('update private.admin_upload_sessions set stage=''approved'' where id=%L',tests.upload_id()),'23514',null,'database rejects approval without media and decisions');
select is(tests.upload_control(8101,'cancel',4),'cancelled','owner cancels an unclaimed job');
select throws_ok('update private.admin_upload_audit set action=''changed''','P0001','audit_append_only','audit append-only');
select is((select count(*)::int from private.ingestion_events where origin='uploader'),0,'draft commands do not create catalogue ingestion records');
select * from finish();
rollback;
