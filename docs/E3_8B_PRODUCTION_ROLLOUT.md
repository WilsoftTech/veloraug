# E3.8B controlled production rollout preflight

Date: 2026-10-10, Africa/Nairobi. **Gate A production migrations complete.
Discovery-only preparation continues; live activation awaits separate approval.
Gate C is deferred and blocked pending new authorization.**
Production identity/history, backup and migration checks are recorded below.
Remote consumer ownership, real rights, reviewer enrollment and publication remain unverified.

## Authorization gates and stop conditions

### Current scope — discovery-only preparation

The operator subsequently deferred Gate C entirely and instructed continued
Gate A/B preparation only. Do not request a publication candidate, publication
reviewer IDs or rights documentation as prerequisites for this stage. No rights
clearance, publication capability, approval or movie publication is authorized.
The previous Gate C authorization is superseded; Gate C stays blocked until
separately authorized again. Further hosted migrations and live listener activation
also require separate approval. The already confirmed Gate A execution below is
historical fact and was completed before this instruction.

Prepared discovery-only workflow:

1. On a separately approved persistent host, configure the existing worker with
   `VELORA_DISCOVERY_INSPECTION=metadata`, restricted discovery database access
   and certificate-verified TLS. Keep `VELORA_DISCOVERY_LIVE_AUTHORIZED=false`
   during preparation; no reader session, MTProto media read or FFmpeg is needed
   for metadata mode. The existing Bot API container continues running.
2. Confirm live consumer ownership, define the pending-update/cursor policy and
   prepare durable receipt/checkpoint configuration before requesting activation.
   No offset is fabricated and no pending update is discarded during preparation.
3. After separate activation approval, new document events are persisted, parsed
   for title/year/VJ, matched catalogue-first and then against TMDB when needed,
   and stored as review candidates with bounded suggestions. Identity is proposed,
   never automatically confirmed. VJ matches use existing active VJs.
4. The website's existing `VELORA_DISCOVERY_MODE=database` adapter serves candidates
   at `/admin/discovery` using the signed-in account's own session. The existing
   fresh admin check and database review capability remain mandatory; no new
   account or capability is assigned by this preparation. Since Gate A left the
   reviewer table empty, production dashboard access is not claimed ready for an
   enrolled operator. Plan review-only access separately when dashboard validation
   is scheduled; publication/rights privileges are unnecessary for candidate display.
5. Metadata mode records no media verification evidence, rights or approval.
   Missing readiness/rights continue to block publication. Bounded media inspection
   remains a separate configuration requiring a dedicated reader session and
   verified tools; it must not infer complete-file integrity.

Metadata-mode candidates already in review are not automatically claimed again
when a future worker switches to bounded mode. A later media-verification rollout
must prepare an authorized revision-safe reinspection workflow; do not reset
candidate status, rights or approval directly to force a retry. This is outside
the current discovery-only stage.

Discovery-only preparation validation: 865 unit tests passed (28 tool-dependent
FFmpeg/probe tests skipped in this test environment); 35 isolated integration
tests passed with the existing one GoTrue skip. The updated offline worker checks
cover metadata mode without reader credentials, empty template values, bounded
mode refusing missing reader configuration, and live startup refusing absent
activation authorization. Existing matching tests preserve proposed identity and
null evidence/rights/approval. Application/discovery typechecks, changed-code lint,
private-value scan and diff audit passed. No database migration changed and no
web UI code changed; this is not a new production browser or playback verification.

### Confirmed execution and live checks — 2026-10-10

After receiving the backup/restore evidence and migration/recovery plan, the
operator explicitly confirmed applying migrations 13–15 now and also authorized
Gate B/C. This supersedes the pending authorization status of the earlier
preparation record; it does not supply a movie, rights evidence, reviewer accounts,
consumer checkpoint or deployment host.

Gate A results:

- Immediately before execution, authenticated Management API identity matched
  Velora UG, `utxtqsfelovmhhcrknrz`, ACTIVE_HEALTHY. TLS-verified owner access,
  exact twelve-version history, three migration file hashes and archive hash
  passed. All 54 backed-up table datasets and the logical schema were unchanged
  since backup; no active other client, new-role collision or duplicate uploader
  document provenance was observed.
- Migrations `20261010090000`, `20261010150000` and `20261010175410` committed
  in that order, each with its history entry in the same transaction, using
  5-second lock and 120-second statement timeouts. No automatic retry occurred.
- Production verification completed at **22:57:34 EAT**, 10 October 2026.
  Hosted history contains all fifteen migrations. All original column values
  and twelve original history rows remain unchanged. New snapshots are null;
  reviewer and discovery cursor tables are empty.
- Both new roles remain NOLOGIN, NOINHERIT, non-superuser/non-bypass, without
  create-role/database/replication attributes or memberships. Effective application
  grants match exactly four review RPCs and nine discovery RPCs, with no application
  table grants. All thirteen callable wrappers are owned by postgres with empty
  pinned search paths. RLS is enabled on the six new review/discovery tables.
- Redacted production migration and privilege evidence is stored encrypted in
  the approved backup directory alongside the verified archive. No production
  reviewer, rights decision, candidate or published movie was created.

Gate B read-only checks:

- The existing Movies bot is explicitly listed on the loopback Bot API server.
  The reused client's `getMe` identity check passed; `getWebhookInfo` reported
  no webhook and **two pending updates**. No `getUpdates` call, queue acknowledgement,
  webhook change, Telegram upload or historical media read occurred.
