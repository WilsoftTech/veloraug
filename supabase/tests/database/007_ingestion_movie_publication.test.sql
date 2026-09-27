-- C2B.2H uploaded movie -> catalogue (20260927090650_ingestion_movie_publication.sql).
--
-- The evaluation worker command (service_role), the owner-only approval and
-- publication commands, their privileges, every refusal the checkpoint
-- requires (no upload, unresolved, ambiguous, inactive VJ, rights, metadata,
-- conflicts), exactly-once materialization and replay, and the public read
-- surface afterwards: the published movie is visible to anon with its VJ,
-- nothing private is, and an uploaded-but-unpublished movie stays hidden.
-- Fake channel ids and fake TMDB ids. Everything is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(77);

create schema tests;
grant usage on schema tests to service_role;

create function tests.fp(p_char text) returns text language sql immutable as $$
  select 'sf1-' || repeat(p_char, 64)
$$;
-- Registers and records one uploaded movie source as the worker would.
create function tests.upload(p_fp text, p_message bigint) returns text language sql as $$
  select upload_state from public.ingest_upload_start(p_fp, 'movie', -1001111111111, 1000);
  select public.ingest_upload_record(p_fp, 'movie', -1001111111111, p_message, 'file-' || p_message, 'uniq-' || p_message,
    'document', 'On The Hunt.VJ ICE P.2026.mkv', 'video/x-matroska', E'On The Hunt (2026)\nVJ ICE P\nMovie\nvelora-src:' || p_fp,
    1000, null, null, null, now())
$$;
create function tests.parsed(p_vj_status text default 'resolved', p_vj_id bigint default null, p_year int default 2026,
  p_kind_status text default 'confirmed') returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('kind', 'movie', 'kind_status', p_kind_status, 'title', 'On The Hunt', 'year', p_year,
    'vj_text', 'ICE P', 'vj_status', p_vj_status,
    'vj_id', case when p_vj_status = 'resolved' then coalesce(p_vj_id, (select id from public.vjs where slug = 'vj-t-active')) end,
    'season', null, 'episode', null)
$$;
create function tests.cand(p_tmdb int, p_year_match text, p_title_match text default 'exact', p_score numeric default null,
  p_media text default 'movie') returns jsonb language sql immutable as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'media_type', p_media,
    'score', coalesce(p_score, case when p_title_match = 'mismatch' then 0 when p_year_match = 'match' then 1
      when p_year_match = 'near' then 0.8 when p_year_match = 'unknown' then 0.6 else 0.3 end),
    'title_match', p_title_match, 'title_field', case when p_title_match = 'exact' then 'title' end,
    'year_match', p_year_match, 'title', 'On the Hunt', 'year', 2026)
$$;
create function tests.meta(p_tmdb int) returns jsonb language sql immutable as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', 'On the Hunt', 'original_title', null,
    'overview', 'A hunt.', 'release_date', '2026-03-06', 'runtime_minutes', 101,
    'poster_path', '/poster.jpg', 'backdrop_path', '/backdrop.jpg', 'vote_average', 6.54, 'vote_count', 12,
    'genres', jsonb_build_array(jsonb_build_object('tmdb_id', 28, 'name', 'Action'), jsonb_build_object('tmdb_id', 53, 'name', 'Thriller')))
$$;
create function tests.vj(p_slug text) returns bigint language sql stable security definer set search_path = '' as $$
  select id from public.vjs where slug = p_slug
$$;
create function tests.event(p_fp text) returns private.ingestion_events language sql stable as $$
  select * from private.ingestion_events where source_fingerprint = p_fp
$$;
grant execute on all functions in schema tests to service_role;

-- Fixtures: channel, VJs, and four uploaded sources.
insert into private.telegram_channels (bot_type, chat_id, checkpoint_message_id) values ('movie', -1001111111111, 10);
insert into public.vjs (slug, name, is_active) values ('vj-t-active', 'VJ T Active', true), ('vj-t-inactive', 'VJ T Inactive', false);

-- ---------------------------------------------------------------------------
-- Privileges and structure
-- ---------------------------------------------------------------------------
select is((select array_to_string(p.proacl, ',') from pg_proc p where p.oid = 'public.ingest_record_evaluation(text, text, jsonb, jsonb)'::regprocedure),
  'postgres=X/postgres,service_role=X/postgres', 'evaluation: EXECUTE for owner and service_role only');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
           where p.oid = 'public.ingest_record_evaluation(text, text, jsonb, jsonb)'::regprocedure),
  'evaluation: SECURITY DEFINER, search_path empty');

