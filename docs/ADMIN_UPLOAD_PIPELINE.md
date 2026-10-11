# Admin direct uploads

The disk foundation below is retained for existing sessions. New cloud staging,
review, Telegram transfer, and cleanup are documented in [R2 upload pipeline](R2_UPLOAD_PIPELINE.md).

The approved design adds `admin_upload` sessions beside Telegram discovery.
Telegram remains final media storage. Private disk staging provides resumable
browser transfer while files await verification and review. No complete movie
passes through Next.js or a Server Action.

## Checkpoint 1: durable model

Migration `20261011083200_admin_upload_sessions.sql` creates private sessions,
processing attempts and append-only audit events. It is not applied to local
Supabase or production by implementation commands. Validate with the existing
disposable `scripts/isolated-db.mjs` harness.

Only enrolled reviewers with server-controlled admin metadata may create,
list, inspect, edit and control their own sessions. Browser commands cannot
write checksums, media references, rights, approval, leases or publication.
Metadata changes advance the revision and invalidate rights and approval.

Stages distinguish browser transport, byte verification, inspection, rights,
approval, Telegram transfer and publication. `verifying` is a requested check,
not proof of completion. The `telegram_uncertain` stage forbids blind transfer
retry or cancellation. The existing Telegram recovery mechanism must settle
the external outcome first. Publication receipt loss returns to reconciliation
of existing database state, never another media upload.

Media is capped at exactly 2,000,000,000 bytes. Initial quota reservations are
five active sessions and 10 GB per owner, with a 100 GB global reservation
ceiling. Reservations do not establish available disk space: the storage
service must check actual capacity before accepting chunks. Draft expiry is
seven days; reservations remain until the worker confirms staging cleanup,
including for cancelled and published sessions.

The upload worker role ships NOLOGIN with no table access. The chunk and
inspection migrations grant only four fenced commands. Credentials and
enablement are operator actions. No discovery role, reviewer enrollment or
existing ingestion origin is changed.

## Implemented draft UI and transport

`/admin/uploads`, `/admin/uploads/new` and `/admin/uploads/[id]` reuse the admin
shell, navigation, form fields and buttons. Their shared server-only runtime
checks fresh admin authorization and database mode. Every command also checks
ownership and current reviewer enrollment in PostgreSQL. Draft actions accept
file facts only; the file picker has no form name and cannot submit media bytes
to a Server Action.

The standalone staging service accepts sequential 8 MiB chunks directly from
the browser. It validates exact Origin, fresh user identity, ownership, quota,
expiry, expected offset and canonical chunk size. It streams each chunk to a
private UUID filename, computes SHA-256, fsyncs and renames before committing
the manifest. An ambiguous database reply retains the complete chunk. Resume
reads the committed manifest and compares each saved hash with the reselected
file before accepting new bytes. Pause aborts the active request; completed
chunks remain. Progress, average speed and ETA update after each committed
chunk, rather than reporting uncommitted network bytes as durable progress.

Verification assembles only contiguous, persisted chunks with bounded memory,
rehashes every chunk and computes the complete file SHA-256. It checks free
disk capacity before chunks and assembly. Equal digests serialize their
duplicate check. Verification and FFprobe inspection use distinct fenced
attempts; expired leases permit safe reinspection after restart. Missing tools,
bounded probe timeouts and provider outages can be retried. Corrupt bytes do
not enter metadata review. Completion is checked against the returned
persistent stage.

Inspection reuses `probeMedia`, `classifyMedia`, `parseFilename`, `resolveVj`,
`decideMatch`, `searchTmdbForIngestion` and `fetchMovieSnapshot`. The existing
active-VJ lookup is reused inside the worker claim without granting the worker
direct access to discovery commands. Suggestions never approve rights, choose
an ambiguous match automatically, transfer to Telegram or publish anything.

## Runtime configuration

All flags default off. The new migrations are reviewable files, not applied
to the developer's Supabase stack or a hosted database by this implementation.

| Variable | Purpose |
| --- | --- |
| `VELORA_ADMIN_UPLOADS_ENABLED` | Enables guarded web entry points after rollout approval |
| `VELORA_UPLOAD_PUBLIC_ORIGIN` | HTTPS origin of the browser-facing staging reverse proxy; loopback HTTP only for development |
| `VELORA_UPLOAD_DATABASE_URL` | Restricted `velora_upload_worker` login; remote connections require `sslmode=verify-full` |
| `VELORA_UPLOAD_STAGING_DIR` | Absolute private persistent disk directory |
| `VELORA_UPLOAD_WEB_ORIGIN` | Exact web origin allowed by CORS |
| `VELORA_UPLOAD_PORT` | Loopback listener port, default 8791 |
| `VELORA_UPLOAD_INSPECTION_ENABLED` | Enables verification and inspection queue polling |