- Registered production Movies channel matches the configured channel. The
  Bot API container remains healthy/running. Local process/container inventory
  found no identified discovery listener, gateway or poller; this cannot establish
  ownership of remote consumers or every host task.
- Before activation, the operator must identify any remote consumer, the
  authoritative final committed update ID (or approve bounded pending-queue
  inspection and a reviewed cursor policy), and the persistent deployment host.
  No hosted cursor was fabricated. A restricted database credential and a separate
  reader session/configuration have not yet been provisioned.

At this historical checkpoint Gate C lacked movie/account/rights details. It has
since been explicitly deferred as recorded above; none is requested for discovery
preparation. No account has been enrolled, no rights have been granted, and no
movie has been approved or published.

### Gate A preparation authorization — 2026-10-10

The operator authorized preparation for **Velora UG**, project reference
`utxtqsfelovmhhcrknrz`: verify production identity/history, create and verify a
recoverable backup, and present the execution/recovery plan. **Applying migrations
still requires a separate final confirmation after those safeguards pass.**
Gate B and Gate C remain unauthorized. Leave the existing Bot API container running.

Preparation evidence:

- Release source: `36b4f22056c353fd3331e1a3155fc232999df437`.
- Fresh isolated rerun: all 15 migrations applied, 692/692 assertions in 11/11 suites.
- After token rotation, authenticated Management API verified Velora UG,
  `utxtqsfelovmhhcrknrz`, `ACTIVE_HEALTHY`, `eu-west-1`, PostgreSQL 17.6.1.166.
- Hosted history exactly matches the twelve earlier repository versions; 13–15
  are pending. History columns are `version`, `statements` and `name`; new service
  roles are absent. Duplicate uploader document provenance count is zero.
- Session-pooler owner connection succeeded with certificate/hostname verification
  using the [official Studio CA URL configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json).
  Server-side SSL enforcement was already disabled and was left unchanged.
  Client TLS was verified; backend `pg_stat_ssl` behind the pooler is not evidence
  about that client connection. No TLS verification was disabled for production.
- Approved production backup: `C:\Users\willi\VeloraBackups\E38B-utxtqsfelovmhhcrknrz-20261010T191251Z\database.dump`.
  Created 10 October 2026, 22:18:08 EAT; custom archive 576,990 bytes. One exported
  read-only repeatable-read snapshot supplied the dump and 54-table data inventory.
  The archive and evidence are EFS-encrypted, outside Git, with account/SYSTEM ACLs.
  Operator confirmed successful EFS certificate export; its password/private key
  were not accessed. Export retention is operator-confirmed, not independently tested.
- Archive SHA-256: `e82a96dbf44632b059568a6175bf4f7f82a22a1ca81ffb143bb23a6a9ad4fa09`.
  Archive parsing and hash verification passed. Fresh compatible disposable restore
  passed all 54 table counts/digests, application ownership/grants/RLS/function and
  logical schema comparisons in about 59 seconds. This is a measured local rehearsal,
  not a promised production RTO.
- Restored-production migrations 13–15 passed, each with its history INSERT in
  the same transaction. All original column values and original history rows stayed
  unchanged; added metadata snapshots remained null, and reviewer enrollment stayed empty.
- Backups API returned no daily backup entries and PITR disabled; no provider
  restore point is claimed verified. This readiness evidence uses the local archive.

Restore rehearsal protections and findings:

- The disposable Docker network was internal; production archive copies used RAM
  storage and database data used tmpfs. Scheduled jobs were disabled, and two
  cron/operational queue DATA entries were omitted from the rehearsal manifest.
  The original archive retains them for separately reviewed recovery. Containers
  were removed after rehearsal; no production task or network endpoint was invoked.
- Fresh-target default API grants widened access unless cleared **before** object
  creation. The successful rehearsal removed those target defaults for `postgres`
  and `supabase_admin`, then restored source ACL/default-ACL entries from the archive.
  Production grants were not changed. Never accept a restore without verifying
  effective grants; an absent source default ACL does not clear target defaults.
- Schema comparison pins an empty search path, compares grant sets rather than
  ACL array ordering, treats owner-only null/default ACLs equivalently, preserves
  relative column order across dropped-column gaps, and recognizes only the two
  known equivalent AND-only search constraint renderings. Other definitions,
  ownership, policies and privileges remain strict. The source schema was checked
  unchanged since backup before qualified metadata was captured.
- The migration data comparison projects original columns: the new nullable
  `metadata_match_candidates.snapshot` is checked separately. New history entries
  are expected additions; all twelve original history rows remain unchanged.

Expected changes: migration 13 adds channel review/delivery/cursor/evidence/rights
records, revision-bound review gates, document provenance uniqueness, media
identity guards, restricted publication wrappers and the shared owner materializer;
14 adds restricted inspection/capability queries, pre-publication rights withdrawal,
lease release and health metrics; 15 creates the disabled discovery-worker role
with nine RPC grants. None enrolls a reviewer or publishes a movie. These database
functions become available only after migration; Gate B/C activation remains separate.

Principal risks: strong ingestion/media-table locks, existing-data constraint/index
validation failures, migration-history drift, wrong-owner/default-grant drift,
backup recovery limitations and loss of writes after a recovery point. Do not
promise zero downtime or automatically repair production inconsistencies.

Proposed execution sequence, subject to final review of live evidence:

1. Verify authenticated project identity and TLS-verified owner connection;
   compare the exact hosted migration history to the twelve preceding repository
   migrations. Inspect required schema, duplicates, role collisions and active writers.
