# E3.8 — Offline channel discovery and review

Date: 2026-10-10 (Africa/Nairobi). Starting branch: `phase-a-foundation`; HEAD: `c775904046a197a3b5214348c33c568123523441`. E3.7D was already committed/pushed at this HEAD; its real upload/publication is not repeated.

> **Superseded in part by E3.8A** (end of this document): direct-channel documents now have trusted provenance and a shared, gated publication path. The E3.8 record below is kept as written.

**Classification: PARTIAL.** Offline detection, durable review, admin UI and supported uploader publication integration are implemented. An approved synthetic uploader-linked review passed through the real existing owner functions in a disposable database and appeared through existing catalogue queries. Brand-new channel documents remain blocked at publication: the current owner boundary requires an evaluated uploader source fingerprint. No live listener is installed or deployed.

## Architecture inventory

| Capability | Existing module | Reuse / extension | Security | Tests |
| --- | --- | --- | --- | --- |
| Title/year/version parsing | `lib/ingestion/parser.ts`, `normalize.ts` | Reused for filename/caption | Suggestions only; series markers block | Existing parser and new discovery examples/conflicts |
| VJ identity/aliases | `lib/ingestion/vj.ts`, `types/ingestion.ts` | Reused; active existing VJ selection | No VJ creation/default Ice P assignment | Existing resolver; unknown/inactive fixtures |
| Metadata matching | `lib/ingestion/match.ts` | Reused after catalogue-first lookup | Exact match proposes identity; ambiguity requires review | Existing tiers; namesakes/provider failures |
| TMDB transport/snapshot | `lib/tmdb/client.ts`, `ingestion-search.ts` | Existing schema and injected ports; synthetic replay | No duplicate HTTP client or live test call | Snapshot validation/mocked enrichment |
| Telegram shape/source tokens | `lib/ingestion/telegram.ts` | Reused; document/edit adapter | Caption fingerprint remains a claim; bot file IDs discarded | Telegram contracts; sanitized inbox fixtures |
| Local journal | `lib/uploader/journal.ts` | Extracted identical atomic-write primitive and reused path guard | Discovery filename/lock/checkpoint separate from uploader | Existing uploader and new persistence/restart tests |
| Upload recovery | `lib/ingestion/recovery.ts`, `lib/telegram/local-bot-api.ts` | Marker recognition reused; recovery unchanged | No new marker, forward, upload or recovery-floor change | Existing recovery tests/SQL concurrency |
| Media/ingestion registry | `private.telegram_media`, `ingestion_events`, `metadata_match_candidates` | Production proposal extends existing roots | Private RLS/explicit grants; no second media registry | Existing SQL privilege suites |
| Owner publication | `lib/uploader/publication.ts`, migration `20260927090650_ingestion_movie_publication.sql` | Existing script/functions unchanged | Owner-only; worker/API roles cannot publish | Existing 77 SQL assertions; isolated review integration |
| Public catalogue | `lib/catalogue.ts`, existing Home/Movies/Search/VJ/detail pages | Unchanged | Anonymous published-only RLS; drafts invisible | Existing catalogue suite and real SQL/PostgREST proof |
| Media policy/gateway/reader | `lib/ingestion/media.ts`, `lib/media-gateway/ports.ts`, `services/media-gateway/mtcute-reader.mts` | Independent evidence; delivery unchanged | Filename/MIME never prove decoding; resolver remains published-only | Existing media/gateway and wrong-proof fixtures |
| Auth/UI | `lib/auth.ts`, `lib/supabase/server.ts`; button/Field/EmptyState/PosterImage/BackdropImage | Reused; fresh admin check and server review views | Server-owned app metadata; no client role minting | Auth/markup tests; 390/1440px Chrome |

## Detection and ownership

Production design: one persistent Node process owns Movies-bot `channel_post` and `edited_channel_post`. Long polling is the simplest initial transport; an authenticated durable webhook receiver with coordinated fan-out is an alternative. Never run both or competing `getUpdates` consumers. The checkpoint implements only the offline replay provider.

Repository inspection found no `getUpdates`, `setWebhook` or `deleteWebhook` consumer. The local Bot API client performs uploads and controlled recovery forwarding. The separate MTProto reader explicitly disables updates and uses a dedicated read-only identity. Local container inventory contained the existing gateway, Bot API and Supabase services. External pollers/webhooks remain unverified; ownership and webhook status must be confirmed separately before activation. No Telegram call was made to inspect them.

