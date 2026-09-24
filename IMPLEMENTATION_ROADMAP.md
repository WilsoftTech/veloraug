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