2. Confirm backup storage encryption/access and restore target. Create a fresh
   logical archive plus protected recovery inventories using a consistent snapshot;
   verify archive parsing, hash and scope, then restore into a fresh disposable
   compatible target. Compare schema/grants, counts and protected catalogue/media
   digests. Report excluded external Storage/Telegram bytes and recovery limitations.
3. Present identity/history, backup location/time/hash, restore results, exact
   migration file hashes, proposed window/deadlines and stop conditions; obtain
   the operator's final confirmation. No migration runs before this step.
4. In the confirmed maintenance window, verify no new drift and the fresh backup
   recovery point. Quiesce ingestion writers only under the approved window;
   leave the Bot API server running. Apply only 13, then 14, then 15, each with its
   history entry in the same bounded transaction. Stop after any failure.
5. Read back migration history, grants/RLS/owners, disabled new logins, empty
   reviewers/uninitialized cursor and unchanged published catalogue. No listener,
   reviewer enrollment, rights grant or publication follows this verification.

Recovery: an uncommitted failed transaction rolls back. If a response is lost,
inspect authoritative history and schema before retrying. Earlier successfully
committed migrations remain recorded if a later one fails; do not blindly rerun
or reverse SQL. Stop rollout and assess whether to retain the safe additive schema
or perform an explicitly authorized data recovery. Restore a verified backup to
a fresh target, validate it and reconcile later writes before any separately
approved cutover. Restoring production is not authorized by preparation approval.

Migration SHA-256 (current working-file bytes):

| Migration | SHA-256 |
| --- | --- |
| 13 | `e6bed14e39b8d5075bd8c54d7dbc487aa56549d8140a71f21d29bd6a0b3c3a7e` |
| 14 | `3bb505261ad95e5794e655ef5bea3fd72d2a14508cca2bac02bfe1dcdd5a9dbc` |
| 15 | `e7b2297824b2d72bb48ab14e6f9af619dfe4be5d88665cc30cd46f480a435ea5` |

Preparation status at that checkpoint: **complete; awaiting final production
migration confirmation.** Execution is recorded above. Recheck target, history,
file hashes, constraints and backup freshness immediately before execution. If new
writes invalidate the agreed recovery point, create and verify a fresh backup first.

Each gate needs a new, explicit authorization naming the production project,
operator, scope and maintenance window. Authorization never transfers between gates.

| Gate | Required explicit approval | Excluded |
| --- | --- | --- |
| A: database preparation | Verify/create the production backup; rehearse its restoration to an approved isolated target; apply migration 13. This release also needs explicit approval of migrations 14 and 15 before its new worker can be used. | Telegram reads, reviewer enrollment, rights decisions and publication |
| B: live read-only detection | Confirm bot/channel identity and live update ownership; provision the restricted worker credential and its dedicated reader-session file; initialize one approved cursor; configure and start one worker; read newly delivered Movies events. Bounded media reads need the inspection scope named explicitly. | Telegram uploads/forwards/deletes, webhook modifications, rights, approval and publication |
| C: one controlled publication | Enroll identified reviewer accounts; record the identified movie's real rights decision; approve and publish its exact candidate/revision; refresh and verify public pages and authorized playback. | Other movies or bulk/automatic publication |

Stop on an unexpected project, migration-history mismatch, unverified backup,
lock timeout, unexpected grants/definer owner, duplicate provenance, nonempty
reviewer table before authorized enrollment, unknown Telegram consumer, any
webhook, 409 conflict, uninitialized cursor, identity/channel mismatch,
missing/stale media evidence, unconfirmed rights, revoked capability, changed
revision, uncertain publication, unreachable gateway, or leaked credentials.
Stop the worker without deleting its cursor, deliveries, evidence or audits.
Never grant capabilities or substitute an owner/service credential to fix a refusal.

## Baseline and architecture

Starting branch `phase-a-foundation`, HEAD `0e44382ee55df4d80f0fc37df7be1b3ad7bf5e03`.
Remote `veloraug` is `https://github.com/WilsoftTech/veloraug.git`.
The E3.8A checkpoint reports 845 unit tests, 621 database assertions and 32
integration tests. Those are historical results. At preflight entry the working
tree already contained related E3.8B work and unrelated design/document changes.
Do not overwrite or stage unrelated work.

```text
Movies bot on self-hosted Bot API
  -> one getUpdates consumer, fenced by durable PostgreSQL lease
  -> discovery deliveries + update cursor committed together
  -> existing ingestion event / Telegram document / channel review
  -> catalogue-first identity + TMDB suggestion + existing VJ resolution
  -> gateway-compatible MTProto bounded verification
  -> own-session reviewer corrections + independent rights clearance
  -> restricted psql approval and publication, explicit actor + revision
  -> shared owner materializer -> public catalogue -> website
```

`services/media-gateway/discovery.mts` is a separate persistent Node 24 process;
it reuses the discovery worker, database adapter, Bot API client, MTProto reader
and FFmpeg tool adapter. It is never a Vercel Route Handler. It cannot publish.
`VELORA_DISCOVERY_INSPECTION=disabled` records events without inspecting them;
`metadata` runs parsing and movie/VJ matching without media evidence or a reader
session; `bounded` also enables media verification. No historical enumeration
is wired into this live process.

Deploy the website to Vercel, database to Supabase, and worker to a persistent
Linux host using `infra/discovery/velora-discovery.service`. Keep Bot API behind
a private authenticated HTTPS origin or loopback. The existing gateway remains
a separately authorized playback service with its original published-only
resolver, entitlement checks and signed ten-minute stream capabilities.
Next.js receives no direct PostgreSQL client or worker/review-service secret.

