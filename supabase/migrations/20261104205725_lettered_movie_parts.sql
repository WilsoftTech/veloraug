begin;

-- A/1 and B/2 name the same part slots. Identity still comes from confirmed metadata.
create or replace function private.movie_file_part(p_name text,p_title text,p_year integer)
returns smallint language plpgsql immutable security invoker set search_path='' as $$
declare v_name text; v_match text[];
begin
 if p_name is null or p_title is null then return 0;end if;
 v_name:=pg_catalog.lower(pg_catalog.regexp_replace(p_name,'\.[a-zA-Z0-9]{2,5}$',''));
 v_name:=pg_catalog.regexp_replace(v_name,'[^[:alnum:] ]+',' ','g');
 v_name:=pg_catalog.regexp_replace(v_name,'\s+',' ','g');
 v_name:=pg_catalog.regexp_replace(v_name,'\s+vj\s.*$','','i');
 if p_year is not null then v_name:=pg_catalog.regexp_replace(v_name,'(^| )'||p_year::text||'( |$)',' ','g');end if;
 v_name:=pg_catalog.btrim(pg_catalog.regexp_replace(v_name,'\s+',' ','g'));
 if private.catalogue_slug(v_name)=private.catalogue_slug(p_title) then return 0;end if;
 v_match:=pg_catalog.regexp_match(v_name,'^(.*?)\s+(?:(?:part|pt)\s*)?([0-9]{1,2}|[a-z])$');
 if v_match is null or private.catalogue_slug(v_match[1])<>private.catalogue_slug(p_title) then return 0;end if;
 if v_match[2] ~ '^[a-z]$' then return (pg_catalog.ascii(v_match[2])-pg_catalog.ascii('a')+1)::smallint;end if;
 return v_match[2]::smallint;
end;
$$;
revoke all on function private.movie_file_part(text,text,integer)
 from public,anon,authenticated,service_role,velora_review_service,velora_discovery_worker,velora_media_gateway;

-- Preserve numbered bindings, curated titles and all source files. Never merge an alias collision.
with recognized as (
 select mv.id,mv.movie_id,mv.vj_id,greatest(
 private.movie_file_part(t.file_name,m.title,extract(year from m.release_date)::integer),
 private.movie_file_part(t.file_name,m.original_title,extract(year from m.release_date)::integer)) as part
 from public.movie_versions mv join public.movies m on m.id=mv.movie_id
 join private.telegram_media t on t.id=mv.telegram_media_id where mv.part_number=0
)
update public.movie_versions mv set part_number=r.part
from recognized r where mv.id=r.id and r.part>0 and not exists (
 select 1 from public.movie_versions other where other.movie_id=r.movie_id and other.vj_id=r.vj_id and other.part_number=r.part and other.id<>r.id
);
update public.movie_versions mv set title_override=m.title||' — Part '||mv.part_number::text
from public.movies m where m.id=mv.movie_id and mv.part_number>0 and mv.title_override is null;
commit;
