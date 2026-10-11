# MP4/MKV Checkpoints 2?3 local close-out

Date: 2026-10-11 (Africa/Nairobi). Roadmap label **E3.9 remains provisional**;
repository numbering has no competing E3.9 entry, but the external numbering
reference is unavailable. Checkpoints 2 and 3 were authorized together.
**Checkpoint 4 has not been implemented.**

## Checkpoint 1 evidence

The full compatibility matrix, per-browser measurements, startup measurements,
fixtures and limitations remain in `MP4_MKV_NATIVE_PLAYBACK.md`. The immutable
baseline archive `evidence/checkpoint1-browser-results.zip` contains 141 saved
JSON records: 117 small-fixture records across nine headless/headed projects
and 24 startup records. Its SHA-256 is recorded next to it.

The four transient headed failures are retained in the baseline record: one
externally closed page, one double-started probe, and two failures with
uncaptured diagnostics. All four passed on rerun. Their missing diagnostics
and exact uncaptured test identities remain unavailable. These runs were
**not flawless**; the archive is of saved baseline outcomes, not fabricated
failure traces. The double-start probe fix is preserved.

## Before and after

| Area | Before | After (local implementation) |
| --- | --- | --- |
| New movie upload extensions | Detection/parser/admin accepted thirteen extensions | New movie uploads accept MP4/MKV only; detection and series parser extensions unchanged |
| Movie acceptance | Canonical fast-start H.264 MP4 with approved audio, or verified remux rendition | Original MP4/MKV with consistent known inspection metadata; codec/browser limitations reported separately |
| MKV / tail-index MP4 plan | Mandatory remux plan | Original-file upload plan when inspection permits; historical raw remux verdicts alone hold instead of mandating conversion |
| Containers, filenames, codecs, audio tracks | Normalization could drop cover art and select one audio stream | New original movie path preserves bytes and all tracks; movie CLI normalization execution refuses |
| Admin disk / R2 staging | Every cache path ended `.verified.mp4` | Generated private directory containing the exact validated original basename and extension; historical cache recovery still supported without rewriting records |
| Bounded Telegram inspection | MP4 only; immediately rejected tail indexes | MP4 and explicit Matroska DocType; complete Tracks required in bounded MKV head; tail-index MP4 samples/index passed to probe at original offsets |
| Integrity | Canonical media class mixed with browser readiness | Metadata consistency/incomplete status plus explicit bounded scope; never full-file integrity |
| Streaming | Non-fast-start MP4 defective by policy | Potentially playable with startup warning; incomplete index/probe/track metadata stays unverified |
| Browser compatibility | Implied by canonical class | Container/codec fixture evidence distinguished from per-file predictions; Firefox MKV streaming unreliable; Safari/iOS/Android untested on devices |
| Download | Reserved/refused | Still unavailable; separate status explicitly says not implemented and authorization required |
| Verification/publication | `playback_ready` contributed to generated verified status | New bounded policy 3 never asserts `playback_ready` or browser verification; current DB rejects new payload until Checkpoint 4 |

Policy 2 classification/normalization services remain for series and historical
renditions; stored source classifications, failures and previously published
MP4s are not rewritten. Existing movie journal metadata can be assessed for
planning without mutating its historical inspection. New source inspections
use policy 3 and the `original` class, not `canonical`. Multiple audio tracks,
subtitles and cover art remain in the file. Ambiguous multiple film-video
tracks or missing required stream metadata stay on hold.

The existing ingestion/uploader services, checksums, chunk checks, size limits,
source revalidation, upload authorization and exactly-once recovery are reused.
New filenames must be safe plain basenames; unsafe filesystem names are refused
rather than renamed. Historical R2 journal paths remain valid, including when
a missing historical cache must be downloaded again into its recorded path.
No new dependency or public database access was introduced.

Confirmed TMDB film/VJ selections continue through the existing media-only
inspection branch in `lib/discovery/database.ts`; that code was not changed.
Append-only database evidence and historical failure rows were not touched.
Rights clearance and publication approval remain separate authoritative gates.

## Validation and evidence

- Final unit/service suite, including offline integration with real ffprobe
  and existing synthetic MP4/MKV fixtures: **1010 passed, 0 failed, 0 skipped**; see `evidence/checkpoints2-3-unit.json`.
  Tests use explicit local verified FFmpeg/ffprobe tool paths, not live media.
- Added original acceptance/metadata/compatibility tests (3), repeated-signal
  shutdown tests (2), bounded real-fixture integration/negative tests (8),
  original disk filename test (1), movie/series planner test (1), and R2
  original/historical filename test (1). Legacy browser-ready and media-gate
  assertions were updated; existing rights/security/recovery tests retained.
- Headless browser run: **52 passed, 26 failed** in the sandbox. Firefox crashed
  while creating pages; WebKit produced a request without the required Range
  header. A one-case-per-browser probe reproduced these problems. Headless
  Firefox/WebKit rerun outside the sandbox: **26 passed**. Together all 78
  combinations passed; neither the initial run nor this session was flawless.
  All three logs are retained. No assertion or gateway rule was weakened.