## Environment inventory (names only)

Worker: `VELORA_DISCOVERY_LIVE_AUTHORIZED`, `VELORA_DISCOVERY_DATABASE_URL`,
`VELORA_DISCOVERY_INSPECTION`, `VELORA_DISCOVERY_HEALTH_PORT`,
`VELORA_DISCOVERY_SESSION_FILE`, `TELEGRAM_BOT_API_URL`,
`TELEGRAM_MOVIES_BOT_TOKEN`, `TELEGRAM_MOVIES_BOT_ID`,
`TELEGRAM_MOVIES_BOT_USERNAME`, `TELEGRAM_MOVIES_CHANNEL_ID`,
`TELEGRAM_MEDIA_API_ID`, `TELEGRAM_MEDIA_API_HASH`, `TELEGRAM_MEDIA_BOT_ID`,
`TELEGRAM_MEDIA_BOT_USERNAME`, `TMDB_ACCESS_TOKEN` (or `TMDB_API_KEY`),
`VELORA_FFPROBE_PATH`, `VELORA_FFMPEG_PATH`, `NODE_EXTRA_CA_CERTS`.

Gate B host preparation must configure certificate-verified database TLS. Node
uses the official trusted CA through `NODE_EXTRA_CA_CERTS` and a verified SSL mode
in the database URL; libpq uses `PGSSLMODE=verify-full` and `PGSSLROOTCERT`. Never
substitute an unverified TLS mode to work around a self-signed-chain error.

Website: existing `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`,
`VELORA_DISCOVERY_MODE`, existing playback server variables
`MEDIA_GATEWAY_TOKEN_SECRET`, `MEDIA_GATEWAY_PUBLIC_ORIGIN`.

Operator-only: `PGSERVICEFILE`, `PGPASSFILE`, `PGCONNECT_TIMEOUT`,
`PGOPTIONS`; the pinned CLI uses its separately managed credentials when needed.
Do not put worker, reviewer-service, bot, session or owner credentials in Vercel,
frontend props, SQL files, shell history, logs or Git.

## Database ordering, locks and migration rehearsal

There are twelve earlier migrations, followed by:

1. `20261010090000_direct_channel_publication.sql` (13): direct-channel records,
   revision-bound gates, consumer lease, shared materializer and restricted review role.
2. `20261010150000_channel_review_operations.sql` (14): restricted read-only
   inspection, rights withdrawal, lease release and health metrics.
3. `20261010175410_discovery_worker_least_privilege.sql` (15): disabled dedicated
   worker role, exactly nine RPC grants, no table access or RLS bypass.

Do not edit applied migration history. Migration 13 is intentionally a
single-apply migration: replay refuses existing objects. A transaction-wrapped
replay was tested and rolled back. SQL-level idempotency is provided by the
delivery/provenance uniqueness and publication functions, not by repeating DDL.
Existing uploader publication still uses `private.catalogue_publish_movie`,
which calls the same owner materializer as channel publication. Existing curated
title fields and linked versions remain untouched by a new publication.

Migration 13 replaces constraints and adds indexes/triggers on ingestion/media
tables. `ALTER TABLE` requires strong locks; unique-index creation and constraint
validation scan existing rows. This is **not a guaranteed zero-downtime migration**.
Pause ingestion writers during the approved window. Measure row counts and index
build/validation time against a restored production-sized backup before scheduling.
Audit duplicate uploader `telegram_media_id` provenance first; the unique index
will refuse inconsistent existing data. Do not repair duplicates automatically.
Use `lock_timeout=5s` and an approved statement deadline; rollback on timeout,
investigate blockers, and reschedule instead of repeatedly competing for locks.

All new private tables have RLS enabled and no API table grants. Worker/reviewer
RPCs have an empty pinned search path, schema-qualified relations, explicit
EXECUTE grants, and owner-controlled SQL. The owner materializer is INVOKER.
The definer wrappers intentionally execute as the migration owner; verify it
is the approved `postgres` owner, never an application login. Restricted roles
must not own those functions or schemas. No caller-controlled dynamic SQL.
pgTAP covers existing publication, RLS, grants, uniqueness, revisions, evidence,
capability revocation, rights revocation, rollback, leases and stale completion.

Offline replay commands, from `C:\Users\willi\veloraug`:

```powershell
node scripts/discovery/rehearse-backup.mjs
node scripts/isolated-db.mjs test --rest
$env:VELORA_E38_ISOLATED_TESTS='true'
$env:VELORA_KEEP_ISOLATED='true'
npm.cmd run test:integration:isolated
node scripts/discovery/build-isolated.mjs
node scripts/isolated-db.mjs down
```

These create only `velora-e38a-*` disposable Docker resources at loopback ports
54439/54440; the build briefly uses a read-only proxy at 54441. They never use
`supabase db reset`, the developer's existing local stack, or hosted credentials.
Do not run two isolated rehearsals concurrently: they share these disposable names.

### Prepared hosted command — Gate A only, not executed

Prepare owner/review libpq service profiles outside Git. Verify the approved
project reference, pooler hostname, database and role against the Dashboard and
change ticket. Use TLS certificate verification and a session pooler/direct
connection for operator transactions, not transaction-pooler session state.
Put passwords in an owner-only `PGPASSFILE`, not connection arguments.

