-- Movie viewing progress (20261117203000_movie_viewing_progress.sql): grants, own-row
-- isolation, the published-version rule, server-side completion and clamping,
-- idempotent upserts and cascade. Everything runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

create schema tests;
-- Runs a statement as a role and user; returns its text result or "SQLSTATE: message".
create function tests.as_role(p_role text, p_user uuid, p_sql text) returns text
language plpgsql set search_path = '' as $$
declare v text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', p_role, 'sub', p_user)::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    return sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  return coalesce(v, 'null');
end $$;
create function tests.record(p_user uuid, p_version bigint, p_position integer, p_duration integer) returns text
language sql set search_path = '' as $$
  select tests.as_role('authenticated', p_user,
    format('select public.record_movie_progress(%s, %s, %s)::text', p_version, p_position, coalesce(p_duration::text, 'null')))
$$;
create function tests.row_of(p_user uuid, p_version bigint) returns text language sql set search_path = '' as $$
  select position_seconds || '/' || coalesce(duration_seconds::text, '-') || '/' || completed
  from public.viewing_progress where user_id = p_user and movie_version_id = p_version
$$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000e1', 'viewer-one@synthetic.invalid'),
  ('00000000-0000-4000-8000-0000000000e2', 'viewer-two@synthetic.invalid');

-- A published movie with a ready, cleared version (public) and an unready one; a draft movie.
insert into public.vjs (slug, name, is_active) values ('vj-progress', 'VJ Progress', true), ('vj-progress-b', 'VJ Progress B', true);
insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date)
values ('movie', -1, 901, 'pf1', 'pu1', 'video', now()), ('movie', -1, 902, 'pf2', 'pu2', 'video', now()),
       ('movie', -1, 903, 'pf3', 'pu3', 'video', now());
insert into public.movies (slug, title, publication_status, published_at) values
  ('progress-published', 'Progress Published', 'published', now()),
  ('progress-draft', 'Progress Draft', 'draft', null);
insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
select m.id, v.id, 'ready', 'cleared', now(), t.id from public.movies m, public.vjs v, private.telegram_media t
where (m.slug, v.slug, t.file_unique_id) in (('progress-published', 'vj-progress', 'pu1'), ('progress-draft', 'vj-progress', 'pu3'));
insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status)
select m.id, v.id, 'draft', 'unknown' from public.movies m, public.vjs v
where m.slug = 'progress-published' and v.slug = 'vj-progress-b';

create table tests.ids as select
  (select mv.id from public.movie_versions mv join public.movies m on m.id = mv.movie_id join public.vjs v on v.id = mv.vj_id
   where m.slug = 'progress-published' and v.slug = 'vj-progress') as public_version,
  (select mv.id from public.movie_versions mv join public.vjs v on v.id = mv.vj_id where v.slug = 'vj-progress-b') as unready_version,
  (select mv.id from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.slug = 'progress-draft') as draft_version;
create function tests.v(p text) returns bigint language plpgsql set search_path = '' as $$
declare r bigint; begin execute format('select %I from tests.ids', p) into r; return r; end $$;

-- ---------------------------------------------------------------------------
-- Structure, grants and function properties
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.viewing_progress'::regclass), 'RLS is enabled');
select is((select array_agg(p order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
           where has_table_privilege('anon', 'public.viewing_progress', p)
              or (p in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege('anon', 'public.viewing_progress', p))),
  null, 'anon has no privilege on the table or its columns');
select is((select array_agg(p order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
           where has_table_privilege('service_role', 'public.viewing_progress', p)
              or (p in ('SELECT','INSERT','UPDATE','REFERENCES') and has_any_column_privilege('service_role', 'public.viewing_progress', p))),
  null, 'service_role has no privilege on the table or its columns');
select ok(not has_table_privilege('authenticated', 'public.viewing_progress', 'DELETE'), 'clients cannot delete progress');
select is((select array_agg(c order by c) from unnest(array['user_id','movie_version_id','position_seconds','duration_seconds','completed','updated_at']) c
           where has_column_privilege('authenticated', 'public.viewing_progress', c, 'INSERT')),
  array['duration_seconds','movie_version_id','position_seconds'], 'clients insert only the version, position and duration');
select is((select array_agg(c order by c) from unnest(array['user_id','movie_version_id','position_seconds','duration_seconds','completed','updated_at']) c
           where has_column_privilege('authenticated', 'public.viewing_progress', c, 'UPDATE')),
  array['duration_seconds','position_seconds'], 'clients update only the position and duration');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc
           where oid = 'public.record_movie_progress(bigint,integer,integer)'::regprocedure),
  'record_movie_progress is SECURITY INVOKER with an empty search_path');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc
           where oid = 'private.viewing_progress_normalize()'::regprocedure),
  'the normalize trigger function is SECURITY INVOKER with an empty search_path');
select is((select array_agg(r order by r) from unnest(array['anon','authenticated','service_role']) r
           where has_function_privilege(r, 'public.record_movie_progress(bigint,integer,integer)', 'EXECUTE')),
  array['authenticated'], 'only authenticated may execute record_movie_progress');
select ok(not exists (select 1 from aclexplode((select proacl from pg_proc where oid = 'public.record_movie_progress(bigint,integer,integer)'::regprocedure)) a where a.grantee = 0),
  'record_movie_progress grants nothing to PUBLIC');