Bot API has no arbitrary channel-history method. Future reconciliation needs a separately approved read-only history adapter, not recovery-marker posts/forwards. Do not repurpose or grant write permissions to the existing reader. Pending-update retention is documented by the [official Bot API](https://core.telegram.org/bots/api#getupdates); prolonged interruption must leave reconciliation incomplete.

No credential loading, `--env-file`, upload, publication, webhook or live polling command exists in `scripts/discovery/replay.mts`. Ordinary development, build and test startup do not start this executable.

## Durable inbox, checkpoints and effects

`lib/discovery/model.ts` defines validated version-1 storage: channel/message/update identity, event kind/time/digest; first/last seen and delivery counts; pending/processed/superseded events; candidate revision/status/attempts/lease/retry/error/audit. Only needed document fields survive. Bot file IDs and raw unrelated payloads are discarded; links and credential-shaped caption text are redacted.

The single-machine local store is **offline operational state**, not catalogue authority. `.velora-ingest/discovery/discovery-inbox.json` has its own lock/checkpoints and never opens uploader journals. Transactions exclusively lock, validate the complete snapshot, flush a temp file and atomically rename. Synchronous callbacks cannot perform external effects. Persistence failure cannot advance acknowledgement/checkpoint. Replay after restart safely resubmits its complete supplied fixture, including out-of-order updates.

A definitely dead local lock PID is reclaimed under a separate exclusive reclaim directory. Malformed locks, permission errors, PID reuse or interrupted reclaim fail closed for operator inspection. Processing leases are separately fenced by token and revision. Slow results cannot overwrite edits or another lease. This is not distributed locking; power-loss directory durability is filesystem-dependent. Production requires database transactions/leases.

Bounds: 100 updates/batch, 10,000 event revisions, 20,000 delivery records, 32 MiB snapshot, 500 audit records/candidate, at most four inspection workers, five automatic failed inspections and exponential retry capped at 60 seconds. Capacity exhaustion stops before acknowledgement; no pending evidence is evicted. Archival and distributed persistence are future work.

Duplicate deliveries and identical revisions have no duplicate candidate/enrichment/publication effect. New edits invalidate rights, evidence and approval. Same document reposts are duplicate review, even with a different VJ caption; different documents remain distinct. Existing movie/new VJ proposes a new version. Existing movie/same VJ/different media requires separate replacement review. Published/rejected candidates cannot silently reopen. Document-removing edits block local review without changing catalogue rows or claiming deletion from gaps.

Discovery's Bot API update checkpoint and enumerated-history reconciliation cursor are independent of `telegram_channels.checkpoint_message_id`, which remains the uploader recovery-floor authority.

## Parsing, matching and enrichment

Existing deterministic parsing handles dotted filenames, parenthesized years, caption separators and uploader title/VJ lines. Machine-token/movie-kind lines are excluded from title suggestions. Conflicting title/year/VJ evidence and uncertain boundaries require correction. `tmdb:movie:` and `velora-src` claims never choose identity or create a fingerprint. Evidence references, confidence and warnings accompany suggestions.

Catalogue lookup runs first using title/original-title/year/TMDB/version associations. Exact existing matches avoid TMDB search. Namesakes stay ambiguous. Injected search/snapshot/media ports use fixtures in this checkpoint. External snapshots use the existing bounded Zod schema; no separate client was created. Existing supported snapshot fields are title/original title, release date, synopsis, artwork, genres, runtime and vote fields. Cast is absent from the current publication snapshot contract and was not added. TMDB failure retains safe retryable state. Unchanged duplicate candidates do not rerun enrichment.

VJ matching reuses names, slugs and aliases and accepts only active unique existing records. Admin correction selects a validated metadata choice and active VJ. The fixture runtime recomputes the selected movie/version relationship from its synthetic catalogue; the future production adapter needs an equivalent restricted lookup.

## Review, rights and UI

States: detected, inspecting, awaiting metadata/identity/VJ/media/rights/review, approved, publishing, published, duplicate, rejected, failed and blocked. Approval requires confirmed identity, valid metadata, active selected VJ, complete Telegram identity, exact-media evidence, explicit rights and a confirmed catalogue relationship. Duplicate/replacement/closed candidates cannot publish. Every correction/decision is audited and stale revisions are rejected.

Readiness separately records container/codec, gateway, browser and accessibility evidence, bound to channel/message/document/size. Defaults are unknown: `.mp4`/`video/mp4` never imply playable media. No bytes are downloaded or streamed during detection. Fixtures may supply clearly synthetic verification for tests.

Rights start absent. A fixture rights decision records server-supplied reviewer, time, reference and current revision. Corrections invalidate it. Telegram metadata is never clearance. A local fixture decision is not production streaming permission; rollout requires the approved owner rights mechanism and durable evidence.

`/admin/discovery` has URL-based title/status filters and queue cards. Detail shows source provenance, metadata/artwork, existing movie/new-version relationship, VJ, readiness layers, rights, warnings and audit; actions correct, select, record fixture rights, reject, approve and reinspect. It can prepare an existing owner script but never executes it. Next Server Actions validate input and authorize every invocation, with POST/origin CSRF protections. Reused form labels, touch-sized buttons, image sizing, empty/loading/error states and Server Components keep the UI small.

Both pages/actions require `VELORA_DISCOVERY_MODE=fixture`, refuse production, and require a genuine non-anonymous authenticated user with fresh Auth-server `app_metadata.role=admin`. User metadata and stale JWT role claims cannot authorize review. No fake login, public fixture URL, admin-minting endpoint or new service-role usage exists. Automated Auth calls were mocked; no hosted admin was created. See [Supabase SSR guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs).

Explicit local setup (synthetic example only):

```powershell
npm.cmd run discovery:replay -- --fixture scripts/discovery/example.json
Copy-Item -LiteralPath scripts/discovery/example.json -Destination .velora-ingest/discovery/fixture.json
$env:VELORA_DISCOVERY_MODE = 'fixture'
npm.cmd run dev
```

The reviewer still needs a real authenticated admin. Do not grant a hosted role just to preview fixtures. Synthetic server markup can instead be exported by the explicit UI-test preview and inspected with browser networking blocked.

## Publication integration and remaining extension

`approvedPublicationScript` invokes the unchanged `publicationScript`: owner transaction calls `private.catalogue_approve_movie_match`, then `private.catalogue_publish_movie`, then readback. It checks revision/gates and a trusted lookup's exact uploader fingerprint/media/evaluated TMDB/evaluated VJ association. Generated fixture scripts carry a synthetic-only warning and remain ignored local artifacts.

`publishReviewed` accepts an injected owner port for isolated tests. Approved review is atomically claimed before the call; concurrent calls are refused, the receipt is durable and completed replay is idempotent. Failure/lost receipt stays `publishing` with an explicit owner-reconciliation error. There is no silent resend, direct catalogue insert or automatic reapproval. The web runtime has no execution transport.

New direct-channel media has no verified uploader source and returns `channel_publication_extension_required`. The proof covers supported uploader-linked review, not arbitrary direct channel publication.

No new migration is required for the local journal. No migration file or hosted execution is included. Production needs a subsequent versioned SQL checkpoint:

1. Extend webhook-origin `private.ingestion_events` with digest/first-last-seen/revision/lease/retry state and an independent discovery checkpoint. Reuse existing bot/update and media-delivery keys; do not invent uploader fingerprints or convert origins.
2. Extend existing metadata review records with revision-bound decisions and independently validated media/rights evidence references. Reuse media/movie/version/VJ foreign keys; add unique candidate/approved-revision constraints and work-queue indexes.
3. Factor only common catalogue materialization inside the current owner publisher into an owner-only helper. Preserve the uploader entry point and gates. Add an owner-only channel-event entry point checking registered channel, observed media, approved current revision, unique identity, active VJ, readiness/rights and conflicts before invoking the same helper. Lock review/media/version relationships transactionally; never replace published versions.
4. Private tables remain RLS-enabled with no direct client policies. Explicitly revoke table/sequence/function privileges from PUBLIC/anon/authenticated/service_role. A future discovery login receives only narrow claim/complete RPC execution, never rights/publication/catalogue grants. Review privileges are separately approved. Owner functions remain invoker, `search_path=''`, schema-qualified and unexposed. Any justified definer RPC must validate caller/scope and explicitly audit execution privileges.

Executable migration SQL is deferred until reviewer-role, rights/verification evidence and identity contracts are decided. Existing migrations 1–12 remain immutable. Follow-up must deliver SQL, RLS/grants, isolated migration/concurrency/publication tests, unchanged uploader tests and hosted backup/migration review. Local compatibility does not prove hosted safety.

Rollback stops only the new event owner and preserves durable inbox/checkpoints/audit. Any grant removal uses a new reviewed migration. Do not erase evidence, reset uploader floors, reverse applied migrations, alter published movies/media or force-push.

## Reconciliation and deployment plan — not activated

Offline reconciliation enumerates pages, at most 100 events/page and ten pages/invocation (default three), and persists a separate cursor. Restart resumes it; repeat/out-of-order pages are safe. Unknown gaps never imply contiguous IDs or deletion. Inaccessible results leave reconciliation incomplete. No historical sweep or upload-recovery action occurs.

Logs contain aggregate updates/duplicates/processed/failures/backlog/metadata/media/rights/approval/publication/incomplete metrics and fixed safe codes, without credentials or channel/document identifiers. SIGINT/SIGTERM stop admission. Committed work/leases support restart. Replay exits when fixtures end; the continuous production polling/reconnect loop is future work.

Separately approved rollout prerequisites:

- Channel-origin persistence/publication SQL, explicit privileges and isolated tests; hosted backup, migration and deployment approval.
- Durable rights decisions and bounded unpublished-media verification: byte/time/concurrency budgets, current accessibility, existing codec policy and browser video/audio/seek proof. Preserve the published-only gateway resolver.
- External poller/webhook inventory and one Movies-bot event owner, required read permissions and secret configuration; preserve upload/reader identity separation.
- Persistent supervised Node worker/container, database leases, graceful lifecycle, health/backlog/lag alerts, rate/backoff bounds, secret mounts, restricted login and network allow-lists. No always-running Vercel function.
- Explicit initial update position, without `drop_pending_updates`; historical import remains separately authorized and bounded.
- Production admin assignment/revocation and review RPC policy; no grants to every signed-in user.
- Publication-completion cache invalidation: Home and VJs currently revalidate every five minutes; Movies/Search/details use current server reads. Future owner completion should revalidate Home/VJs/affected detail paths. Offline actions invalidate only admin routes.

Recommended next checkpoint: **E3.8A — isolated channel-origin SQL and bounded media-verification contract**, then separately authorized rollout. Stop before listener/migration/publication/history activation.

## Verification and external-state record

- Full unit suite: **811 passed, 27 pre-existing skipped, 40 files**. Existing uploader, recovery, gateway and public-boundary assertions remain enabled.
- Discovery fixtures cover the requested success/failure categories: duplicates/edits/reposts/new VJ, ambiguous/unknown metadata, unavailable TMDB, unsupported/unknown media, rights/auth/stale/concurrent review, persistence crashes/restart, reconciliation/gaps/inaccessible media, markers, uncertain/idempotent publication and supported isolated success.
- Existing catalogue suite on real isolated PostgREST: **22 passed, 1 skipped**. Skipped authenticated watchlist migration needs a disposable Auth service, which was not started. Docker-exec transport required a 120-second deadline; original assertions were preserved.
- Supported isolated publication: **1 passed** through real existing owner SQL and anonymous current queries. Hidden draft became visible on Movies/Search/VJ detail/filter/movie detail; existing home featured selection was preserved. Existing synthetic movie rows were byte-for-byte unchanged. No hardcoded public rows/new data source.
- Isolated SQL: **482 assertions passed across all eight existing suites**, including cron/security, catalogue, watchlist, identity, uploader worker, recovery concurrency, owner publication and gateway. Initial harness errors in scheduler setup, seed order, dblink authentication and public-schema defaults were corrected; assertions were not removed. Restarting the disposable tmpfs container cleared its fixtures as expected, so the final complete SQL run used a restored schema and the default scheduler database. No developer reset.
- Typecheck and tracked-code lint passed; final secret scan and diff recorded in completion report.
- Copied-workspace full webpack build passed compilation, TypeScript, all 15 static pages and route manifests against disposable data, with telemetry disabled/no `.env.local`. Temporary GET-only localhost proxy reached only the internal test network. Existing `.next/dev` output remained intact. Font-fetch retry recovered. Cleanup of already absent empty TMDB variables produced a PowerShell error after the first successful Next build. An unintended root-directory build subsequently hit the sandbox font-network restriction; the final copied-workspace build avoids the developer environment.
- Chrome markup/layout checks, 390/1440px queue/detail: no horizontal overflow, all labels wired, all buttons at least 44px. Four network-blocked screenshots generated/inspected. This is layout evidence, not a real hosted admin-session proof.
- No dependency added. Current Supabase changelog/SSR docs and bundled Next mutation/security guides reviewed. Gateway/Telegram deployment/current publication SQL/public catalogue reads unchanged.
- Telegram **0 reads / 0 writes**; hosted Supabase **0 reads / 0 writes**; production migrations **0**; real movie/series modifications **0**. Local Supabase reads exported schema/password-free roles only; all fixture SQL/publication occurred in disposable internal-network databases with tmpfs and no hosted credentials.
- Call of Heroes, On The Hunt and Fuze were not accessed or modified; their production integrity is protected by no writes and unchanged publication/delivery paths, not a fresh live playback claim.
- Unrelated CSS/logo/design prompt/Phase C document/gateway test/`.claude/` changes remain unstaged. E3.7D remains committed at starting HEAD.

Ignored evidence: `.velora-ingest/e3.8/` logs, copied build, synthetic markup/screenshots and responsive results. Disposable containers/proxy are removed after verification; existing local Supabase/Bot API/gateway remain.

**E3.8 OFFLINE IMPLEMENTATION: PARTIAL** — safe offline prototype and supported publication integration proven; new direct-channel publication, production persistence/transport, durable rights/readiness evidence and authenticated fixture integration remain unfinished. Do not deploy this as automatic channel publication.

---

# E3.8A — Direct-channel review and publication

Date: 2026-10-10 (Africa/Nairobi). Branch `phase-a-foundation`; starting HEAD `f63daeae2db6b65ab093592a68210b983e2839cb` (equal to `veloraug/phase-a-foundation`).

**Classification: PASS for isolated implementation; ready for controlled rollout.** A document posted directly to the Movies channel can now be detected, persisted, verified (bounded), reviewed, rights-cleared, approved and published, and then appear through the existing catalogue queries. This is proven end to end in a disposable database. Nothing ran against Telegram or hosted Supabase. **Migration 13 is local only, not deployed.**

## What changed

| Area | Implementation | Reused |
| --- | --- | --- |
| Persistence | Migration `20261010090000_direct_channel_publication.sql` | `private.telegram_media`, `private.ingestion_events` (new origin `channel`), `private.metadata_match_candidates` (now with the validated `snapshot`) |
| Provenance | `tg1-` identity = SHA-256 of `[chat_id, message_id, "file_unique_id", file_size]` (the E3.8 `mediaKey`), computed by the database (`private.channel_media_identity`) and by `channelIdentity` in `lib/discovery/events.ts` | E3.8 detection and digests |
| Shared publication | `private.catalogue_materialize_movie_version` is steps 1–3 of the C2B.2H publisher, factored out unchanged. `catalogue_publish_movie` (uploader) and `catalogue_publish_channel_movie` (channel) both end in it. | All 77 C2B.2H assertions pass unchanged |
| Worker | `DiscoveryPersistence` port in `lib/discovery/worker.ts`. JSON inbox = `inboxPersistence` (E3.8 behaviour, unchanged); Supabase = `databasePersistence` in `lib/discovery/database.ts` | `runReplay`, `reconcile`, `inspectCandidate`, parser, VJ resolver, matcher |
| Media readiness | `lib/discovery/media-verification.ts` (bounded verifier); `lib/media-gateway/range-reader.ts` (gateway MediaReader → aligned ranges); `headProbe` in `lib/uploader/media-tools.ts` | `readMp4Layout`, `inspectionFromProbe`, `classifyMedia` (policy v2), E1.1 range planner, gateway `MediaReader` |
| Review UI | `/admin/discovery` gains `VELORA_DISCOVERY_MODE=database` (`ReviewQueue`/`ReviewDetail` `mode` prop; database gates; owner command panel; "Refresh public pages") | Same pages, components, Server Actions and fresh-session admin check |
| Approval/publication commands | `lib/discovery/owner-commands.ts` prepares validated psql commands; `publicationState` reconciles uncertain results | C2B.2H owner-service pattern |
| Bot API consumer | `lib/discovery/bot-api-provider.ts`: bounded `getUpdates` provider, **not wired or started** | Local Bot API transport (injected) |
| Isolated gates | `scripts/isolated-db.mjs` (`npm run test:db:isolated`), `vitest.discovery.config.mts` (`npm run test:integration:isolated` with `VELORA_E38_ISOLATED_TESTS=true`) | E3.8 integration tests, now on the new harness |

No dependency was added. An in-app Postgres client was tried and removed, because the E1.2 boundary test forbids Postgres packages in the application.

## Direct-channel provenance

- A channel row has `origin = 'channel'`. A CHECK forbids any uploader column on it (fingerprint, size, upload state, floor), so it can never claim uploader provenance.
- One partial unique index (`ingestion_events_media_provenance_key`) lets a delivered document belong to the uploader or to a channel post, never both. A delivery of the uploader's own message is ignored, not turned into a candidate.
- Captions, filenames, `velora-src`/`tmdb:` claims and `file_id` are never identity. `file_id` is stored only in the private media row (required there) and never appears in review views.
- **Edits.** Edits apply in Telegram date order. An unpublished document that is edited or replaced gets a new revision, its approval is cleared, and its rights and evidence become stale (both are bound to the revision and to the `tg1` identity).
- **Published and duplicate documents.**
  - A published message is never reopened. Its media identity is frozen by `telegram_media_guard_identity`, an edit only flags `published_message_changed`, and the gateway already refuses a document whose `file_unique_id` no longer matches.
  - A repost of the same document is `ignored`/`duplicate_media`. The same unique id with another size is `blocked`/`document_identity_conflict`.

## Database schema and grants (migration 13)

New private tables, all with RLS on, no policies, and every privilege revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`:

| Table | Holds |
| --- | --- |
| `channel_reviews` | revision, fenced worker lease, retry time, identity state, TMDB/VJ choice, relation, approval |
| `media_evidence` | bounded verification of one identity; `scope` is fixed to `bounded`, and `verified` is a generated column |
| `rights_clearances` | unique per (candidate, revision), bound to the identity |
| `catalogue_reviewers` | separate `can_review`, `can_clear_rights` and `can_publish` capabilities; **ships empty** |
| `channel_review_audit` | append-only (trigger) |
| `discovery_deliveries` | `u:<update_id>` / `r:<event digest>` dedupe |
| `discovery_cursors` | update offset, reconciliation cursor and single-consumer lease. **Absent until the owner initializes it**, independent of the uploader's `checkpoint_message_id` |

Command tiers (all `search_path=''`, schema-qualified, no dynamic SQL):

1. **Worker**, `service_role` only (SECURITY DEFINER): `discovery_acquire_consumer`, `discovery_receive`, `discovery_claim`, `discovery_complete`, `discovery_fail`, `discovery_catalogue_lookup`, `discovery_vjs`, `discovery_health`. They record deliveries, inspections and evidence. They never write the catalogue, rights or approvals.
2. **Reviewer**, `authenticated` only, plus a capability check in `private.require_reviewer` against fresh database state (anonymous sign-ins and unlisted accounts are refused): `discovery_review_list`, `discovery_review_get`, `discovery_review_correct`, `discovery_review_clear_rights` (rights capability), `discovery_review_reject`, `discovery_review_retry`.
3. **Approval and publication**: `catalogue_review.approve_channel_candidate` and `catalogue_review.publish_channel_candidate`.
   - They live in a schema the Data API does not expose. EXECUTE belongs only to the new role `velora_review_service` (NOLOGIN, NOINHERIT, no memberships, connection limit 5; login and password are operator configuration) and to the owner.
   - Each names the reviewer and requires that account's `review` or `publish` capability.
   - This keeps the C2B.2H invariant: *no approval or publication function in the Data API schema* (suite 007, unchanged).
4. **Owner**, no API role (SECURITY INVOKER): `catalogue_materialize_movie_version`, `catalogue_publish_movie`, `catalogue_publish_channel_movie`, `channel_review_blockers` and internals.

The `velora_media_gateway` role and its published-only resolver are unchanged. Suite 003's reviewed inventory was updated to name the 7 new tables and the 16 new SECURITY DEFINER functions, and its scan now includes `catalogue_review`. No other existing assertion changed.

## Review workflow, gates and rights

`detected → inspecting → awaiting_metadata | awaiting_identity | awaiting_vj | awaiting_media | awaiting_rights | awaiting_review → approved → published`, plus `failed`, `blocked`, `duplicate` and `rejected`.

`private.channel_review_blockers` is the single gate evaluator. It drives the reviewer's view, approval, publication and the health counts. Any of these blocks:

| Gate | Blocks when |
| --- | --- |
| Candidate state | closed, inspection pending, or a duplicate |
| Channel | not registered |
| Media identity | incomplete |
| Movie identity | not confirmed by a reviewer (a high-confidence match is only `proposed`), or no validated snapshot |
| VJ | not active |
| Media evidence | no current, verified evidence for the current identity |
| Rights | no clearance for this revision and identity |
| Conflicting evidence | unresolved warnings |
| Catalogue relation | archived title, an existing version of the same title and VJ (replacement needs a separate workflow), or media already linked |

Rights are never implied by Telegram, TMDB, approval or publication. Approval needs the review capability and publication the separate publish capability. A reviewer may hold any combination, so duties can be split. Stale revisions, unauthorized accounts, `service_role`, `anon` and a plain owner session (no reviewer identity) all fail closed.

**How an administrator approves and publishes.** The detail page shows the gates.
- When every gate passes, the page shows the **approval command**; once approved, it shows the **publication command**.
- Each command is prepared for the signed-in admin's account and is run through psql as `velora_review_service` (or the owner).
- The browser never has an approve or publish button, because the application has no route to the owner tier.
- After publication, "Refresh public pages" calls the existing `revalidatePath` for Home, Movies, VJs, Search, the movie page and the VJ page. Without it, Home and VJs refresh within 5 minutes.

## Atomicity, idempotency and uncertain outcomes

- Publication is one transaction: lock the candidate, re-evaluate the gates, materialize (movie and genres, VJ version, media link, ready and cleared, published), then mark it published, attribute it and audit it.
- A replay at the approved revision returns `already_published` with the same ids.
- Concurrent publishers serialize on the candidate row and the movie row. A second title insert or version insert is refused (`catalogue_publication_conflict` / `catalogue_version_conflict`); nothing is merged.
- Any failure rolls back everything (proven with a slug collision: no movie, no version, and the candidate stays approved).
- **Uncertain result:** check the candidate's state (`publicationState`, or the detail page). If it is published, stop. If it is approved but not published, the same command may be run again; it is idempotent. Never re-run blindly.

## Media verification

The verifier reads, through the gateway's own `MediaReader`:

- one 16-byte header per top-level box;
- `ftyp..moov` (at most 16 MiB) for ffprobe;
- the last 4 KiB.

It never reads media data in between. The existing policy v2 must classify the file `canonical`: fast-start ISO MP4, H.264 within policy, AAC-LC or MP3, nothing else, and boxes that cover exactly the size Telegram reports. On a ~1 GB synthetic document this costs under 16 KiB of reads. Anything incomplete, unreadable, over budget, non-MP4, not fast-start, fragmented or unprobeable is recorded `unverified` and blocks publication. **Evidence never claims full-file integrity**: the database refuses any scope but `bounded`. Browser compatibility follows from the E3.3/E3.5 proven policy, not from a per-file browser test. Safari/iOS remains the pre-launch gate.

## Detection ownership and reconciliation

- One process must own Movies-bot updates. The database enforces this with a lease: `discovery_acquire_consumer` hands out a single token, a second consumer gets `discovery_consumer_busy`, and a record attempt without the current token gets `discovery_consumer_lease_lost`. Telegram's own 409 is a second line of defence (`bot-api-provider.ts` stops on it).
- Never run a webhook and polling together. Never call `deleteWebhook` or `drop_pending_updates`.
- Each batch and its offset commit together, before any acknowledgement. The reconciliation cursor is separate and never resets to the start of history.

## Verification (2026-10-10)

| Gate | Result |
| --- | --- |
| Unit suite (`npx vitest run`) | **845 passed, 27 skipped, 43 files.** The 811 existing tests are unchanged, plus 34 new: verifier, range adapter, database adapters, owner commands, Bot API provider, identity digest, database-mode markup. One full-suite run hit a timing failure in the untouched `lib/media-gateway/pump.test.ts`; it passed 3/3 alone and in the next full run. |
| Isolated database (`npm run test:db:isolated`) | **9/9 suites, 621 assertions** (482 existing + 139 new in `009_direct_channel_publication.test.sql`) |
| Mutation checks on suite 009 | Removing the rights gate → 6 failures; removing the publish-capability check → 3 failures |
| `supabase db lint` (isolated DB, `--level warning`) | No schema errors, including `catalogue_review` |
| Isolated integration (`npm run test:integration:isolated`) | **32 passed, 1 skipped**: catalogue 22 (+1 skipped Auth-service case, as in E3.8), E3.8 uploader-linked publication 1, E3.8A end to end 9 |
| Typecheck and tracked-code lint | Pass |
| Production build | Pass: webpack build of a copied workspace without `.env*`, against the isolated seeded PostgREST through a GET-only local proxy; 15 static pages. No review RPC, review schema or JWT secret string in any browser chunk. |

The E3.8A end-to-end test uses real modules throughout: worker, persistence, verifier, reviewer client, owner commands via psql as `velora_review_service`, `lib/catalogue`, entitlement and capability issuing, and the gateway resolver. It proves:

- **Detection:** duplicate delivery, the single consumer, restart without re-inspection, a proposed identity and VJ, and exact-identity bounded evidence. Rights start missing.
- **Authorization:** refusal for `anon`, `service_role`, rights-only reviewers and accounts without a capability. Approval needs confirmation and rights; stale and unauthorized approvals fail, and the worker identity cannot run owner commands.
- **Publication:** an uncertain publication is reconciled to `published`, and a re-run returns `already_published`. The title is visible on Movies, Search, the detail page, the VJ list and the VJ filter.
- **Playback:** anonymous streaming is denied, signed-in streaming is allowed, and tampered, download-op and other-version tokens are denied. The resolver serves the exact message.
- **Afterwards:** later edits, reposts and reconciliation leave every version byte-identical, and every pre-existing title is unchanged.

**Not covered:** the Next.js Server Actions themselves (markup and client modules are tested). The live MTProto reader and ffprobe path need Telegram and the verified ffprobe build, so they are offline-tested only.

## External state

- Telegram reads/writes **0**.
- Hosted Supabase reads/writes **0**; hosted migrations **0**.
- Production movies, versions, media and rights rows are not touched. Call of Heroes, On The Hunt and Fuze are not accessed.
- The developer's local Supabase stack is not reset or written: all database work ran in disposable `velora-e38a-*` containers on tmpfs with synthetic credentials.

## Production rollout (requires separate authorization; not executed)

1. **Review** migration 13 and this record (grants, `catalogue_review`, `velora_review_service`).
2. **Back up** the hosted database (PITR point or `pg_dump` of `public`, `private`, `auth.users` ids). Confirm hosted has exactly 12 migrations and that `supabase db push --dry-run` proposes only `20261010090000`.
3. **Apply** it with `supabase db push`. Verify function bodies against the local chain, the privilege fingerprints, and advisors (expect `rls_enabled_no_policy` INFO on the new private tables, as for `telegram_channels`). Re-run the read-only ACL checks of suite 009.
4. **Credentials:**
   - Keep the worker on `service_role` on the worker host only. Never in Vercel, never `NEXT_PUBLIC_`.
   - For approvals, enable login for `velora_review_service` with a SCRAM password set outside SQL history (as for `velora_media_gateway`), stored on the operator machine.
   - Grant named reviewers in `private.catalogue_reviewers` as the owner, splitting review, rights and publish where possible. Set their `app_metadata.role = 'admin'` for the UI gate.
5. **Update ownership.** Confirm no webhook is set and no other `getUpdates` consumer exists, using the Movies bot's local Bot API `getWebhookInfo` (a read). The discovery worker is the only consumer; the uploader posts never conflict.
6. **Listener host:** a persistent, supervised Node process next to the local Bot API (not Vercel). It needs the MTProto reader session (read-only reader bot), the verified ffprobe, and network access to Supabase and the local Bot API only.
7. **Initialize** `insert into private.discovery_cursors (bot_type) values ('movie')` as the owner. The channel row already exists. The first poll starts from Telegram's pending queue; never use `drop_pending_updates`.
8. **Activate read-only detection first:** run the worker with inspection on, review mode off.
9. **Validate candidates:** `discovery_health`, the review queue counts, and one known test post.
10. **Enable admin review:** set `VELORA_DISCOVERY_MODE=database` on the web deployment.
11. **Check media readiness:** the evidence must be `canonical`, bounded, at the current identity.
12. **Clear rights and approve** a test candidate whose rights are confirmed, using the reviewer accounts and the prepared approval command.
13. **Publish** through the prepared publication command (owner service, psql, as `velora_review_service`).
14. **Check public visibility:** Home, Movies, Search, VJ and detail pages ("Refresh public pages"), plus authenticated playback through the gateway.
15. **Monitor and roll back.** Watch backlog, failures, `media_blocked`, `rights_blocked`, reconciliation lag and consumer-lease errors.
    - Rollback stops the worker and revokes reviewer capabilities or the `velora_review_service` login.
    - Grants change only through a new migration.
    - Never delete audit or evidence. Never unpublish by editing rows outside a reviewed procedure. Never reverse an applied migration.

**Remaining production prerequisites:**
- operator wiring of the worker entrypoint (persistence + `botApiUpdateProvider` + `mediaReaderRange` + `headProbe`);
- reviewer-account assignment;
- the live Telegram verification above;
- a GoTrue-backed run of the skipped watchlist case before launch.

**E3.8A: PASS — DIRECT-CHANNEL REVIEW/PUBLICATION READY FOR CONTROLLED ROLLOUT** (isolated; migration 13 not deployed; listener not started).