- Post-change browser JSON archive contains the 78 updated headless fixture
  results alongside unchanged baseline headed/startup records. It is separate
  from the immutable Checkpoint 1 archive.
- Typecheck, lint, dedicated discovery-service typecheck and production build
  **passed**. Results are retained in `evidence/checkpoints2-3-*.log`.
- Production build uses `node docs/evidence/checkpoints2-3-build.mjs`: existing
  environment-file values are overridden in the child process, and a read-only
  empty loopback catalogue supplies anonymous build-time GET/HEAD requests.
  No database, operational credential, Telegram call or hosted request is used.
  The first build attempt compiled/typechecked but failed prerendering against
  a deliberately unavailable loopback catalogue; its log is retained separately.
- Existing build warnings: parent-directory `bun.lock` ignored; dynamic journal
  filesystem tracing. Existing tracing exclusions are unchanged.
- Database-backed integration/pgTAP suites were **not run**: their normal setup
  resets/seeds or applies migrations, forbidden for this checkpoint. The new
  policy cannot be tested end-to-end through the current DB contract until
  Checkpoint 4. Startup/real-device/new full-length movie tests were not rerun.

## Listener shutdown

Only the signal registration in `services/media-gateway/discovery.mts` changed:
`process.once` became `process.on` for both SIGTERM and SIGINT. The existing
finally block releases the lease, stops the reader, closes the database and
removes listeners. Abort is idempotent. Two offline tests execute the actual
host signal registration/finally block with fake ports, simulate the library
re-raising each signal during pending release, and assert one abort event,
**exactly one lease release**, one reader stop and one DB close.

The listener was **not rebuilt, restarted or replaced**. These tests establish
local wiring behavior; live shutdown verification remains a separately gated
operation. The earlier isolated-container reproduction remains in the
Checkpoint 1 record.

## Compatibility limits and risks

- Firefox MKV: small fixtures may play, but larger baseline MKVs required the
  whole file before metadata; MP3 in MKV was silent. Reliable streaming is not
  claimed. Feature-length/cache-limit behavior remains untested.
- Safari/iOS and Android need real devices. Windows Playwright WebKit is not
  Safari evidence. Firefox is Playwright's build; HEVC results depend on hardware
  and mode. AC-3 audio was silent in the tested browsers.
- Multiple audio tracks stay intact; browser track switching is unavailable in
  the tested Chromium/Firefox APIs. Embedded subtitles were not exposed.
- A non-fast-start MP4 may start later and need tail requests. Bounded samples
  cannot prove mid-file packets, end-to-end decoding or full download success.
- A large index or MKV Tracks beyond the inspection budget, unreadable bytes,
  missing codec/duration/track metadata, unsupported containers or ambiguous
  film-video streams stay unverified/on hold. Original bytes are never repaired.
- Tail-index inspection creates a private disposable probe file with the index
  at its original offset. Physical sparse-file behavior depends on the host
  filesystem; allocation/tool failures produce unverified inspection, not a
  passing claim. Production Linux/container validation remains outstanding.
- Policy 3 is local code only. Do not run new-policy inspection against the
  current database: `discovery_complete` validates an exact legacy field set,
  `media_evidence` excludes `original`, and admin SQL still gates canonical
  media. Existing operational flags/authorization boundaries are unchanged.

## Checkpoint 4 requirements (proposal only)

No SQL/migration was written or applied. Preparation requires:

1. Add policy 3 evidence storage for integrity scope/status, streaming status,
   warnings, track metadata, container/codecs and compatibility evidence/basis.
   Validate bounded payloads and exact document identity server-side.
2. Extend `private.media_evidence` class/contract and `discovery_complete`,
   current-evidence/readback RPCs and admin inspection contracts for policy 3.
   Keep evidence append-only and historical failures/confirmed selections intact.
   Preserve legacy canonical evidence and published MP4 version behavior.
3. Separate new-policy acceptance from the legacy generated `verified` predicate
   and browser readiness. Downloads must remain unavailable until their own
   authorized endpoint exists; inspection must not grant rights/publication.
4. Update movie-only admin creation/inspection/storage gates for MP4/MKV and
   original filenames. Reconcile pending admin migrations independently of the
   already-hosted baseline; do not rewrite applied migration history.
5. Keep worker privilege grants narrow, revoke unintended PUBLIC/anon/
   authenticated privileges for every new/replaced object, pin function search
   paths and audit security mode. No privileged Next.js access.
6. Add database/contract regression tests for incomplete evidence, append-only
   history, identity preservation, series policy, historical MP4s, rights and
   publication gates. Migration application, live listener rollout, media
   operations and deployment need separate authorization.

## Pre-existing changes (preserved separately)