```powershell
# Gate A read-only checks, after verifying the service profile target.
psql -X 'service=velora-prod-owner' -v ON_ERROR_STOP=1 -c 'select current_database(), current_user, session_user;'
psql -X 'service=velora-prod-owner' -v ON_ERROR_STOP=1 -c 'select version from supabase_migrations.schema_migrations order by version;'
```

Stop unless hosted history is exactly the twelve expected earlier versions.
The following is the explicit SQL apply path, avoiding credentialed CLI argv.
Run each file with its version-history INSERT in **the same transaction**;
the history table must already exist and support the repository's `version,name`
columns. Verify that shape first; do not improvise if the hosted CLI schema differs.
Example for migration 13 (approved migration 14/15 follow the identical pattern):

```sql
-- Save outside Git as the reviewed Gate A driver; invoke with psql -X
-- 'service=velora-prod-owner' -v ON_ERROR_STOP=1 --single-transaction -f <driver>.
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- Absolute repository path on the OPERATOR host; no password in this file.
\i C:/Users/willi/veloraug/supabase/migrations/20261010090000_direct_channel_publication.sql
insert into supabase_migrations.schema_migrations(version,name)
values ('20261010090000','direct_channel_publication');
```

CLI alternative: pinned `supabase@2.117.0 db push --linked --dry-run --skip-vault`
then `db push --linked --skip-vault`, **only** with an independently verified
linked project, secret-safe configured credentials, and an approved exact list
of all pending migrations. Never add `--include-all`, `--include-seed`, or
`--include-roles` to bypass discrepancies. Do not execute either path in preflight.
After apply, read back history, object owners, RLS, grants, catalogue snapshots,
empty reviewers/cursor and disabled login roles. Archive redacted results.

## Backup and recovery

The original offline preflight created only synthetic backups. The subsequently
authorized Gate A production archive and recovery evidence are recorded above;
its local key retention and external-media limitations still apply.

