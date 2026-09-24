# Hosted Bootstrap Audit

Date: 2026-09-23
Scope: post-bootstrap, read-only verification of the hosted Velora UG Supabase project
`utxtqsfelovmhhcrknrz` (PostgreSQL 17.6).

## Result

**HOSTED BOOTSTRAP: PASS**

Every required database and security property that was checked matches the validated
four-migration chain. No schema or security discrepancy was found.

One tooling finding sits outside the database: the Supabase MCP server connects with
write access, not read-only access (see [MCP posture](#mcp-posture)). It does not change
the database result, but fix it before Checkpoint B.

Nothing in the hosted project was applied, repaired, inserted, updated or deleted. Every
query in this audit was a catalog `SELECT`, or an advisor or listing call.

## MCP posture

| Property | Observed | Status |
| --- | --- | --- |
| Authenticated | `list_migrations` and `list_tables` succeeded | PASS |
| Project scope | `.mcp.json` pins `project_ref=utxtqsfelovmhhcrknrz`; `get_project_url` returns `https://utxtqsfelovmhhcrknrz.supabase.co` | PASS |
| Read-only | `current_user` = `postgres`, `default_transaction_read_only` = `off`; the `.mcp.json` URL has no `read_only=true` and enables the `development`, `functions` and `branching` features | **NOT READ-ONLY** |

This audit kept itself read-only by running only catalog `SELECT` queries. The server
itself would have accepted writes.

## Migration history

`list_migrations` and `supabase_migrations.schema_migrations` both show exactly four rows:

| Version | Name |
| --- | --- |
| `20260919000000` | `profiles_and_watchlist` |
| `20260920000000` | `watchlist_limit_lock` |
| `20260920181819` | `search_analytics_and_history` |
| `20260922080911` | `velora_ug_catalogue_baseline` |

These match `supabase/migrations/` one-to-one.

## Hosted checks

| Check | Observed | Status |
| --- | --- | --- |
| Application objects | 14 tables: `public.{profiles, watchlist_items, search_history, vjs, movies, series, seasons, episodes, movie_versions, episode_versions, genres, movie_genres, series_genres}` and `private.search_events`; 9 identity sequences; 7 functions; all owned by `postgres`; all empty (0 rows) | PASS |
| Columns | Name, type, nullability and default match the migrations for all 14 tables, including the `watchlist_items.movie_id`/`series_id` additions and nullable `tmdb_id` | PASS |
| PKs, FKs, checks, uniques | All 106 constraints match, including `watchlist_items_identity_check`, the widened `media_type` check, `*_published_at_check`, `*_available_at_check`, and `ON DELETE` actions (catalogue RESTRICT, genre joins CASCADE, `auth.users` CASCADE) | PASS |
| Indexes | All 46 indexes match, including the partial cursor, featured and public-lookup indexes, `vjs_name_lower_key`/`genres_name_lower_key`, and the four partial `watchlist_items` indexes | PASS |
| FK leading-column index coverage | 15 of 15 FKs have an index whose first column is the FK column | PASS |
| RLS | Enabled on all 14 tables (not forced, as designed) | PASS |
| Phase 2/3 policies | Exactly 7, all `PERMISSIVE`, `TO authenticated`, `(select auth.uid())`-scoped: profiles read/update own; watchlist_items read/add/remove own; search_history read/remove own | PASS |
| Catalogue tables deny-by-default | All 10 have RLS with zero policies; the ACL is `postgres` only; no `service_role`, `anon`, `authenticated` or `PUBLIC` entry | PASS |
| Catalogue privileges (effective) | `has_table_privilege`/`has_any_column_privilege` are false for every privilege for both `anon` and `authenticated` on all 10 tables; no client privilege on any catalogue sequence | PASS |
| `anon`/`authenticated` SELECT on `movies`/`series` | `false` for all four combinations | PASS |
| Phase 2 grants | `authenticated`: `profiles` SELECT plus column UPDATE on `display_name` only; `watchlist_items` SELECT/INSERT/DELETE. `anon`: nothing on either | PASS |
| Phase 3 grants | `authenticated`: `search_history` SELECT/DELETE. `anon`: nothing. `private.search_events` and its sequence: no client privilege. `private` schema: no `USAGE` for `anon`/`authenticated` | PASS |
| Triggers | 11 enabled triggers that resolve: 9 `*_set_updated_at` → `private.set_updated_at()`; `watchlist_items_enforce_limit` (BEFORE INSERT) → `private.enforce_watchlist_limit()`; `on_auth_user_created` on `auth.users` (AFTER INSERT) → `private.handle_new_user()` | PASS |
| Function bodies | The whitespace-normalised MD5 of all 7 live bodies equals the final repo definition of each (for `enforce_watchlist_limit`, the corrected version in `20260922080911`) | PASS |
| Hardened `search_path` | `search_path=""` on all 7 functions | PASS |
| `SECURITY DEFINER` set | Exactly `handle_new_user`, `enforce_watchlist_limit`, `record_search`, `trending_searches` | PASS |
| `private.enforce_watchlist_limit()` | `SECURITY DEFINER`, owner `postgres`, ACL `{postgres=X/postgres}`; EXECUTE is false for `anon`, `authenticated` and `service_role`; the body contains the advisory lock and the catalogue lookups | PASS |
| `public.record_search(text, text, integer)` | `SECURITY DEFINER`, volatile, owner `postgres`, EXECUTE for `anon` and `authenticated` (and `service_role`, via platform default) | PASS |
| `public.trending_searches(integer)` | `SECURITY DEFINER`, `STABLE`, owner `postgres`, EXECUTE for `anon` and `authenticated` (and `service_role`, via platform default) | PASS |
| Private helpers | `normalize_search_query` (immutable) and `purge_search_events`: no EXECUTE for clients. `set_updated_at` keeps the default PUBLIC EXECUTE, unchanged since Phase 2: it is a non-definer trigger function in the unexposed `private` schema | PASS |

## Advisors

### Security

| Finding | Level | Classification | Reason |
| --- | --- | --- | --- |
| `rls_enabled_no_policy` on the 10 catalogue tables | INFO | Informational | Intended deny-by-default baseline. Phase B adds published-only read policies |
| `rls_enabled_no_policy` on `private.search_events` | INFO | Informational | Intended: only the definer functions touch it |
| `anon_security_definer_function_executable`: `record_search`, `trending_searches` | WARN | Existing/non-blocking | Intended Phase 3 RPC design, validated input, no row output, accepted in the Phase 3 audit |
| `authenticated_security_definer_function_executable`: same two functions | WARN | Existing/non-blocking | As above |

### Performance

| Finding | Level | Classification | Reason |
| --- | --- | --- | --- |
| `unused_index` on 14 indexes | INFO | Informational | Every table is empty and no catalogue query path exists yet |

No advisor finding is a bootstrap blocker.

## Classified follow-ups

| Item | Classification |
| --- | --- |
| MCP server has write access (`postgres`, no `read_only=true`) | Should fix before Checkpoint B. Add `read_only=true` to the `.mcp.json` URL and drop the features audits don't need, so verification sessions can't write to the database |
| Search-event retention unscheduled (`pg_cron` not installed) while `record_search` is callable by `anon` | Should fix before Checkpoint B / public release. Phase A accepts either verified retention or analytics writing disabled; neither holds yet |
| Default privileges in `public` grant `anon`/`authenticated` full rights on future tables, sequences and functions | Informational (Supabase platform default). Every Phase B migration must keep explicit `revoke`s, as `20260922080911` does |
| `service_role` keeps its default grants on `profiles`, `watchlist_items`, `search_history`, and EXECUTE on the public RPCs | Existing/non-blocking. It bypasses RLS and the app never uses its key |

## Repository gates

Not rerun. Only `.claude/settings.local.json` has changed since the gates last ran (the
file-modification check covers everything except `node_modules`, `.next` and `.git`), so
the earlier results stand:

| Gate | Command | Result (2026-09-23) |
| --- | --- | --- |
| Lint | `npm run lint` | PASS (exit 0, no findings) |
| Typecheck | `npm run typecheck` (`next typegen && tsc --noEmit`) | PASS (exit 0) |
| Build | `npm run build` | PASS (exit 0, 15 static pages generated) |

Build note: Next.js warns that it ignored a `bun.lock` in `C:\Users\willi` (outside the
repository) and suggests setting `turbopack.root`. It is non-blocking and unchanged.

## Not covered by this audit

This is a static metadata audit. It did not exercise behaviour as the `authenticated` or
`anon` role on the hosted project: no legacy-insert normalization, 500-item cap, race, or
two-user RLS tests, because those need writes. The local clean-bootstrap run in
`docs/VELORA_UG_SCHEMA_BASELINE.md` covered them. The hosted objects are shown to be
identical to what that run tested.

---

# Pre-B hardening (2026-09-23)

Status: **READY TO DEPLOY PRE-B HARDENING**. The retention migration is validated on a
clean local chain and the hosted dry-run is clean. It has **not** been pushed to hosted.
MCP read-only verification is still pending a reconnect. The bootstrap results above
are unchanged.

## 1. MCP read-only correction

- `.mcp.json` now sets `read_only=true` on the existing Supabase MCP URL, between
  `project_ref=utxtqsfelovmhhcrknrz` and `features=` (approved). Supabase documents this
  flag as "Execute all queries as a read-only Postgres user". The file holds no
  credentials; OAuth is handled by the client.
- **Verification pending.** The MCP server has not reconnected yet. It still reports
  `current_user = postgres`, `transaction_read_only = off`, and `apply_migration` is
  still offered. No write was attempted as a test. After reconnecting (`/mcp`), verify
  with no writes:
  - `get_project_url` returns `https://utxtqsfelovmhhcrknrz.supabase.co`
  - `list_tables` still works
  - `select current_user, current_setting('transaction_read_only')` returns
    `supabase_read_only_user` / `on`
  - `apply_migration` and other mutating tools are no longer offered

## 2. Retention policy (explicit decision)

**30 days for raw anonymous `search_events` is an explicit Velora UG
product/engineering decision, approved 2026-09-23.** It was not inferred from the Phase 3
implementation, which deliberately set no period.

| Data | Lifecycle |
| --- | --- |
| `private.search_events` (raw anonymous analytics) | Kept **30 days**. Purged **daily** by Supabase Cron, in batches of 5,000 |
| `trending_searches` calculation | Reads the last **7 days** (unchanged) |
| `public.search_history` (user-linked) | Separate lifecycle, unchanged: newest 20 per user, user removal under RLS, deleted with the account. The 30-day policy does **not** apply to it |
| Analytics writer (`record_search`) | Remains enabled |

### `search_events` and `search_history`

| | `private.search_events` | `public.search_history` |
| --- | --- | --- |
| Purpose | Anonymous aggregate analytics for `trending_searches` | A signed-in user's own "Recent searches" |
| Whose data | Guests and signed-in users, with no identity recorded | Signed-in users only |
| Identifiers | None: no user id, IP, user agent, session or token. `id` is a surrogate key | `user_id` (FK to `auth.users`) |
| Content | Canonical query, scope, caller-reported `result_count` | Scope and canonical query |
| Timestamps | `created_at` | `searched_at` (refreshed when the same search repeats) |
| Written by | `public.record_search` only (`POST /api/search-events` ← `components/search-recorder.tsx`) | `public.record_search` only; read and removed via `lib/search-history-actions.ts` |
| Hosted rows (2026-09-23) | 0 | 0 |

## 3. Mechanism: `20260923180000_search_events_retention.sql`

- `create extension if not exists pg_cron with schema pg_catalog` (Supabase's supported
  install; version 1.6.4 locally).
- Job `velora-purge-search-events`, schedule `17 0 * * *` (00:17 UTC, 03:17 in Kampala),
  command `select private.purge_search_events(interval '30 days', 5000)`. It runs as
  `postgres`, the function's owner.
- It reuses the existing Phase 3 purge function unchanged: it deletes only from
  `private.search_events`, oldest first, one bounded batch per call, and never anything
  newer than 7 days. The interval is explicit and non-null (Phase 3 debt item 7 is
  satisfied).
- Idempotent: a named `cron.schedule` updates the job in place, so re-running the
  migration leaves exactly one job with this definition.
- Privileges (per the `AGENTS.md` invariant):
  - Explicit revokes from `anon` and `authenticated` on the `cron` schema, its tables
    and its functions, and from `PUBLIC`, `anon` and `authenticated` on the purge
    function.
  - pg_cron's own `supabase_admin`-owned `PUBLIC` grants (EXECUTE on
    `schedule`/`unschedule`, SELECT on the job tables) can't be revoked by `postgres`,
    but clients can't reach them: no role other than `postgres`/`supabase_admin` has
    `USAGE` on `cron`, `cron` isn't an exposed API schema, and the job tables apply RLS
    by `username`.
  - No object is created in `public` or `private`.
- **Capacity limit:** daily × 5,000 purges at most 5,000 events per day. Sustained volume
  above that grows the backlog. Monitor `private.search_events` size, and raise the
  cadence or batch in a new migration if needed.

## 4. Default-privilege invariant

Added to `AGENTS.md` §14 ("Migration privilege invariant"). It requires explicit
privilege handling in every migration that creates or replaces a table, sequence, view,
materialized view or function. Default privileges are never relied on. It also requires
explicit revokes from `PUBLIC`, `anon` and `authenticated`, and a review of each
function's definer/invoker mode, `search_path`, `EXECUTE` and dynamic SQL. Applied
migrations are immutable.

## 5. Clean five-migration validation (local Supabase, PostgreSQL 17, CLI 2.117.0)

Run in an isolated scratch project with `supabase db reset`. The migration file used
was byte-identical to the repository copy.

| Check | Result |
| --- | --- |
| All five migrations apply from clean | PASS |
| Cron extension and job | PASS: `pg_cron` 1.6.4 in `pg_catalog`; exactly one job, active, `postgres`, `17 0 * * *`, explicit `interval '30 days'`, `5000` |
| Scheduled worker actually executes | PASS: with the schedule temporarily set to every minute (local only, then restored), `cron.job_run_details` shows `succeeded` as `postgres`, and a 45-day event was deleted |
| Older than 30 days removed / newer survive | PASS: fixtures at 1, 6, 8, 29, 31, 60, 400 days plus 5,003 at 90 days leave exactly 1, 6, 8, 29 days |
| Batch bound | PASS: first run deletes exactly 5,000 (oldest first), second run 6 |
| Repeated cleanup idempotent | PASS: third run deletes 0 |
| 7-day floor still effective | PASS: `purge('1 day')` and `purge('0 seconds')` delete only the 8- and 29-day rows; 1 and 6 days survive (rolled back) |
| `search_history` unaffected | PASS: rows at 400 days and 1 day both survive |
| Migration re-run | PASS: exactly one job, schedule restored, no warnings |
| Phase 2/3 schema intact | PASS: 14 tables, 106 constraints, 46 indexes, 7 policies, RLS on 14, 0 unindexed FKs, identical table ACLs to hosted |
| Functions | PASS: all 7 bodies hash-identical to hosted, with the same `SECURITY DEFINER` set, `search_path=""` and ACLs |
| Catalogue RLS/grants unchanged | PASS: 0 privileges for `anon`/`authenticated` on the 10 catalogue tables |
| Watchlist correction (as `authenticated`) | PASS: legacy `{550, movie}` insert resolves to `movie_id`; the duplicate is a no-op; `SELECT public.movies` is denied |
| No unintended privileges | PASS: `anon`/`authenticated` denied reading `cron.job`, calling `cron.schedule`, and calling the purge function |
| `supabase db lint` (`public`, `private`) | PASS: no schema errors |
| `npm run lint` / `npm run typecheck` / `npm run build` | PASS / PASS / PASS (15 static pages) |

## 6. Hosted deployment status

`npx supabase db push --linked --dry-run` proposes only
`20260923180000_search_events_retention.sql`. **Not pushed.** The real push needs
explicit authorization. After it runs, verify on hosted that the job exists as above and
that the first 00:17 UTC run appears in `cron.job_run_details` as `succeeded`.

## 7. Final Pre-B hosted verification (2026-09-23, 19:57 UTC)

Status: **PRE-B GATE: PASS**, with one check still pending: the first scheduled run
is due at 00:17 UTC on 2026-09-24.

The session was read-only throughout. Only catalog/data `SELECT`s, listings and advisors
were used.

### MCP posture (re-verified)

| Property | Observed | Status |
| --- | --- | --- |
| Project scope | `get_project_url` → `https://utxtqsfelovmhhcrknrz.supabase.co` | PASS |
| Role | `current_user` = `session_user` = `supabase_read_only_user` | PASS |
| Read-only transactions | `transaction_read_only` = `on`, `default_transaction_read_only` = `on` | PASS |
| Role memberships | `pg_read_all_data` yes; `pg_write_all_data` no; `postgres` no | PASS |
| Mutating tools | `apply_migration`, `deploy_edge_function` and branch create/merge/reset are no longer offered | PASS |

### Retention migration on hosted

| Check | Observed | Status |
| --- | --- | --- |
| Migration history | Exactly 5 rows, ending `20260923180000 search_events_retention`; B-1/B-2 not pushed | PASS |
| Extension | `pg_cron` 1.6.4 in `pg_catalog` | PASS |
| Job | Exactly one: `velora-purge-search-events`, `17 0 * * *`, `select private.purge_search_events(interval '30 days', 5000)`, `postgres`, active | PASS |
| Purge function ACL | `{postgres=X/postgres}` only | PASS |
| Client reach into `cron` | `anon`/`authenticated`: no `USAGE` on `cron` (ACL `supabase_admin`, `postgres` only), so pg_cron's non-revocable `PUBLIC` SELECT on the job tables can't be reached; no reachable EXECUTE on any `cron` function or the purge function; no `USAGE` on `private` | PASS |
| First scheduled run | `cron.job_run_details` is empty. The first run is due 2026-09-24 00:17 UTC | **PENDING** |

### Baseline drift

14 tables (RLS on all 14), 106 constraints, 46 indexes, 7 policies, 7 functions (all
`search_path=""`; definers `enforce_watchlist_limit`, `handle_new_user`,
`record_search`, `trending_searches`), 11 enabled triggers, 0 `anon`/`authenticated`
privileges on the 10 catalogue tables, all tables empty. This is identical to the
bootstrap audit.

### Advisors

- Security: the same findings as the bootstrap audit (`rls_enabled_no_policy` INFO ×11;
  `record_search`/`trending_searches` definer WARN ×4, accepted in Phase 3). None are new,
  and none relate to cron.
- Performance: `unused_index` INFO ×13 (was 14), expected on empty tables.

### Remaining follow-up

After 2026-09-24 00:17 UTC, run
`select status, username, start_time, return_message from cron.job_run_details order by start_time desc limit 1`
and confirm the result is `succeeded` as `postgres`.

---

# Repository reconciliation checkpoint (2026-09-24, 19:31 UTC)

Scope: read-only reconciliation of hosted Supabase, Git and documentation. Nothing
was applied, pushed, repaired or executed on hosted. No `db push`, no
`migration repair`, and the cron job was not run manually.

The earlier observations above stand as recorded at their time. §7 correctly saw
5 migrations and an empty `cron.job_run_details` on 2026-09-23 at 19:57 UTC. B-1
and B-2 were deployed later that day (see `docs/PHASE_B_CATALOGUE_DESIGN.md`,
"Hosted deployment (B-1 + B-2)"). That record says the owner explicitly authorized
the push and that it went through `db push --db-url` over the session pooler. This
checkpoint independently confirms the hosted *result*. It holds no further evidence
about who ran the push, or when.

## 8.1 MCP posture

| Property | Observed | Status |
| --- | --- | --- |
| Role | `current_user` = `supabase_read_only_user` | PASS |
| Read-only | `transaction_read_only` = `on`, `default_transaction_read_only` = `on` | PASS |
| Project | Tools scoped to `utxtqsfelovmhhcrknrz` (`.mcp.json`) | PASS |

## 8.2 First scheduled retention run

`cron.job` joined to `cron.job_run_details`:

| Field | Observed |
| --- | --- |
| Job | `velora-purge-search-events` (jobid 1, `17 0 * * *`, owner `postgres`, active) |
| Run | runid 1, the only run so far |
| Status | `succeeded` |
| Username | `postgres` |
| Start / end | `2026-09-24 00:17:00.199148+00` / `2026-09-24 00:17:00.239315+00` |
| Return message | `1 row` (the single result row of `select private.purge_search_events(...)`) |
| Command | `select private.purge_search_events(interval '30 days', 5000)` |

**PASS.** It was the scheduled run, not a manual one. This closes the §7 follow-up.

## 8.3 Hosted migration history

`list_migrations` and `supabase_migrations.schema_migrations` show exactly **7**:

| Version | Name | Statements | MD5 of recorded statements |
| --- | --- | --- | --- |
| `20260919000000` | `profiles_and_watchlist` | 21 | `a52ddafd67f3e89b0daea33d0c76ebda` |
| `20260920000000` | `watchlist_limit_lock` | 1 | `93e36670e6b77070d9aff5e82302c046` |
| `20260920181819` | `search_analytics_and_history` | 22 | `e4a28d933c26407d8cfce26591972bf7` |
| `20260922080911` | `velora_ug_catalogue_baseline` | 53 | `31928e2429785cf08c8f49a3fe15d14a` |
| `20260923180000` | `search_events_retention` | 6 | `30415882ca7acfbfa4a256840e6188e7` |
| `20260923200000` | `catalogue_ingestion_tables` (B-1) | 17 | `d467c2287abe83352bc0a7b49a99020f` |
| `20260923210000` | `catalogue_public_read` (B-2) | 29 | `5b4b75b248c5400cf053e422f6d806f2` |

Comparison method: the repository's `supabase/migrations/` was applied to a clean
local Supabase stack (CLI 2.117.0, `supabase/postgres:17.6.1.166`). That stack records
statements the same way. Every version has an identical statement count, joined
length and MD5 on both sides. **Hosted history equals the repository exactly.**

## 8.4 Hosted drift spot-check (catalog reads only)

17 tables in `public`/`private`, 0 without RLS; 17 policies. `SECURITY DEFINER` set
is exactly the 4 `catalogue_access` predicates plus `enforce_watchlist_limit`,
`handle_new_user`, `record_search` and `trending_searches`. 0 application
functions without `search_path=""`. `anon`/`authenticated` have no `USAGE` on `cron`
or `private`, and `authenticated` cannot execute the purge function. 0 movies and 0
watchlist rows. These are the invariants the new regression suite asserts locally
(§8.6).

## 8.5 Git durability

| Ref | Commit | Contents |
| --- | --- | --- |
| `veloraug/phase-a-foundation` | `6632328` | All 7 migrations: Phase A (`05aef93`), retention (`a6c8885`), B-1 (`525bdd1`), B-2 (`b40a99c`), deploy record (`638a805`), B-3 app (`6632328`) |
| `veloraug/main` | `c91f07d` | GitHub PR #1 merge (2026-09-23 21:30 +03:00) of `phase-a-foundation` at `a6c8885`: migrations 1–5 only |
| `origin/*` (`WilsoftTech/velora`) | — | Legacy Velora repository: Phase 2 only; no Velora UG work |

The source for every hosted migration was already on the remote before this
checkpoint. The local branch was identical to `veloraug/phase-a-foundation`, so
nothing needed pushing to make hosted reproducible.

## 8.6 Repeatable regression tests

`supabase/tests/database/*.test.sql` (pgTAP, 126 assertions) runs via
`npm run test:db`, which rebuilds the **local** database from migrations, then runs
`supabase test db --local`. Result on 2026-09-24: **126/126 PASS**. A mutation check
(an injected leak policy, a hidden-column grant, and purge EXECUTE for
`authenticated`) made 7 assertions fail, as intended. `supabase db lint --local`
(`public`, `private`, `catalogue_access`): no schema errors. These tests never
run against hosted.
