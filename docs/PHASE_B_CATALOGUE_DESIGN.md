# Phase B — Catalogue Domain: Checkpoint Plan and Decisions

Date: 2026-09-23
Status: **Approved 2026-09-23 (D1–D5 as recommended).**
Baseline: `phase-a-foundation` at `a6c8885`. Hosted migrations 1–5 applied.

## Entry gate

**Closed 2026-09-23.** The Pre-B retention migration `20260923180000` was verified on
hosted over a read-only MCP connection (`supabase_read_only_user`, read-only
transactions). See `docs/HOSTED_BOOTSTRAP_AUDIT.md` §7. One post-run check is still
open: confirm that the first 00:17 UTC run on 2026-09-24 succeeded.

B-1 and B-2 were deployed to hosted on 2026-09-23 and verified there. See "Hosted deployment
(B-1 + B-2)" below.

## What Phase B already has

`20260922080911` created the normalized catalogue: `vjs`, `movies`,
`movie_versions`, `series`, `seasons`, `episodes`, `episode_versions`, `genres` and
both genre joins. It also added watchlist compatibility columns, the backfill and
the corrected trigger. All ten tables are RLS-on and deny-all.

Phase B still has to deliver the roadmap's remaining work:

- **B1:** public read policies, advisors and adversarial RLS tests.
- **B2:** Telegram media, ingestion events and match-review records.
- **B3:** the server data layer.
- **B4:** watchlist application compatibility.
- **B5:** TMDB removed from ordinary reads.

## Proposed checkpoints

Each checkpoint is one reviewed change set. Each migration is validated from a clean
local chain, then goes through a hosted dry-run, and is pushed only with explicit
authorization.

| # | Checkpoint | Contents | Client exposure |
| --- | --- | --- | --- |
| B-1 | Ingestion and review tables | `telegram_media`, `ingestion_events`, `metadata_match_candidates`; version → media links; constraints, indexes, explicit revokes | None: server-only tables |
| B-2 | Public read contract + data layer | Published-only RLS policies and SELECT grants on the 10 catalogue tables; server-only `lib/catalogue/*` query modules returning framework-independent domain types; keyset pagination; adversarial two-role RLS tests | Published, ready, rights-cleared rows only |
| B-3 | Watchlist compatibility (app) | Actions/UI prefer internal `movie_id`/`series_id`; legacy rows stay readable and removable; unresolved-row report | Unchanged RLS (own rows) |
| B-4 | TMDB boundary | TMDB out of home/browse/detail/watchlist reads; sample catalogue disabled in production; TMDB kept for server-side matching only | None |

Why B-2 combines policies and the data layer: `VELORA_UG_SCHEMA_BASELINE.md` says
public read contracts are added "only after their readiness predicates and query
paths exist". Opening client reads with no query path using them would expose data
before any consumer or test exists.

## Decisions requiring approval

### D1. How published-only RLS avoids policy recursion (B-2)

Visibility is defined in both directions:

- A movie is public only if it has a ready, cleared version from an active VJ.
- A version is public only if its movie is published.

Two plain policies that reference each other fail with PostgreSQL's "infinite
recursion detected in policy". The series chain has the same problem
(`series → seasons → episodes → episode_versions`).

**Recommended:** a small set of `STABLE SECURITY DEFINER` predicate functions (for
example `movie_is_public(bigint)`, `series_is_public(bigint)`) in a **new, dedicated,
non-exposed schema, `catalogue_access`**:

- `anon` and `authenticated` get `USAGE` on that schema and `EXECUTE` on those
  functions only.
- Each function has an empty `search_path`, schema-qualified objects, no dynamic
  SQL, and returns only a boolean.

Rejected alternatives:

- **Granting `USAGE` on `private`:** removes the verified "no client `USAGE` on
  `private`" layer that protects `search_events` and the privileged functions.
- **Predicate functions in `public`:** they would become callable `/rpc` endpoints
  that reveal whether a draft id exists.
- **`SECURITY DEFINER` read RPCs instead of policies:** contradicts the roadmap
  ("Public policies read published rows only") and gives up the SDK's relational
  queries.
- **Relaxing the rules** so versions of unpublished titles, or published titles
  with no playable version, are visible: violates B's acceptance criterion
  "Public roles see only active VJs and published, ready content."

### D2. How Telegram media attaches to inventory (B-1)

**Recommended:**

- `movie_versions.telegram_media_id` and `episode_versions.telegram_media_id`:
  nullable, **unique** FKs to `telegram_media`, restrictive delete, indexed.