Gate A requires an operator with authorized backup/restore access and an owner
database login capable of dumping all required schema/data under RLS. Confirm
hosted backup/PITR availability, timestamp and retention in the Dashboard; do not
assume the project plan supplies a usable backup. Supabase custom-role passwords
must be reprovisioned after provider restore, and database backups exclude
Storage object bytes. See [Supabase backups](https://supabase.com/docs/guides/platform/backups).

The destination must be an approved encrypted backup store **outside the checkout**
(for example an operator-controlled `D:\VeloraBackups\<change-id>` staging folder,
then the organization's encrypted off-site store). Use restrictive ACLs, access
auditing, retention and secure transfer. Never store dumps or role passwords in Git.
Stop writers and record a consistent cutover point. `pg_dump` gives a database
snapshot, but Telegram state, app configuration and secrets are external and need
separate protected inventories. Preserve the Bot API state volume and original
reader session; they are not restored by a SQL dump.

```powershell
# Gate A only. Backups contain private data; this was NOT run on production.
pg_dump --dbname='service=velora-prod-owner' --format=custom --file='D:\VeloraBackups\<change-id>\database.dump'
pg_restore --list 'D:\VeloraBackups\<change-id>\database.dump' > 'D:\VeloraBackups\<change-id>\manifest.txt'
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\VeloraBackups\<change-id>\database.dump'
```

Record PostgreSQL/client versions, role attributes/memberships and grants,
extensions, schema owners, policies, constraints, migrations, table counts and
catalogue/version/media snapshot digests alongside the archive. Do not dump
password verifiers into routine logs. A hash proves unchanged bytes, not restore
success. Restore to a **fresh isolated compatible instance/project**, reproduce
required custom roles as NOLOGIN, then restore with reviewed ownership/ACL handling
and `--exit-on-error`. Hosted managed schemas/extensions require the current
provider restore procedure; the local full-cluster dump is not certification that
unmodified `pg_restore` works against a hosted project.

The synthetic rehearsal discovered two important constraints: `pg_cron` requires
the configured `postgres` database, and in-place `--clean` of an older archive
cannot remove foreign keys added after backup. Fresh-target recovery passed with
exact pre-migration catalogue/media equality and absence of migration-13 tables.
The measured synthetic restore was about 5.4 seconds; it is **not a production RTO**.
Budget provisioning, archive transfer, extension/role restoration, validation,
credentials, cutover and backlog reconciliation. Approve RPO/RTO only after a
production-sized rehearsal under Gate A. Recovery may lose writes after the backup;
reconcile them from authoritative journals and retained Telegram evidence.
Never treat reversing migration SQL as production data recovery.

## Restricted credentials and reviewer enrollment

`velora_review_service` is NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE,
NOCREATEDB, NOREPLICATION and NOINHERIT by default. It has four EXECUTE grants
in `catalogue_review`: inspect, capabilities, approve, publish. It cannot edit
movies, ingestion journals, reviewers or rights, or call unrelated privileged
functions. Approval/publication recheck the named user's live database capability
and all gates. The operator login is a trusted service boundary: do not expose
an endpoint that accepts arbitrary reviewer UUIDs. Browser approval requires a
separately reviewed backend design.

`velora_discovery_worker` is a separate NOLOGIN/non-bypass role with nine discovery
EXECUTE grants only. Use its direct PostgreSQL credential with the existing
service's `postgres` dependency; no new dependency and no `service_role` JWT.
Migration-13 service-role callers remain compatible; production discovery must
use the dedicated role. Review and discovery credentials are never interchangeable.

After the relevant gate, the owner provisions each role separately:

```sql
-- In an interactive psql owner session with history disabled; password is prompted.
\password velora_discovery_worker
alter role velora_discovery_worker login;
-- Review credential belongs to Gate C's trusted publication operator.
\password velora_review_service
alter role velora_review_service login;
```

Use independent random passwords from the approved secret manager. Verify actual
session/current identity, attributes, memberships, table grants and function grants
before using them. Rotate without widening grants. Emergency disable with owner
`ALTER ROLE ... NOLOGIN` and terminate existing role sessions separately under
incident authorization; NOLOGIN alone does not stop established connections.

Reviewer table is empty after all migrations and remains empty until Gate C.
Enroll only independently verified nonanonymous `auth.users` UUIDs. The UI also
requires fresh server-controlled `app_metadata.role='admin'`; user metadata cannot
authorize access. Update that through approved Supabase Auth administration, not
frontend claims. Assign capability rows explicitly, for example:

```sql
-- Gate C only. Replace each placeholder with an approved EXISTING account UUID.
insert into private.catalogue_reviewers(user_id,can_review,can_clear_rights,can_publish)
values ('<review-uuid>',true,false,false),
       ('<rights-uuid>',false,true,false),
       ('<publish-uuid>',false,false,true);
```

Three accounts preserve operational separation of review, rights and publication.
The current SQL model has separate capabilities but does not enforce distinct
persons; do not claim a database-enforced two-person policy. Document any approved
combined duties rather than silently assigning all flags. Test fresh UI sessions
and capabilities independently; no reviewer password goes into frontend config.

## Telegram consumer ownership and cursor policy

Code inventory: local Bot API configuration is under `infra/telegram-bot-api`;
upload CLI under `scripts/ingest`; its recovery methods can forward/mark/delete,
so they are **not** read-only ownership checks. Discovery uses
`botApiUpdateProvider`/`pollChannelUpdates`. No repository `setWebhook` or
`deleteWebhook` activation exists. The gateway MTProto reader starts with updates
disabled and never consumes Bot API `getUpdates`. Source establishes the intended
owner, **not the current live owner**.

Gate B operator must inventory host services, scheduled tasks, containers,
external bot dashboards and any remote poller/webhook. Confirm the bot is already
on its intended local Bot API server; do not migrate/logout it as a side effect.
Use the client's read-only `checkIdentity('movie')` and `updateOwnership()` to
verify `getMe` and `getWebhookInfo`; log only success/webhook presence/pending count,
never token paths or webhook URLs. Stop on a webhook or unknown process. Do not
call `checkRecoveryAccess`, forwarding probes or recovery writes. Acquire the
database lease before the first poll. A 409 stops the worker (exit 78); never
delete a webhook or fight another poller. One live consumer must be an operational
invariant beyond the database lease because unrelated pollers do not honor it.

The durable `update_offset` is the last committed **Bot API update ID**, not a
channel message ID. Startup refuses a missing row or null offset. The cursor
must not be fabricated from `telegram_channels.checkpoint_message_id`, which is
the uploader's recovery floor. Do not change that floor during discovery rollout.

For newly received events only, agree a cutover with the previous update owner
and obtain its authoritative final committed update ID. Stop the old consumer,
retain its durable receipt proof, initialize discovery to that exact ID, then
start the worker. If there is no authoritative baseline, **stop**: obtain separate
approval for inspecting a bounded pending queue or a queue-discard policy.
Never quietly use `getUpdates(offset=-1)`, `drop_pending_updates` or an invented
large offset to discard unreviewed deliveries. A newly observed post cannot
justify skipping earlier queue entries without explicit approval of that range.

```sql
-- Gate B owner operation, after verifying the registered Movies channel.
-- No ON CONFLICT reset: an existing cursor must be resumed, not overwritten.
insert into private.discovery_cursors(bot_type,update_offset)
values ('movie', <authoritative-last-committed-update-id>);
```

Normal restart resumes this offset; checkpoint and batch persistence precede
Telegram acknowledgement (the next higher-offset poll). A crash before commit
replays the batch; uniqueness makes duplicate delivery harmless. Lease expiry
allows takeover and stale inspection leases cannot overwrite newer results.
Optional historical import uses the existing `boundedHistoryProvider` only after
approval names the channel, message-ID range and reader: max 5,000 IDs, 100 per
page, bounded pages per reconciliation. It is not enabled in the live entrypoint.
Its reconciliation cursor is separate from the update offset. Missing IDs never
mean deletion; inaccessible pages remain incomplete and require operator review
and an approved retry range. Preserve receipts before changing any history cursor.

## Persistent host and media verification

Before Gate B, install the reviewed checkout at `/opt/velora`, Node 24.13+,
root lockfile dependencies and `services/media-gateway` lockfile dependencies.
No new package is required. Validate both TypeScript projects. Use a dedicated
unprivileged OS user and private `/var/lib/velora-discovery` session file.
Provision an independently managed read-only reader session; never let the
worker and live gateway write the same session file. First login remains disabled
in the worker. Do not copy/open the active session during preflight.

The service template uses restart-on-failure, bounded restart rate, memory/task
limits, read-only system paths, private temporary storage, and 90-second SIGTERM
grace. Exit 78 is configuration/ownership failure and requires intervention.
Transient failures retry with exponential backoff; database disconnect leaves
uncommitted updates unacknowledged. Graceful shutdown aborts polling/reads, closes
connections and releases the lease; failed release recovers through expiry.
Inspection errors have bounded attempt/retry policy in the existing database.
Health is loopback-only on `/healthz` and `/readyz`; forward it only through an
authorized monitoring path. A waiting lease/cursor state is reported distinctly;
do not interpret it as evidence that this process owns the live Telegram stream.

```sh
# Offline shape check: no database, Telegram or session access, no env-file loading.
node --experimental-transform-types --import ./scripts/ingest/register.mjs services/media-gateway/discovery.mts --check
# Gate B only, after protected /etc/velora/discovery.env is provisioned and approved:
systemd-analyze verify infra/discovery/velora-discovery.service
sudo install -m 0644 infra/discovery/velora-discovery.service /etc/systemd/system/velora-discovery.service
sudo systemctl daemon-reload
sudo systemctl enable --now velora-discovery
curl --fail http://127.0.0.1:8790/readyz
```

`VELORA_DISCOVERY_LIVE_AUTHORIZED` must remain absent/false until separate Gate B
activation approval; normal
startup refuses it before any database or Telegram call. Detection-only is the
default. For discovery-only metadata extraction use `metadata` after activation
approval. After approved read-only validation, enable bounded inspection with
verified tool paths and TMDB metadata credentials. Monitor one known naturally
received post; do not upload a test message under a read-only authorization.

The verification adapter checks registered channel, message, file_unique_id,
declared size and trusted `tg1` document identity. The reused MTProto reader
asserts bot identity/channel access and resolves the exact document; one reader
cache slot bounds backlog memory. Reads cover MP4 box headers, `ftyp`/`moov`, a
capped 64 KiB initial sample, and tail, under the 16 MiB head budget. Real ffprobe
needs sample packets to infer H.264/AAC profiles; index-only inspection was fixed
after a real local fixture exposed missing profiles. Layout, fast-start, codecs,
pixel format, stream selection and audio follow policy v2. Unsupported/unknown
properties, reader failure, replacement and truncated media fail closed.
Evidence is identity-bound; edited/replaced documents invalidate prior evidence,
rights and approval. Bounded verification does **not** prove complete-file
integrity, full decodability or end-to-end playback. Gate C still verifies actual
authorized playback through the existing gateway, without changing its resolver.

Local executable identity: ffprobe/ffmpeg reported
`9.0.2-essentials_build-www.gyan.dev`. SHA-256:
ffprobe `f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52`;
ffmpeg `3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`.
These identify the tested local binaries; they are not a publisher-signature claim
or a substitute for separately verifying Linux host tools.

## Review, exact commands, publication and cache coordination

Gate C operator enables website `VELORA_DISCOVERY_MODE=database` after authorized
enrollment. Existing `/admin/discovery` queue/detail show gates, identity warnings,
corrections, VJ, media readiness, rights, audits and the exact eligible psql command.
UI decisions use the reviewer's own Supabase session. Database authorization is
authoritative. No browser publication action or PostgreSQL client was added.

Create libpq `velora-prod-review` with the approved production host and restricted
login. Independently verify its environment before opening the session. The
read-only script prepares candidate, rights, readiness, capability and publication
inspection without exposing Bot API file IDs:

```powershell
psql -X 'service=velora-prod-review' -v ON_ERROR_STOP=1 -v candidate='<64-hex-key>' -v reviewer='<approved-user-uuid>' -f scripts/discovery/review-operator.sql
```

Within that verified restricted psql session, set the exact selected parameters:

```sql
\set candidate '<64-hex-key>'
\set revision '<exact-reviewed-positive-integer>'
\set approver '<review-capability-user-uuid>'
\set publisher '<publish-capability-user-uuid>'
select catalogue_review.reviewer_capabilities(:'approver'::uuid);
select catalogue_review.reviewer_capabilities(:'publisher'::uuid);
select catalogue_review.inspect_channel_candidate(:'candidate')->'rights';
select catalogue_review.inspect_channel_candidate(:'candidate')->'evidence';
-- Gate C explicit approval after gates, reference and revision review:
select catalogue_review.approve_channel_candidate(:'candidate', :'revision'::integer, :'approver'::uuid);
-- Separate controlled publication decision for this exact approved revision:
select catalogue_review.publish_channel_candidate(:'candidate', :'revision'::integer, :'publisher'::uuid);
-- ALWAYS reconcile here if the publication response is lost:
select catalogue_review.inspect_channel_candidate(:'candidate');
select catalogue_review.inspect_channel_candidate(:'candidate')->'publication';
```

These function calls were exercised against the isolated database. Use the UI's
validated command builders for actual values. Approval checks live reviewer
capability, identity, VJ, current evidence, rights, warnings, duplicates and
catalogue relationship; publication repeats gates and locks rows in one transaction.
An exact repeat returns `already_published`. A stale revision fails closed.
After a disconnect never blindly republish: inspect authoritative publication and
approval revision; committed means do not retry, still-approved/not-published
means an operator may retry the same revision, inconsistent state means stop.

Verify catalogue through ordinary website queries for the returned movie slug
and VJ slug, Movies/Search/detail/VJ pages and anonymous denial/signed-in gateway
playback. The restricted role cannot query arbitrary catalogue tables; this is
intentional. Do not use its credential in the browser to work around that.

Publication SQL does not call Next.js. **Required coordinated step:** an authorized
admin opens the published candidate and presses **Refresh public pages**. The
existing guarded Server Action rereads authoritative publication, then invalidates
`/`, `/movies`, `/search`, `/vjs`, the exact movie and VJ paths. It cannot invalidate
an unpublished candidate. Repeating refresh is safe and retries a cache failure
without retrying publication. Tests cover all paths, unauthenticated denial,
unpublished refusal, failed refresh and successful repetition. Home/VJ index also
have five-minute ISR; catalogue/search/detail/VJ detail are dynamic in the tested
build. Verify visible content after refresh; record a failed refresh as a separate
incident. No unauthenticated revalidation endpoint exists or was added.

## Failure drills and observability

| Failure | Evidence/recovery | Operator action |
| --- | --- | --- |
| Crash before persistence | Worker commits before acknowledgement; replay/restart tests preserve cursor | Supervisor restarts, inspect lag |
| Database disconnect | Synthetic service fault backs off with ceiling; no poll after failed checkpoint | Restore connectivity; never reset cursor |
| Lease conflict/expiry | Isolated second consumer refused; takeover after expiry/release; stale completion refused | Investigate persistent conflicts/external owner |
| Duplicate/out-of-order edits | SQL/unit replay dedupes; newer revisions fence stale inspection | Review conflicts, no inferred deletion |
| Media replacement | Old evidence/rights/approval invalidated; published link is not silently replaced | Separate reviewed replacement workflow |
| Missing/inaccessible history | Bounded reconciliation marks incomplete, no deletion | Approve a bounded retry after access repair |
| Publication response loss | Integration discards returned result and reconciles committed authoritative state | Read state before any manual retry |
| Transaction failure | SQL slug-collision drill leaves no partial catalogue records | Correct conflict under review, reapprove if revision changes |
| Cache invalidation failure | Server Action test blocks refresh, repeat succeeds | Retry refresh only; verify all affected paths |
| Revoked rights/capability | Revision/live-capability checks block old approval | Rights withdrawal/account revocation needs authorized owner/reviewer |
| Gateway/reader unavailable | Synthetic unreadable media yields unverified evidence; existing gateway faults/authorization tests deny bytes | Restore reader/gateway; never widen resolver or mint bypass tokens |

These are application-level synthetic failure drills over actual modules and
disposable SQL. No live outage, physical network cut, live gateway interruption,
or production process crash was induced. Connection loss is represented by a
lost response and authoritative reconciliation, not a production socket kill.

Use structured service JSON in journald plus loopback health and
`public.discovery_health()` via the restricted worker. Monitor last completed
cycle/progress, consecutive failures, last delivery age, oldest pending age,
checkpoint/lease heartbeat, pending/blocked/review counts, media/rights blocks,
verification failures, publication audit outcomes, lease conflicts and database
failures. Alert on stale cycles (>180 seconds), persistent retries, increasing
pending age, missing heartbeat, `fatal` or incomplete reconciliation. Idle channels
can have old last-delivery times without being unhealthy; combine metrics.
The persistent entrypoint's health describes loop state; database health exposes
counts/ages separately. Do not mistake a healthy loop for playback readiness.

Keep logs fixed codes/counts only. Never log raw exceptions, captions, private
media, bot URLs/tokens, database URLs, session contents or signed playback URLs.
Use existing platform/journald monitoring; no new monitoring platform is required.

Rollback first stops worker activation and disables/terminates affected service
sessions under incident authority. Keep journals, cursor, evidence and audits.
If the schema is sound, restore the prior application release with discovery
disabled; do not reverse migration 13. If corruption requires data recovery,
use the verified backup/fresh-target procedure and reconcile post-backup writes
before cutover. Published rights withdrawal uses the existing owner-controlled
version rights boundary and cache refresh; never direct unreviewed movie edits.

## Regression evidence and limitations

Completed offline checks: 889 unit tests; 692 database assertions in 11 suites;
35 integration tests (one deliberate GoTrue skip), including the prepared psql
inspection script authenticated as the restricted review service; synthetic backup/archive
verification and fresh-target restore (about 5.4 seconds for this small fixture);
application, gateway and discovery typechecks; tracked/new-code lint; isolated
production build; private-value scan (837 files, 12 values, zero matches) and
deployment trace audit (zero operational files). These counts are rehearsal
evidence, not production verification. The restore time is not a production RTO.

Docker stopped during the last check, then the operator restored engine access.
The final disposable integration run passed after restoration. Docker's existing
restart policy also resumed `velora-telegram-bot-api`; the operator was notified.
The preflight agent did not start it, call its API, or activate a listener. That
process observation does not establish live update-consumer ownership.

Baseline and extended
isolated suites cover catalogue, ingestion, publication and playback boundaries.
The one GoTrue watchlist integration is deliberately skipped by the existing safe
isolated command because the disposable harness provides PostgREST, not GoTrue;
it must run in an authorized isolated full-auth environment before enabling that
flow in a release. Do not run `test:catalogue`/`test:db`: they reset the user's local
Supabase instance. Browser responsive UI behavior is unchanged; existing server
markup tests exercise responsive grids and labeled touch controls. This checkpoint
does not claim a fresh authenticated browser/visual production test.

The isolated production build clears operational env values and reads only the
synthetic catalogue via a temporary read-only loopback proxy. It is not deployable
production output: rebuild with approved production configuration for deployment.
Next.js still emits the pre-existing dynamic-journal tracing warning; explicit
output tracing exclusions now keep operational directories, env files and service
state out of web deployment manifests. The secret scan checks actual private env
values against source/new build artifacts and audits traced operational paths;
unrelated prior `.next/dev`/cache state is excluded and is not a release artifact.

Mandatory stop after preflight: no hosted migration, no live listener, no reviewer
assignment, no real rights decision and no real movie publication until that
specific gate is explicitly authorized.
