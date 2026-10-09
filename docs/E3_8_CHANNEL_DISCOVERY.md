# E3.8 — Offline channel discovery and review

Date: 2026-10-10 (Africa/Nairobi). Starting branch: `phase-a-foundation`; HEAD: `c775904046a197a3b5214348c33c568123523441`. E3.7D was already committed/pushed at this HEAD; its real upload/publication is not repeated.

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
