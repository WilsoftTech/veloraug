-- Synthetic full-catalogue reads only; all fixtures and helper privileges roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
create schema tests;
create function tests.as_role(p_role text, p_user text, p_sql text) returns text
language plpgsql set search_path = '' as $$
declare v text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', p_role, 'sub', p_user, 'is_anonymous', false)::text, true);
  execute format('set local role %I', p_role);
  begin execute p_sql into v;
  exception when others then reset role; return sqlerrm;
  end;
  reset role; return coalesce(v, 'null');
end $$;
create function tests.read(p_query text, p_status text, p_cursor bigint, p_limit integer) returns jsonb
language sql set search_path = '' as $$
  select tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000c1',
    format('select public.catalogue_admin_movie_page(%L,%L,%L,%L)::text', p_query, p_status, p_cursor, p_limit))::jsonb
$$;
revoke all on function tests.as_role(text,text,text), tests.read(text,text,bigint,integer) from public, anon, authenticated, service_role;
insert into auth.users(id,aud,role,email) values
 ('00000000-0000-4000-8000-0000000000c1','authenticated','authenticated','catalogue-reader@synthetic.invalid'),
 ('00000000-0000-4000-8000-0000000000c2','authenticated','authenticated','catalogue-outsider@synthetic.invalid');
insert into private.catalogue_reviewers(user_id,can_review) values ('00000000-0000-4000-8000-0000000000c1',true);
insert into public.movies(id,slug,title,release_date,publication_status)
select 820000+n, 'catalogue-page-'||n, case when n=1 then 'Older needle 100%_film' else 'Catalogue page '||n end,
  case when n=1 then date '1987-01-01' else date '2024-01-01' end,
  case when n%3=0 then 'archived' when n%3=1 then 'draft' else 'published' end
from generate_series(1,245) n;
insert into public.vjs(slug,name) values ('vj-page-one','VJ Needle'),('vj-page-two','VJ Needle Second');
insert into public.movie_versions(movie_id,vj_id) select 820001,id from public.vjs where slug in ('vj-page-one','vj-page-two');

select ok(has_function_privilege('authenticated','public.catalogue_admin_movie_page(text,text,bigint,integer)','EXECUTE'),'authenticated can reach the checked boundary');
select ok(not exists(select 1 from unnest(array['anon','service_role','velora_review_service','velora_discovery_worker']) r where has_function_privilege(r,'public.catalogue_admin_movie_page(text,text,bigint,integer)','EXECUTE')),'no worker or anonymous execution');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""'] from pg_proc where oid='public.catalogue_admin_movie_page(text,text,bigint,integer)'::regprocedure),'stable definer has pinned empty search_path');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c2','select public.catalogue_admin_movie_page(null,null,null,20)::text'),'review_not_authorized','unenrolled users cannot read hidden catalogue states');
select matches(tests.as_role('anon',null,'select public.catalogue_admin_movie_page(null,null,null,20)::text'),'^permission denied','anonymous denied');
select is(jsonb_array_length(tests.read(null,null,null,20)->'items'),20,'first page bounded');
select is(tests.read(null,null,null,20)->'items'->0->>'id','820245','newest id first');
select is(tests.read(null,null,null,20)->>'next_cursor','820226','cursor is the last returned id');
select is(tests.read(null,null,820226,20)->'items'->0->>'id','820225','next page excludes boundary');
select is(jsonb_array_length(tests.read('OLDER NEEDLE',null,null,20)->'items'),1,'search finds older title outside the latest 200');
select is(tests.read(' older needle ',null,null,20)->'items'->0->>'id','820001','trimmed case-insensitive title search');
select is(jsonb_array_length(tests.read('1987',null,null,20)->'items'),1,'release year search');
select is(jsonb_array_length(tests.read('vj needle',null,null,20)->'items'),1,'two VJ matches do not duplicate a movie');
select is(jsonb_array_length(tests.read('100%_',null,null,20)->'items'),1,'percent and underscore search literally');
select is(jsonb_array_length(tests.read('%',null,null,20)->'items'),1,'percent does not match everything');
select is(tests.read('Older needle','published',null,20)->'items','[]'::jsonb,'state and search combine');
select is(jsonb_array_length(tests.read(null,'archived',null,20)->'items'),20,'withdrawn movies are searchable');
select is(tests.read('Older needle','draft',null,20)->'items'->0->>'publication_status','draft','draft movies are searchable');
select is(tests.read('absent',null,null,20),'{"items":[],"next_cursor":null}'::jsonb,'empty search has no continuation');
select is(tests.read(null,null,1,20),'{"items":[],"next_cursor":null}'::jsonb,'exhausted cursor has no continuation');
select is(tests.read(null,null,820006,20)->>'next_cursor',null,'last page has no continuation');
select ok(not (tests.read('Older needle',null,null,20)->'items'->0 ?| array['telegram_media_id','file_id','rights_reference']),'no private delivery references in movie');
select ok(not (tests.read('Older needle',null,null,20)->'items'->0->'versions'->0 ?| array['telegram_media_id','file_id','rights_reference']),'no private delivery references in version');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c1','select public.catalogue_admin_movie_page(null,null,null,21)::text'),'discovery_invalid_input','oversized limit refused');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c1','select public.catalogue_admin_movie_page(null,null,null,0)::text'),'discovery_invalid_input','zero limit refused');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c1','select public.catalogue_admin_movie_page(null,null,null,null)::text'),'discovery_invalid_input','null limit refused');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c1','select public.catalogue_admin_movie_page(null,''unknown'',null,20)::text'),'discovery_invalid_input','unknown state refused');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c1','select public.catalogue_admin_movie_page(null,null,0,20)::text'),'discovery_invalid_input','invalid cursor refused');
select is(tests.as_role('authenticated','00000000-0000-4000-8000-0000000000c1','select public.catalogue_admin_movie_page(repeat(''a'',301),null,null,20)::text'),'discovery_invalid_input','oversized query refused');
-- Traverse every fixture through the read boundary: no truncation, duplicates or skips.
do $$
declare v_cursor bigint; v_page jsonb; v_item jsonb; v_ids bigint[] := '{}';
begin
  loop
    v_page := tests.read(null,null,v_cursor,20);
    for v_item in select value from jsonb_array_elements(v_page->'items') loop
      v_ids := array_append(v_ids,(v_item->>'id')::bigint);
    end loop;
    v_cursor := (v_page->>'next_cursor')::bigint;
    exit when v_cursor is null;
    if cardinality(v_ids)>300 then raise exception 'pagination_did_not_terminate'; end if;
  end loop;
  create temporary table traversed as select unnest(v_ids) id;
end $$;
select is((select count(*)::int from traversed),245,'all 245 movies reachable');
select is((select count(distinct id)::int from traversed),245,'no duplicate ids across pages');
select is((select count(*)::int from public.movies where id between 820001 and 820245 and publication_status='published'),82,'reads never publish drafts');
select * from finish();
rollback;