`.env.example` was already modified before this work and was not edited. Its
exact initial/current diff is `evidence/preexisting-env-example.diff`: the R2
staging configuration block was reduced to Cloudflare placeholders, removing
upload storage, parallelism, retention and worker settings, with no final
newline. This is independent of Checkpoints 2?3. `.claude/` was already
untracked and remains untouched. `.env.local` was not edited.

## Exact files changed by this task

- `IMPLEMENTATION_ROADMAP.md`
- `app/admin/uploads/new/page.tsx`
- `docs/MP4_MKV_CHECKPOINTS_2_3.md`
- `docs/MP4_MKV_NATIVE_PLAYBACK.md`
- `docs/evidence/checkpoint1-browser-results.sha256`
- `docs/evidence/checkpoint1-browser-results.zip`
- `docs/evidence/checkpoints2-3-browser-probe.log`
- `docs/evidence/checkpoints2-3-browser-rerun.log`
- `docs/evidence/checkpoints2-3-browser-results.zip`
- `docs/evidence/checkpoints2-3-browser.log`
- `docs/evidence/checkpoints2-3-build-unavailable-catalogue.log`
- `docs/evidence/checkpoints2-3-build.log`
- `docs/evidence/checkpoints2-3-build.mjs`
- `docs/evidence/checkpoints2-3-discovery-typecheck.log`
- `docs/evidence/checkpoints2-3-git-status.txt`
- `docs/evidence/checkpoints2-3-lint.log`
- `docs/evidence/checkpoints2-3-typecheck.log`
- `docs/evidence/checkpoints2-3-unit.json`
- `docs/evidence/preexisting-env-example.diff`
- `lib/discovery/media-probe.test.ts`
- `lib/discovery/media-verification.test.ts`
- `lib/discovery/media-verification.ts`
- `lib/discovery/shutdown.test.ts`
- `lib/ingestion/boundary.test.ts`
- `lib/ingestion/lifecycle.test.ts`
- `lib/ingestion/media.ts`
- `lib/ingestion/original-media.test.ts`
- `lib/ingestion/original-media.ts`
- `lib/ingestion/plan.ts`
- `lib/uploader/admin-inspection.test.ts`
- `lib/uploader/admin-inspection.ts`
- `lib/uploader/admin-upload.test.ts`
- `lib/uploader/admin-upload.ts`
- `lib/uploader/cli.test.ts`
- `lib/uploader/disk-transfer.test.ts`
- `lib/uploader/disk-transfer.ts`
- `lib/uploader/journal.ts`
- `lib/uploader/media-tools.ts`
- `lib/uploader/r2-worker.ts`
- `lib/uploader/r2.test.ts`
- `lib/uploader/staging.ts`
- `lib/uploader/upload.ts`
- `lib/uploader/uploader.test.ts`
- `scripts/ingest/cli.mts`
- `services/media-gateway/discovery.mts`
- `types/ingestion.ts`

`.env.example` is excluded from that list because its diff predates this task.
No package/lockfile, migration, database test or published media file changed.
Ignored outputs in `.next/`, `test-results/`, `tests/browser/.results/` and local
unit-run logs were generated by validation; baseline results were archived
before the browser run.

## Git working-tree status at close-out

All changes are unstaged; no commit, push or deployment was made.

```text
 M .env.example
 M IMPLEMENTATION_ROADMAP.md
 M app/admin/uploads/new/page.tsx
 M docs/MP4_MKV_NATIVE_PLAYBACK.md
 M lib/discovery/media-probe.test.ts
 M lib/discovery/media-verification.test.ts
 M lib/discovery/media-verification.ts
 M lib/ingestion/boundary.test.ts
 M lib/ingestion/lifecycle.test.ts
 M lib/ingestion/media.ts
 M lib/ingestion/plan.ts
 M lib/uploader/admin-inspection.test.ts
 M lib/uploader/admin-inspection.ts
 M lib/uploader/admin-upload.test.ts
 M lib/uploader/admin-upload.ts
 M lib/uploader/cli.test.ts
 M lib/uploader/disk-transfer.test.ts
 M lib/uploader/disk-transfer.ts
 M lib/uploader/journal.ts
 M lib/uploader/media-tools.ts
 M lib/uploader/r2-worker.ts
 M lib/uploader/r2.test.ts
 M lib/uploader/staging.ts
 M lib/uploader/upload.ts
 M lib/uploader/uploader.test.ts
 M scripts/ingest/cli.mts
 M services/media-gateway/discovery.mts
 M types/ingestion.ts
?? .claude/
?? docs/MP4_MKV_CHECKPOINTS_2_3.md
?? docs/evidence/
?? lib/discovery/shutdown.test.ts
?? lib/ingestion/original-media.test.ts
?? lib/ingestion/original-media.ts
```

## Approval boundary

Stop here. Requested next approval is for **Checkpoint 4 local schema/migration
and RPC code preparation**, with migration application, hosted changes,
listener replacement, media operations, push and deployment gated separately.
