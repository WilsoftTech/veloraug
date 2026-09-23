# Phase B — Catalogue Domain: Checkpoint Plan and Decisions

Date: 2026-09-23
Status: **Approved 2026-09-23 (D1–D5 as recommended).**
Baseline: `phase-a-foundation` at `a6c8885`. Hosted migrations 1–5 applied.

## Entry gate

Phase A is complete in the repository. One gate remains open: **hosted verification
of the Pre-B retention migration `20260923180000`**. The Supabase MCP server's new
read-only configuration needs OAuth sign-in (`claude mcp get supabase` →
"Needs authentication"), so the current session still has write access.

Until that gate closes, Phase B work stays local: migrations validated on a clean
local Supabase, nothing pushed to hosted.

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

Status: **validated locally, ready to deploy.** Not pushed to hosted.

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

Status: **validated locally, ready to deploy together with B-1.** Not pushed to hosted.

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

Not yet run: the hosted Supabase advisors (they need the MCP sign-in). Expect
`rls_enabled_no_policy` to disappear for the 10 catalogue tables and new
informational notices for the `catalogue_access` definer functions.
