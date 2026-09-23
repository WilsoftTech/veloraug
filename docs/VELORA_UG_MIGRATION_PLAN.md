# Velora UG Migration Plan

Status: planning checkpoint only  
Prepared: 2026-09-22  
Baseline: `main` at `313e621`

This audit plans the controlled migration of the existing Velora discovery app into Velora UG, a database-driven Ugandan VJ-translated streaming platform. It does not apply migrations, add provider routes, or rewrite the application.

## Executive decisions

1. Supabase becomes the public catalogue source of truth. TMDB only enriches records already ingested or approved.
2. Existing auth, profiles, guest/account watchlists, RLS, UI primitives, async states, and semantic tokens stay.
3. Movies and series are separate roots; series normalize into seasons and episodes. Telegram media is stored once and linked without polymorphic foreign keys.
4. Telegram ingestion and playback are separate. Secure delivery of feature-length files requires a spike before player work.
5. Entitlement is server-derived from verified subscription/payment records. No client boolean is authoritative.
6. Payments are persisted before remote initiation, idempotent, callback-audited, reconciled, and server-only.
7. Theme support extends the semantic variables with `system`, `light`, and `dark` without a new dependency by default.
8. The first gate is repository/schema reconciliation: Phase 3 exists on `origin/phase3-discover`, not `main`, while its audit says its migration is already live.

## 1. Current architecture summary

### Application

- Next.js 16.3.5 App Router, React 19.2.8, strict TypeScript, Tailwind CSS 4, Zod 4, Lucide.
- Server Components render pages/data. Client islands are limited to interactive carousel, search, auth, session/watchlist, retry, and trailer behavior.
- Routes on `main`: `/`, `/movies`, `/tv`, `/trending`, `/search`, `/my-list`, `/account`, auth routes, and `/[mediaType]/[id]`.
- Home/browse/search/detail currently call TMDB popular, top-rated, trending, search, detail, and similar endpoints. A sample catalogue is used without TMDB credentials.
- Reusable UI includes `MovieCard`, `MovieGrid`, `MovieSection`, `MovieListItem`, `MediaImage`, `Hero`, `BrowsePage`, skeletons, `EmptyState`, and `RetryButton`.
- `app/globals.css` now provides persisted `system | light | dark` semantic themes with a pre-paint initializer.

### Auth and personal data

- Supabase SSR uses the publishable key. Browser/request clients are separated; `getClaims()` verifies server identity; RLS is authoritative.
- `proxy.ts` refreshes sessions narrowly for account/sign-in/sign-up routes.
- `profiles` and `watchlist_items` are the only tables on `main`, with RLS and least-privilege grants.
- Guest My List uses `localStorage`; signed-in My List uses Server Actions. Guest import is idempotent and only clears local data after server success.
- Account watchlists store `(tmdb_id, media_type)` and resolve metadata from TMDB on every read.
- `database.types.ts` is deliberately hybrid/hand-restricted, not disposable generator output.

### Phase and migration state

- Phase 1 is complete on `main`: discovery UI, deep-blue tokens, reusable media UI, responsive/accessibility work, and audit.
- Phase 2 is complete on `main`: Supabase auth/profiles/watchlists, guest merge, RLS, and a race-safe 500-item cap.
- Phase 3 is four commits ahead on `origin/phase3-discover`: `/discover`, reusable pagination, search analytics/history, a migration, and its audit.
- That audit says `20260920181819_search_analytics_and_history.sql` was applied live and that search-event retention remains unscheduled—a release blocker.
- Before Velora UG SQL, reconcile the Phase 3 branch, local migrations, live migration history, and live schema. Never create a competing migration from `main` alone.

## 2. Existing functionality to KEEP

- Supabase email/password auth, profile trigger, account/session boundary, and redirect safety.
- Existing RLS style: explicit roles/grants, `(select auth.uid())`, `USING`/`WITH CHECK`, private helpers, empty function `search_path`, and revokes.
- Guest/signed-in watchlists, optimistic UI, cross-tab behavior, guest import, and concurrency-safe cap during migration.
- Phase 3 search history/privacy-preserving analytics after branch reconciliation and retention scheduling.
- Server Components first and narrow client islands.
- Existing card/grid/row/image/hero/browse/search/form/skeleton/error/empty primitives.
- Image sizing/lazy loading, YouTube facade, metadata patterns, accessibility, and touch behavior.
- Semantic token names and blue/sky identity as Velora UG's starting point.
- TMDB attribution and centralized TMDB client/mappers, limited to ingestion enrichment and approved refreshes.