create temp table owner_functions (f regprocedure);
insert into owner_functions values
  ('private.catalogue_slug(text)'),
  ('private.catalogue_approve_movie_match(text, integer)'),
  ('private.catalogue_publish_movie(text, jsonb, boolean)');
select is((select array_agg(format('%s %s', r, f)) from owner_functions, unnest(array['anon', 'authenticated', 'service_role']) r
           where has_function_privilege(r, f, 'EXECUTE')),
  null, 'owner commands: no API role (not even service_role) can execute them');
select is((select array_agg(distinct array_to_string(p.proacl, ',')) from owner_functions w join pg_proc p on p.oid = w.f),
  array['postgres=X/postgres'], 'owner commands: exact ACL is the owner only (no PUBLIC)');
select is((select array_agg(f::text) from owner_functions w join pg_proc p on p.oid = w.f
           where p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false) or pg_get_userbyid(p.proowner) <> 'postgres'),
  null, 'owner commands: SECURITY INVOKER (no elevation), owned by postgres, search_path empty');
select is((select array_agg(f::text) from owner_functions w join pg_proc p on p.oid = w.f where p.prosrc ~* '\mexecute\M|format\s*\('),
  null, 'owner commands: no dynamic SQL');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname ~ 'approve|publish'), 0,
  'no approval or publication function is exposed through the Data API schema');

-- ---------------------------------------------------------------------------
-- Evaluation (service_role)
-- ---------------------------------------------------------------------------
set local role service_role;
select tests.upload(tests.fp('a'), 11);
select results_eq($q$select upload_state from public.ingest_upload_start(tests.fp('b'), 'movie', -1001111111111, 1000)$q$,
  $q$values ('uploading'::text)$q$, 'fixture: source b is uploading, not uploaded');

select throws_ok($q$select public.ingest_record_evaluation(tests.fp('b'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(900, 'match')))$q$,
  'P0001', 'ingest_not_uploaded', 'evaluation: refused without uploaded media');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('9'), 'movie', tests.parsed(), '[]')$q$,
  'P0001', 'ingest_not_registered', 'evaluation: refused for an unknown fingerprint');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'series', tests.parsed(), '[]')$q$,
  'P0001', 'ingest_identity_mismatch', 'evaluation: refused for the other bot');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(900, 'match', p_score => 0.8)))$q$,
  '22023', 'ingest_invalid_input', 'evaluation: a score that is not its tier is refused (caller cannot inflate confidence)');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(900, 'match', p_media => 'tv')))$q$,
  '22023', 'ingest_invalid_input', 'evaluation: a candidate of the other media type is refused');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(900, 'match'), tests.cand(900, 'near')))$q$,
  '22023', 'ingest_invalid_input', 'evaluation: duplicate TMDB ids are refused');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed() || '{"extra": 1}', '[]')$q$,
  '22023', 'ingest_invalid_input', 'evaluation: unknown parsed keys are refused');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed() || '{"vj_id": null}', '[]')$q$,
  '22023', 'ingest_invalid_input', 'evaluation: a resolved VJ without an id is refused');
reset role;
select is((select count(*)::int from private.metadata_match_candidates), 0, 'evaluation: refusals wrote no candidate');
select is((tests.event(tests.fp('a'))).status, 'received', 'evaluation: refusals left the ingestion untouched');

-- Unique exact title + year among namesakes: matched.
set local role service_role;
select is(public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(),
  jsonb_build_array(tests.cand(900, 'match'), tests.cand(901, 'conflict'), tests.cand(902, 'unknown', 'mismatch'))),
  'matched', 'evaluation: a unique exact title and year is matched');
select is(public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(),
  jsonb_build_array(tests.cand(902, 'unknown', 'mismatch'), tests.cand(900, 'match'), tests.cand(901, 'conflict'))),
  'already_recorded', 'evaluation: an identical replay (any order) is a no-op');
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(901, 'match')))$q$,
  'P0001', 'ingest_evaluation_conflict', 'evaluation: a different evaluation never replaces the recorded one');
reset role;
select is((select count(*)::int from private.metadata_match_candidates c join private.ingestion_events e on e.id = c.ingestion_event_id
           where e.source_fingerprint = tests.fp('a')), 3, 'evaluation: three candidates, recorded once');
