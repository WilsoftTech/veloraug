# Velora UG Schema Baseline

Date: 2026-09-22
Status: Approved for the first Velora UG migration

## Purpose

This record resolves the identity and relationship decisions required before
the first Velora UG migration. It covers the catalogue foundation and legacy
watchlist compatibility. It does not expose the new catalogue publicly or
replace any TMDB-backed application read path.

## Decisions

### Canonical titles and VJ versions

- A movie or series is one canonical title, independent of its translator.
- A VJ translation is inventory attached to the canonical title, not a second
  copy of that title.
- Movies therefore have `movie_versions`, unique by `(movie_id, vj_id)`.
- Series do not have one permanent VJ. Translation availability belongs to
  each episode through `episode_versions`, unique by `(episode_id, vj_id)`.
- A version may carry an optional title override for genuinely VJ-specific
  display wording. The canonical title remains the search/metadata identity.
- Supporting more than one edition from the same VJ is deferred until a real
  ingestion case requires an edition discriminator.

This permits the same title to be available from multiple VJs without
duplicating metadata, seasons, episodes, genres, or watchlist identity.

### Internal and external identity

- Every catalogue table uses a database-owned `bigint generated always as
  identity` primary key.
- Public navigation will use stable, unique slugs for movies, series, and VJs.
  Numeric IDs remain implementation identifiers and relationship keys.
- TMDB IDs are nullable, positive, unique external mappings. They enrich a
  canonical record but never define Velora UG inventory.
- Movies and series have separate ID spaces. No polymorphic `catalogue_items`
  table or untyped `catalogue_id` is introduced.
- Season identity is `(series_id, season_number)`; episode identity is
  `(season_id, episode_number)`. TMDB episode IDs remain optional mappings.

### Movie and series boundary

- The Velora UG domain vocabulary is `movie | series`.
- TMDB's `tv` value remains only at the TMDB adapter and legacy-route boundary.
- Movies are directly translated through `movie_versions`.
- Series normalize as `series -> seasons -> episodes -> episode_versions`.
- Shared presentation types may form a TypeScript union, but database
  relationships remain concrete foreign keys rather than polymorphic pairs.

### Publication, availability, and rights

- Canonical movies and series have `draft | published | archived` publication
  state.
- Versions independently have `draft | ready | unavailable | archived`
  availability and `unknown | cleared | blocked` rights state.
- Later public catalogue queries must require a published canonical title and
  at least one ready, rights-cleared version.
- The baseline migration enables RLS and grants no client access to the new
  tables. Phase B will add narrowly scoped public reads only when its query
  contract and readiness predicates are implemented.
- Admin/reviewer authorization must use server/database-controlled membership,
  never user-editable Auth metadata. That authorization model is deferred
  until an admin write path is introduced.

### Relationships and deletion

- VJs, movies, series, and media versions are independent first-class rows.
- Canonical-to-version and canonical hierarchy foreign keys use restrictive
  deletion. Published catalogue history must not disappear through an
  accidental cascading delete.
- Genre join rows cascade when either side is intentionally deleted; the join
  contains no independent business record.
- Every foreign key is indexed when it is not already the leading part of a
  primary or unique index.
- All timestamps use `timestamptz`; identifiers and object names use lowercase
  snake_case.

## Legacy watchlist migration

The existing `(user_id, media_type, tmdb_id)` identity remains readable and
removable during a compatibility period.

The first migration will:

1. Add nullable `movie_id` and `series_id` foreign keys.
2. Allow `tmdb_id` to become nullable for internal-only rows.
3. Permit transitional `media_type` values `movie | tv | series`, where `tv`
   is valid only for an unresolved legacy row.
4. Require every row to be one of:
   - unresolved legacy: neither internal FK, positive TMDB ID, `movie | tv`;
   - movie: `movie_id` only and `media_type = movie`;
   - series: `series_id` only and `media_type = series`.
5. Add per-user unique indexes for internal movie and series identities.
6. Backfill only exact unique TMDB mappings. Movie rows retain `movie`; mapped
   TV rows become `series`.
7. Leave unavailable rows unresolved and removable. Never guess a mapping and
   never delete a user's saved row because catalogue inventory is absent.
8. Preserve the legacy unique constraint and Phase 2 application writes until
   Phase B changes the data layer and measures unresolved rows.

The 500-item trigger continues to serialize inserts per user and is extended to
recognize both legacy and internal identities.

## First migration scope

The first Velora UG migration creates only the normalized foundation:

- `vjs`
- `movies` and `movie_versions`
- `series`, `seasons`, `episodes`, and `episode_versions`
- `genres`, `movie_genres`, and `series_genres`
- watchlist compatibility columns, constraints, indexes, safe backfill, and
  trigger update

Telegram references, ingestion events, matching review, public catalogue
policies, and application query conversion remain in Checkpoints B and C.

## Consequences

- A watchlist saves the canonical work, not a VJ version. VJ choice belongs to
  playback or a later preference.
- Adding another VJ never creates a duplicate search/detail title.
- A series can mix VJs across episodes without misrepresenting the whole
  series.
- TMDB can be removed from ordinary reads after Phase B without changing
  canonical IDs.
- Legacy rows survive until catalogue coverage makes their mapping explicit.

## Verification

The migration was applied after all Phase 1–3 migrations to an isolated local
Supabase/Postgres 17 database.

- All four migrations applied successfully and appeared in local migration
  history.
- `supabase db lint` found no schema errors in `public` or `private`.
- All ten new public tables have RLS enabled.
- The new tables expose zero grants to `PUBLIC`, `anon`, `authenticated`, or
  `service_role`.