## 3. Existing functionality to MODIFY

| Area | Change |
| --- | --- |
| Identity | Introduce internal catalogue IDs; TMDB IDs become nullable external mappings. |
| Public data | Replace TMDB lists/search/detail with published Supabase catalogue queries. |
| Watchlists | Add movie/series FKs, backfill unambiguous matches, support both formats temporarily. |
| Types/routes | Move to internal IDs/slugs and `movie | series`; keep TMDB `tv` only at its boundary; redirect legacy URLs. |
| Search | Search database movies, series, and VJs first; retain history/analytics concepts. |
| Home/browse | Render database-derived featured/latest/popular/genre/VJ sections only. |
| Posters | Extend one poster/card path with a reusable top-left VJ overlay. |
| Navigation | Desktop gains Search/Series/VJs/History/Settings; mobile uses five focused destinations. |
| Account | Compose profile, subscription, payments, security, appearance, and playback settings. |
| Theme | Add persisted system/light/dark semantic themes. |
| Metadata | Store approved TMDB snapshots locally; no TMDB dependency during normal renders. |
| Phase 3 | Reconcile and reuse URL/filter/search work, then replace its TMDB discovery source. |

## 4. Existing functionality to REMOVE or DEPRECATE

- Public TMDB trending/popular/top-rated/discover/search as catalogue truth.
- Production sample-catalogue fallback (development fixture only, explicitly gated).
- `/trending` as a TMDB route; replace/redirect after a database-derived equivalent exists.
- Public `tv` terminology where the product means series.
- TMDB-only watchlist identity after a verified compatibility period.
- Per-read TMDB hydration of saved items.
- Any implication that metadata alone means a title is playable.
- Direct browser access to Telegram IDs, provider payloads, privileged mutations, or secrets.

No removal occurs in Phase A. Deprecation requires data backfill, redirects, and regressions.

## 5. New domain entities

Catalogue: `vjs`, `movies`, `series`, `seasons`, `episodes`, `genres`, movie/series genre joins, `telegram_media`, `ingestion_events`, and preferably `metadata_match_candidates`.

Commerce/access: `subscription_plans`, `payments`, `payment_events`, `subscriptions`, and an optional entitlement audit log. Current entitlement is derived, not copied into a client flag.

Engagement: evolved `watchlist_items`, `playback_progress`, and `watch_history` only if event-level history is truly needed; retain Phase 3 search tables.

Administration starts with states and audit records. Authorization belongs in trusted app metadata or a dedicated membership table, never user-editable metadata.

## 6. Proposed Supabase schema changes

This is a logical design, not executable SQL. Exact migrations follow Phase 3/live reconciliation and disposable/local verification.

### Conventions

- Lowercase names; `bigint identity` for internal rows; UUID for `auth.users`; `timestamptz`; `numeric(12,2)` for UGX; `bigint` Telegram sizes.
- Text plus check constraints for workflow/provider states unless a stable enum is justified.
- Index every FK not already leading a PK/unique index. Match composite indexes to equality filters then cursor fields; use keyset pagination.
- Every `public` table gets RLS. Add explicit Data API grants because new Supabase tables may not be auto-exposed.
- Provider/ingestion/raw Telegram/audit tables get no client grants. Public views use `security_invoker = true`.
- Necessary `SECURITY DEFINER` functions use an empty `search_path`, explicit identity/role checks, narrow schemas, and revoked default execution.

### Catalogue

`vjs`: bigint PK, unique normalized slug, names, description/avatar, finite `badge_variant`, active/sort flags, timestamps. Public read active rows; writes server/admin only.

`movies`: canonical bigint PK and unique slug; publication and metadata state; local TMDB snapshot fields; sync timestamp; publish dates. TMDB ID is a nullable unique external mapping. Public reads later require a published title with a ready, rights-cleared movie version.

`movie_versions`: indexed movie/VJ FKs, optional VJ-specific title override, availability and rights state; unique `(movie_id, vj_id)`. Telegram media is attached in the ingestion phase.