- One delivered file backs at most one version. Concrete FKs, no polymorphic pair.
- A version may become `ready` only when its media reference is set (check
  constraint).

Alternative: a join table allowing one file for many versions. It isn't needed
yet, and it weakens the "stored once" rule.

### D3. Duplicate Telegram deliveries (B-1)

**Recommended:**

- Unique `(bot_type, chat_id, message_id)` for a delivery.
- Unique `(bot_type, telegram_update_id)` on `ingestion_events`.
- `file_unique_id` indexed but **not unique**: a re-upload of the same file is
  flagged for review, not silently merged.

This follows the migration plan: decide file-level uniqueness only after observing
real channel behaviour.

### D4. Reviewer/admin authorization

**Recommended: defer to Phase C.** Phase B introduces no admin write path, so all
writes stay migration- or service-side. C3 (audited corrections) introduces a
dedicated database membership table. User-editable Auth metadata is never used for
authorization.

### D5. VJ display fields

The migration plan mentions `short_name` for badges. The baseline has only `name`.

**Recommended:** add nothing now. Badges ship in Phase D, and `short_name` is added
there only if real VJ names don't fit the badge.

## Not in Phase B

- Webhooks, parsing, TMDB matching logic (Phase C).
- UI changes, routes, VJ badges, redirects (Phase D).
- Playback (Phase E).
- Payments (Phase F).
- Removing legacy watchlist columns: a later migration, after measuring unresolved rows.

## Verification per checkpoint

1. Clean local chain (migrations 1–5 plus new).
2. `supabase db lint`.
3. Explicit privilege audit per the `AGENTS.md` invariant.
4. Adversarial RLS tests as `anon` and as two `authenticated` users: drafts,
   archived rows, inactive VJs, blocked rights and unready versions never visible.
5. Phase 2/3 and watchlist-correction regressions.
6. Advisors.
7. `npm run lint`, `npm run typecheck`, `npm run build`.
8. Hosted dry-run proposing only the new migration.

## B-1 result: ingestion and review tables

Status: **deployed to hosted 2026-09-23 and verified.** See "Hosted deployment (B-1 + B-2)".

Migration `20260923200000_catalogue_ingestion_tables.sql`:

- `private.telegram_media`: one delivery, unique `(bot_type, chat_id, message_id)`.
  `(bot_type, file_unique_id)` is indexed but not unique (D3).
- `private.ingestion_events`: unique `(bot_type, telegram_update_id)`; typed status;
  parsed suggestions as a JSON object; a safe error code only, no raw payload.
- `private.metadata_match_candidates`: unique per event, TMDB type and id; at most one
  `approved` per event; decisions need `decided_at`; history kept (restrictive
  delete).
- `movie_versions` / `episode_versions` gain `telegram_media_id`: unique, restrictive
  FK. A composite FK pins the media's bot type, so movie versions take movie-bot
  media only and episode versions series-bot media only. `ready` requires media (D2).
- Placement: the three raw tables live in `private` (not exposed), like
  `search_events`. They have RLS with no policies and every privilege revoked from
  `PUBLIC`, `anon`, `authenticated` and `service_role`.
- **Note for B-2:** the version tables' new `telegram_media_id` and
  `telegram_media_bot_type` columns are internal. B-2's public grants must be
  column-level and exclude them.

Clean local chain (migrations 1–6, PostgreSQL 17):

| Check | Result |
| --- | --- |
| All six apply from clean | PASS |
| Structure | 17 tables, all RLS; 149 constraints; 60 indexes; 20 FKs, 0 unindexed; policies unchanged (7) |
| Privileges | 0 effective privileges for `anon`/`authenticated`/`service_role` on the 3 new and 10 catalogue tables; no client `USAGE` on `private` |
| Functions | The 7 existing functions are unchanged (hash-identical); none added |
| Constraint behaviour | 20/20 PASS: duplicate delivery/update rejected; cross-bot media rejected (including a forged bot-type column); one media per version; ready-without-media and clearing media on a ready version rejected; linked media undeletable; one approved candidate; candidate history kept |
| Client isolation | `anon`, `authenticated`, `service_role` denied on all three tables and on `movie_versions.telegram_media_id` |
| Regressions | Retention (30-day purge, 7-day floor, `search_history` untouched, idempotent), cron isolation, watchlist correction as `authenticated`: PASS |
| `supabase db lint` | No schema errors |
| `npm run lint` / `typecheck` / `build` | PASS / PASS / PASS |
| `db push --linked --dry-run` | Proposes only `20260923200000_catalogue_ingestion_tables.sql` |

