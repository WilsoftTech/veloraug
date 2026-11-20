-- Local preparation only. Applying this migration to hosted requires separate authorization.
-- Roadmap E3 (progress persistence) and E5 (Continue Watching), movies only.
--
-- One row per (user, movie version): a VJ translation and each numbered part of a
-- film are separate versions, so resuming never jumps to another VJ or part.
--
-- Writes run as the caller (SECURITY INVOKER). Whether a version may be saved is
-- decided by the caller's own read policy on public.movie_versions, so progress
-- follows the current public catalogue rule without copying it here. Completion,
-- clamping and timestamps are computed by the trigger, never taken from a client.
begin;

create table public.viewing_progress (
  -- Defaults to the caller, so the app never sends (or is trusted with) a user id.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  movie_version_id bigint not null references public.movie_versions (id) on delete cascade,
  position_seconds integer not null
    constraint viewing_progress_position_check check (position_seconds between 0 and 86400),
  duration_seconds integer
    constraint viewing_progress_duration_check check (duration_seconds is null or duration_seconds between 1 and 86400),
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_version_id)
);

-- Continue Watching reads a user's most recent rows; the foreign key to versions needs its own index.
create index viewing_progress_user_recent_idx on public.viewing_progress (user_id, updated_at desc);
create index viewing_progress_movie_version_idx on public.viewing_progress (movie_version_id);

-- A film counts as watched once the remaining time is at most 5% of it (end credits).
-- The position never exceeds a known duration. Keep in sync with lib/playback/progress.ts.
create function private.viewing_progress_normalize()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.duration_seconds is not null and new.position_seconds > new.duration_seconds then
    new.position_seconds := new.duration_seconds;
  end if;
  new.completed := new.duration_seconds is not null and new.position_seconds * 20 >= new.duration_seconds * 19;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.viewing_progress_normalize() from public, anon, authenticated, service_role;

create trigger viewing_progress_normalize
  before insert or update on public.viewing_progress
  for each row execute function private.viewing_progress_normalize();

alter table public.viewing_progress enable row level security;

create policy "viewing_progress: read own"
  on public.viewing_progress for select to authenticated
  using ((select auth.uid()) = user_id);

-- The movie_versions subquery runs under that table's public read policy for the
-- caller: an unpublished, unready or uncleared version is invisible, so it cannot be saved.
create policy "viewing_progress: add own"
  on public.viewing_progress for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.movie_versions mv where mv.id = movie_version_id)
  );

create policy "viewing_progress: update own"
  on public.viewing_progress for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.movie_versions mv where mv.id = movie_version_id)
  );

-- Grants: nothing by default, then only what the app uses. Rows are never deleted
-- by clients (no remove control yet); account deletion cascades.
revoke all on table public.viewing_progress from public, anon, authenticated, service_role;
grant select (movie_version_id, position_seconds, duration_seconds, completed, updated_at)
  on public.viewing_progress to authenticated;
grant insert (movie_version_id, position_seconds, duration_seconds) on public.viewing_progress to authenticated;
grant update (position_seconds, duration_seconds) on public.viewing_progress to authenticated;
-- ON CONFLICT (user_id, movie_version_id) reads the conflict columns.
grant select (user_id) on public.viewing_progress to authenticated;

-- One idempotent upsert per save. The same arguments always leave the same row.
-- Returns whether the version now counts as watched.
create function public.record_movie_progress(p_movie_version_id bigint, p_position_seconds integer, p_duration_seconds integer)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_completed boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'progress_auth_required' using errcode = '42501';
  end if;
  if p_movie_version_id is null or p_movie_version_id <= 0
     or p_position_seconds is null or p_position_seconds not between 0 and 86400
     or (p_duration_seconds is not null and p_duration_seconds not between 1 and 86400) then
    raise exception 'progress_invalid_input' using errcode = '22023';
  end if;
  insert into public.viewing_progress as vp (movie_version_id, position_seconds, duration_seconds)
  values (p_movie_version_id, p_position_seconds, p_duration_seconds)
  on conflict (user_id, movie_version_id) do update
    set position_seconds = excluded.position_seconds,
        duration_seconds = coalesce(excluded.duration_seconds, vp.duration_seconds)
  returning vp.completed into v_completed;
  return v_completed;
end;
$$;
revoke all on function public.record_movie_progress(bigint, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.record_movie_progress(bigint, integer, integer) to authenticated;

commit;