The service also needs the existing public Supabase URL/key for fresh Auth
validation, and the existing server-only TMDB and FFprobe configuration for
inspection. It does not need a Supabase service-role key or a Telegram token.
Do not use `.env.local` automatically to start it. Prepare a dedicated private
environment file containing only its approved configuration, then start:

```text
node --experimental-transform-types --env-file=<private-worker-env> --import ./scripts/ingest/register.mjs services/media-gateway/admin-upload.mts
```

The service binds `127.0.0.1`. Remote browsers require an authenticated TLS
reverse proxy on the configured public origin, forwarding PATCH requests
without buffering entire movies. Do not expose PostgreSQL or private staging
files through that proxy. SIGINT/SIGTERM stops queue polling and drains the
current inspection and HTTP requests. When the computer is offline, transfer
and processing pause; committed disk chunks and database manifests survive.

Allow capacity for original chunks, the assembled file and any later verified
remux rendition. The 100 GB reservation limit is logical, not a guarantee of
disk space. Windows operators must restrict the directory ACL to the service
identity; POSIX file modes alone do not establish a Windows ACL.

## Current limitations and remaining work

This is an inactive foundation, not the complete upload-to-publication feature.
There is no reachable Telegram transfer or automatic publication operation yet.
The existing Local Bot API adapter and rights/publication boundaries remain
unchanged. `REAL_TELEGRAM_UPLOADS_AUTHORIZED` must stay unset or false during
implementation and isolated testing.

Rich metadata editing, custom artwork, catalogue duplicate lookup, rights and
approval controls, audit-history presentation, verified remux, automatic disk
cleanup, and browser/mobile acceptance remain pending. Expired or cancelled
sessions currently retain reservations until staging cleanup is implemented;
do not manually mark them cleaned while files remain. Lost replies and expired
verification attempts may leave private orphan files requiring later safe
garbage collection. Never delete chunks merely because an HTTP response failed.
Refresh the detail page to see worker progress; processing status does not yet
poll automatically. An expired browser access token requires resuming to obtain
a fresh token and read the persisted offset.

Custom artwork cannot safely be written into existing TMDB path fields: the
current global image loader treats those fields as TMDB paths. Artwork needs
its own validated storage reference and catalogue rendering support. Series
publication likewise needs an explicit tested extension to the existing
movie-only publication boundary. Neither invariant is silently bypassed.

## Checkpoint status (2026-10-11)

The original plan's eight checkpoints, against what the repository holds after
the R2 pipeline commit (`393a9ed`) and the follow-up below. "Local" means
implemented and tested with injected adapters and disposable databases only.

| # | Deliverable | Status |
| --- | --- | --- |
| 0 | Audit, convergence design, storage choice, episode scope | Approved. Storage is R2 staging with Telegram as final storage. Episodes stay draft-only |
| 1 | Sessions and state model, privileges, ownership, leases, revision-bound decisions | Done, local. Migrations `20261011083200` to `20261011095632`; pgTAP 013 to 016 |
| 2 | List, new and detail UI, metadata editing, draft persistence | Done, local. Custom artwork is not built (see below) |
| 3 | Resumable transfer, checksum, probing, normalization, artwork | Transfer is R2 multipart, replacing the planned TUS; checksum and probing done, local. Normalization and artwork are not built (see below) |
| 4 | Existing Telegram adapter, ambiguity, duplicates, restart, receipts | Done, local, with injected Telegram. No real send |
| 5 | Existing publication, revocation, retry, persistent readback, cache refresh | Done, local. Cache refresh added in the follow-up below |
| 6 | Both ingestion paths, catalogue and playback regressions, mobile and desktop acceptance | Automated regressions pass. Layout checked from rendered markup at 360 to 1440 px. A signed-in browser session and a real transfer are not tested |
| 7 | Runbooks, capacity, cleanup and recovery procedures, rollout evidence | Runbook and cost model in the R2 document. The configuration-only checkpoint ran (local-origin CORS and lifecycle). **Stopped here for approval** |

### Follow-up, 2026-10-11

- **Cache refresh (checkpoint 5).** A movie published from an upload session
  reached the public pages only on their five-minute timer. The detail page of a
  published session now offers **Refresh public pages**, the same step the
  discovery review has. It reads the slug back from the catalogue through the
  owner's own session, so an unpublished, unapproved or foreign session refreshes
  nothing. Both paths share one path list (`publishedMoviePaths`, `lib/utils.ts`).
- **Detail page tests.** `components/admin-upload-page.test.tsx` renders the real
  page for the published, approval, review and transfer states. It had no test.
- **Layout.** Those four states were rendered at 360, 390, 768 and 1440 px with
  the built stylesheet: no horizontal overflow, controls at least 44 px, every
  input labelled.

### Not built, and why each needs a decision