- No new foreign key lacks an index.
- Rollback-only fixtures verified movie/series/VJ relationships, automatic
  normalization of mapped legacy watchlist writes, duplicate no-ops, and
  preservation of unavailable legacy rows.
- Security/performance advisors produced no errors. Their informational notices
  were expected for an empty schema: query indexes are not used yet, and the
  deliberately inaccessible baseline tables have RLS without policies.

## Corrective pass: watchlist trigger privilege defect

Date: 2026-09-22

### Defect found

Before this pass, `private.enforce_watchlist_limit()` (as replaced by this
migration) read `public.movies`/`public.series` — both to resolve a legacy
`{tmdb_id, media_type}` insert into `movie_id`/`series_id`, and in the
cross-format duplicate check that compares an internal-ID row against an
existing legacy row. The function ran with caller (invoker) privileges, and
this same migration revokes all catalogue-table privileges from
`authenticated`/`anon`. A clean local bootstrap of migrations 1–4, tested as
the `authenticated` role rather than a superuser connection, reproduced a
deterministic failure on every legacy watchlist insert:

```
ERROR:  permission denied for table movies
HINT:  Grant the required privileges to the current role with: GRANT SELECT ON public.movies TO authenticated;
```

and equivalently for `series`. This breaks the existing "Add to My List" path,
since `lib/watchlist-actions.ts` only ever sends `{tmdb_id, media_type}` —
the legacy shape — today. The earlier "Rollback-only fixtures verified
... automatic normalization of mapped legacy watchlist writes" note above was
evidently exercised as a privileged connection, which does not reproduce this
grant boundary.

### Why a direct SELECT grant was rejected

Granting `authenticated`/`anon` `SELECT` on `movies`/`series` was considered
and rejected: those tables have RLS enabled with **no policies at all** at
this checkpoint (Phase B has not defined public reads yet), so a table-level
grant would expose every row — including draft/unpublished titles — to any
authenticated request, not just the narrow "does this id exist" lookup the
trigger needs. That would silently widen the catalogue security boundary this
migration exists to hold shut.

### Fix: narrowly scoped SECURITY DEFINER

`private.enforce_watchlist_limit()` is now `security definer`, matching the
existing pattern already used in this codebase for the identical
privileged-read/unprivileged-caller shape (`private.handle_new_user`,
`public.record_search`, `public.trending_searches`):

- Empty `search_path` (unchanged — was already present).
- Every referenced object schema-qualified (unchanged — was already correct).
- No dynamic SQL anywhere in the function (confirmed by inspection — every
  query is a static `plpgsql` `SELECT`/`EXISTS` against a fixed table name;
  caller-controlled values are only ever used as comparison values, never as
  identifiers).
- `EXECUTE` explicitly revoked from `public`, `anon`, `authenticated` (the
  `private` schema already has no `USAGE` grant for those roles, so this is
  defense-in-depth, not the primary control).
- The function never returns catalogue data to the caller. It only assigns a
  looked-up id onto `NEW.movie_id`/`NEW.series_id` on the caller's own
  about-to-be-inserted row, which the caller could already read back once
  inserted. The elevation therefore discloses nothing beyond "this tmdb_id
  already has a canonical mapping" — no title, overview, poster, or any other
  catalogue field is ever exposed through this path.
- All other logic (advisory-lock race-safety, 500-item cap, duplicate
  detection, unresolved-legacy-row preservation) is unchanged.

### Migration-history decision

`20260922080911_velora_ug_catalogue_baseline.sql` was corrected **in place**,
not superseded by a new migration file. Verified before editing: the file was
untracked in git (`git log` for its path is empty) and
`supabase_migrations.schema_migrations` on the hosted `utxtqsfelovmhhcrknrz`
project has zero rows — this migration has never been applied anywhere,
hosted or otherwise. The repository's own established convention (see the
Phase 2 audit's live-migration handling) only ever avoids rewriting a
migration once it has been applied and adopted as history; an unapplied,
untracked file carries no such constraint. Editing in place avoids
introducing migration debt for a defect that never reached any environment.

### Clean-bootstrap re-verification

Re-ran the full four-migration chain against a fresh isolated local
Supabase/Postgres 17 database (system schemas only, mirroring the new hosted
project's current state). All four applied without manual intervention.
Re-verified unchanged: all 14 tables, RLS on all 14, the same 7 Phase 2/3
policies, all 15 foreign keys indexed, all 11 triggers resolve, zero
catalogue grants for `anon`/`authenticated`/`public`, `search_path` hardened
on all 7 functions, `SECURITY DEFINER` now correctly set on exactly
`handle_new_user`, `enforce_watchlist_limit`, `record_search`,
`trending_searches`. `supabase db lint` reported no schema errors.

Newly verified as the `authenticated` role (not a superuser connection):
legacy movie/series resolution, cross-format duplicate suppression (both
legacy→legacy and internal-ID→legacy), unresolved-row preservation for an
unmatched `tmdb_id`, no misassignment for a mismatched `media_type`, the
500-item cap and 501st-item rejection, a genuine two-connection race at the
cap boundary (exactly one of two concurrent inserts for the 500th slot
succeeded, the other was cleanly rejected — the advisory lock still
serializes correctly), delete/removal, and read-own. `anon` remains fully
denied on `watchlist_items` (no grant at all, not merely an RLS filter) and
on the ten catalogue tables. `has_table_privilege` confirms `authenticated`
and `anon` still cannot `SELECT` `movies` or `series` directly.

This corrective pass does not change the outcome of Checkpoint A2's original
decisions (identity model, publication/availability/rights states, VJ
architecture) — only the trigger's privilege boundary.
