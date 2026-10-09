# Velora UG — Implementation Roadmap

> Controlled migration from the existing Velora discovery application to a production-oriented Ugandan VJ-translated streaming platform.

## 1. Purpose and baseline

Velora UG is not a greenfield rewrite. It evolves the existing Next.js/Supabase application while preserving working UI, authentication, watchlists, search work, accessibility, performance, and security controls.

The architecture audit is in [`docs/VELORA_UG_MIGRATION_PLAN.md`](docs/VELORA_UG_MIGRATION_PLAN.md). Engineering rules remain in `AGENTS.md`; visual foundations remain in `DESIGN.md` and semantic tokens in `app/globals.css`.

### Completed legacy foundation

- **Phase 1 complete on `main`:** TMDB discovery UI, responsive deep-blue design, reusable media components, search/details, async states, guest My List, accessibility, and release verification.
- **Phase 2 complete on `main`:** Supabase auth, profiles, persistent own-row watchlists, guest merge, grants/RLS, and concurrency-safe 500-item cap.
- **Phase 3 implemented on `origin/phase3-discover`, not merged into `main`:** Discover filters, search analytics, and recent-search history. Its audit says its migration is live and analytics retention is unscheduled.

The first Velora UG task is reconciliation, not feature construction.

### Status (2026-09-24 reconciliation checkpoint)

