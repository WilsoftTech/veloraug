-- Velora UG catalogue identity baseline.
--
-- Canonical movies and series own metadata. VJ translations are separate
-- versions, so one title can be available from multiple VJs without copying
-- its metadata or hierarchy. This migration intentionally grants no client
-- access to the new catalogue: Phase B will add public read contracts only
-- after their readiness predicates and query paths exist.

-- ---------------------------------------------------------------------------
-- VJs and canonical titles
-- ---------------------------------------------------------------------------
create table public.vjs (
  id bigint generated always as identity primary key,
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null
    check (name = btrim(name) and char_length(name) between 1 and 100),
  description text
    check (description is null or char_length(description) <= 2000),
  avatar_url text
    check (avatar_url is null or char_length(avatar_url) <= 2048),
  badge_variant text not null default 'blue'
    check (badge_variant in ('blue', 'amber', 'emerald', 'violet', 'rose', 'slate')),
  is_active boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index vjs_name_lower_key on public.vjs (lower(name));
create index vjs_active_sort_idx on public.vjs (sort_order, id) where is_active;

create table public.movies (
  id bigint generated always as identity primary key,
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null
    check (title = btrim(title) and char_length(title) between 1 and 300),
  original_title text
    check (original_title is null or (original_title = btrim(original_title) and char_length(original_title) between 1 and 300)),
  overview text check (overview is null or char_length(overview) <= 10000),
  release_date date,
  runtime_minutes integer check (runtime_minutes is null or runtime_minutes > 0),
  poster_path text check (poster_path is null or char_length(poster_path) <= 2048),
  backdrop_path text check (backdrop_path is null or char_length(backdrop_path) <= 2048),
  tmdb_id integer unique check (tmdb_id is null or tmdb_id > 0),
  tmdb_vote_average numeric(3,1)
    check (tmdb_vote_average is null or tmdb_vote_average between 0 and 10),
  tmdb_vote_count integer check (tmdb_vote_count is null or tmdb_vote_count >= 0),
  metadata_status text not null default 'unmatched'
    check (metadata_status in ('unmatched', 'matched', 'reviewed')),
  metadata_synced_at timestamptz,
  publication_status text not null default 'draft'
    check (publication_status in ('draft', 'published', 'archived')),
  is_featured boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint movies_published_at_check
    check (publication_status <> 'published' or published_at is not null)
);

create index movies_published_cursor_idx
  on public.movies (published_at desc, id desc)
  where publication_status = 'published';
create index movies_featured_cursor_idx
  on public.movies (published_at desc, id desc)
  where publication_status = 'published' and is_featured;

create table public.series (
  id bigint generated always as identity primary key,
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null
    check (title = btrim(title) and char_length(title) between 1 and 300),
  original_title text
    check (original_title is null or (original_title = btrim(original_title) and char_length(original_title) between 1 and 300)),
  overview text check (overview is null or char_length(overview) <= 10000),
  first_air_date date,
  poster_path text check (poster_path is null or char_length(poster_path) <= 2048),
  backdrop_path text check (backdrop_path is null or char_length(backdrop_path) <= 2048),
  tmdb_id integer unique check (tmdb_id is null or tmdb_id > 0),
  tmdb_vote_average numeric(3,1)
    check (tmdb_vote_average is null or tmdb_vote_average between 0 and 10),
  tmdb_vote_count integer check (tmdb_vote_count is null or tmdb_vote_count >= 0),
  metadata_status text not null default 'unmatched'
    check (metadata_status in ('unmatched', 'matched', 'reviewed')),
  metadata_synced_at timestamptz,
  publication_status text not null default 'draft'
    check (publication_status in ('draft', 'published', 'archived')),
  is_featured boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint series_published_at_check
    check (publication_status <> 'published' or published_at is not null)
);

create index series_published_cursor_idx
  on public.series (published_at desc, id desc)
  where publication_status = 'published';
create index series_featured_cursor_idx
  on public.series (published_at desc, id desc)
  where publication_status = 'published' and is_featured;

-- ---------------------------------------------------------------------------
-- Series hierarchy
-- ---------------------------------------------------------------------------
create table public.seasons (
  id bigint generated always as identity primary key,
  series_id bigint not null references public.series (id) on delete restrict,
  season_number integer not null check (season_number >= 0),
  title text
    check (title is null or (title = btrim(title) and char_length(title) between 1 and 300)),
  overview text check (overview is null or char_length(overview) <= 10000),
  air_date date,
  poster_path text check (poster_path is null or char_length(poster_path) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seasons_series_number_key unique (series_id, season_number)
);

create table public.episodes (
  id bigint generated always as identity primary key,
  season_id bigint not null references public.seasons (id) on delete restrict,
  episode_number integer not null check (episode_number > 0),
  title text
    check (title is null or (title = btrim(title) and char_length(title) between 1 and 300)),
  overview text check (overview is null or char_length(overview) <= 10000),
  air_date date,
  runtime_minutes integer check (runtime_minutes is null or runtime_minutes > 0),
  still_path text check (still_path is null or char_length(still_path) <= 2048),
  tmdb_id integer unique check (tmdb_id is null or tmdb_id > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint episodes_season_number_key unique (season_id, episode_number)
);

-- ---------------------------------------------------------------------------
-- VJ-specific inventory. Media-provider references arrive in Checkpoint C.
-- ---------------------------------------------------------------------------
create table public.movie_versions (
  id bigint generated always as identity primary key,
  movie_id bigint not null references public.movies (id) on delete restrict,
  vj_id bigint not null references public.vjs (id) on delete restrict,
  title_override text
    check (title_override is null or (title_override = btrim(title_override) and char_length(title_override) between 1 and 300)),
  availability_status text not null default 'draft'
    check (availability_status in ('draft', 'ready', 'unavailable', 'archived')),
  rights_status text not null default 'unknown'
    check (rights_status in ('unknown', 'cleared', 'blocked')),
  available_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint movie_versions_movie_vj_key unique (movie_id, vj_id),
  constraint movie_versions_available_at_check
    check (availability_status <> 'ready' or available_at is not null)
);

create index movie_versions_vj_id_idx on public.movie_versions (vj_id);
create index movie_versions_public_lookup_idx
  on public.movie_versions (movie_id, vj_id)
  where availability_status = 'ready' and rights_status = 'cleared';

create table public.episode_versions (
  id bigint generated always as identity primary key,
  episode_id bigint not null references public.episodes (id) on delete restrict,
  vj_id bigint not null references public.vjs (id) on delete restrict,
  title_override text
    check (title_override is null or (title_override = btrim(title_override) and char_length(title_override) between 1 and 300)),
  availability_status text not null default 'draft'
    check (availability_status in ('draft', 'ready', 'unavailable', 'archived')),
  rights_status text not null default 'unknown'
    check (rights_status in ('unknown', 'cleared', 'blocked')),
  available_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint episode_versions_episode_vj_key unique (episode_id, vj_id),
  constraint episode_versions_available_at_check
    check (availability_status <> 'ready' or available_at is not null)
);

create index episode_versions_vj_id_idx on public.episode_versions (vj_id);
create index episode_versions_public_lookup_idx
  on public.episode_versions (episode_id, vj_id)
  where availability_status = 'ready' and rights_status = 'cleared';

-- ---------------------------------------------------------------------------
-- Genres
-- ---------------------------------------------------------------------------
create table public.genres (
  id bigint generated always as identity primary key,
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null
    check (name = btrim(name) and char_length(name) between 1 and 100),
  tmdb_movie_id integer unique check (tmdb_movie_id is null or tmdb_movie_id > 0),
  tmdb_tv_id integer unique check (tmdb_tv_id is null or tmdb_tv_id > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index genres_name_lower_key on public.genres (lower(name));

create table public.movie_genres (
  movie_id bigint not null references public.movies (id) on delete cascade,
  genre_id bigint not null references public.genres (id) on delete cascade,
  primary key (movie_id, genre_id)
);

create index movie_genres_genre_id_idx on public.movie_genres (genre_id, movie_id);

create table public.series_genres (
  series_id bigint not null references public.series (id) on delete cascade,
  genre_id bigint not null references public.genres (id) on delete cascade,
  primary key (series_id, genre_id)
);

create index series_genres_genre_id_idx on public.series_genres (genre_id, series_id);

-- Reuse the Phase 2 timestamp trigger function on mutable catalogue rows.
create trigger vjs_set_updated_at
  before update on public.vjs
  for each row execute function private.set_updated_at();
create trigger movies_set_updated_at
  before update on public.movies
  for each row execute function private.set_updated_at();
create trigger series_set_updated_at
  before update on public.series
  for each row execute function private.set_updated_at();
create trigger seasons_set_updated_at
  before update on public.seasons
  for each row execute function private.set_updated_at();
create trigger episodes_set_updated_at
  before update on public.episodes
  for each row execute function private.set_updated_at();
create trigger movie_versions_set_updated_at
  before update on public.movie_versions
  for each row execute function private.set_updated_at();
create trigger episode_versions_set_updated_at
  before update on public.episode_versions
  for each row execute function private.set_updated_at();
create trigger genres_set_updated_at
  before update on public.genres
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Legacy watchlist compatibility
-- ---------------------------------------------------------------------------
alter table public.watchlist_items
  add column movie_id bigint references public.movies (id) on delete restrict,
  add column series_id bigint references public.series (id) on delete restrict;

alter table public.watchlist_items
  alter column tmdb_id drop not null,
  drop constraint watchlist_items_media_type_check,
  add constraint watchlist_items_media_type_check
    check (media_type in ('movie', 'tv', 'series')),
  add constraint watchlist_items_identity_check
    check (
      (
        movie_id is null
        and series_id is null
        and tmdb_id is not null
        and media_type in ('movie', 'tv')
      )
      or (
        movie_id is not null
        and series_id is null
        and media_type = 'movie'
      )
      or (
        movie_id is null
        and series_id is not null
        and media_type = 'series'
      )
    );

create unique index watchlist_items_user_movie_key
  on public.watchlist_items (user_id, movie_id)
  where movie_id is not null;
create unique index watchlist_items_user_series_key
  on public.watchlist_items (user_id, series_id)
  where series_id is not null;
create index watchlist_items_movie_id_idx
  on public.watchlist_items (movie_id)
  where movie_id is not null;
create index watchlist_items_series_id_idx
  on public.watchlist_items (series_id)
  where series_id is not null;

-- Only unique canonical mappings are possible because each catalogue TMDB ID
-- is unique. Missing inventory remains a valid, removable legacy row.
update public.watchlist_items as watchlist
set movie_id = movie.id
from public.movies as movie
where watchlist.movie_id is null
  and watchlist.series_id is null
  and watchlist.media_type = 'movie'
  and watchlist.tmdb_id = movie.tmdb_id;

update public.watchlist_items as watchlist
set series_id = show.id,
    media_type = 'series'
from public.series as show
where watchlist.movie_id is null
  and watchlist.series_id is null
  and watchlist.media_type = 'tv'
  and watchlist.tmdb_id = show.tmdb_id;

-- Preserve the Phase 2 race-safe limit while recognizing both legacy and
-- internal identities. Unique constraints remain the final duplicate guard.
--
-- SECURITY DEFINER is required, not convenient: legacy-identity resolution and
-- the cross-format duplicate check below both read public.movies/public.series
-- by exact id/tmdb_id equality, but authenticated/anon hold no privilege on
-- those tables (Checkpoint B's catalogue stays deny-by-default; see
-- docs/VELORA_UG_SCHEMA_BASELINE.md). Granting SELECT on the catalogue tables
-- instead was rejected: it would expose the whole catalogue (including
-- unpublished/draft rows, since RLS on those tables has no policies yet) to
-- any authenticated request, not just this narrow id lookup. This function
-- never returns catalogue rows to the caller; it only ever assigns a looked-up
-- id into NEW.movie_id/NEW.series_id on the caller's own row, so the elevation
-- exposes nothing beyond "does this tmdb_id/id already exist" through the
-- resulting row the caller could already read. Same hardening as
-- private.handle_new_user and public.record_search: empty search_path, every
-- object schema-qualified, no dynamic SQL, EXECUTE revoked below.
create or replace function private.enforce_watchlist_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Old application clients still send TMDB identity. When that external ID
  -- already has a canonical mapping, normalize the insert before duplicate and
  -- limit checks so legacy and internal forms cannot create parallel saves.
  if new.movie_id is null and new.series_id is null and new.tmdb_id is not null then
    if new.media_type = 'movie' then
      select movie.id into new.movie_id
      from public.movies as movie
      where movie.tmdb_id = new.tmdb_id;
    elsif new.media_type = 'tv' then
      select show.id into new.series_id
      from public.series as show
      where show.tmdb_id = new.tmdb_id;

      if new.series_id is not null then
        new.media_type = 'series';
      end if;
    end if;
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

revoke all on function private.enforce_watchlist_limit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Security: deny by default until Phase B defines public catalogue reads.
-- ---------------------------------------------------------------------------
alter table public.vjs enable row level security;
alter table public.movies enable row level security;
alter table public.series enable row level security;
alter table public.seasons enable row level security;
alter table public.episodes enable row level security;
alter table public.movie_versions enable row level security;
alter table public.episode_versions enable row level security;
alter table public.genres enable row level security;
alter table public.movie_genres enable row level security;
alter table public.series_genres enable row level security;

revoke all on table
  public.vjs,
  public.movies,
  public.series,
  public.seasons,
  public.episodes,
  public.movie_versions,
  public.episode_versions,
  public.genres,
  public.movie_genres,
  public.series_genres
from public, anon, authenticated, service_role;

revoke all on sequence
  public.vjs_id_seq,
  public.movies_id_seq,
  public.series_id_seq,
  public.seasons_id_seq,
  public.episodes_id_seq,
  public.movie_versions_id_seq,
  public.episode_versions_id_seq,
  public.genres_id_seq
from public, anon, authenticated, service_role;