`series`: canonical identity/workflow/metadata fields without a permanent VJ. TMDB ID is a nullable unique external mapping.

`seasons`: bigint PK, indexed cascading series FK, non-negative season number, optional season metadata; unique `(series_id, season_number)`.

`episodes`: bigint PK, indexed restrictive season FK, positive episode number and local metadata/runtime; unique `(season_id, episode_number)`. Public queries must also enforce published parent/readiness.

`episode_versions`: indexed episode/VJ FKs, availability and rights state; unique `(episode_id, vj_id)`. A series may therefore use different VJs by episode without duplicating its hierarchy.

`genres` plus `movie_genres`/`series_genres`: stable slug/name and optional TMDB mapping; composite join PKs and reverse indexes. Do not use JSONB as the primary filter model.

### Telegram/ingestion

`telegram_media`: bigint PK; bot type, 64-bit chat/message IDs, `file_id`, `file_unique_id`, media type, caption/name/MIME, bigint size, duration/dimensions, timestamps. Unique `(bot_type, chat_id, message_id)`; decide duplicate-file uniqueness after observing business rules. No client grants. `file_id` must always be interpreted with bot type because it is bot-specific.

`ingestion_events`: bigint PK; bot type/update ID, optional media FK, typed status, retry/parser data, safe errors and parsed suggestions, timestamps. Unique `(bot_type, telegram_update_id)`. Use short transactions; workers may claim rows with `FOR UPDATE SKIP LOCKED`.

`metadata_match_candidates`: ingestion FK, candidate TMDB ID/type, score and structured reasons, reviewer decision/ID/time. Only one approved mapping; ambiguity never publishes.

### Watchlist compatibility

1. Add nullable `movie_id`/`series_id`; retain legacy TMDB columns and `tv` only for unresolved compatibility rows.
2. Permit legacy rows while requiring exactly one typed internal reference for new-format rows.
3. Backfill only unique canonical TMDB mappings; report unavailability without guessing.
4. Prefer internal IDs in actions/UI while still reading/removing legacy rows.
5. Validate, stop legacy writes, measure unresolved rows, then remove legacy columns in a later migration.

### Playback

`playback_progress`: user ID plus exactly one movie/episode FK, position/duration, completion, last watched; unique per user/content with atomic upsert, own-row RLS, and Continue Watching indexes. Avoid a separate history table unless product queries require events beyond the latest progress row.

### Commerce

See sections 10–13. All commerce records use constraints, immutable references, least privilege, and no raw secret storage.

## 7. Telegram ingestion architecture

Proposed server boundary:

```text
lib/telegram/{client,validation,types,movie-bot,series-bot,parser,ingestion}.ts
app/api/telegram/movies/webhook/route.ts
app/api/telegram/series/webhook/route.ts
```

Split only when implementation size justifies each file.

Webhook flow:

1. POST-only, small body limit, JSON requirement.
2. Constant-time compare `X-Telegram-Bot-Api-Secret-Token` with the bot-specific secret.
3. Zod-validate and allow only configured channels/expected channel-post media.
4. Insert an ingestion event keyed by `(bot_type, update_id)`; duplicates return success.
5. Upsert Telegram media by delivery key, retaining both file identifiers.
6. Parse title/year/VJ or series/season/episode as suggestions.
7. Resolve VJ from database rules/aliases; unknown or conflicting values require review.
8. Create/attach a draft transactionally and run bounded TMDB matching.
9. Store clear matches; mark ambiguity `needs_review`; publish only through an explicit readiness transaction.
10. Acknowledge only after durable recording; processing must resume safely.

Security: separate credentials/channels/secrets; never leak tokens or token-bearing URLs; log IDs rather than full captions; provide audited/idempotent internal replay. Telegram retries/out-of-order updates are normal.

Official Bot API constraints: `update_id` supports dedupe; webhook secrets use a dedicated header; `file_id` is bot-specific and may change; `file_unique_id` is stable but cannot download.

### Playback blocker

The hosted Bot API documents `getFile` downloads up to 20 MB and token-bearing time-limited URLs. That does not establish production streaming for movies. Before Phase E, test real file sizes/codecs, hosted vs local Bot API or another authorized method, byte ranges/seeking, Vercel duration/bandwidth/egress, token-safe proxying, concurrency/abuse, and Telegram terms. Do not promise direct Telegram streaming until this passes.