- Phase 3 is in the Velora UG repository's `main` (`veloraug/main`). Phase A and retention reached it through PR #1 (`c91f07d`).
- Search-event retention is scheduled (daily, 30 days), and the first hosted run succeeded on 2026-09-24.
- Hosted Supabase has 7 migrations, identical to `supabase/migrations/`, including B-1/B-2. Source: `veloraug/phase-a-foundation` (`6632328`).
- Phase A (A1–A5) is complete. Roadmap B1, B2 and B3 are delivered and B4 is partly delivered. Historical checkpoint labels are mapped in `docs/PHASE_B_CATALOGUE_DESIGN.md`.
- B4 update (2026-09-24, later): B4 is implemented and validated locally. Internal ids are canonical, new internal-id saves are limited to public titles (`20260924195306`, **not yet deployed**), legacy TMDB rows remain readable and removable, and unresolved rows are measured by `supabase/diagnostics/watchlist_identity.sql`. Legacy TMDB writes continue for unmapped titles until B5. B5 has not started.
- B4 deployed (2026-09-24): hosted has 8 migrations, ending `20260924195306`. Read-only verification passed: definitions and privilege fingerprints are identical to the clean local chain, no new advisor findings, 0 watchlist rows. **Roadmap B4 is complete.** B5 is next and has not started.
- B5 (2026-09-24, later): catalogue read cutover implemented and validated locally. Supabase is the catalogue authority. Home, Movies, Series, details, VJs and search read only the published catalogue, normal browsing makes no TMDB request, and ordinary saves use internal ids only. The sample catalogue is removed. No migration. Remaining TMDB uses (artwork CDN, temporary legacy My List lookup, transport for Phase C) are listed in `docs/PHASE_B_CATALOGUE_DESIGN.md`, "B5 result". Phase B is complete once B5 is reviewed. Phase C has not started.
- C1 contract checkpoint (2026-09-25): ingestion contract and pure pipeline foundation implemented and tested locally. It covers the lifecycle state machine (upload separate from publication), filename parser, VJ resolution, TMDB match scoring over an injected search, source fingerprints, duplicate classes, the Telegram identity schema and the dry-run planner, all in `lib/ingestion/`. **No migration** and no upload, webhook or database write path. The contract, schema mapping and the C2 decision points (write path, upload transport for files up to 2 GB) are in `docs/PHASE_C_INGESTION_DESIGN.md`. Phase C is **not** complete.
- C2A secure upload foundation (2026-09-25, **blocked at migration 9**): transport, recovery and tooling are implemented and tested locally. That covers the self-hosted Bot API adapter (`lib/telegram/local-bot-api.ts`: fails closed, no cloud fallback, two-bot/two-channel routing, 2000 MiB ceiling, local-path upload), caption token, crash reconciliation (`lib/ingestion/recovery.ts`), local journal and uploader (`lib/uploader/`), the ingestion-only TMDB search (`lib/tmdb/ingestion-search.ts`) and the `npm run ingest` CLI (dry run by default). **Migration 9 was not written.** `private.ingestion_events` requires a Telegram `update_id`, and its source fingerprint has no unique key, so an uploader-originated item has no valid row. The brief requires a stop before any table change, so the worker RPC boundary awaits a schema decision (`docs/PHASE_C_INGESTION_DESIGN.md`, "C2A"). No upload, no Telegram call, no hosted change. Phase C is **not** complete.
- C2A.1 worker boundary (2026-09-25): Option A was approved and implemented in migration 9, `20260925004059_ingestion_uploader_worker_boundary.sql` (**local only, not deployed**). `private.ingestion_events` stays the single lifecycle root, with an `origin` discriminator (webhook rows keep their original shape by CHECK). The fingerprint is unique, and the upload state is independent of review. It adds the private `private.telegram_channels` allow-list (ships empty; fails closed until configured) and four `ingest_upload_*` SECURITY DEFINER commands executable by `service_role` only, with no table grants and no publication capability. The uploader's RPC store is wired in, but real Telegram uploads stay disabled in code (`REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`) until C2B. Audit and tests: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2A.1". C2B and Phase C are **not** complete.
- C2A.2 hosted deployment (2026-09-25): migration 9 deployed, **PASS**. Before the push, hosted had exactly 8 migrations and 0 ingestion rows, and the dry-run proposed only `20260925004059`. Hosted now has 9 migrations. Read-only verification found schema, indexes, RLS and RPC bodies identical to the repository. The four `ingest_upload_*` functions have owner `postgres`, SECURITY DEFINER and `search_path=''`, with EXECUTE for `postgres`/`service_role` only. There are no private-table grants for `anon`, `authenticated`, `service_role` or `PUBLIC`, and no catalogue write path. `private.telegram_channels` is intentionally empty (0 rows), so hosted uploads fail closed. The advisors report one new INFO, `rls_enabled_no_policy` on `telegram_channels`, which is intended and accepted, and nothing blocking. No Telegram call and no upload happened. C2B has **not** started. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2A.2".
- C2B.1A recovery hardening (2026-09-25): the C2B.1 preflight was BLOCKED, and this fixes the cause. The "20 consecutive missing ids = end of channel" rule is removed. Crash recovery now uses a bounded marker protocol. The floor is the attempt's journal high-water; the upper bound is a text-only marker posted to the same channel by the same bot. Every id in between is inspected, and a scan confirms absence only when complete. Service and non-forwardable messages, rate limits, transient and permission failures, and unknown floors all hold the source as `uncertain` and never permit a reupload. Implemented and tested locally with fakes; no Telegram call, no migration. A safe floor on a fresh machine (lost journal) needs **migration 10, proposed and not authorized**; until then that case holds. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.1A". Bot migration (C2B.1) has not started.
- C2B.1B durable recovery bounds (2026-09-25): migration 10, `20260925194322_ingestion_recovery_bounds.sql` (**local only, not deployed**; hosted still has 9). `ingest_upload_start` computes each attempt's recovery floor and persists it, fixed for that attempt. The floor is the larger of an advance-only per-channel checkpoint and the highest recorded message. `ingest_upload_status` returns it with the attempt's start and age. The new `ingest_channel_checkpoint` never goes backwards and never passes an unresolved upload. Start and checkpoint serialize on a per-channel advisory lock. A fresh machine recovers from Supabase state alone. The journal only corroborates the floor, and any disagreement holds. Five service_role-only worker commands; no publication authority. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.1B". C2B is **not** complete: hosted deployment of migration 10, channel checkpoints, the Bot API server and bot migration remain.
- C2B.1C hosted deployment (2026-09-25): migration 10 deployed, **PASS**. Before the push, hosted had exactly 9 migrations and 0 rows in all four ingestion tables, and the dry run proposed only `20260925194322`. Hosted now has 10 migrations. Columns, CHECKs, triggers and all five RPCs match the repository: function bodies are MD5-identical to the local stack. EXECUTE is `postgres`/`service_role` only; no private-table grants, no publication references, no new advisor findings. Fresh-machine durable recovery is available on hosted. `private.telegram_channels` is intentionally empty and checkpoints are intentionally unseeded. Seeding is an operational prerequisite that needs a message id observed in the verified channel. No Telegram call, no upload; the bot migration has not begun. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.1C".
- C2B.2A local Bot API infrastructure (2026-09-26): **PASS**. Telegram's official `tdlib/telegram-bot-api` is built from source, with no third-party image. It is pinned to the Bot API 10.3 release commit `2efabc722e94` (td `bc9c263e2bfe`) on a digest-pinned `debian:trixie-slim` (`infra/telegram-bot-api/`). It runs `--local` on `127.0.0.1:8081` only, as a non-root user with a read-only root filesystem, and keeps its state in a host directory outside Git that survives restart and recreation. The `G:\Movies` → `/media/movies` read-only mount is a separate compose override, unused while the drive is absent. Path translation now refuses `.`/`..` segments, which could previously escape the mapped root. `TELEGRAM_BOT_API_PATH_MAP` roots are validated: a bare drive, `/`, UNC/device paths, or a server root that overlaps the Bot API's state or temp directory are refused, not repaired. The recovery group is verified (private supergroup, both bots are members, and the ID is stored locally only). Hosted `private.telegram_channels` has 0 rows, no checkpoint is seeded and `REAL_TELEGRAM_UPLOADS_AUTHORIZED` is still `false`. No `logOut`, no Telegram write, no upload. Both bots are still on the cloud Bot API. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2A". The bot migration needs separate authorization.
- C2B.2B Movies bot migration (2026-09-26): **PASS (Movies bot only).** `@veloramovies_bot` is migrated to the local Bot API. Its display name is `velora_movies_bot`. The first attempt was blocked: TDLib aborted on the Windows bind-mounted state directory. After that, Bot API state moved to the named volume `velora-telegram-bot-api-state`, the exposed token was rotated (the old one returns 401) and its failed session was deleted. `TELEGRAM_BOT_API_LOCAL_BOTS` now gates each bot on its completed migration, with a `getMe` check of the configured id and exact username. The retry's cloud `logOut` succeeded at 08:23:06Z, and the gate was set to `movie` only afterwards. Local identity, the Movies channel and the recovery group all verified through the local server, and the session survived a restart and a full recreation. **Series stays on the cloud on purpose**, and the local adapter refuses it before any request. Real uploads remain disabled (`REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`). Hosted channel registration and checkpoint seeding are still outstanding. Next is the Movies channel row and checkpoint, then the Movies trial, before Series. Phase C is **not** complete. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2B".
- C2B.2C Movies checkpoint bootstrap (2026-09-26): **PASS.** The Movies channel is registered in hosted `private.telegram_channels`, as the owner, with one row only. Its first checkpoint equals the `message_id` Telegram returned for one deliberately posted bootstrap text marker (`velora-checkpoint:v1`, distinct from recovery markers and media captions). The reply was validated first: the registered channel, type `channel`, the exact text. The checkpoint was then seeded through `ingest_channel_checkpoint`. The marker is retained in the channel. Series is still on the cloud and unregistered, ingestion rows are 0, and `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`. Production ids are not recorded. Next is the controlled Movies trial, which needs its own authorization. Phase C is **not** complete. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2C".
- C2B.2C.1 Ice P VJ bootstrap (2026-09-27): **PASS.** C2B.2D stopped before any upload: its trial movie's VJ text `ICE P` could not resolve, because hosted `public.vjs` was empty. One active VJ was added as the owner (`VJ Ice P`, slug `vj-ice-p`, following the repository convention), with no description, avatar or aliases. The existing `vjKey` normalization is proven to resolve `ICE P`, `Ice P`, `ICEP`, `ICE_P`, `VJ_ICEP` and all 14 library filenames to it, and anon can read it. The trial file now plans `upload` with no stop reasons. No upload, Telegram call or ingestion write. `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2C.1".
- C2B.2C.2 single-fingerprint selection (2026-09-27): **PASS.** `npm run ingest -- upload --fingerprint <sf1-…>` selects exactly one already-scanned journal entry. The value must be canonical, so a path is never accepted and nothing is normalized. Zero or several matches, a repeated option, a `--limit` other than 1 and a `--kind` mismatch all fail closed. The entry then goes through the same `uploadEntry` path, so no plan, state, server, preflight or authorization check is bypassed. Without it, `upload --limit 1` on the real scan would have picked a different, ambiguous-match movie. `resume` is unchanged. Finding: before sending, the upload rechecks only the file's size, not its content (mitigation and follow-up are in the record). Code and tests only; no Telegram call, no hosted write, `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2C.2".
- C2B.2C.3 upload-time fingerprint revalidation (2026-09-27): **PASS.** Before a new upload attempt starts, `uploadEntry` (the one path shared by `upload`, `upload --limit` and `upload --fingerprint`) recomputes the source's `sf1` fingerprint from its current bytes. It uses the same `fingerprintFile` as `scan`/`inspect`, and the fingerprint must equal the journal value exactly. The check runs after preflight and before the journal attempt, `ingest_upload_start` and `sendDocument`. A mismatch (`source_fingerprint_changed`) or a read failure (`source_fingerprint_unreadable`) refuses without touching the journal or the server; a rescan is required. Uncertain and interrupted attempts still go to reconciliation first and are never revalidated into a resend. Cost: a fixed 12 MiB read (about 30 ms on the trial movie). Proven on the trial movie (exact match) and on a same-size mutated copy outside the library (refused). Remaining narrow window: between the check and the Bot API server's own read, and edits outside the sampled regions (documented). Code and tests only; no Telegram call, no hosted write, `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2C.3".
- C2B.2D first controlled Movies upload (2026-09-27): **BLOCKED, confirmed not sent.** All preconditions passed, including the fingerprint dry run (1 of 14) and source revalidation, with `G:\Movies` mounted read-only. Enabling uploads then meant editing a source constant, which the agent's permission policy refused; this was not worked around. No attempt, Telegram write or hosted write. Still open. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2D".
- C2B.2C.4 runtime real-upload gate (2026-09-27): **PASS.** `REAL_TELEGRAM_UPLOADS_AUTHORIZED` is now a runtime, fail-closed environment gate: only the exact string `true` enables, and unset or any other value denies. It is read on every call, never `NEXT_PUBLIC_`, and never committed enabled (`.env.example` documents `false`). `uploadEntry` and `resumeEntry` check it first, and the injectable `telegramEnabled` flag is removed, so no caller can pass authorization in. The CLI also refuses early and shows only an enabled/disabled state. The operator enables it for one command only (PowerShell `try`/`finally`), together with `upload --fingerprint`; it does not select a file or relax any check. Code and tests only; no Telegram call, no hosted write. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2C.4".
- C2B.2D retry (2026-09-27): **BLOCKED — UNCERTAIN.** Preflight passed, and one attempt ran with the runtime gate set for that one command only (removed in `finally`). The client got `uncertain` / `network_error` after exactly 300 s. Cause: Node's `fetch` (undici) default `headersTimeout` of 300 s cuts off the local Bot API's reply, which comes only after Telegram accepts the whole file; the adapter's 4 h signal does not override it. The server kept uploading, and its output levelled off at about the file size (1.01 GB), so the message is probably in the channel, though this is unconfirmed. Hosted: one row `uncertain`, attempt 1, floor 22; media 0; checkpoint 22. The journal is `uploading`. The server refuses any new start. Not retried. Next: fix the transport timeout, then an authorized reconciliation. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2D … retry".
- C2B.2E uncertain upload recovery (2026-09-27): **PASS.** The existing bounded marker protocol resolved the C2B.2D attempt without re-sending. It posted marker 24 to the Movies channel, forward-probed the interval (22, 24) = {23}, and matched the exact `velora-src` token and size. It then recorded the message through `ingest_upload_record`. Result: the same row is `uploaded` with attempt count 1 and floor 22; one media row is linked, message 23 (document, 1,004,462,878 bytes). The protocol advanced the checkpoint to 24. No candidates; nothing approved or published. A rescan skips the movie as `already_uploaded`, and with a lost journal the server's record returns `adopt_server` before any send. Recovery made 1 marker, 1 forward and 1 best-effort delete, and 0 `sendDocument`. Series untouched; real uploads disabled again. Next: fix the 300 s transport timeout. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2E".
- C2B.2F long-running Bot API transport (2026-09-27): **PASS.** The C2B.2D cause was reproduced on loopback: built-in `fetch` failed at 306 s with `UND_ERR_HEADERS_TIMEOUT` (undici's 300 s `headersTimeout`) despite the adapter's 4 h `AbortSignal`, because the local Bot API sends no headers until Telegram has the whole file. `sendDocument` now uses `longRunningFetch` (`node:http`/`node:https`, no own header or body timeout, a fresh connection per call, no global change, no dependency). This goes through a required `mediaFetch` transport; every other Bot API call keeps `fetch` and its 60 s limit. The 4 h upload limit is now real and finite. A timeout stays `uncertain`, a refused connection stays `unreachable`, and recovery is unchanged. Proven through the real adapter against a loopback server that held headers for 330 s: it succeeded at 330.1 s. 8 of 8 mutations were caught. `upload_failure_code` is the last recorded failure (historical), so no cleanup is needed. No Telegram or hosted writes. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2F".
- C2B.2H first movie catalogue publication (2026-09-27): **PASS.** On The Hunt (VJ Ice P) was
  published after the operator's explicit rights confirmation (this title only):
  - one owner transaction, with script SHA-256 `F4D978A6…`, approved TMDB 1428857;
  - result: movie 1 `on-the-hunt-2026` and version 1 (VJ Ice P, ready, cleared, linked privately to message 23);
  - upload attempt 1, Telegram writes 0, checkpoint 26; Fuze unpublished; Series untouched;
  - it renders from the hosted catalogue on `/`, `/movies`, its detail page, search and `/vjs/vj-ice-p`, with the VJ badge;
  - there is no overflow at 360, 390 or 430 px.

  Earlier in this checkpoint, the publication foundation (PASS):
  - **Migration 11**, `20260927090650_ingestion_movie_publication.sql`, is deployed; hosted now has 11
    migrations and no new advisor findings.
  - **Evaluation (worker, service_role).** The new command `ingest_record_evaluation` records parsed
    evidence and **pending** TMDB candidates, and re-derives the match decision itself.
  - **Approval and publication (owner only).** They are private SECURITY INVOKER functions
    that no API role can execute, and they run only through `psql` as `postgres`. So the
    uploader's key cannot approve or publish.
  - **CLI.** `npm run ingest -- evaluate` and `publication-sql`.
  - **UI.** `MovieCard` shows a VJ badge.
  - **On The Hunt** is evaluated `matched` to TMDB 1428857, with 20 pending candidates, and a replay
    returns `already_recorded`. Attempt 1, one media row; 0 movies and 0 versions; nothing is
    public.
  - **Pending.** Rights confirmation, then approval and publication. Fuze and Series are
    untouched. No Telegram writes. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2H".
- C2B.2I first browser media delivery (2026-09-27): **BLOCKED — DELIVERY ARCHITECTURE.**
  - Local-mode `getFile` needs a complete ~1 GB download before it returns (past the 300 s header limit), and later calls come from the Bot API cache.
  - The Bot API offers no usable HTTP file path, and the cached bytes sit in its Docker state volume, unreachable by the Next.js application (on Vercel in production).
  - So no Range delivery is possible in the current architecture. Media: Matroska, H.264 High@4.0 1080p, MP3.
  - Options (the E1 decision) are recorded. No code changed; Telegram writes 0; hosted writes 0.
  - A diagnostic exposed the Movies token in an operator transcript, so it was rotated. **MOVIES BOT CREDENTIAL ROTATION: PASS**:
    - the new session was local only, with the exact id and username;
    - channel admin/can-post and recovery-group access are verified;
    - the session survived a restart, and no stale state remained;
    - hosted and media references are unchanged, Series untouched, and Telegram writes 0.
  - Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "C2B.2I".
- E1 MTProto feasibility spike (2026-09-27): **BLOCKED — SESSION ARCHITECTURE** (stopped after research, before any login).
  - The protocol fits HTTP ranges: bots may call `upload.getFile`, with `precise` 1 KiB alignment, ≤ 1 MiB, inside one 1 MiB window. The document resolves read-only through `channels.getMessages`.
  - The official Local Bot API README gives no guarantee of updates when a bot is logged in on more than one server, so the ingestion bot must not get a second MTProto login.
  - Recommendation: a dedicated media-reader bot (channel admin, all rights off) configured by the operator; GramJS for the spike.
  - Nothing installed; Telegram 0; hosted 0. Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "E1".
- E1.1 dedicated MTProto range proof (2026-09-27): **CLOSED — LEAST PRIVILEGE VERIFIED.**
  - A separate reader bot (never on the Bot API) logs in over MTProto, resolves Movies message 23 read-only, and reads bounded ranges with `upload.getFile` (`precise`, one read per 1 MiB window).
  - Beginning, middle, tail, EOF clamp and the unaligned range `123456789-124505364` all match the local source byte for byte.
  - 17 calls; about 5.5 MiB received for a 958 MiB file. Concurrency is fine; there is no per-RPC cancel. The ingestion bot is unaffected.
  - Pure mapper `lib/telegram/mtproto-range.ts`. GramJS was spike-only (npm marks it archived, so not for production).
  - After the operator removed its default rights, the reader holds only the admin-state marker `other`: visibility only, no write or manage ability, which is the minimum for a bot in a channel.
  - Message 23 is still readable, and a 64 KiB read was byte-equal.
  - Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "E1.1".
- E1.2 media gateway foundation (2026-09-27): **PASS.**
  - **Client.** mtcute 0.32.3 (exact pin) over teleproto and tdl/TDLib: it is the only maintained client with per-RPC cancellation, and no native build is needed with in-memory storage. GramJS is rejected (archived, no cancel). mtcute's `downloadChunk` is not used: it can cross a 1 MiB window and truncates at EOF (reproduced).
  - **Gateway.** A long-running, published-only HTTP byte-range gateway: dependency-free core in `lib/media-gateway/`, MTProto/Postgres adapters and Dockerfile in `services/media-gateway/`, and none of it in the Next.js bundle. It keeps one warm MTProto session for the dedicated reader, with identity, channel and `other`-only rights asserted at startup.
  - **Authorization.** HMAC tokens bound to operation (`stream` ≠ `download`), internal version and lifetime; publication is rechecked on every request with one read-only round trip.
  - **Limits.** Bounded read-ahead, a global read semaphore, and stream, rate and time limits. Backpressure stops scheduling, and a disconnect stops it and cancels in-flight reads.
  - **Proof on On The Hunt.** The beginning, middle, final 64 KiB and unaligned ranges were byte-equal with correct 206 headers; 416 carried `bytes */1004462878`; unauthorized, expired, wrong-operation and Fuze requests made 0 MTProto RPCs. Headless Chrome range fetches were byte-equal.
  - **Warm latency.** Median TTFB ~0.58 s for 64 KiB (E1.1 cold script: 16–18 s).
  - **Container.** 76.5 MiB with three paused streams under a 256 MiB cap; it recovered from a real network cut; graceful SIGTERM.
  - **External writes.** Telegram content 0, hosted 0. Checkpoint 26; Series untouched.
  - **Debt.** The gateway reads through the owner database connection until a least-privilege resolver exists. The entitled token issuer is E2.
  - Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "E1.2".
- E1.2A media gateway database least privilege (2026-09-28): **PASS.** This closes the E1.2 database-credential debt.
  - **Migration 12,** `20260927210453_media_gateway_least_privilege.sql`, is deployed (hosted has 12, and the function body is MD5-identical to local).
  - **Role.** `velora_media_gateway` is NOINHERIT with no attributes or memberships. Its login and password are operator configuration, set as a SCRAM verifier, never SQL history.
  - **Resolver.** The unexposed `media_gateway.resolve_movie_version(bigint)` is SECURITY DEFINER with an empty `search_path`, enforces the publication rule, and returns exactly five transport fields. Only that role can execute it.
  - **Gateway.** It accepts only that identity, with no owner fallback, and readiness re-verifies it.
  - **Live proof as the role on hosted.**
    - On The Hunt resolves; Fuze and unknown ids return nothing.
    - 23 prohibited reads, writes, commands, DDL and role switches are all refused with 42501.
    - The Data API does not offer the resolver (PGRST202/PGRST106).
  - **Residual.** The role can create session-temporary tables, through PostgreSQL's `PUBLIC` TEMP grant.
  - **Tests.** 66 pgTAP and 22 integration tests; 17 of 20 database mutants killed, and the 3 survivors are equivalent to schema constraints.
  - **External writes.** Telegram reads and writes 0. Hosted writes: the migration and the login step only. Catalogue unchanged, checkpoint 26, Series untouched.
  - Record: `docs/PHASE_C_INGESTION_DESIGN.md`, "E1.2A".
- E2 entitlement and stream capability issuing (2026-09-30): **PASS.**
  - **Access policy (product decision, 2026-09-30).** Until Phase F, every signed-in user may stream published movies; signed-out users are denied. It lives only in `hasStreamingEntitlement`, which Phase F replaces with the subscription check.
  - **Boundary.** `canStreamMovieVersion` checks id, then session, then entitlement, then catalogue. Eligibility reuses the public read contract (a ready version always has media), so no migration was needed.
  - **Endpoint.** `POST /api/media/stream-token` takes `{ movieVersionId }` only, uses the Supabase session, and returns `{ streamUrl, expiresAt }` with `no-store`. Every unplayable version gets the same 404. Same-origin, JSON, a 256-byte body limit, a strict schema, and 30 requests per user per minute.
  - **Capability.** The E1.2 format and signer, unchanged. It is `op = stream` only, bound to version and user, and lasts 10 minutes. Renewal is the same request again, with no refresh token. The gateway origin is configuration only: HTTPS, or loopback HTTP outside production.
  - **Proofs.** The real gateway core accepts On The Hunt's capability. Download, another version, tampering and expiry are refused, with 0 media reads. Fuze has no version and gets no capability. The browser output contains no secret.
  - **External state.** Telegram reads and writes 0; hosted writes 0; catalogue unchanged, checkpoint 26. The obsolete GramJS session was deleted; the active mtcute session is untouched.
  - **Not built.** The player (E3). Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E2".
- E3 real movie playback (2026-09-30): **BLOCKED — MEDIA COMPATIBILITY.**
  - **Built.** A reusable native-`<video>` `MoviePlayer` on `/movies/[slug]`: Play requests the E2 capability, with in-place renewal that is safe under clock skew, and it cleans up on close and navigation. Signed-out Play gets the existing sign-in prompt and never reaches the gateway. Versions come from the catalogue, with a VJ choice when there are several.
  - **Chrome 153** plays the original MKV fully: 1920×1080, 5208 s, video and audio decode, seeks to 30:00 and 81:40 resume. Renewal was proven live, delivery is bounded (8 MiB responses), and nothing private reaches the browser.
  - **Firefox (Playwright Gecko 155)** decodes the video but not the MP3-in-Matroska audio, so it plays silently. **Playwright WebKit** never loads metadata. **Safari: NOT TESTED.**
  - **Evidence for the next step.** Video re-encoding looks unnecessary. Try first a container-only remux to MP4 keeping the MP3, which Gecko reports "probably"; next, MP3 → AAC. Nothing was transformed.
  - **External state.** Telegram writes 0; about 0.35 GB of bounded reads; hosted catalogue writes 0; the throwaway auth user was deleted. Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3".
- E3.1 browser-compatible packaging proof (2026-09-30): **PASS — MP4 REMUX ONLY.**
  - **Change.** `ffmpeg -c copy -movflags +faststart` moves both streams unchanged from the MKV into a fast-start MP4. It takes about 4 s, uses no encoding, and adds 0.30% (1,007,441,962 bytes).
  - **Identity.** The H.264 packets, Annex B stream, SPS/PPS and all 124,997 packets are byte-identical to the source; so are all 199,380 MP3 packets.
  - **Browsers.** Chrome 153 and Playwright Gecko 155 both decode video **and** audio, and seek to 15:00, 30:00 and 81:40. Delivery is bounded: 8 MiB 206 windows, metadata within the first 8–16 MiB, no full-file request, nothing fetched while paused. Playwright WebKit (Windows) reads the metadata but decodes no H.264 or audio (engine build), so AAC was not justified and was not created. **Safari: NOT TESTED.**
  - **Open.** Safari MP3-in-MP4 needs a real-device check, and MSE or HLS would need AAC.
  - **External state.** Telegram and hosted reads and writes 0; nothing uploaded; the derivative was deleted. Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.1". Where the derivative lives is the next checkpoint's decision.
- E3.2 production media architecture (2026-09-30): **DECIDED — Hybrid B-prime. Superseded by E3.2A: deferred, not implemented; the research is kept as the future scaling path.**
  - **Playback** comes from a private **Cloudflare R2** bucket: one browser-canonical fast-start MP4 per version, through 10-minute presigned GETs issued by the unchanged E2 boundary (`{ streamUrl, expiresAt }`, same player).
  - **Local masters are authoritative.** **Telegram** keeps the original only as an **archive** (existing C2 uploader, off the playback path).
  - The **Media Gateway** leaves production playback. Its reader is kept for archive restore and as a fallback.
  - **Evidence** (researched 2026-09-30):
    - R2 has free egress and $0.015/GB-month, and Cloudflare's network includes a Kampala PoP. At 1,000 × 1 GB that is about $15–51/month from 1 to 100 TB, against B2 at $7–977, Bunny Africa at $70–6,010, and Wasabi, whose egress policy excludes it.
    - The gateway is cheapest at ≤ 20 TB but puts every byte on Velora infrastructure and on Telegram's untested throughput and unaddressed terms.
  - **Trade-off.** Publication withdrawal takes effect at the next renewal (≤ 10 min) instead of per request; deleting the object is the immediate lever.
  - **Ingestion policy.** Classes 1–5: none / remux / AAC audio only / stop / review, with the E3.1 identity check after every copy.
  - **Next:** the E3.3 one-object R2 playback proof (never run; superseded by E3.2A). No storage was created; nothing changed externally. Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.2".
- E3.2A architecture reconciliation (2026-09-30): **PASS.** There is one active production playback architecture: **Telegram + Media Gateway**.
  - **Path.** Local master (authoritative) → inspect and normalize → browser-ready fast-start MP4 → existing C2 uploader → Telegram Movies channel → dedicated MTProto reader → Media Gateway → HTTP 206 → native `<video>`.
  - **Authorization.** E2 is unchanged: entitlement, catalogue eligibility, and a 10-minute stream-only capability.
  - **Why.** E3 and E3.1 showed a packaging defect (MP3 in Matroska for Firefox), fixed by a lossless remux, not a storage defect. B-prime (R2) is deferred.
  - **Scaling.** The gateway stays in the byte path. Telegram throughput, gateway bandwidth and Telegram dependence are recorded as scaling risks, not demonstrated blockers. E3.2's R2 research is the migration path if they become material.
  - **Boundary.** The player sees only `{ streamUrl, expiresAt }`, so an origin change never touches the player.
  - **Ingestion.** Normalization classes 1–5 are active: none, remux (stream copy with an identity check), audio only (not built), stop, and review.
  - **Safari/iOS.** Not tested; a real Apple-device test is a pre-launch gate.
  - **Not introduced:** R2, HLS and player libraries. Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.2A".
- E3.3 Telegram MP4 playback proof (2026-09-30): **PASS.** On The Hunt now plays from a fast-start MP4 in the Telegram Movies channel.
  - **Normalization.** Class 2 remux with stream copy only. H.264 and MP3 are packet-identical to the source, `moov` precedes `mdat`, and the file is 1,007,441,962 bytes. The temporary derivative was deleted afterwards.
  - **Upload.** Exactly **1** `sendDocument`. The client got `uncertain` at 505 s, because the pinned Bot API hard-codes a 500 s idle timeout on HTTP connections (a new ingestion finding). It was not retried. The existing marker protocol recovered **message 27** (marker 28, checkpoint 28, attempt count 1).
  - **Cutover.** Before any database change, the real reader and gateway core read message 27 byte-equal to the local MP4 at the beginning, middle, tail and an unaligned range. One guarded owner transaction, rehearsed first with ROLLBACK, then moved version 1 from media 1 (MKV, message 23) to media 3 (MP4). No migration was needed. A rollback script is ready.
  - **Gateway fix.** The reader's document cache is now keyed by the full locator identity, so a warm gateway can never serve the replaced file's bytes after a cutover.
  - **Browsers.** Chrome 154 and Firefox 155 (Gecko) both play video and audio (Gecko Web Audio RMS 0.323) and seek to 15:00, 30:00 and 81:40. Metadata needs only `bytes=0-`, with no tail fetch. Every response was 206 `video/mp4` and ≤ 8 MiB, with 0 full-file requests and 0 reads while paused. Close and navigation stop all activity.
  - **E2.** Renewal made exactly 1 issuer call with position preserved and no loop. Signed-out access is blocked. All negative-security cases were denied with 0 Telegram reads, and nothing private reached the browser or the logs.
  - **Resources.** Gateway peak 74.3 MiB of its 256 MiB cap.
  - **External state.** Telegram Movies writes: 1 document and 1 marker, plus 1 forward and 1 delete in the recovery group. Series 0. Hosted: 0 migrations and 1 cutover. The old MKV is retained and unlinked; Fuze is unchanged. Throwaway auth users were created and deleted.
  - **Next:** the real Safari/iOS device test (a pre-launch gate), then roadmap E3 progress persistence (bounded, throttled, idempotent writes). Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.3".
- E3.4 gateway recovery and player error classification (2026-10-01): **PASS.**
  - **Cause.** "This movie can't be played in this browser." on On The Hunt came from a stopped media gateway, not the media. Chrome and Firefox report `MediaError` 4 for a refused connection, any HTTP error status and undecodable bytes alike, and the player mapped 4 to "unsupported".
  - **Fix.** An error before metadata is now diagnosed with at most two bounded requests straight to the gateway (a two-byte read of the stream URL, then a no-cors `/healthz`). "Unsupported" now requires the gateway to be serving the file. Unreachable, 5xx and 429 show "temporarily unavailable", 404 "isn't available", 401 gets one renewal, and anything unknown gets a neutral "Playback failed". There is no new automatic retry.
  - **Startup.** `npm run gateway:dev` runs the existing image from `.env.local`, passing only gateway variables and never a login token, and waits for readiness. `next dev` warns when the gateway is down. The README documents the two commands.
  - **Proof.** Started from a stopped machine. The restricted role resolves version 1 to the E3.3 MP4 (message 27). Chrome and Firefox play with video, audio and a seek to 30:00, all responses 206 ≤ 8 MiB.
  - **External state.** Telegram writes 0, Series 0, hosted writes 0, persistent auth writes 0; nothing re-uploaded or remapped.
  - **Open.** Set `MEDIA_GATEWAY_ALLOWED_ORIGINS` on the deployed gateway; Safari and iOS are still the pre-launch gate. Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.4".
- E3.5 production media normalization and automated movie ingestion (2026-10-01): **PASS.** This is the bridge from proven single-movie playback to repeatable production ingestion.
  - **Inspection.** `scan` inspects every file with ffprobe and the MP4 box headers, never by its extension, and classifies it deterministically (`lib/ingestion/media.ts`): canonical, remux, audio_normalization, video_transcode_required, manual_review.
  - **Upload gate.** Only canonical bytes are planned for upload, and `uploadEntry` refuses anything else (`media_not_verified`).
  - **Class 2.** `ingest normalize` repackages by stream copy only into a fast-start MP4 under `.velora-renditions` (inside the Bot API path map). It proves every video and audio packet and the codec configuration identical and the source unchanged, then journals the rendition as its own entry, so the existing exactly-once upload and recovery apply unchanged. `cleanup` deletes a derivative only when that is safe.
  - **Classes 3–5** stop with reasons. There is no audio or video transcoding; MP3 stays approved, and Safari/iOS remains the pre-launch gate.
  - **Proof.** Re-running the pipeline on On The Hunt produced a file byte-identical to message 27 (SHA-256 `c475dcfc…`). The server recognizes its fingerprint as already uploaded (`adopt_server`), so it is never sent again. The derivative was deleted.
  - **Library classification** (read-only): 7 remux, 1 HEVC (transcode required), 6 cover-art MP4s (manual review), 0 canonical.
  - **External state.** Telegram writes 0, hosted writes 0, Series untouched; On The Hunt plays unchanged in Chrome and Firefox.
  - **Next.** Production Media Gateway hosting and deployment. The operator's plan names it E4, but the E4 work item below is series continuity, so the numbering needs a decision.
  - Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.5".
- E3.6 multi-stream media selection and library readiness (2026-10-02): **PASS.**
  - **Numbering (decided).** E4 keeps its meaning, series continuity (below). Movie production and ingestion checkpoints continue as E3.x. Gateway hosting will get an E3.x number when it is scheduled.
  - **Covers.** The six E3.5 cover-art MP4s carry a 500×500 MJPEG that ffprobe flags `attached_pic` (1 packet). It is an iTunes `covr` metadata atom, not a track: each file has exactly two `trak` boxes.
  - **Selection** (`selectPlaybackStreams`, policy v2) works from stream meaning, never position.
    - The film is the one video stream not flagged as cover art.
    - The flag is trusted only together with a still-image codec.
    - Two motion-video or two audio streams stay `manual_review`.
  - **Class 2** maps the selected streams by index (`-map 0:<n>`, not `0:v:0`, which can be the cover). Verified cover art is left out of the rendition, so a file with a cover is `remux`, never canonical. Packet identity follows the selected streams. The local master keeps its artwork.
  - **Proof.** On The Hunt re-normalized byte-identical to message 27 (`adopt_server`). Synthetic fixtures cover the cover first, the audio first, two video streams and two audio streams.
  - **Library (read-only, 14 files).**
    - Classes: 12 remux, 2 HEVC (`video_transcode_required`; Desert Warrior was hidden by the E3.5 cover stop), 0 manual review, 0 canonical.
    - **9 ready after stream copy** (7 new titles, plus On The Hunt (live) and Fuze (replacement decision)).
    - **5 blocked**: 3 over the 2000 MiB ceiling, 2 HEVC.
  - **External state.** Telegram writes 0, Series 0, hosted writes 0; the library is unchanged.
  - **Next:** E3.7, controlled batch normalization and Telegram ingestion of the 7 new titles, one at a time (not started).
  - Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.6".
- E3.7 controlled batch movie ingestion, Call of Heroes canary (2026-10-07): **BLOCKED — TELEGRAM UPLOAD TRANSPORT STALL.**
  - **Before any Telegram write.** E3.6 was pushed (`a885b73`). The library rescan equalled E3.6. Bot API, Movies bot identity, channel and server preflight all passed.
  - **Normalization.** Class 2 stream copy, cover art left out. 172,374 video and 274,947 audio packets identical. Rendition `sf1-2957a6d8…`: 1,917,405,700 B, fast-start, H.264 + MP3 only.
  - **Upload.** Exactly **1** `sendDocument`. It was `uncertain` at 516 s (the Bot API's 500 s idle timeout) and was not retried. The detached Bot API upload then ran at about 0.5 MB/s and **stalled for good at about 61%** (1.16 GB). This is new: E3.3's detached upload had completed.
  - **Recovery.** The existing marker protocol inspected ids 29–38 completely with no match: `wait` inside the 3 h grace period, then `abandon` after it.
  - **Event 4** is `upload_failed` / `verified_absent`, attempt 1, no media. The checkpoint went from 28 to 39 (marker 39).
  - **External state.** Telegram movie documents 0, duplicates 0. Catalogue, rights and Series writes 0. On The Hunt and Fuze unchanged; the other six titles not started.
  - **Local.** The rendition was retained, and `cleanup` was not run. The `G:` library drive then disconnected, so verify the rendition (SHA-256 `7131620845cc…`) on reconnect.
  - **Next:** E3.7A, the Telegram upload transport investigation. It covers throughput, the stall's cause, and the client idle timeout. Then a separately authorized Call of Heroes attempt.
  - Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.7".
- E3.7A Telegram large-upload transport investigation (2026-10-09): **INVESTIGATION COMPLETE — PRODUCTION RELIABILITY UNPROVEN.**
  - **Integrity.** G: is accessible again: Disk 3, USB-connected Verbatim SSD. Source sf1/size/mtime match. Retained rendition SHA-256 exactly matches `7131620845cc2d5563e27a4e085e8f91331e85d744105aae2ba14ebdff38084c`.
  - **Evidence.** USB storage resets at 20:32:33Z and 20:33:53Z coincide with the outbound plateau; Disk 3 I/O errors followed recovery. An Ethernet disconnect occurred earlier, at 19:57:47Z. Whether TDLib was still reading G: at the plateau remains unknown; no confirmed upload root cause.
  - **Timeout.** Node's deadline was four hours; the pinned Bot API has a 500-second HTTP idle boundary. Post-disconnect traffic continued. The approximate 61% figure was an interface counter, not an exact file offset. No speculative timeout increase or uploader replacement.
  - **Validation.** Two added loopback boundary tests; transport/recovery 227 passed. Full suite rerun: 731 passed, 27 skipped. Typecheck, tracked-code lint and production build passed; literal lint has pre-existing errors in ignored operational scripts. Docker daemon unavailable, so live mount/restart and TDLib file-read faults remain untested.
  - **External state.** Telegram reads/writes 0; hosted investigation reads/writes 0 (historical snapshots only). Build uses existing anonymous catalogue reads; exact count unmeasured. No ingestion/publication writes, movie copy, normalization or recovery operation.
  - **Next.** Approved isolated Docker startup and network-disabled read-only synthetic mount probe, compare G: with internal storage. Any real Telegram synthetic write or movie retry needs separate authorization. Local staging of the retained rendition remains a proposal requiring an approved plan.
  - Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.7A".
- E3.7B isolated storage and Docker mount reliability (2026-10-09): **PASS — ISOLATED STORAGE DIAGNOSTICS COMPLETE. PRODUCTION TELEGRAM UPLOAD RELIABILITY: UNPROVEN.**
  - **Safety/integrity.** Reused retained source/rendition verification and successful read evidence. Disposable containers used local images, network none, no credentials/state, read-only synthetic mounts. Production Bot API was already running before inventory; unchanged throughout. Source/rendition preserved; no new storage errors observed.
  - **Comparisons.** Native and Docker internal/USB reads: matching 1 MiB hashes, zero errors. Added one bounded directory-mount check per location to close the earlier file-bind gap; both rejected write-open with EROFS. Cached timing/throughput measurements are not sustained disk benchmarks.
  - **Faults.** Six new tests cover injected cancellation/EIO/timeout/short reads and native synthetic disappearance/truncation. Isolated internal-only container killed after 64 KiB, restarted, then recovered the full expected hash. No physical USB fault induced or historical cause proved.
  - **Staging proposal.** Internal SSD had 72.97 GiB free; conservative one-file budget plus 2 GiB reserve is 4.372 GB. Existing journal/fingerprint/path-map/checkpoint infrastructure can support verified atomic staging with unchanged exactly-once identity; no staging implementation or movie copy.
  - **Validation.** Full default-timeout suite: 736 passed, one pre-existing CLI timeout, 27 skipped. That CLI test passed alone unchanged. Typecheck/tracked lint passed; production build not run because it would use external font/catalogue access. No database mutation gates applicable.
  - **External state / next.** Task-issued Telegram and hosted database reads/writes 0. Review evidence and staging design, then separately authorize implementation or a synthetic transport experiment. Movie retry remains unauthorized.
  - Record: `docs/PHASE_E_PLAYBACK_DESIGN.md`, "E3.7B"; primary local evidence `.velora-ingest/e3.7b/REPORT.md`.
- Database regression suite: `npm run test:db` (local only).

## 2. Product and data rules

- Supabase determines what Velora UG offers.
- Telegram is the private media origin.
- TMDB enriches ingested/approved records only; it never creates the public catalogue by itself.
- VJs are first-class database entities.
- Movies and series are separate roots; series normalize into seasons and episodes.
- Browser code never receives Telegram/channel/payment/service-role/database secrets.
- Supabase auth remains. Ownership and entitlement are server/database enforced.
- Plans and prices are database-driven; payment success is provider-verified and reconciled.
- Reuse existing components and boundaries before adding new ones.

## 3. Phase overview

| Phase | Focus | Milestone |
| --- | --- | --- |
| A | Migration/Foundation | Reconciled, branded, theme-ready baseline |
| B | Catalogue Domain | Supabase-owned VJ/movie/series catalogue |
| C | Telegram Ingestion | Idempotent bots, matching, review states |
| D | Discovery UI | Database-driven public Velora UG |
| E | Playback + History | Secure playback and resume flows |
| F | Subscription + Mobile Money | Verified entitlements and collections |
| G | Production/PWA | Operable, tested production release |

Do not mix phases into one uncontrolled change set. Audit each phase before starting the next.

# Phase A — Migration/Foundation

## Objective

Establish a trustworthy repository/database baseline, migrate product identity, and add theme foundations without changing catalogue behavior yet.

## Work

### A1. Reconcile Phase 3 and live schema

- Compare `main`, `origin/phase3-discover`, live migration history, and live schema.
- Preserve Phase 3 Discover/search history/analytics unless explicitly superseded.
- Merge/rebase as a reviewed change; never recreate its live migration under a new version.
- Schedule and verify bounded search-event retention before public release.
- Re-run Phase 1–3 regressions.

### A2. Approve domain decisions

- Decide whether one TMDB title may have multiple entries for different VJs.
- Approve internal ID/slug strategy and legacy redirects.
- Approve watchlist handling for unavailable/ambiguous legacy items.
- Confirm content rights and trusted admin/reviewer authorization.
- Decision record: `docs/VELORA_UG_SCHEMA_BASELINE.md`.
- First migration: `20260922080911_velora_ug_catalogue_baseline.sql`.

### A3. Brand migration

- Update product-facing metadata, headings, auth/account copy, accessible labels, logo/footer, and relevant docs to Velora UG.
- Do not rename repository/package/database schema/directories/environment keys without need.
- Keep TMDB attribution wherever its metadata/artwork is used.
- Implemented product-facing identity: Velora UG metadata, accessible branding,
  home/auth copy, and logo treatment; internal package/storage names remain
  unchanged.

### A4. Theme foundation

- Extend semantic tokens for deliberate light and dark themes.
- Implement persisted `system | light | dark` with pre-paint initialization and accessible settings control.
- Test contrast, focus, motion, artwork, skeletons, and forms in both themes.
- Add no theme dependency unless platform features prove insufficient.
- Implemented with semantic CSS tokens, a pre-paint initializer, and one native
  footer control persisted as `system | light | dark`.

### A5. Environment/documentation cleanup

- Remove duplicate `.env.example` entries and add only variables consumed by Phase A.
- Update README/CLAUDE after behavior/branding land.
- Preserve server-only naming and production checks.
- Implemented 2026-09-24: `.env.example` reduced to the variables the app reads, plus
  the migration-tooling `DATABASE_URL`. README and CLAUDE describe Velora UG's
  current and planned architecture.

## Acceptance criteria

- Git and live migration history agree; no applied migration is absent from the chosen branch.
- Search retention is verified, or analytics writing remains disabled.
- Lint, typecheck, build, auth, watchlist, search, and responsive checks pass.
- Product identity is Velora UG without risky internal renames.
- Light/dark/system persist without wrong-theme flash and meet contrast requirements.
- Existing catalogue behavior remains until deliberately replaced.

# Phase B — Catalogue Domain

## Objective

Create the normalized Supabase source of truth for VJs, available movies, series, seasons, episodes, genres, Telegram references, and review state.

## Work

### B1. Migration design and verification

- Resolve schema workflow from the reconciled repository.
- Create migrations through the Supabase CLI workflow; do not invent history around live objects.
- Add PKs, FKs, unique/check constraints, timestamps, indexes, grants, and RLS.
- Public policies read published rows only; raw/provider tables have no client access.
- Run advisors and adversarial RLS tests.

### B2. Catalogue entities

- Add VJs, movies, series, seasons, episodes, normalized genres/joins, Telegram media, ingestion events, and match-review records.
- Store approved TMDB snapshots/sync timestamps locally.
- Keep drafts, ambiguous, rejected, and unavailable records non-public.

### B3. Catalogue data layer

- Add server-only query modules returning framework-independent domain types.
- Support published lists, featured/latest/popular, VJ, genre, details, seasons, and episodes.
- Use deterministic keyset pagination as data grows.
- Never expose Telegram identifiers in public shapes.

### B4. Watchlist compatibility

- Add internal movie/series references alongside legacy TMDB references.
- Backfill only unambiguous approved mappings; report exceptions.
- Support both formats without losing guest/account data.
- Stop legacy writes first; remove legacy columns only later after verification.

### B5. TMDB boundary

- Retain centralized server TMDB access for admin matching and refresh.
- Remove TMDB from ordinary catalogue read paths.
- Disable sample catalogue in production.

## Acceptance criteria

- Constraints prevent orphan seasons/episodes, duplicate deliveries, invalid workflows, and cross-user access.
- Common FKs/RLS filters have appropriate indexes.
- Public roles see only active VJs and published, ready content.
- Draft/ingestion/payment/Telegram rows have no unintended client grants.
- Existing watchlists survive and unresolved rows remain removable.
- Normal home/browse/detail/watchlist renders make zero TMDB calls.
- Migrations, database types, advisors, lint, typecheck, and build pass.

# Phase C — Telegram Ingestion

## Objective

Ingest movie/series channel posts through separate bots, attach normalized records, enrich metadata, and route ambiguity to review.

## Work

### C1. Server boundary

- Add typed server-only Telegram transport/validation.
- Configure separate movie/series tokens, channel IDs, and webhook secrets.
- Add POST routes with body limits, strict schemas, secret checks, and channel allow-lists.

### C2. Idempotent persistence

- Deduplicate by bot/update and bot/chat/message.
- Store both Telegram file IDs plus filenames/captions/sizes and safe metadata.
- Acknowledge after durable recording; make retries/reprocessing safe.

### C3. Parsing and review

- Parse title/year/VJ and series/season/episode as suggestions.
- Resolve VJs from database data, not hardcoded reusable logic.
- Unknown/conflicting parses enter `needs_review`.
- Provide minimal audited correction operations.

### C4. TMDB matching

- Search only for existing ingestion/draft records.
- Score multiple signals and record reasons.
- Auto-match only clear high-confidence candidates; never auto-publish ambiguity.
- Store metadata locally and publish transactionally only when ready.

### C5. Operations

- Add authenticated/internal replay and reconciliation.
- Redact logs and retain raw payloads only as justified.
- Monitor failures, review backlog, and parser regressions.

## Acceptance criteria

- Movie and series credentials/updates cannot cross channels.
- Bad secrets/channels/bodies/schemas/media fail safely.
- Concurrent/replayed updates produce one durable result.
- Ambiguous TMDB/VJ/episode matches cannot become public.
- Corrections are audited and reprocessing is idempotent.
- Tokens/private IDs are absent from client code, responses, and logs.
- Failure, empty, pending, review, rejected, and published states are tested.

# Phase D — Velora UG Discovery UI

## Objective

Replace TMDB-first discovery with polished database-driven Movies, Series, VJs, and Search using the existing UI system.

## Work

### D1. Information architecture

- Desktop: Home, Search, Movies, Series, VJs, My List, History, Account/Settings.
- Mobile: Home, Search, Movies, Series, Library/Profile.
- Fix existing 768–960 px header compression instead of cramming more labels.
- Redirect deprecated `/tv`, `/trending`, and legacy details.

### D2. Posters and VJs

- Extend existing card/image composition with reusable top-left `VjBadge`.
- Use database names/variants and semantic tokens.
- Preserve lazy/responsive images, fallbacks, touch, and keyboard access.

### D3. Home

- Featured, Continue Watching, Latest Movies/Episodes, Popular Movies/Series, VJs, Recently Added, and database genre rows.
- Render only useful non-empty sections and available records.
- Preserve independent streaming boundaries where beneficial.

### D4. Movies and Series

- Responsive grids; URL VJ/genre/sort filters; keyset pagination; complete async states.
- Series details expose normalized seasons/episodes and next-episode relationships.
- Mobile filters use compact accessible controls.

### D5. VJs and search

- VJ index/detail with movie/series sections.
- Search published movies, series, and VJs in Postgres.
- Adapt Phase 3 search history/analytics scopes and retention.
- Keep TMDB search admin-only.

### D6. SEO

- Local metadata drives title/description/canonical/Open Graph.
- Published details are indexable; filter pages get intentional canonical/index rules.
- Unpublished records never leak through metadata.

## Acceptance criteria

- Public pages contain only published/available Supabase catalogue content.
- Relevant posters carry readable overlays without modified artwork.
- Filters survive refresh/back/forward and have canonical URL state.
- Search returns movies/series/VJs, never unavailable TMDB titles.
- 360, 390, 430, 768, 1024, and 1280+ layouts have no overflow and have touch targets.
- Keyboard/headings/labels/focus/contrast/motion/async states pass.
- Auth, guest/account watchlists, guest merge, search history, and themes regressions pass.
- Image/client-bundle budgets do not regress without justification.

# Phase E — Playback + History

## Objective

Deliver entitled Telegram-backed media securely and add resume, Continue Watching, History, and next episode.

## Work

### E1. Delivery spike (blocks player work)

- Measure real file sizes/codecs and verify the authorized Telegram path.
- Test byte ranges, seeking, throughput, concurrency, token refresh, and hosting limits.
- Compare hosted/local Bot API or another permitted server delivery gateway.
- Document cost, failure, legal/terms, and rollback.

### E2. Playback authorization

- Issue short-lived server playback sessions only for published media and entitled users.
- Never expose bot credentials/permanent private URLs.
- Add rate/abuse controls and safe cache headers.

### E3. Player and progress

- Build a lightweight accessible player with mobile-data awareness.
- Persist progress through bounded/throttled idempotent writes.
- Define completion and restart.

### E4. Series continuity

- Resolve next episode from normalized order.
- Persist autoplay-next setting and handle missing next episodes.

### E5. Continue Watching and History

- Derive own-user rows from progress/history.
- Provide RLS-protected clear/remove controls.
- Keep these distinct from My List.

## Acceptance criteria

- Spike proves secure seek/range playback for representative feature-length files.
- Unauthenticated/unentitled/unpublished/expired/cross-user/tampered requests cannot play.
- Network/browser output contains no bot or privileged keys.
- Resume survives sessions/devices without write flooding.
- Continue Watching, History, completion, restart, next episode, and autoplay work on mobile/desktop.
- Loading, expired, missing, network-error, and recovery states work.

# Phase F — Subscription + Mobile Money

## Objective

Add database plans, server-derived entitlement, MTN/Airtel collection, verified callbacks, and reconciliation.

## Work

### F1. Plans and subscriptions

- Add active/sorted UGX plans without inventing final prices.
- Add subscription terms/state snapshots and server entitlement service.
- Define renewal/cancellation/expiry/revocation/refund/device semantics before UI claims them.

### F2. Provider-neutral service

- Typed provider interface and server-side validation/phone normalization.
- Load plan/amount/currency server-side.
- Persist pending before remote initiation.
- Enforce immutable references, user idempotency, transitions, and redaction.

### F3. MTN MoMo

- Sandbox OAuth, RequestToPay, callback, status polling, error mapping.
- Treat asynchronous acceptance as pending.
- Reconcile because callbacks may be sent once only.

### F4. Airtel Money

- Obtain official Uganda merchant documentation/sandbox access first.
- Implement only documented auth, collection, callback verification, and status behavior.
- Never use unofficial examples as the contract.

### F5. Verification and activation

- Persist/deduplicate events and prevent replay.
- Verify server-side, lock terminal transitions, activate/extend transactionally.
- Add protected reconciliation and runbooks.

### F6. UX

- Plans, provider selection, Uganda phone input, pending/failure/success, subscription summary, payment history.
- Explain phone approval and that pending is not success.

## Acceptance criteria

- Prices/durations/currency/entitlement are server-derived.
- Browser tampering with plan/amount/user/reference/success has no authority.
- Duplicate initiation/callback/reconciliation never double-extends.
- MTN sandbox covers initiation, missed callback polling, success/rejection/expiry/failure.
- Airtel requires official Uganda contract tests and sandbox evidence before enablement.
- Only verified success activates access.
- RLS/two-user tests, limits, secret scans, redaction, lint, typecheck, build, and E2E pass.

# Phase G — Production/PWA

## Objective

Make Velora UG installable, observable, maintainable, secure, and production-ready.

## Work

### G1. Lightweight admin

- Pending ingestion, metadata review, published/rejected, VJs, series mapping, payments, subscriptions.
- Reuse domain services; do not build a giant CMS.
- Audit privileged actions and use trusted admin authorization.

### G2. Testing and CI

- Add Vitest/RTL where useful and Playwright for critical flows.
- Cover parser/idempotency, catalogue/RLS, auth/watchlist, discovery, playback, and payment machines.
- CI: clean install, lint, typecheck, tests, build, migration checks.

### G3. Observability and operations

- Sentry, structured redacted logs, operational dashboards/alerts.
- PostHog only for approved minimal analytics.
- Verify retention, backups/restore, rollback, provider reconciliation, and incidents.

### G4. Security and performance

- Rate-limit risky/expensive/provider endpoints.
- Run advisors, RLS/dependency/secret/CSP/callback/replay reviews.
- Measure Web Vitals, latency, queries, imagery, playback start, JS, and mobile data.

### G5. PWA/mobile readiness

- Manifest, production icons, install UX, safe areas, theme colors, graceful offline shell.
- Cache only safe static/public resources, never auth/payment/playback/entitlement secrets.
- Keep types/validation/contracts/business logic Expo-ready without premature monorepo conversion.

### G6. Launch

- Provider production onboarding/callback allow-lists.
- Legal approval for content, privacy, terms, subscriptions, refunds, and Uganda payments.
- Staged release, monitoring, rollback, support, and reconciliation ownership.

## Acceptance criteria

- Critical E2E flows pass in CI/staging.
- No high-severity security/RLS/advisor issue remains.
- Retention/reconciliation/backups/restore/alerts/rollback/incidents are tested.
- PWA works without caching sensitive responses.
- Accessibility and real-device/browser checks cover representative layouts.
- Catalogue/playback performance budgets pass.
- Legal/content/provider approvals and operational owners are recorded.

## Cross-phase engineering gates

Every phase must:

1. Inspect and reuse before creating.
2. Keep Server Components default and client boundaries narrow.
3. Add no dependency unless platform/existing packages cannot solve the need.
4. Validate external input and keep secrets server-side.
5. Handle loading, success, empty, and error states.
6. Verify RLS/grants independently of UI authorization.
7. Preserve mobile/touch/accessibility/image performance.
8. Run relevant lint, typecheck, tests, build, advisors, and diff review.
9. Document migrations, environment changes, operations, and debt.
10. Stop at the phase boundary.

## Dependency policy

- Current dependencies cover Next.js, React, Supabase, Zod, Tailwind, and icons.
- Prefer native fetch/crypto, server modules, CSS, and browser APIs for Telegram, payments, theme, and UI.
- Add testing packages with automated tests; Redis only when a concrete coordination/abuse need exists.
- No Redux, GraphQL, alternate UI framework, heavy animation library, or speculative service layer.

## Architecture guardrails

```text
UI / routes
  -> domain services and validation
    -> catalogue / auth / payment / Telegram boundaries
      -> Supabase, TMDB enrichment, Telegram, payment providers
```

- Components consume Velora UG domain types, never raw provider payloads.
- TMDB/Telegram/payment shapes stay at their adapters.
- Catalogue/entitlement logic remains portable to a future Expo client.
- Public reads are published-only; privileged writes use narrow audited server paths.
- Preserve deliberate restrictions when regenerating database types.
- Prefer the simplest solution satisfying correctness, security, performance, and migration safety.