select is((select array_agg(r order by r) from unnest(array['anon','authenticated','service_role']) r
           where has_function_privilege(r, 'private.viewing_progress_normalize()', 'EXECUTE')),
  null, 'the trigger function is not executable by API roles');

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 600, 6000), 'false', 'a public version is saved and is not yet watched');
select is(tests.row_of('00000000-0000-4000-8000-0000000000e1', tests.v('public_version')), '600/6000/false', 'the row holds the position and duration');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 600, 6000), 'false', 'the same save again is accepted');
select is((select count(*)::int from public.viewing_progress where user_id = '00000000-0000-4000-8000-0000000000e1'), 1, 'repeated saves keep one row (idempotent)');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 1200, null), 'false', 'a save without duration is accepted');
select is(tests.row_of('00000000-0000-4000-8000-0000000000e1', tests.v('public_version')), '1200/6000/false', 'an unknown duration keeps the known one');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 5699, 6000), 'false', 'more than 5% left: not watched');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 5700, 6000), 'true', 'at most 5% left: watched');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 9000, 6000), 'true', 'a position past the end is accepted');
select is(tests.row_of('00000000-0000-4000-8000-0000000000e1', tests.v('public_version')), '6000/6000/true', 'a position past the end is clamped to the duration');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 30, 6000), 'false', 'watching again from the start clears completion');
select is(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 30, null), 'false', 'a later save without duration is judged against the recorded one');

-- Unpublished, unready or unknown versions are refused by the caller's own read policy.
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('draft_version'), 10, 100), '^42501: new row violates row-level security', 'a draft movie''s version is refused');
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('unready_version'), 10, 100), '^42501: new row violates row-level security', 'an unready version is refused');
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', 999999999, 10, 100), '^42501: new row violates row-level security', 'an unknown version is refused');
select is((select count(*)::int from public.viewing_progress where movie_version_id in (tests.v('draft_version'), tests.v('unready_version'))), 0, 'nothing was stored for refused versions');

-- Input bounds.
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), -1, 100), '^22023: progress_invalid_input', 'a negative position is refused');
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 86401, null), '^22023: progress_invalid_input', 'a position over 24 h is refused');
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 10, 0), '^22023: progress_invalid_input', 'a zero duration is refused');
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', 0, 10, 100), '^22023: progress_invalid_input', 'a zero version id is refused');
select matches(tests.as_role('authenticated', null, 'select public.record_movie_progress(1, 10, 100)::text'), '^42501: progress_auth_required', 'a session without a user is refused');
select matches(tests.as_role('anon', null, format('select public.record_movie_progress(%s, 10, 100)::text', tests.v('public_version'))), '^42501: permission denied', 'anon cannot execute');

-- ---------------------------------------------------------------------------
-- Isolation and direct table access
-- ---------------------------------------------------------------------------
select is(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e2', 'select count(*)::text from public.viewing_progress'), '0', 'another user sees none of the first user''s rows');
select is(tests.record('00000000-0000-4000-8000-0000000000e2', tests.v('public_version'), 100, 6000), 'false', 'another user saves the same version');
select is(tests.row_of('00000000-0000-4000-8000-0000000000e1', tests.v('public_version')), '30/6000/false', 'that save does not touch the first user''s row');
select is(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e2', 'select count(*)::text from public.viewing_progress'), '1', 'each user reads only their own row');
select matches(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e2',
  format('insert into public.viewing_progress (user_id, movie_version_id, position_seconds) values (%L, %s, 1) returning 1', '00000000-0000-4000-8000-0000000000e1', tests.v('public_version'))),
  '^42501: permission denied', 'a client cannot choose the user id');
select matches(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e1', 'update public.viewing_progress set completed = true returning 1'),
  '^42501: permission denied', 'a client cannot set completion directly');
select matches(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e1', 'delete from public.viewing_progress returning 1'),
  '^42501: permission denied', 'a client cannot delete progress');
select is(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e2',
  format('update public.viewing_progress set position_seconds = 1 where user_id = %L returning 1', '00000000-0000-4000-8000-0000000000e1')),
  'null', 'a direct update cannot reach another user''s row');
select is(tests.row_of('00000000-0000-4000-8000-0000000000e1', tests.v('public_version')), '30/6000/false', 'the first user''s row is unchanged');
select is(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e1',
  format('update public.viewing_progress set position_seconds = 5900 where movie_version_id = %s returning completed::text', tests.v('public_version'))),
  'true', 'a direct update of one''s own row still has completion computed by the database');

-- A version withdrawn from the catalogue can no longer be written, though its row remains readable to its owner.
update public.movie_versions set availability_status = 'unavailable' where id = tests.v('public_version');
select matches(tests.record('00000000-0000-4000-8000-0000000000e1', tests.v('public_version'), 40, 6000), '^42501: new row violates row-level security', 'a withdrawn version is no longer saved');
select is(tests.as_role('authenticated', '00000000-0000-4000-8000-0000000000e1', 'select count(*)::text from public.viewing_progress'), '1', 'its existing row remains readable to its owner');

-- Deleting an account removes its progress.
delete from auth.users where id = '00000000-0000-4000-8000-0000000000e2';
select is((select count(*)::int from public.viewing_progress where user_id = '00000000-0000-4000-8000-0000000000e2'), 0, 'account deletion cascades to progress');

select * from finish();
rollback;