select is((select array_agg(distinct decision) from private.metadata_match_candidates), array['pending'],
  'evaluation: candidates are pending; the worker approves nothing');
select is((tests.event(tests.fp('a'))).parsed->'review_reasons', '[]'::jsonb, 'evaluation: matched has no review reasons');

-- Ambiguous, missing and unresolved evidence goes to review.
set local role service_role;
select tests.upload(tests.fp('c'), 12);
select tests.upload(tests.fp('d'), 13);
select tests.upload(tests.fp('e'), 14);
select tests.upload(tests.fp('f'), 15);
select tests.upload(tests.fp('1'), 16);
select is(public.ingest_record_evaluation(tests.fp('c'), 'movie', tests.parsed(),
  jsonb_build_array(tests.cand(900, 'match'), tests.cand(903, 'match'))), 'needs_review', 'evaluation: two exact title+year candidates -> review');
select is(public.ingest_record_evaluation(tests.fp('d'), 'movie', tests.parsed(), '[]'), 'needs_review', 'evaluation: no candidate -> review');
select is(public.ingest_record_evaluation(tests.fp('e'), 'movie', tests.parsed('unresolved'),
  jsonb_build_array(tests.cand(900, 'match'))), 'needs_review', 'evaluation: unresolved VJ -> review');
select is(public.ingest_record_evaluation(tests.fp('f'), 'movie', tests.parsed(p_year => null),
  jsonb_build_array(tests.cand(900, 'unknown'))), 'needs_review', 'evaluation: medium confidence (no year) -> review');
select is(public.ingest_record_evaluation(tests.fp('1'), 'movie', tests.parsed(p_vj_id => tests.vj('vj-t-inactive')),
  jsonb_build_array(tests.cand(904, 'match'))), 'matched', 'fixture: 1 claims a resolved VJ that is in fact inactive');
reset role;
select is((tests.event(tests.fp('c'))).parsed->'review_reasons', '["match_ambiguous"]'::jsonb, 'review reasons: ambiguous');
select is((tests.event(tests.fp('d'))).parsed->'review_reasons', '["match_not_found"]'::jsonb, 'review reasons: not found');
select is((tests.event(tests.fp('e'))).parsed->'review_reasons', '["vj_unresolved"]'::jsonb, 'review reasons: VJ unresolved');
select is((tests.event(tests.fp('f'))).parsed->'review_reasons', '["match_needs_confirmation"]'::jsonb, 'review reasons: needs confirmation');

-- ---------------------------------------------------------------------------
-- Client roles
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', '{}', '[]')$q$, '42501', null, 'anon: cannot evaluate');
reset role;
set local role authenticated;
select throws_ok($q$select public.ingest_record_evaluation(tests.fp('a'), 'movie', '{}', '[]')$q$, '42501', null, 'authenticated: cannot evaluate');
reset role;
set local role service_role;
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('a'), 900)$q$, '42501', null, 'service_role: cannot approve');
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('a'), tests.meta(900), true)$q$, '42501', null, 'service_role: cannot publish');
reset role;

-- ---------------------------------------------------------------------------
-- Approval (owner)
-- ---------------------------------------------------------------------------
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('a'), tests.meta(900), true)$q$,
  'P0001', 'catalogue_not_approved', 'publish: refused before approval');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('b'), 900)$q$,
  'P0001', 'catalogue_not_uploaded', 'approve: refused without uploaded media');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('c'), 900)$q$,
  'P0001', 'catalogue_not_matched', 'approve: refused for an ambiguous match');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('d'), 900)$q$,
  'P0001', 'catalogue_not_matched', 'approve: refused for an unresolved match');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('a'), 901)$q$,
  'P0001', 'catalogue_match_not_unique', 'approve: refused for a candidate that is not the unique exact match');
-- Approval re-checks the recorded evidence instead of trusting the status:
-- a second score-1 candidate added behind the evaluation's back is refused.
set local role service_role;
select tests.upload(tests.fp('5'), 17);
select public.ingest_record_evaluation(tests.fp('5'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(907, 'match')));
reset role;
insert into private.metadata_match_candidates (ingestion_event_id, tmdb_media_type, tmdb_id, score, reasons)
select id, 'movie', 908, 1, '{}' from private.ingestion_events where source_fingerprint = tests.fp('5');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('5'), 907)$q$,
  'P0001', 'catalogue_match_not_unique', 'approve: refused when the recorded evidence no longer has a unique exact match');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('1'), 904)$q$,
  'P0001', 'catalogue_vj_not_active', 'approve: refused for an inactive VJ');
