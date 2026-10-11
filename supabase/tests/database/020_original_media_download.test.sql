begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(25);
select has_function('media_gateway','resolve_movie_download',array['bigint','uuid'],'typed download RPC');
select is((select prosecdef from pg_proc where oid='media_gateway.resolve_movie_download(bigint,uuid)'::regprocedure),true,'definer reviewed');
select is((select proconfig from pg_proc where oid='media_gateway.resolve_movie_download(bigint,uuid)'::regprocedure),array['search_path=""'],'empty search path');
select is((select pg_get_userbyid(proowner) from pg_proc where oid='media_gateway.resolve_movie_download(bigint,uuid)'::regprocedure),'postgres','owner');
select ok(has_function_privilege('velora_media_gateway','media_gateway.resolve_movie_download(bigint,uuid)','EXECUTE'),'gateway executes');
select ok(not has_function_privilege('public','media_gateway.resolve_movie_download(bigint,uuid)','EXECUTE'),'PUBLIC denied');
select ok(not has_function_privilege('anon','media_gateway.resolve_movie_download(bigint,uuid)','EXECUTE'),'anon denied');
select ok(not has_function_privilege('authenticated','media_gateway.resolve_movie_download(bigint,uuid)','EXECUTE'),'authenticated denied');
select ok(not has_function_privilege('service_role','media_gateway.resolve_movie_download(bigint,uuid)','EXECUTE'),'service role denied');
select ok(not has_schema_privilege('velora_media_gateway','auth','USAGE'),'gateway cannot read auth schema');
select ok(not has_table_privilege('velora_media_gateway','auth.users','SELECT'),'gateway cannot read user rows');

delete from private.telegram_channels where bot_type='movie';
insert into private.telegram_channels(bot_type,chat_id) values('movie',-1006665554444);
insert into auth.users(id,is_anonymous) values('00000000-0000-4000-8000-000000000051',false);
insert into public.vjs(slug,name,is_active) values('cp5-vj','Synthetic VJ',true);
insert into public.movies(slug,title,publication_status,published_at) values('cp5-film','Synthetic film','published',now());
insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,mime_type,file_size_bytes,file_name,telegram_date)
values('movie',-1006665554444,5001,'synthetic-cp5-id','synthetic-cp5-unique','document','video/x-matroska',10000,'Original é.MKV',now());
insert into public.movie_versions(movie_id,vj_id,availability_status,rights_status,available_at,telegram_media_id)
select m.id,v.id,'ready','cleared',now(),t.id from public.movies m,public.vjs v,private.telegram_media t
where m.slug='cp5-film' and v.slug='cp5-vj' and t.file_unique_id='synthetic-cp5-unique';
create temporary table cp5_version as select id from public.movie_versions where movie_id=(select id from public.movies where slug='cp5-film');
select results_eq($$select file_name,mime_type,file_size_bytes from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,
  $$values('Original é.MKV'::text,'video/x-matroska'::text,10000::bigint)$$,'exact original filename and MKV MIME');
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000099')$$,'unknown user denied');
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),null)$$,'missing subject denied');
update auth.users set banned_until=now()+interval '1 day' where id='00000000-0000-4000-8000-000000000051';
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'revoked user denied');
update auth.users set banned_until=null,deleted_at=now() where id='00000000-0000-4000-8000-000000000051';
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'deleted user denied');
update auth.users set deleted_at=null,is_anonymous=true where id='00000000-0000-4000-8000-000000000051';
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'anonymous identity denied');
update auth.users set is_anonymous=false where id='00000000-0000-4000-8000-000000000051';
update public.movies set publication_status='draft' where slug='cp5-film';
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'unpublished denied');
update public.movies set publication_status='published' where slug='cp5-film';
update public.movie_versions set rights_status='blocked' where id=(select id from cp5_version);
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'revoked rights denied');
update public.movie_versions set rights_status='cleared' where id=(select id from cp5_version);
update public.vjs set is_active=false where slug='cp5-vj';
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'inactive VJ denied');
update public.vjs set is_active=true where slug='cp5-vj';
update private.telegram_media set mime_type='video/mp4',file_name='Original Film.MP4' where file_unique_id='synthetic-cp5-unique';
select is((select file_name from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')),'Original Film.MP4','MP4 preserved');
update private.telegram_media set file_name=null where file_unique_id='synthetic-cp5-unique';
select is((select file_name from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')),null,'historical missing filename delegated to safe gateway fallback');
update private.telegram_media set mime_type='video/webm' where file_unique_id='synthetic-cp5-unique';
select is_empty($$select * from media_gateway.resolve_movie_download((select id from cp5_version),'00000000-0000-4000-8000-000000000051')$$,'other containers denied');
insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,mime_type,file_size_bytes,telegram_date)
values('movie',-1006665554444,5002,'synthetic-big-id','synthetic-big-unique','document','video/mp4',2097152001,now());
insert into public.movies(slug,title,publication_status,published_at) values('cp5-big','Synthetic oversized','published',now());
insert into public.movie_versions(movie_id,vj_id,availability_status,rights_status,available_at,telegram_media_id)
select m.id,v.id,'ready','cleared',now(),t.id from public.movies m,public.vjs v,private.telegram_media t
where m.slug='cp5-big' and v.slug='cp5-vj' and t.file_unique_id='synthetic-big-unique';
select is_empty($$select * from media_gateway.resolve_movie_download((select mv.id from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.slug='cp5-big'),'00000000-0000-4000-8000-000000000051')$$,'upload ceiling preserved');
select is((select count(*)::integer from media_gateway.resolve_movie_version((select id from cp5_version))),1,'legacy streaming RPC remains unchanged');
select * from finish();
rollback;
