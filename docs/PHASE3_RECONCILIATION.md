# Phase 3 Reconciliation

Date: 2026-09-22

## Scope

This checkpoint reconciles `origin/phase3-discover` with `main`. It does not add
features, change the database, or begin the Velora UG schema work.

## Repository baseline

- The pre-integration `main` and `origin/main` baseline was
  `313e62109999bfd98bcf65a135c88029bf9caf8b`.
- `origin/phase3-discover` is exactly four commits ahead of `main` and has not
  diverged from it.
- The branch can therefore be integrated with a fast-forward merge. A
  cherry-pick is not appropriate unless one of the commits is intentionally
  rejected.
- `git diff --check main..origin/phase3-discover` passes.

## Commit assessment

| Commit | Purpose | Reconciliation result |
| --- | --- | --- |
| `c5a9bbcad101af82c61ee29e0a98e9a8eb635d68` | Discover page with genre, year, rating, and sort filters | Preserve as completed Phase 3 functionality. Its TMDB catalogue source is temporary and can be replaced progressively during Checkpoint B. |
| `7dbcc4492cd2c83aeb00dbd398ad80412e666226` | Phase 2 responsive-header documentation correction | Documentation-only; preserve with the branch history. |
| `e9ce7f016af8be663bb4106184b5fa2a43f1d6b4` | Search analytics and history database migration | Reconciled against the Phase 3 CLI audit and current live Data API behavior. The branch migration is `20260920181819_search_analytics_and_history.sql`. |
| `8a4c8e3839866d2cc6077767f0beb8ab5102d8b7` | Search-history application integration | Preserve, but do not publicly release the event writer until retention and abuse controls are resolved. |

## Database review

The Phase 3 branch contains these migration versions:

1. `20260919000000`
2. `20260920000000`
3. `20260920181819`

The branch's Phase 3 audit records that all three versions were applied and
that the final migration created the following objects:

- `private.search_events` and its supporting sequence/index
- `public.search_history`
- `private.normalize_search_query`
- `public.record_search`
- `public.trending_searches`
- `private.purge_search_events`

Static review of the migration confirms that it enables row-level security for
user-owned history, keeps raw events in the private schema, revokes broad
defaults, grants only the intended function access, and hardens security-definer
functions with an empty `search_path`.

The audit file is historical evidence, not by itself an independent
confirmation of the current hosted database.

On 2026-09-22, a read-only PostgREST check against the configured hosted
project confirmed that:

- the service-role credential is accepted by the live Data API;
- `public.search_history` is present in the live OpenAPI schema;
- `public.record_search` and `public.trending_searches` are present in the live
  OpenAPI schema; and
- a service-role zero-row request for all expected `search_history` columns
  succeeds;
- anonymous table access to `search_history` is denied with HTTP 401; and
- anonymous execution of the read-only `trending_searches` RPC succeeds,
  corroborating its private search-event dependency.

Together with the Phase 3 audit's recorded Supabase CLI migration list and
catalog verification, this confirms that the applied versions are:

1. `20260919000000`
2. `20260920000000`
3. `20260920181819`

The supplied `DATABASE_URL` and `DIRECT_URL` both identify the correct project,
but both contain the same shared session-pooler endpoint. `DIRECT_URL` is not a
direct connection. TCP connectivity to the pooler succeeds, while Supabase CLI
2.117.0 connections are terminated by the server and an independent Postgres
driver times out. The project's direct hostname resolves to IPv6, but this
environment cannot reach it. This prevented a second direct catalog dump; it
does not contradict the recorded CLI audit or the current live API evidence.

## Verification result

The combined audit evidence confirms:

1. The Phase 3 audit recorded the three migration-history versions and catalog
   objects after applying the migration.
2. The current hosted Data API exposes the intended public table and RPCs.
3. The expected service-role, anonymous table, and anonymous RPC behaviors are
   still in effect.
4. The checked-in migration matches the objects and permissions described by
   that audit.

## Integration decision

All four commits were integrated using:

```text
git merge --ff-only origin/phase3-discover
```

Do not cherry-pick the commits individually. The branch is linear, the commits
form one reviewed Phase 3 unit, and selective cherry-picking would leave either
the database source or its application integration out of sync.

`main` now points to `8a4c8e3839866d2cc6077767f0beb8ab5102d8b7`.

## Release gate carried forward

`private.purge_search_events` exists, but the Phase 3 audit reports that no
retention schedule is installed. The anonymous `record_search` entry point can
also be abused to generate event volume. This does not require rewriting or
discarding Phase 3, but the event writer must not be exposed publicly until a
retention and rate-limiting decision is implemented and verified.

## Checkpoint status

Checkpoint A1 is complete. Phase 3 was accepted as one linear unit and
fast-forwarded onto `main`. Checkpoint A2 may now begin, while the retention and
rate-limiting item above remains a release gate.