## B-2 result: public read contract and data layer

Status: **deployed to hosted with B-1 on 2026-09-23 and verified.** See "Hosted deployment
(B-1 + B-2)".

Migration `20260923210000_catalogue_public_read.sql` (D1):

- Schema `catalogue_access` (not exposed by the Data API): `movie_is_public`,
  `series_is_public`, `season_is_public`, `episode_is_public`. Each is `STABLE
  SECURITY DEFINER`, `search_path=""`, returns only a boolean, and is executable
  only by `anon`/`authenticated`. `USAGE` on the schema is granted to those two
  roles only.
- 10 `SELECT` policies for `anon`/`authenticated`:
  - active VJs;
  - published titles with a ready, rights-cleared version from an active VJ;
  - seasons and episodes of published series that have such a version;
  - versions that are themselves ready, cleared, from an active VJ, and belong to
    a public title;
  - all genres, and genre links for public titles only.
- Column-level `SELECT` grants on display fields only. Workflow state
  (publication, availability, rights, metadata status and sync times),
  `is_active`, timestamps and the Telegram link columns are never granted, so
  they can be neither read nor filtered on. No write, sequence or `service_role`
  grant.
- Bug found and fixed in testing: the version policies first read
  `vjs.is_active` directly. Clients have no grant on that column, so every read
  failed. They now rely on the `vjs` policy (active only).

Data layer:

- `lib/catalogue.ts` (server-only): `listMovies`, `listSeries` (newest first,
  opaque keyset cursor on `(published_at, id)`, optional `featured`/`vjSlug`/
  `genreSlug`), `getMovie`, `getSeries` (ordered seasons/episodes), `listVjs`,
  `getVj`, `listGenres`.
- It runs on a session-free client using the publishable key, so the published-
  only policies apply to every query. Nothing uses it yet: Phase D wires the UI.
- `types/catalogue.ts` holds the framework-independent domain types.
  `database.types.ts` gains read-only catalogue rows limited to the granted
  columns.

Validation (clean local chain, migrations 1–7):

| Check | Result |
| --- | --- |
| All seven apply from clean | PASS |
| Visibility as `anon` and `authenticated` (fixtures for every hidden case) | PASS: only the active VJ, the published ready movie, the published series with a ready episode, its populated season, and that episode/version. Hidden: draft, archived, no-version, rights-blocked, inactive-VJ-only and unready-version titles; the inactive VJ's version of a public movie; empty seasons; draft-series episodes |
| Denied as both roles | PASS: workflow and Telegram columns, `is_active`, `private` schema, `INSERT`/`UPDATE`/`DELETE` |
| Data API (PostgREST) | PASS: nested movie → versions → VJ and series → seasons → episodes → versions queries work. `select=*` and filters on hidden columns 401; `/rpc/movie_is_public` 404; the `catalogue_access` and `private` profiles are refused |
| Query plan | The newest-first list uses `movies_published_cursor_idx` |
| Data layer against the local API | PASS: 8 items over 3 pages across tied timestamps, no duplicates; featured, genre and VJ filters for movies and series; invalid cursor restarts; hidden slugs return `null`; the series tree holds only available seasons/episodes |
| Regressions | 7 original functions unchanged; retention job intact; 17 policies (7 + 10) |
| `supabase db lint` (`public`, `private`, `catalogue_access`) | No schema errors |
| `npm run lint` / `typecheck` / `build` | PASS / PASS / PASS |
| `db push --linked --dry-run` | Proposes exactly B-1 and B-2 |

## Hosted deployment (B-1 + B-2)

Date: 2026-09-23. Status: **HOSTED B-1/B-2: PASS.**

### Deployment

- The CLI access token (both the stored login and the `SUPABASE_ACCESS_TOKEN` in
  `.env.local`) lacks the `database_write` permission, so `db push --linked` fails
  with 403. The push went through the session pooler instead: `db push --db-url`
  with the `DATABASE_URL` connection on port 5432. The direct `db.` host does not
  resolve on this network.
- The dry-run proposed exactly `20260923200000_catalogue_ingestion_tables.sql` and
  `20260923210000_catalogue_public_read.sql`, with no seeds and no roles. Both files
  were unchanged from their commits.
- Push authorized explicitly by the owner. Both applied. Hosted history now has 7
  migrations, identical to `supabase/migrations/`.

### Verification (read-only MCP, `supabase_read_only_user`)

