-- Velora UG roadmap B4: internal catalogue ids are canonical watchlist identity,
-- and a new save may only point at a title that is public right now.
-- Decision and evidence: docs/PHASE_B_CATALOGUE_DESIGN.md, "B4 result".
--
-- Before this migration a signed-in client that bypassed the app could store
-- any existing movie_id/series_id, including drafts, and a legacy TMDB save was
-- normalized onto a draft title's id. Either way the caller learned that an
-- unpublished title existed. The app itself already refused unpublished ids.
--
-- Changes to private.enforce_watchlist_limit() (everything else is unchanged:
-- duplicate suppression across forms, the per-user advisory lock and the
-- 500-row cap):
--   1. A legacy TMDB save is normalized only onto a public title. Otherwise it
--      stays a legacy tmdb_id row, which reads resolve later once the title is
--      published.
--   2. Any internal id on a new row must satisfy the B-2 visibility predicate
--      (catalogue_access.*_is_public). Unknown and unpublished ids fail
--      identically (23503, raised before the FK check), so the error is not an
--      existence oracle.
-- The rules apply at insert time only. Existing rows are never removed when a
-- title's availability later changes. Watchlist rows have no UPDATE grant.
--
-- SECURITY DEFINER stays required, for the reason given in
-- 20260922080911_velora_ug_catalogue_baseline.sql: the function reads catalogue
-- rows that clients cannot, and it returns nothing to the caller beyond the
-- accept/reject outcome of the caller's own insert. No grant changes: clients
-- gain no catalogue privilege, no column is exposed, and the catalogue_access
-- predicates are called as the function owner.

create or replace function private.enforce_watchlist_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Old application clients still send TMDB identity. When that external ID
  -- maps to a public catalogue title, normalize the insert before duplicate and
  -- limit checks so legacy and internal forms cannot create parallel saves.
  if new.movie_id is null and new.series_id is null and new.tmdb_id is not null then
    if new.media_type = 'movie' then
      select movie.id into new.movie_id
      from public.movies as movie
      where movie.tmdb_id = new.tmdb_id
        and catalogue_access.movie_is_public(movie.id);
    elsif new.media_type = 'tv' then
      select show.id into new.series_id
      from public.series as show
      where show.tmdb_id = new.tmdb_id
        and catalogue_access.series_is_public(show.id);

      if new.series_id is not null then
        new.media_type = 'series';
      end if;
    end if;
  end if;

  -- Canonical identity must name a public title at save time.
  if (new.movie_id is not null and not catalogue_access.movie_is_public(new.movie_id))
     or (new.series_id is not null and not catalogue_access.series_is_public(new.series_id)) then
    raise exception 'Title is not available' using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.watchlist_items as existing
    where existing.user_id = new.user_id
      and (
        (new.movie_id is not null and existing.movie_id = new.movie_id)
        or (new.series_id is not null and existing.series_id = new.series_id)
        or (
          new.movie_id is null
          and new.series_id is null
          and existing.movie_id is null
          and existing.series_id is null
          and existing.media_type = new.media_type
          and existing.tmdb_id = new.tmdb_id
        )
        or (
          new.movie_id is not null
          and existing.movie_id is null
          and existing.series_id is null
          and existing.media_type = 'movie'
          and existing.tmdb_id = (
            select movie.tmdb_id from public.movies as movie where movie.id = new.movie_id
          )
        )
        or (
          new.series_id is not null
          and existing.movie_id is null
          and existing.series_id is null
          and existing.media_type = 'tv'
          and existing.tmdb_id = (
            select show.tmdb_id from public.series as show where show.id = new.series_id
          )
        )
      )
  ) then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('velora.watchlist:' || new.user_id::text, 0));

  if (select count(*) from public.watchlist_items where user_id = new.user_id) >= 500 then
    raise exception 'Watchlist limit reached' using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Privilege audit (AGENTS.md invariant). CREATE OR REPLACE keeps the owner
-- (postgres) and ACL; restated explicitly: trigger-only, no client EXECUTE.
revoke all on function private.enforce_watchlist_limit() from public, anon, authenticated, service_role;
