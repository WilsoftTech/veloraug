-- Admin dashboard actions (20261011081425_admin_dashboard_actions.sql).
--
-- Approval, publication and catalogue management are now reachable from a
-- reviewer's own session. Proven here: the caller always comes from the
-- session, each command needs its capability, the existing gates still decide
-- approval and publication, and withdrawal hides a movie from the public read.
-- Fake ids only. Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(65);

create schema tests;
grant usage on schema tests to service_role, authenticated, anon;
create function tests.hex(p text) returns text language sql immutable as $$ select md5(p) || md5(p || '#') $$;
create function tests.as_role(p_role text, p_claims jsonb, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
  exception when others then
    reset role;
    return sqlerrm;
  end;
  reset role;
  return coalesce(v, 'null');
end $$;
create function tests.claims(p_user uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object('sub', p_user, 'role', 'authenticated', 'is_anonymous', false) $$;
create function tests.as_user(p_user text, p_sql text) returns text language sql as $$
  select tests.as_role('authenticated', tests.claims(('00000000-0000-4000-8000-0000000000' || p_user)::uuid), p_sql) $$;
create function tests.key(p_message bigint) returns text language sql as $$ select private.discovery_message_key(-1001111111111, p_message) $$;
create function tests.vj() returns bigint language sql as $$ select id from public.vjs where slug = 'vj-admin-test' $$;
create function tests.movie() returns bigint language sql as $$ select id from public.movies where tmdb_id = 9830001 $$;
-- One synthetic document, inspected; `p_verified` decides whether it carries verified media evidence.
create function tests.candidate(p_message bigint, p_tmdb integer, p_verified boolean) returns text language plpgsql as $$
declare v_claim jsonb;
begin
  perform public.discovery_receive('00000000-0000-4000-8000-0000000000d1', -1001111111111, jsonb_build_array(jsonb_build_object(
    'key', 'u:' || p_message, 'digest', tests.hex('d' || p_message), 'update_id', p_message, 'withdrawn_message_id', null,
    'event', jsonb_build_object('event_id', tests.hex('e' || p_message), 'payload_digest', tests.hex('p' || p_message), 'kind', 'channel_post',
      'message_id', p_message, 'observed_at', 1760000000 + p_message, 'date', 1760000000 + p_message, 'file_id', 'synthetic-file-' || p_message,
      'file_unique_id', 'AgADadmin' || p_message, 'size', 1048576 + p_message, 'name', 'Admin.Movie.2024.VJ.Test.mp4', 'mime', 'video/mp4', 'caption', null))), null);
  v_claim := public.discovery_claim(30);
  return public.discovery_complete(tests.key(p_message), (v_claim->>'lease')::uuid, 1, jsonb_build_object(
    'outcome', 'review', 'error_code', null, 'title', 'Admin Movie', 'year', 2024, 'vj_text', 'Test', 'vj_id', tests.vj(), 'warnings', '[]'::jsonb,
    'identity_state', 'proposed', 'proposed_tmdb_id', p_tmdb,
    'candidates', jsonb_build_array(jsonb_build_object('tmdb_id', p_tmdb, 'score', 1, 'reasons', '{}'::jsonb, 'snapshot', jsonb_build_object(
      'tmdb_id', p_tmdb, 'title', 'Admin Movie ' || p_tmdb, 'original_title', null, 'overview', 'Synthetic.', 'release_date', '2024-05-01',
      'runtime_minutes', 100, 'poster_path', null, 'backdrop_path', null, 'vote_average', 7, 'vote_count', 1, 'genres', '[]'::jsonb))),
    'evidence', case when p_verified then jsonb_build_object('identity', v_claim->>'identity', 'method', 'bounded_mtproto_v1', 'policy_version', 2,
      'media_class', 'canonical', 'reasons', '[]'::jsonb, 'container', 'mp4', 'video_codec', 'h264', 'audio_codec', 'aac',
      'accessible', true, 'gateway_compatible', true, 'playback_ready', true, 'bytes_read', 3072) else null end));
end $$;

-- Reviewers: a1 review, a2 rights, a3 publish, a4 enrolled with nothing, a5 not enrolled.
insert into private.telegram_channels (bot_type, chat_id) values ('movie', -1001111111111);
insert into private.discovery_cursors (bot_type, update_offset) values ('movie', 1);
insert into public.vjs (slug, name, is_active) values ('vj-admin-test', 'VJ Admin Test', true);
insert into auth.users (id, aud, role, email)
select ('00000000-0000-4000-8000-0000000000a' || n)::uuid, 'authenticated', 'authenticated', 'a' || n || '@admin.invalid' from generate_series(1, 5) n;
insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
  ('00000000-0000-4000-8000-0000000000a1', true, false, false),
  ('00000000-0000-4000-8000-0000000000a2', false, true, false),
  ('00000000-0000-4000-8000-0000000000a3', false, false, true),
  ('00000000-0000-4000-8000-0000000000a4', false, false, false);
select public.discovery_acquire_consumer('00000000-0000-4000-8000-0000000000d1', 60);

-- ---------------------------------------------------------------------------
-- Who can reach the commands at all
-- ---------------------------------------------------------------------------
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and (p.proname like 'catalogue_admin_%' or p.proname in
             ('discovery_review_capabilities', 'discovery_review_approve', 'discovery_review_publish'))
             and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE')
                  or has_function_privilege('velora_review_service', p.oid, 'EXECUTE') or has_function_privilege('velora_discovery_worker', p.oid, 'EXECUTE'))),
  null, 'anon, service_role, the review service and the worker can execute none of the dashboard commands');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'catalogue_admin_%' or p.proname in
             ('discovery_review_capabilities', 'discovery_review_approve', 'discovery_review_publish'))
             and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosecdef
             and p.proconfig @> array['search_path=""']), 7, 'all seven are SECURITY DEFINER with an empty search_path, for authenticated');