## 8. TMDB matching architecture

- Query TMDB only after an ingestion/draft record exists.
- Build editable candidate data from caption/filename, title/year/type, and season/episode fields.
- Score multiple signals and save candidates/reasons. Require a strong threshold and margin over runner-up for auto-match.
- Ties, missing years, mismatched types, and inconsistent episode data go to `needs_review`.
- Reviewer approval writes mapping and local metadata atomically; rejection retains audit history.
- Refresh metadata through intentional jobs/admin actions using `metadata_synced_at` and rate controls.
- Normal home/browse/search/detail/watchlist/playback reads use Supabase only. TMDB search is admin-side matching only.

## 9. VJ architecture

- Database IDs/slugs define VJs; names in filenames never become permanent identity automatically.
- `short_name` drives badges, `display_name` headings, and a finite tokenized `badge_variant` drives styling.
- Movies/series reference VJs. No names are hardcoded into reusable logic.
- Add reviewed alias rules later if parsing needs them.
- Public `/vjs` and `/vjs/[slug]` routes expose movie/series sections.
- `VjBadge` overlays the top-left of the existing poster composition: compact, accessible, token-based, never baked into artwork.
- Decide whether one TMDB title may have multiple VJ variants before SQL; it changes uniqueness and watchlist UX.

## 10. Payment architecture

Proposed server boundary:

```text
lib/payments/{types,validation,provider,service,mtn-momo,airtel-money}.ts
```

The provider interface translates initiation/status only. The service owns plan lookup, server-calculated amount, persistence, idempotency, transitions, and activation.

Initiation: require verified session/same origin; validate plan/provider/phone/idempotency key; load active plan; normalize Ugandan MSISDN; insert pending attempt; generate immutable reference; call adapter; store redacted response; return pending, never authoritative browser success.

Callback/reconciliation: verify by official provider rules/status query; persist deduplicated event before transition; lock payment during terminal update; activate in the same transaction; never downgrade verified success; poll because callbacks can fail; rate-limit relevant endpoints.

Suggested tables:

- `subscription_plans`: slug/name/description, `price_ugx numeric(12,2)`, positive duration, device/download flags, active/sort, timestamps.
- `payments`: immutable public reference, user/plan, provider references, idempotency key, normalized phone, UGX amount, status, safe JSONB, failure/timestamps. Raw operational table stays server-only or exposes a safe projection.
- `payment_events`: payment, provider event ID or deterministic hash, event/status, safe payload, verification/processing timestamps; unique event identity.
- `subscriptions`: user/plan/source payment, state, start/expiry/cancel/revoke timestamps, and terms snapshot; index `(user_id, status, expires_at)`.

## 11. MTN MoMo flow

- Sandbox first with official Collections credentials.
- Cache OAuth tokens server-side; never store bearer tokens in payment rows.
- Persist payment before RequestToPay; use unique provider reference and configured callback.
- HTTP 202 means asynchronous acceptance, not payment success.
- Map documented states to the internal machine while keeping safe diagnostic codes.
- MTN documents callbacks may be sent only once and recommends GET status polling when missed; reconciliation is a launch requirement.
- Verify sandbox/production callback host/protocol requirements during onboarding.
- Never copy sample currencies/MSISDNs into Uganda production; plans remain server-loaded UGX and provider support must be confirmed.

## 12. Airtel Money flow

- Airtel Africa publicly confirms an official portal for collection/disbursement APIs and country onboarding.
- Authenticated Uganda merchant details are not in this repository or publicly inspectable during the audit.
- Therefore no endpoint paths, signature headers, callback schemas, or statuses are invented here.
- Phase F must obtain Uganda sandbox access, official current auth/collection/status/callback documentation, verification rules, country/currency requirements, and go-live checklist.
- Only then implement adapters/contract tests. Unofficial blogs and SDKs are not specifications.
- Persist before initiation, reconcile server-side, dedupe callbacks, and activate only after verified success.

## 13. Subscription and entitlement model