| Check | Observed | Status |
| --- | --- | --- |
| Structure | 17 tables, RLS on all 17 (none forced); 149 constraints; 60 indexes; 20 FKs; 17 policies; 13 enabled triggers; all tables empty. Matches the local chain | PASS |
| FK index coverage | 18 FKs are covered by a leading-column index. The 2 composite `(telegram_media_id, telegram_media_bot_type)` FKs have a unique index on `telegram_media_id` only, which reaches at most one row per lookup | PASS (see advisors) |
| New private tables | `telegram_media`, `ingestion_events`, `metadata_match_candidates`: ACL `postgres` only; 0 privileges for `anon`/`authenticated`/`service_role`; no client `USAGE` on `private` | PASS |
| Ready requires media | `movie_versions_ready_media_check` and `episode_versions_ready_media_check` present | PASS |
| Policies | 10 catalogue `SELECT` policies `TO anon, authenticated` exactly as in the migration; the 7 Phase 2/3 policies unchanged | PASS |
| `catalogue_access` | 4 functions: `SECURITY DEFINER`, `STABLE`, `search_path=""`, owner `postgres`, EXECUTE for `anon`/`authenticated` only; whitespace-normalised body MD5s equal the repository. Schema `USAGE` for `anon`/`authenticated` only, none for `service_role` | PASS |
| Existing functions | Still 7 in `public`/`private` | PASS |
| Column grants | Display fields only, identical for `anon` and `authenticated`, exactly as the migration lists them. No workflow, `is_active`, timestamp or Telegram column. No table-level `SELECT`, no write privilege (table or column), no client sequence privilege, nothing for `service_role` | PASS |

### Public visibility boundary (live Data API, publishable key, reads only)

| Request | Result | Status |
| --- | --- | --- |
| `movies` with named display columns | 200 `[]` | PASS |
| Nested `movies → movie_versions → vjs`; `series → seasons → episodes → episode_versions`; `genres` | 200 `[]` | PASS |
| `movies?select=*`; filter on `publication_status`; `movie_versions.telegram_media_id`; `vjs.is_active` | 401 `42501` | PASS |
| `POST /rpc/movie_is_public` | 404 `PGRST202` | PASS |
| `Accept-Profile: catalogue_access` / `private` | 406 `PGRST106` (exposed: `public`, `graphql_public`) | PASS |
| `telegram_media` via `public` | 404 `PGRST205` | PASS |
| Anonymous `POST /movies` (sent unintentionally in the probe script) | Rejected; `movies` has 0 rows and 0 inserts ever | PASS |

Row-level visibility (drafts, archived, blocked rights, inactive VJs, unready
versions) needs fixture writes, so it was not repeated on hosted. The local
two-role run above covered it. Hosted policies, grants and predicate bodies are
identical to what that run tested.

### Advisors

| Finding | Level | Classification |
| --- | --- | --- |
| `rls_enabled_no_policy` ×4 (`private.search_events`, `telegram_media`, `ingestion_events`, `metadata_match_candidates`) | INFO | Intended: server-only tables. The 10 catalogue tables no longer appear |
| `anon`/`authenticated_security_definer_function_executable`: `record_search`, `trending_searches` | WARN | Existing, accepted in Phase 3. The `catalogue_access` functions raise nothing (schema not exposed) |
| `unindexed_foreign_keys` ×2: `movie_versions_telegram_media_fkey`, `episode_versions_telegram_media_fkey` | INFO | Accepted. The unique `telegram_media_id` index serves the FK check (at most one row), and a second two-column index would be redundant. Revisit only if `telegram_media` deletes show up in slow queries |
| `unused_index` ×15 | INFO | Expected: all tables empty |

## B-3 result: watchlist identity

Status: **implemented and validated locally.** App-only. No migration: the identity
columns, checks and the normalizing insert trigger came with `20260922080911`.

### Behaviour

- **Identity type.** `types/watchlist.ts` adds `WatchlistRef`, which is either
  `{ source: "catalogue", kind, id }` (canonical) or `{ source: "tmdb", mediaType, id }`
  (legacy). Movie, series and TMDB ids are separate spaces, so the whole ref is the
  identity. `TitleSummary` gains `tmdbId`, so a catalogue title and a legacy save of
  the same TMDB title are recognised as one.
- **Saves** (`lib/watchlist-actions.ts`):
  - Every ref is resolved through the published catalogue (`findTitles`, which runs
    under the anon policies).
  - A published title is stored as `movie_id` or `series_id` only.
  - An unmapped TMDB title is still stored as a legacy `tmdb_id` row, so the TMDB pages
    keep working.
  - A catalogue id that is not published is refused (`invalid`).
  - Duplicates in either form are skipped by the trigger. A concurrent save's `23505`
    counts as success.