select matches(tests.as_role('anon', null, $$ select public.discovery_review_capabilities()::text $$), '^permission denied', 'anon cannot ask for capabilities');
select ok((select not has_table_privilege(r, 'private.catalogue_admin_audit', 'SELECT') and not has_table_privilege(r, 'private.catalogue_admin_audit', 'INSERT')
           from unnest(array['anon', 'authenticated', 'service_role']) r order by 1 limit 1), 'no API role can read or write the audit table');
select ok((select relrowsecurity from pg_class where oid = 'private.catalogue_admin_audit'::regclass), 'the audit table has RLS enabled');

-- ---------------------------------------------------------------------------
-- Capabilities: the caller's own, never another account's
-- ---------------------------------------------------------------------------
select is(tests.as_user('a1', $$ select public.discovery_review_capabilities()::text $$), '{"review": true, "rights": false, "publish": false}', 'a reviewer sees review only');
select is(tests.as_user('a3', $$ select public.discovery_review_capabilities()::text $$), '{"review": false, "rights": false, "publish": true}', 'a publisher sees publish only');
select is(tests.as_user('a5', $$ select public.discovery_review_capabilities()::text $$), '{"review": false, "rights": false, "publish": false}', 'an account that is not enrolled has none');
select is(tests.as_role('authenticated', jsonb_build_object('sub', '00000000-0000-4000-8000-0000000000a1', 'role', 'authenticated', 'is_anonymous', false),
  $$ select (public.discovery_review_capabilities()->>'publish') $$), 'false', 'the answer follows the session, not a wish');