- Plans/prices come from the database; no final prices are invented.
- States: `pending`, `active`, `expired`, `cancelled`, `revoked`, with explicit allowed transitions.
- Entitlement requires an active, started, unexpired, non-revoked subscription.
- Playback checks a server entitlement service whenever issuing a playback session; cached UI status is not authorization.
- Activation/renewal is transactional and idempotent. Define renewal from current expiry vs payment time before coding.
- Snapshot relevant plan terms so later edits do not rewrite history.
- Do not claim device-limit enforcement until a real device/session model exists.

## 14. Dark/light/system theme strategy

- Keep all components on semantic `globals.css` tokens.
- Preserve the cinematic blue dark theme; add a deliberate warm-neutral light theme with accessible surface hierarchy.
- Explicit choices set `data-theme="light|dark"`; no attribute means system mode via `prefers-color-scheme`.
- A tiny pre-paint initializer applies persisted explicit preference before content paints; a small client control handles changes/system listeners.
- Persist `system | light | dark` in local storage initially. Consider a cookie only if server-dependent assets justify making requests theme-aware.
- Test `color-scheme`, theme-color, focus/destructive/muted/glass/fallback/badge/skeleton tokens in both themes.
- Settings exposes all three states; a quick toggle must not hide that model. No package is currently justified.

## 15. Routes to add/change

Public: database-driven `/`; `/movies` and `/movies/[slug]`; `/series` and `/series/[slug]`; optional season route; `/vjs` and `/vjs/[slug]`; database `/search`; `/history`; existing `/my-list`; and `/settings` or account subroutes. Redirect/deprecate `/tv`, `/trending`, and legacy TMDB detail URLs after replacements exist.

Server: separate Telegram webhooks; payment initiation/callback/status routes (or a Server Action for authenticated initiation); protected reconciliation/reprocess hooks; playback session/proxy only after the Phase E spike.

Add routes only in their owning phase. Public reads can stay in server modules rather than mechanical API wrappers.

## 16. Components to reuse

- `MovieCard`, `MovieGrid`, `MovieSection`, `MovieListItem`, `PosterImage`, `BackdropImage`, `Rating`, `SectionHeader`, `TabLinks`.
- `Hero`/`HeroCarousel`, `BrowsePage` concepts, and Phase 3 pagination/URL parsing after reconciliation.
- `SearchInput`, `EmptyState`, `RetryButton`, skeletons.
- `Button`, `Field`, auth/profile/account primitives.
- `WatchlistButton`, `WatchlistView`, and the guest/account store boundary.
- Header, bottom navigation, nav link, footer, and logo structures with new content/IA.

## 17. Components to modify

- Poster/card/image composition for internal IDs, VJ summary, and overlay slot.
- Grid/section/list/hero/browse/search/detail for database domain/query contracts.
- Watchlist for internal references plus compatibility reads.
- Navigation/footer/logo/metadata/auth copy for Velora UG.
- Account into composed settings/subscription/payment sections.
- Skeletons to match new layouts while retaining shared primitives.

## 18. Genuinely new components required

- `VjBadge` and perhaps a thin poster composition wrapper.
- VJ card/filter; season/episode list/row; mobile catalogue filter control.
- Theme selector.
- Subscription plan, payment initiation, status/history UI.
- Playback shell/player only in Phase E.
- Lightweight admin ingestion/review UI after domain/server APIs exist.

Do not build separate movie and series card systems.

## 19. Environment variable diff

`.env.example` is unchanged in this checkpoint because proposed integrations do not consume their variables yet; unused configuration would mislead.

Keep existing TMDB, site/app environment, Supabase, server/tooling database, and implemented optional service variables. Add only when consumed: `NEXT_PUBLIC_APP_NAME`, `INTERNAL_API_SECRET`, separate Telegram bot/channel/webhook secrets, Telegram API base, common payment settings, MTN collection settings, and Airtel settings confirmed by official documentation.

When next editing `.env.example`, remove its duplicated TMDB/site preamble and obsolete phase/copy labels. Never expose service-role, Telegram, payment, database, app, or reconciliation secrets through `NEXT_PUBLIC_`.

## 20. Security risks

