-- Velora UG: admin dashboard actions.
--
-- The operator asked (2026-10-11) for approval, publication and catalogue
-- management as dashboard buttons. E3.8A kept approval and publication out of
-- the Data API; this migration reverses that placement, and only that.
--
-- What does not change: who may act, and when.
--   * Every command here takes the caller from the session (auth.uid()), never
--     from an argument, and requires the capability private.catalogue_reviewers
--     grants that account. A browser cannot name another reviewer.
--   * Approval and publication delegate to the existing catalogue_review
--     functions, which check the capability again and re-evaluate every gate
--     (identity, VJ, verified media, revision-bound rights, relationship) inside
--     the transaction that writes the catalogue. No gate is added, removed or
--     relaxed. velora_review_service and the owner keep their psql path.
--
-- What is new:
--   1. private.catalogue_admin_audit: append-only record of catalogue changes.
--   2. discovery_review_capabilities: the caller's own three capabilities, so
--      the dashboard offers only what the account may do.
--   3. discovery_review_approve / discovery_review_publish: session-bound
--      wrappers (review / publish capability).
--   4. catalogue_admin_movies: every movie with its state (any capability),
--      including withdrawn titles the public read hides.
--   5. catalogue_admin_set_movie: withdraw, restore, feature, unfeature (publish).
--   6. catalogue_admin_edit_movie: title and overview (publish).
--   7. catalogue_admin_add_vj: a new active VJ (publish).
--
-- A withdrawn movie is `archived`: the public read policies, the stream
-- eligibility check and the media gateway resolver already require
-- `published`, so withdrawal hides it and stops playback without touching its
-- versions, media or rights.

-- ---------------------------------------------------------------------------
-- 1. Audit of catalogue changes
-- ---------------------------------------------------------------------------
create table private.catalogue_admin_audit (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null check (action ~ '^[a-z0-9_]{1,60}$'),
  subject_kind text not null check (subject_kind in ('movie', 'vj')),
  subject_id bigint not null,
  detail text check (detail is null or char_length(detail) between 1 and 300),
  created_at timestamptz not null default now()
);

create index catalogue_admin_audit_subject_idx on private.catalogue_admin_audit (subject_kind, subject_id, id);

create trigger catalogue_admin_audit_append_only
  before update or delete on private.catalogue_admin_audit
  for each row execute function private.guard_append_only();

-- ---------------------------------------------------------------------------
-- 2. The caller's own capabilities
-- ---------------------------------------------------------------------------
-- All false for anyone who is not an enrolled, non-anonymous reviewer. Reveals
-- nothing about any other account.
create function public.discovery_review_capabilities()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'review', private.reviewer_has(auth.uid(), 'review'),
    'rights', private.reviewer_has(auth.uid(), 'rights'),
    'publish', private.reviewer_has(auth.uid(), 'publish'))
$$;

-- ---------------------------------------------------------------------------
-- 3. Approval and publication for the signed-in reviewer
-- ---------------------------------------------------------------------------
create function public.discovery_review_approve(p_key text, p_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('review');
begin
  return catalogue_review.approve_channel_candidate(p_key, p_revision, v_uid);
end;
$$;

create function public.discovery_review_publish(p_key text, p_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('publish');
begin
  return catalogue_review.publish_channel_candidate(p_key, p_revision, v_uid);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Catalogue management
-- ---------------------------------------------------------------------------
-- Every movie, newest first, with the state the public read does not show.
-- No Telegram reference and no private media field.
create function public.catalogue_admin_movies(p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_reviewer('any');
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', m.id, 'slug', m.slug, 'title', m.title, 'overview', m.overview,
        'release_year', extract(year from m.release_date)::integer, 'poster_path', m.poster_path,
        'publication_status', m.publication_status, 'is_featured', m.is_featured, 'published_at', m.published_at,
        'versions', coalesce((
          select jsonb_agg(jsonb_build_object('id', mv.id, 'vj', v.name, 'availability_status', mv.availability_status,
                                              'rights_status', mv.rights_status) order by mv.id)
          from public.movie_versions mv join public.vjs v on v.id = mv.vj_id where mv.movie_id = m.id), '[]'::jsonb))
      order by m.id desc)
    from (select * from public.movies x order by x.id desc limit p_limit) m), '[]'::jsonb);
end;
$$;