select is(private.catalogue_approve_movie_match(tests.fp('a'), 900), 'approved', 'approve: the unique exact match is approved');
select is(private.catalogue_approve_movie_match(tests.fp('a'), 900), 'already_approved', 'approve: replay is a no-op');
select throws_ok($q$select private.catalogue_approve_movie_match(tests.fp('a'), 902)$q$,
  'P0001', 'catalogue_approval_conflict', 'approve: another candidate can never be approved afterwards');
select results_eq($q$select tmdb_id, decision from private.metadata_match_candidates c join private.ingestion_events e on e.id = c.ingestion_event_id
                   where e.source_fingerprint = tests.fp('a') order by tmdb_id$q$,
  $q$values (900, 'approved'::text), (901, 'superseded'), (902, 'superseded')$q$, 'approve: one approved, the rest superseded (kept)');
select is((tests.event(tests.fp('a'))).status, 'matched', 'approve: approved = matched + approved candidate (C1 mapping)');
select is((select count(*)::int from public.movies), 0, 'approve: approval alone creates no catalogue row');

-- ---------------------------------------------------------------------------
-- Publication (owner)
-- ---------------------------------------------------------------------------
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('a'), tests.meta(901), true)$q$,
  'P0001', 'catalogue_metadata_mismatch', 'publish: metadata for another TMDB id is refused');
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('a'), tests.meta(900), false)$q$,
  'P0001', 'catalogue_rights_not_cleared', 'publish: refused without the rights attestation');
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('a'), tests.meta(900) || '{"poster_path": "https://evil/x.jpg"}', true)$q$,
  '22023', 'catalogue_invalid_input', 'publish: artwork must be a TMDB path');
select is((select count(*)::int from public.movies), 0, 'publish: refusals created nothing');

select results_eq($q$select result, movie_slug from private.catalogue_publish_movie(tests.fp('a'), tests.meta(900), true)$q$,
  $q$values ('published'::text, 'on-the-hunt-2026'::text)$q$, 'publish: published with a title-year slug');
select results_eq($q$select m.title, m.tmdb_id, m.publication_status, m.metadata_status, m.release_date, m.runtime_minutes, m.tmdb_vote_average
                   from public.movies m$q$,
  $q$values ('On the Hunt'::text, 900, 'published'::text, 'reviewed'::text, '2026-03-06'::date, 101, 6.5::numeric)$q$,
  'publish: one movie from the approved snapshot');
select results_eq($q$select v.slug, mv.availability_status, mv.rights_status, mv.telegram_media_id = (tests.event(tests.fp('a'))).telegram_media_id
                   from public.movie_versions mv join public.vjs v on v.id = mv.vj_id$q$,
  $q$values ('vj-t-active'::text, 'ready'::text, 'cleared'::text, true)$q$, 'publish: one ready, cleared version for the VJ, linked to the uploaded media');
select results_eq($q$select g.slug from public.movie_genres mg join public.genres g on g.id = mg.genre_id order by g.slug$q$,
  $q$values ('action'::text), ('thriller')$q$, 'publish: genres linked');
select is((tests.event(tests.fp('a'))).status, 'published', 'publish: the ingestion is published');

-- Idempotency: replaying every step creates nothing.
create temp table counts_before as
  select (select count(*) from public.movies) movies, (select count(*) from public.movie_versions) versions,
         (select count(*) from private.telegram_media) media, (select count(*) from private.ingestion_events) events,
         (select count(*) from private.metadata_match_candidates) candidates, (select count(*) from public.genres) genres,
         (select count(*) from public.movie_genres) movie_genres, (select upload_attempt_count from private.ingestion_events where source_fingerprint = tests.fp('a')) attempts;
set local role service_role;
select is(public.ingest_record_evaluation(tests.fp('a'), 'movie', tests.parsed(),
  jsonb_build_array(tests.cand(900, 'match'), tests.cand(901, 'conflict'), tests.cand(902, 'unknown', 'mismatch'))),
  'already_recorded', 'replay: evaluation after publication is a no-op');