- **Custom artwork.** The image loader treats poster and backdrop fields as TMDB
  paths, and the R2 bucket is private staging. Artwork needs a public storage
  location, a catalogue column and rendering support. Where published artwork
  lives is a product decision.
- **Normalization on this path.** The cloud worker accepts only canonical media
  (fast-start MP4, H.264, AAC or MP3) and refuses the rest with its reason. The
  stream-copy remux exists for the local uploader (`ingest normalize`); running
  it on the cloud worker is a capacity and cost decision.
- **Episodes.** The materializer publishes exact movie matches only. Series need
  a reviewed publication and playback extension first.
- **VJ entry.** The detail page takes a numeric VJ ID. A picker of active VJs
  would be a small improvement and is not built.

### Gates before activation, each a separate approval

Hosted migrations (the six admin-upload migrations are undeployed; hosted has
16), a production web origin in the bucket CORS, the cloud worker host and its
restricted credentials, the upload worker login, the Local Bot API on that host,
`VELORA_ADMIN_UPLOADS_ENABLED`, `VELORA_R2_WORKER_ENABLED` and finally
`REAL_TELEGRAM_UPLOADS_AUTHORIZED`. All three flags are `false`. No commit,
deployment, live transfer or production migration is implied by this status.

Series metadata can be drafted, but publication stays explicitly blocked until
an episode publication/playback extension is reviewed and tested. Existing
movie publication and Telegram discovery behavior are preserved.

Rollback starts by disabling upload entry points and worker execution. Retain
sessions, audit, attempts and confirmed Telegram references. Do not reverse
applied migration history or delete existing catalogue/discovery records.

## Verification record and changed files

The disposable database suite passes 15 suites and 823 assertions. The full
unit run passes 923 tests with 28 preexisting skips; subsequent targeted VJ
inspection and disk tests pass 11 tests, including the added ambiguity case.
The existing isolated catalogue, admin and discovery integration suites pass
39 tests with one explicitly excluded catalogue/auth flow. Root, gateway and
upload-service TypeScript checks and scoped source lint pass. These synthetic
checks do not establish real 2 GB transfer, Telegram delivery, custom artwork,
publication, or device acceptance.

The production build passes using the existing
`scripts/discovery/build-isolated.mjs` helper and a seeded disposable PostgREST
fixture. Direct fixture builds first failed because the endpoint was absent
and then lacked the `/rest/v1` gateway prefix; the existing helper supplies
that read-only proxy and strips operational environment values. The build
retains the existing dynamic filesystem tracing warning from
`lib/uploader/journal.ts` through the admin discovery runtime, plus the warning
about the parent directory's `bun.lock`. Neither was changed for this feature.

New files:

- `app/admin/uploads/actions.ts`
- `app/admin/uploads/page.tsx`
- `app/admin/uploads/new/page.tsx`
- `app/admin/uploads/[id]/page.tsx`
- `app/api/admin/uploads/[id]/transfer/route.ts`
- `components/admin-upload-form.tsx`
- `components/admin-upload-form.test.tsx`
- `components/admin-upload-transfer.tsx`
- `lib/uploader/admin-upload.ts`
- `lib/uploader/admin-runtime.ts`
- `lib/uploader/admin-upload.test.ts`
- `lib/uploader/admin-upload-actions.test.ts`
- `lib/uploader/admin-inspection.ts`
- `lib/uploader/admin-inspection.test.ts`
- `lib/uploader/disk-transfer.ts`
- `lib/uploader/disk-transfer.test.ts`
- `services/media-gateway/admin-upload.mts`
- `services/media-gateway/tsconfig.upload.json`
- `supabase/migrations/20261011083200_admin_upload_sessions.sql`
- `supabase/migrations/20261011084309_admin_upload_disk_chunks.sql`
- `supabase/migrations/20261011085220_admin_upload_inspection.sql`
- `supabase/tests/database/013_admin_upload_sessions.test.sql`
- `supabase/tests/database/014_admin_upload_disk_chunks.test.sql`
- `supabase/tests/database/015_admin_upload_inspection.test.sql`
- `docs/ADMIN_UPLOAD_PIPELINE.md`

Surgical additions to existing files:

- `.env.example`: inactive upload configuration
- `components/admin-nav.tsx`: conditional uploads tab
- `services/media-gateway/tsconfig.json`: isolate the new service's compilation
- `supabase/tests/database/003_security_boundaries.test.sql`: additive private
  table and reviewed definer-function inventory
- `lib/catalogue-boundary.test.ts`, `lib/ingestion/boundary.test.ts`,
  `lib/discovery/security.test.ts`: explicit guarded admin entry-point coverage

Discovery runtime, worker, listener, Telegram channels and publication functions
were not modified by this feature. Existing unrelated working-tree changes
remain intact. No dependency, commit, push, deployment or real transfer was made.