-- ---------------------------------------------------------------------------
-- Approval and publication from the session
-- ---------------------------------------------------------------------------
select is(tests.candidate(10, 9830001, true), 'needs_review', 'a candidate with verified media is inspected');
select is(tests.as_user('a1', format($$ select public.discovery_review_correct(%L, 1, 9830001, 2024, %s)->>'revision' $$, tests.key(10), tests.vj())), '2', 'identity confirmed');
select is(tests.as_user('a1', format($$ select public.discovery_review_approve(%L, 2)::text $$, tests.key(10))), 'review_gates_not_met', 'approval without rights is still refused by the gates');
select is(tests.as_user('a2', format($$ select public.discovery_review_clear_rights(%L, 2, 'contract ADMIN-001')->>'revision' $$, tests.key(10))), '3', 'rights cleared');
select is(tests.as_user('a2', format($$ select public.discovery_review_approve(%L, 3)::text $$, tests.key(10))), 'review_not_authorized', 'a rights-only account cannot approve');
select is(tests.as_user('a5', format($$ select public.discovery_review_approve(%L, 3)::text $$, tests.key(10))), 'review_not_authorized', 'an unenrolled account cannot approve');
select is(tests.as_user('a1', format($$ select public.discovery_review_approve(%L, 2)::text $$, tests.key(10))), 'review_stale_revision', 'an old revision cannot be approved');
select is(tests.as_user('a1', format($$ select public.discovery_review_publish(%L, 3)::text $$, tests.key(10))), 'review_not_authorized', 'a review-only account cannot publish');
select is(tests.as_user('a3', format($$ select public.discovery_review_publish(%L, 3)::text $$, tests.key(10))), 'catalogue_not_approved', 'nothing is published before approval');
select is(tests.as_user('a1', format($$ select public.discovery_review_approve(%L, 3)->>'status' $$, tests.key(10))), 'matched', 'the reviewer approves from the session');
select is((select approved_by::text from private.channel_reviews where discovery_key = tests.key(10)), '00000000-0000-4000-8000-0000000000a1', 'the approval names the session account');
select is(tests.as_user('a1', format($$ select public.discovery_review_approve(%L, 3)->>'status' $$, tests.key(10))), 'matched', 'approving again is the same approval');
select is((select count(*)::int from public.movies where tmdb_id = 9830001), 0, 'approval creates no catalogue row');
select is(tests.as_user('a3', format($$ select public.discovery_review_publish(%L, 3)->>'result' $$, tests.key(10))), 'published', 'the publisher publishes from the session');
select is((select published_by::text from private.channel_reviews where discovery_key = tests.key(10)), '00000000-0000-4000-8000-0000000000a3', 'the publication names the session account');
select is(tests.as_user('a3', format($$ select public.discovery_review_publish(%L, 3)->>'result' $$, tests.key(10))), 'already_published', 'publishing again changes nothing');
select is(tests.as_role('anon', null, $$ select count(*)::text from public.movies where tmdb_id = 9830001 $$), '1', 'the published movie is public');

-- The media gate is untouched: no verified evidence, no approval.
select is(tests.candidate(11, 9830002, false), 'needs_review', 'a candidate without media evidence is inspected');
select is(tests.as_user('a1', format($$ select public.discovery_review_correct(%L, 1, 9830002, 2024, %s)->>'revision' $$, tests.key(11), tests.vj())), '2', 'its identity is confirmed');
select is(tests.as_user('a2', format($$ select public.discovery_review_clear_rights(%L, 2, 'contract ADMIN-002')->>'revision' $$, tests.key(11))), '3', 'and its rights cleared');
select is(tests.as_user('a1', format($$ select public.discovery_review_approve(%L, 3)::text $$, tests.key(11))), 'review_gates_not_met', 'but unverified media still cannot be approved');
select is(tests.as_user('a3', format($$ select public.discovery_review_publish(%L, 3)::text $$, tests.key(11))), 'catalogue_not_approved', 'or published');
select is((select count(*)::int from public.movies where tmdb_id = 9830002), 0, 'and no catalogue row appears for it');

-- ---------------------------------------------------------------------------
-- Catalogue management
-- ---------------------------------------------------------------------------
select is(tests.as_user('a5', $$ select public.catalogue_admin_movies(50)::text $$), 'review_not_authorized', 'an unenrolled account cannot list the catalogue');
select is(tests.as_user('a4', $$ select public.catalogue_admin_movies(50)::text $$), 'review_not_authorized', 'nor an enrolled account with no capability');
select is(tests.as_user('a1', format($$ select (public.catalogue_admin_movies(50) @> %L::jsonb)::text $$,
  jsonb_build_array(jsonb_build_object('id', tests.movie(), 'publication_status', 'published', 'is_featured', false)))), 'true', 'a reviewer lists movies with their state');
select is(tests.as_user('a1', $$ select (public.catalogue_admin_movies(50)::text ~ 'synthetic-file|file_id|chat_id')::text $$), 'false', 'the list carries no Telegram reference');
select is(tests.as_user('a1', $$ select public.catalogue_admin_movies(0)::text $$), 'discovery_invalid_input', 'the list size is bounded');