| Risk | Control |
| --- | --- |
| Telegram/token leakage | Server-only modules; no token-bearing URLs in client/logs; redaction. |
| Forged/replayed ingestion | Secret header, channel allow-list, strict body/schema, unique update/message keys. |
| Ambiguous publication | Candidate evidence and mandatory review states. |
| Catalogue leakage | Published-only RLS; deny client access to drafts/raw ingestion. |
| Service-role overreach | Narrow server modules only; ordinary user reads retain session/RLS. |
| BOLA/IDOR | Session-derived user IDs plus ownership RLS; no payload user IDs. |
| Amount tampering | Server-loaded plans and calculated UGX amounts. |
| Callback spoof/replay | Official verification/status, unique event identity, monotonic transitions. |
| Double activation | Row lock and idempotent activation transaction. |
| Phone/privacy leakage | Minimize, normalize, redact, and restrict retention/display. |
| Search growth | Schedule and verify Phase 3 retention before release. |
| Admin escalation | Trusted app metadata/dedicated membership, never user metadata. |
| RLS-bypassing views/functions | Security-invoker views; hardened/revoked definer functions only when required. |
| Playback link sharing | Short-lived authorized sessions and abuse controls after the spike. |

## 21. Migration risks and blockers

1. **Blocking:** Phase 3 Git/live-schema drift must be reconciled before new SQL.
2. **Blocking public release:** Phase 3 analytics retention is unscheduled.
3. **Blocking Phase E:** Telegram hosted-download and serverless streaming feasibility is unresolved.
4. **Blocking Airtel adapter:** official Uganda merchant contract/callback verification is unavailable.
5. Multi-VJ duplicate-title policy changes uniqueness and watchlist semantics.
6. Legacy watchlists may map to zero/multiple catalogue variants; never discard or guess.
7. ID/slug routes need redirects/canonicals without breaking saved links.
8. Series filenames are unreliable; review workflow is required.
9. Parent publication checks/admin access need adversarial RLS tests.
10. Provider onboarding, callback allow-lists, refunds/disputes, and reconciliation ownership are operational dependencies.
11. Content rights, privacy/terms, retention, cancellations/refunds, and Uganda payment compliance need owner/legal confirmation.
12. Pre-paint theme code must align with the future CSP.

## 22. Phased implementation plan

The authoritative sequence is `IMPLEMENTATION_ROADMAP.md`:

- A — Migration/Foundation
- B — Catalogue Domain
- C — Telegram Ingestion
- D — Velora UG Discovery UI
- E — Playback + History
- F — Subscription + Mobile Money
- G — Production/PWA

Each phase is a separate controlled change set.

## 23. Acceptance criteria by phase

### A

- Git/live migrations reconcile without data loss; Phase 1–3 regressions pass.
- Search retention is verified or its writer remains disabled.
- Velora UG branding and flash-free accessible light/dark/system foundation ship.
- Multi-VJ, ID/slug, and watchlist decisions are approved.

### B

- Normalized catalogue constraints/indexes/grants/RLS pass local/live-safe verification and advisors.
- Public queries return only published/ready rows; ordinary renders make no TMDB requests.
- Existing watchlists survive compatibility migration.

### C

- Separate webhook credentials/channel validation; duplicate updates create no duplicates.
- Ambiguity enters review; tokens/raw privileged data never reach clients/logs.

### D

- Home/Movies/Series/VJs/Search use only published database content.
- VJ badges, URL filters, mobile/desktop, accessibility, async states, auth/watchlist/history regressions pass.

### E

- A viable, permitted, scalable byte-range delivery architecture is proven.
- Playback is entitled/server-authorized; resume/history/next episode work under RLS.

### F

- Server-derived plans/amounts/entitlements; official sandbox contracts for enabled providers.
- Initiation/callback/polling/reconciliation are idempotent; only verified success activates.

### G

- Admin review, observability, retention, rate limits, backups, reconciliation runbooks, PWA, E2E/accessibility/performance/security audits pass.
- Legal/provider approvals, rollback, and incident ownership exist.

## Audit evidence and primary references

Inspected: all tracked files under `app/`, `components/`, `lib/`, `types/`, `supabase/migrations/`; root proxy/config/package/environment files; required project docs/audits; recent/all-branch Git history; and the Phase 3 remote diff, migration, and audit.

- Telegram Bot API: https://core.telegram.org/bots/api
- MTN MoMo developer portal: https://momodeveloper.mtn.com/
- Airtel Africa portal announcement: https://www.airtel.africa/assets/pdf/press-release/Airtel-Africa-Developer-Portal_ENGLISH.pdf
- Supabase breaking changes: https://supabase.com/changelog?types=breaking-change