-- Withdraws a published movie from the site, restores a withdrawn one, or
-- changes whether it is featured. Never creates a publication: only a movie
-- that was published before can be restored.
create function public.catalogue_admin_set_movie(p_movie_id bigint, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('publish');
  v_movie public.movies%rowtype;
begin
  if p_movie_id is null or p_action is null or p_action not in ('withdraw', 'restore', 'feature', 'unfeature') then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  select m.* into v_movie from public.movies m where m.id = p_movie_id for update;
  if not found then
    raise exception 'catalogue_not_found' using errcode = 'P0001';
  end if;
  if (p_action = 'withdraw' and v_movie.publication_status <> 'published')
     or (p_action = 'restore' and (v_movie.publication_status <> 'archived' or v_movie.published_at is null))
     or (p_action in ('feature', 'unfeature') and v_movie.publication_status <> 'published') then
    raise exception 'catalogue_illegal_transition' using errcode = 'P0001';
  end if;
  update public.movies m
  set publication_status = case p_action when 'withdraw' then 'archived' when 'restore' then 'published' else m.publication_status end,
      is_featured = case p_action when 'feature' then true when 'unfeature' then false when 'withdraw' then false else m.is_featured end
  where m.id = p_movie_id
  returning m.* into v_movie;
  insert into private.catalogue_admin_audit (actor, action, subject_kind, subject_id)
  values (v_uid, 'movie_' || p_action, 'movie', p_movie_id);
  return jsonb_build_object('id', v_movie.id, 'slug', v_movie.slug, 'publication_status', v_movie.publication_status, 'is_featured', v_movie.is_featured);
end;
$$;

-- Corrects the displayed title and overview. The slug (the page address) and
-- the TMDB identity never change here.
create function public.catalogue_admin_edit_movie(p_movie_id bigint, p_title text, p_overview text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('publish');
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_overview text := nullif(pg_catalog.btrim(coalesce(p_overview, '')), '');
  v_movie public.movies%rowtype;
begin
  if p_movie_id is null or char_length(v_title) not between 1 and 300 or char_length(coalesce(v_overview, '')) > 10000 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  update public.movies m set title = v_title, overview = v_overview where m.id = p_movie_id returning m.* into v_movie;
  if not found then
    raise exception 'catalogue_not_found' using errcode = 'P0001';
  end if;
  insert into private.catalogue_admin_audit (actor, action, subject_kind, subject_id)
  values (v_uid, 'movie_edited', 'movie', p_movie_id);
  return jsonb_build_object('id', v_movie.id, 'slug', v_movie.slug, 'title', v_movie.title);
end;
$$;

-- Adds an active VJ. The name is stored in the house form "VJ <name>" and the
-- slug follows from it; an existing VJ of the same name or slug is refused.
create function public.catalogue_admin_add_vj(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_reviewer('publish');
  v_rest text := pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '^vj(?:[ ._-]+|$)', '', 'i'));
  v_name text;
  v_slug text;
  v_id bigint;
begin
  v_name := 'VJ ' || v_rest;
  v_slug := private.catalogue_slug(v_name);
  if char_length(v_rest) not between 1 and 96 or private.catalogue_slug(v_rest) = '' then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.vjs v where v.slug = v_slug or pg_catalog.lower(v.name) = pg_catalog.lower(v_name)) then
    raise exception 'catalogue_vj_exists' using errcode = 'P0001';
  end if;
  insert into public.vjs (slug, name, is_active, sort_order)
  values (v_slug, v_name, true, coalesce((select max(v.sort_order) + 1 from public.vjs v), 0))
  returning id into v_id;
  insert into private.catalogue_admin_audit (actor, action, subject_kind, subject_id, detail)
  values (v_uid, 'vj_added', 'vj', v_id, v_slug);
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'name', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Privileges (AGENTS.md migration privilege invariant)
-- ---------------------------------------------------------------------------
alter table private.catalogue_admin_audit enable row level security;

revoke all on table private.catalogue_admin_audit from public, anon, authenticated, service_role;
revoke all on sequence private.catalogue_admin_audit_id_seq from public, anon, authenticated, service_role;

-- Reviewer commands: authenticated only. Each checks private.catalogue_reviewers
-- for the session's own account; an account with no capability gets nothing.
revoke all on function
  public.discovery_review_capabilities(),
  public.discovery_review_approve(text, integer),
  public.discovery_review_publish(text, integer),
  public.catalogue_admin_movies(integer),
  public.catalogue_admin_set_movie(bigint, text),
  public.catalogue_admin_edit_movie(bigint, text, text),
  public.catalogue_admin_add_vj(text)
from public, anon, authenticated, service_role;

grant execute on function
  public.discovery_review_capabilities(),
  public.discovery_review_approve(text, integer),
  public.discovery_review_publish(text, integer),
  public.catalogue_admin_movies(integer),
  public.catalogue_admin_set_movie(bigint, text),
  public.catalogue_admin_edit_movie(bigint, text, text),
  public.catalogue_admin_add_vj(text)
to authenticated;