select is(tests.as_user('a1', format($$ select public.catalogue_admin_set_movie(%s, 'withdraw')::text $$, tests.movie())), 'review_not_authorized', 'a review-only account cannot withdraw');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'delete')::text $$, tests.movie())), 'discovery_invalid_input', 'only the four named actions exist');
select is(tests.as_user('a3', $$ select public.catalogue_admin_set_movie(987654321, 'withdraw')::text $$), 'catalogue_not_found', 'an unknown movie is refused');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'restore')::text $$, tests.movie())), 'catalogue_illegal_transition', 'a published movie cannot be restored');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'feature')->>'is_featured' $$, tests.movie())), 'true', 'the publisher features a movie');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'withdraw')->>'publication_status' $$, tests.movie())), 'archived', 'the publisher withdraws it');
select is(tests.as_role('anon', null, $$ select count(*)::text from public.movies where tmdb_id = 9830001 $$), '0', 'a withdrawn movie is no longer public');
select is(tests.as_role('anon', null, format($$ select count(*)::text from public.movie_versions where movie_id = %s $$, tests.movie())), '0', 'nor are its versions');
select is((select is_featured::text from public.movies where id = tests.movie()), 'false', 'withdrawal also ends the feature');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'withdraw')::text $$, tests.movie())), 'catalogue_illegal_transition', 'it cannot be withdrawn twice');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'feature')::text $$, tests.movie())), 'catalogue_illegal_transition', 'a withdrawn movie cannot be featured');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_set_movie(%s, 'restore')->>'publication_status' $$, tests.movie())), 'published', 'the publisher restores it');
select is(tests.as_role('anon', null, $$ select count(*)::text from public.movies where tmdb_id = 9830001 $$), '1', 'and it is public again');

select is(tests.as_user('a1', format($$ select public.catalogue_admin_edit_movie(%s, 'Renamed', null)::text $$, tests.movie())), 'review_not_authorized', 'a review-only account cannot edit');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_edit_movie(%s, '   ', null)::text $$, tests.movie())), 'discovery_invalid_input', 'a blank title is refused');
select is(tests.as_user('a3', format($$ select public.catalogue_admin_edit_movie(%s, '  Admin Movie Renamed ', ' New overview. ')->>'title' $$, tests.movie())), 'Admin Movie Renamed', 'the publisher edits the title');
select is((select slug || '|' || overview || '|' || tmdb_id from public.movies where id = tests.movie()), 'admin-movie-9830001-2024|New overview.|9830001', 'the address and identity are unchanged');

select is(tests.as_user('a1', $$ select public.catalogue_admin_add_vj('Junior')::text $$), 'review_not_authorized', 'a review-only account cannot add a VJ');
select is(tests.as_user('a3', $$ select public.catalogue_admin_add_vj('  vj.junior  ')->>'name' $$), 'VJ junior', 'the publisher adds a VJ in the house form');
select is((select slug || '|' || is_active from public.vjs where name = 'VJ junior'), 'vj-junior|true', 'it is active with a matching slug');
select is(tests.as_user('a3', $$ select public.catalogue_admin_add_vj('VJ JUNIOR')::text $$), 'catalogue_vj_exists', 'the same VJ cannot be added twice');
select is(tests.as_user('a3', $$ select public.catalogue_admin_add_vj('VJ')::text $$), 'discovery_invalid_input', 'a name of only "VJ" is refused');
select is(tests.as_user('a3', $$ select public.catalogue_admin_add_vj('!!!')::text $$), 'discovery_invalid_input', 'a name with no letters or digits is refused');

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
select is((select array_agg(action order by id) from private.catalogue_admin_audit),
  array['movie_feature', 'movie_withdraw', 'movie_restore', 'movie_edited', 'vj_added'], 'every catalogue change is recorded, refusals are not');
select is((select count(distinct actor)::int from private.catalogue_admin_audit), 1, 'each row names the session account');
select throws_ok($$ update private.catalogue_admin_audit set action = 'x' $$, 'audit_append_only', 'the audit cannot be rewritten');
select throws_ok($$ delete from private.catalogue_admin_audit $$, 'audit_append_only', 'or deleted');
select is((select array_agg(a.action order by a.id) from private.channel_review_audit a join private.channel_reviews r on r.ingestion_event_id = a.ingestion_event_id
           where r.discovery_key = tests.key(10) and a.action in ('approved', 'published')), array['approved', 'published'], 'approval and publication keep their existing audit');

select set_config('request.jwt.claims', '', true);
select * from finish();
rollback;