- **Removals** match every row that stores the title: `{kind}_id = id`, or the TMDB id
  with a matching `media_type` (`tv` and `series` for series). That covers legacy rows
  and rows the trigger normalized.
- **Reads** resolve each row in this order:
  1. its published catalogue title, including legacy rows whose TMDB id is now
     published;
  2. otherwise TMDB, when the row has a TMDB id;
  3. otherwise an "Unavailable title" row with no link, which can still be removed.

  Previously, titles TMDB no longer had were dropped from the list but still counted
  towards the 500 cap.
- **Guests.** localStorage keeps its key. Pre-catalogue entries (TMDB `MediaSummary`)
  are upgraded on read. Every entry is rebuilt from known fields, and links must be
  same-site paths. On import, a catalogue ref that is no longer published has nothing
  to save and is dropped. A TMDB ref resolves as it does for a save.
- **UI.**
  - `WatchlistButton` and `useWatchlist` take a `WatchlistItem`. Built by
    `mediaWatchlistItem` (TMDB pages) or `titleWatchlistItem` (catalogue).
  - Matching (`sameTitle`) accepts either id.
  - `MovieListItem` takes an explicit `href` (null renders plain text) and `typeLabel`.
  - The My List tabs keep the Movies / TV Shows split; a catalogue series is labelled
    "Series".

### Validation (clean local chain, migrations 1–7, real server actions)

`lib/watchlist-actions.ts` ran unmodified against a local Supabase stack. Only
`lib/auth` was stubbed (the session); `server-only` was stubbed and TMDB served the
built-in sample data. The fixtures were published mapped and unmapped movies, a draft
mapped movie, and a published series.

| Area | Result |
| --- | --- |
| Saves (8) | PASS: TMDB ref of a published movie → `movie_id` only; catalogue re-save no-op; unmapped TMDB → legacy row; draft catalogue id refused; TMDB ref of a draft-mapped movie → legacy insert normalized by the trigger; TMDB tv → `series_id`; catalogue title without TMDB id; old-client direct legacy insert still accepted |
| Validation (2) | PASS: invalid id and extra fields rejected (strict schema) |
| Reads (6) | PASS: newest first; catalogue movie/series with href and TMDB alias; draft-mapped and unmapped rows described by TMDB; unknown TMDB id listed as unavailable with no link |
| Late catalogue match (4) | PASS: a legacy row whose title is published later reads as the catalogue title, a catalogue save of it is a no-op, and removal by catalogue ref deletes the legacy row |
| Removals (5) | PASS: by TMDB ref (internal row), draft-mapped row, series by catalogue ref, unavailable row; unrelated rows untouched |
| Guest import (3) | PASS: mixed forms merge to one row per title; draft catalogue ref dropped; unmapped TMDB kept legacy; re-import no-op |
| Isolation (3) | PASS: another user sees and removes nothing of the first user's; signed out refused |
| Client store (11) | PASS: pre-catalogue guest entries upgraded; malformed dropped; extra fields stripped; off-site/script links rejected; alias matching across id spaces (movie vs series, catalogue vs TMDB numbers) |
| `npm run lint` / `typecheck` / `build` | PASS / PASS / PASS |

### Unresolved-row report

Run read-only on hosted:

```sql
select count(*) as total_rows,
       count(*) filter (where movie_id is not null or series_id is not null) as catalogue_rows,
       count(*) filter (where movie_id is null and series_id is null) as legacy_rows,
       count(*) filter (where movie_id is null and series_id is null and (
         (media_type = 'movie' and exists (select 1 from public.movies m where m.tmdb_id = w.tmdb_id))
         or (media_type = 'tv' and exists (select 1 from public.series s where s.tmdb_id = w.tmdb_id)))) as legacy_mappable_now,
       count(distinct user_id) as users
from public.watchlist_items w;
```

2026-09-23: all zero. There are no hosted watchlist rows yet.

### Follow-ups

- Catalogue links go to `/movies/{slug}` and `/series/{slug}` (`titleHref`). Those
  routes arrive with the catalogue UI work; until then no catalogue title can be
  saved, because hosted has none.
- The database accepts any existing `movie_id`/`series_id` from an authenticated
  client that bypasses the app: an FK check, with no publication check. The app
  saves only published titles. A crafted request could only learn whether an
  internal id exists, and could store a reference that reads back as unavailable.
  Consider a trigger guard (published titles only for new internal saves) in a later
  migration.