select throws_ok($q$select * from public.ingest_upload_start(tests.fp('a'), 'movie', -1001111111111, 1000)$q$,
  'P0001', 'ingest_already_uploaded', 'replay: a published source cannot start another upload');
reset role;
select is(private.catalogue_approve_movie_match(tests.fp('a'), 900), 'already_approved', 'replay: approval after publication is a no-op');
select results_eq($q$select result, movie_slug from private.catalogue_publish_movie(tests.fp('a'), tests.meta(900), true)$q$,
  $q$values ('already_published'::text, 'on-the-hunt-2026'::text)$q$, 'replay: publication is a no-op');
select results_eq($q$select (select count(*) from public.movies), (select count(*) from public.movie_versions), (select count(*) from private.telegram_media),
                          (select count(*) from private.ingestion_events), (select count(*) from private.metadata_match_candidates),
                          (select count(*) from public.genres), (select count(*) from public.movie_genres),
                          (select upload_attempt_count from private.ingestion_events where source_fingerprint = tests.fp('a'))$q$,
  $q$select * from counts_before$q$, 'replay: no second movie, version, media, event, candidate, genre link or attempt');

-- A second file of the same movie and VJ is a replacement decision, never merged here.
set local role service_role;
select tests.upload(tests.fp('2'), 19);
select is(public.ingest_record_evaluation(tests.fp('2'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(900, 'match'))),
  'matched', 'fixture: 2 is the same movie and VJ from another file');
reset role;
select is(private.catalogue_approve_movie_match(tests.fp('2'), 900), 'approved', 'fixture: 2 approved');
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('2'), tests.meta(900), true)$q$,
  'P0001', 'catalogue_version_conflict', 'publish: same title + same VJ with other media is refused (reviewer decision)');

-- A slug already used by another movie is refused, not suffixed silently.
insert into public.movies (slug, title, tmdb_id) values ('taken-2026', 'Taken', 777);
set local role service_role;
select tests.upload(tests.fp('3'), 20);
select public.ingest_record_evaluation(tests.fp('3'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(905, 'match')));
reset role;
select private.catalogue_approve_movie_match(tests.fp('3'), 905);
select throws_ok($q$select * from private.catalogue_publish_movie(tests.fp('3'), tests.meta(905) || '{"title": "Taken"}', true)$q$,
  'P0001', 'catalogue_slug_conflict', 'publish: a slug collision with another movie is refused');

-- ---------------------------------------------------------------------------
-- Public read surface
-- ---------------------------------------------------------------------------
-- Source 4 is uploaded, evaluated and approved but not published (the Fuze case).
set local role service_role;
select tests.upload(tests.fp('4'), 21);
select public.ingest_record_evaluation(tests.fp('4'), 'movie', tests.parsed(), jsonb_build_array(tests.cand(906, 'match')));
reset role;
select private.catalogue_approve_movie_match(tests.fp('4'), 906);

set local role anon;
select results_eq($q$select slug, title, poster_path, release_date from public.movies$q$,
  $q$values ('on-the-hunt-2026'::text, 'On the Hunt'::text, '/poster.jpg'::text, '2026-03-06'::date)$q$,
  'anon: sees exactly the published movie (not the draft, not the approved-but-unpublished one)');
select results_eq($q$select v.slug, v.name from public.movie_versions mv join public.vjs v on v.id = mv.vj_id$q$,
  $q$values ('vj-t-active'::text, 'VJ T Active'::text)$q$, 'anon: sees the version and its VJ');
select results_eq($q$select g.slug from public.movie_genres mg join public.genres g on g.id = mg.genre_id order by 1$q$,
  $q$values ('action'::text), ('thriller')$q$, 'anon: sees the genres of the published movie');
select throws_ok($q$select telegram_media_id from public.movie_versions$q$, '42501', null, 'anon: cannot read the Telegram media link');
select throws_ok($q$select availability_status from public.movie_versions$q$, '42501', null, 'anon: cannot read availability');
select throws_ok($q$select publication_status from public.movies$q$, '42501', null, 'anon: cannot read publication state');
select throws_ok($q$select * from private.telegram_media$q$, '42501', null, 'anon: cannot read Telegram media');
select throws_ok($q$select * from private.ingestion_events$q$, '42501', null, 'anon: cannot read ingestion events');
select throws_ok($q$select * from private.metadata_match_candidates$q$, '42501', null, 'anon: cannot read match candidates');
reset role;

select * from finish();
rollback;
