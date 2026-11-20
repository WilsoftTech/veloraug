-- Read-only full-catalogue search. Existing mutation and publication gates are unchanged.
-- The definer boundary matches catalogue_admin_movies: explicit reviewer checks,
-- pinned search_path, no dynamic SQL, no Telegram or private media references.
create function public.catalogue_admin_movie_page(
  p_query text, p_status text, p_before_id bigint, p_limit integer
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
begin
  perform private.require_reviewer('any');
  if p_limit is null or p_limit not between 1 and 20
     or char_length(coalesce(p_query, '')) > 300
     or (p_status is not null and p_status not in ('draft', 'published', 'archived'))
     or (p_before_id is not null and p_before_id <= 0) then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  return (
    with selected as materialized (
      select m.* from public.movies m
      where (p_before_id is null or m.id < p_before_id)
        and (p_status is null or m.publication_status = p_status)
        and (v_query = '' or strpos(lower(m.title), v_query) > 0
          or strpos(extract(year from m.release_date)::integer::text, v_query) > 0
          or exists (
            select 1 from public.movie_versions mv join public.vjs v on v.id = mv.vj_id
            where mv.movie_id = m.id and strpos(lower(v.name), v_query) > 0
          ))
      order by m.id desc limit p_limit + 1
    ), page as (select * from selected order by id desc limit p_limit)
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'slug', m.slug, 'title', m.title, 'overview', m.overview,
        'release_year', extract(year from m.release_date)::integer, 'poster_path', m.poster_path,
        'publication_status', m.publication_status, 'is_featured', m.is_featured, 'published_at', m.published_at,
        'versions', coalesce((select jsonb_agg(jsonb_build_object(
          'id', mv.id, 'vj', v.name, 'availability_status', mv.availability_status, 'rights_status', mv.rights_status
        ) order by mv.id) from public.movie_versions mv join public.vjs v on v.id = mv.vj_id
          where mv.movie_id = m.id), '[]'::jsonb)
      ) order by m.id desc) from page m), '[]'::jsonb),
      'next_cursor', case when (select count(*) from selected) > p_limit
        then (select min(id)::text from page) else null end
    )
  );
end;
$$;

revoke all on function public.catalogue_admin_movie_page(text, text, bigint, integer)
  from public, anon, authenticated, service_role, velora_review_service, velora_discovery_worker;
grant execute on function public.catalogue_admin_movie_page(text, text, bigint, integer) to authenticated;
