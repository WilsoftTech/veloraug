# MP4/MKV Checkpoint 6: frontend playback and original downloads

2026-10-12. Local implementation and isolated validation only. Started on
`phase-a-foundation` at `972a41b392388403bccc306cc42a6332cb1bbc1b` (the committed
Checkpoint 4–5 work). The starting normal-user tree contained only the existing
`.env.example` edit; restricted Git additionally listed the user-ignored
`.claude/` because it could not read the global ignore file. Both remain untouched.

Reviewed the Checkpoint 5 report, both prepared CP4 migrations, CP5 download
resolver and gateway, existing player/renewal/diagnostics, issuer/entitlement,
movie page, session hint, shared button classes and CP1 matrix before editing.
Read the installed Next.js 16.3.8 server/client guide and used the Supabase skill
and current RPC documentation. Existing `IMPLEMENTATION_ROADMAP.md` registers
E3.9 after E3.8, with no competing E3.9 entry: the previously provisional label
has now been checked against project numbering. Earlier reports remain historical.

## Behavior before and after

| Area | Before | After |
| --- | --- | --- |
| Download UI | CP5 endpoint/gateway existed without a frontend action | Signed-in UX hint shows Download for the selected published VJ version; every actual attempt is authenticated and authorized again |
| Original format | No player format/codec facts | Optional safe MP4/MKV/video/audio facts; absent facts remain unknown; gateway MIME confirms download format |
| Playback | Native video with renewal and gateway diagnostics | Same native player and renewal, plus conservative compatibility messages, picture/audio observations and bounded loading/buffering |
| Continuation | No frontend flow | Explicit Resume/Retry Download; new capability and fresh authorization on each click; no automatic partial-file stitching |
| Missing prepared SQL | No profile dependency | Missing public profile RPC leaves the existing movie usable; unavailable download resolver produces a safe availability message and no full-file navigation |

The button uses the existing `buttonClass`, 44px minimum controls, icons and
alert/status patterns. Guests see no Download action. `useSession` is a visibility
hint, never authorization; even a stale signed-in UI cannot obtain media after
server denial. No hidden/draft title is added to the catalogue or made downloadable.
VJ changes abort pending preparation, reset its format/status and request the
selected version next time. Playback failures keep the download fallback available.

## Download issuance, continuation and security

`prepareDownload` posts only `{ movieVersionId }` to the existing same-origin
authenticated issuer, with credentials and no cache. The CP5 issuer still verifies
the current Auth user and entitlement/publication policy. No issuer or gateway
authorization rule was changed.

A fresh capability is checked directly at its gateway with **Range bytes=0-0**.
JavaScript cancels the body without buffering it, requires a one-byte 206 response,
checks Content-Range and MP4/MKV MIME, and then hands the URL to a temporary anchor.
The normal browser download streams straight from the gateway. Its original
Content-Disposition owns the filename; the frontend does not override it. The
probe also detects the unapplied download resolver safely. A server that ignores
Range is cancelled and rejected rather than read into memory.

The readiness probe is one byte of HTTP output; the existing gateway may need a
small aligned upstream read. It does not verify the whole movie, complete rights
clearance, establish browser compatibility, or guarantee the subsequent transfer.
Revocation/network failure can still occur between probe and browser navigation.

One expired issuer timestamp or gateway 401 may trigger **one** new authenticated
issuance within the clicked action. Repeated expiry is reported. Issuer 401 prompts
sign-in; 403 denies access; 404 reports unavailable; 429/5xx reports temporary
unavailability. Network interruption during preparation offers retry guidance.
No revoked/unauthorized download is silently retried. Preparation gives up after
15 seconds and aborts its fetches. Version changes, sign-out and unmount cancel it.

The ten-minute token remains in transient request/navigation memory only. It is
not stored in React state, localStorage, sessionStorage, a service worker or logs.
The anchor uses `noopener noreferrer` and no-referrer, then is removed. HTTPS is
required except loopback test/development HTTP; malformed destinations, credentials,
fragments and wrong version/operation paths are rejected. No private Telegram
location, privileged database/storage credentials or file bytes go through Next.js.
No browser Blob, full-file fetch, file assembly, decoder or new dependency was added.

**Browser-managed resume is limited.** The gateway's existing Range/If-Range
contract remains available to browsers/download managers. This page cannot observe
transfer progress, completion or later errors, or supply a refreshed URL to an
already-running partial transfer. It says so, and offers Resume/Retry Download.
A browser may restart from zero with the new URL. Seamless automatic resume is
neither implemented nor claimed. A late revoked/expired/failed full GET is handled
by the browser's download manager; the next explicit click rechecks authorization.

## Compatibility and playback failure handling

The safe public CP4 projection supplies container, video/audio codecs and the
tail-MP4 startup status. The parser forwards only these whitelisted facts, never
raw evidence, track titles, private identifiers or a `verified` assertion. UA and
touch hints identify engine/platform conservatively. `canPlayType` supplies
representative MIME hints; it is not per-file proof. `MediaCapabilities.decodingInfo`
is intentionally not called because the safe RPC does not supply the required
dimensions, bitrate and frame rate; no values are invented. See the browser API
[MIME guidance](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/canPlayType)
and [decoding configuration](https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo).

| Combination | UI interpretation |
| --- | --- |
| Windows Chromium H.264 with AAC/MP3 in MP4/MKV; Windows Firefox MP4 | Tested fixture combination; explicitly says this file/device is untested |
| Other platform with positive common-codec hints | Expected, not tested |
| MP4 index at end | Startup warning, playback allowed, not classified as defective |
| Firefox MKV | Browser-dependent/unreliable streaming; may fetch the whole movie before metadata |
| Firefox MKV/MP3 | Additional video-without-audio warning |
| HEVC | Device decoder dependent; picture may be missing while audio plays |
| AC-3/E-AC-3 | Audio may be unsupported/silent; AC-3 fixture evidence is retained, E-AC-3 is a caution/prediction |
| Safari/iOS or Playwright WebKit | Unknown pending real-device tests; no support claim |
| Absent/incomplete metadata or unidentified browser | Unknown, playback attempt allowed |
| Container outside this player's MP4/MKV scope | Unsupported; Play disabled and authorized Download remains available |

Known fixture evidence overrides negative MIME guesses for tested combinations.
Integrity, streaming readiness, browser compatibility and operational download
availability stay separate. Historical inspection `download_status` is not used
as current gateway availability. Browser playback does not upgrade inspection
evidence or authorize publication.

The existing native error diagnosis still distinguishes serving bytes, expired
capability, catalogue availability and service failure. Only after a successful
gateway probe can known container/codec facts refine an unsupported-media message.
Metadata alone does not prove decoded output: `loadeddata` with zero dimensions
reports missing picture; explicit native `mozHasAudio=false` or an empty exposed
audio track list shows a sound warning. Absence of those APIs is not silence proof.
The UI does not measure audio RMS or promise to detect every silent decoder.

The stream issuer request now has a 15-second bound. Initial loading or buffering
has a 30-second watchdog scheduled at the committed loading state, so delayed
passive effects do not shift its start: no metadata gives slow-metadata fallback, while stalled
buffering after metadata gives connection guidance. Slow tail-MP4 startup remains
allowed within that bound. Existing renewal before expiry and on resume/network
failure, renewal throttling, playback position and VJ switching are preserved.

Track metadata remains intact in ingestion/evidence. The public projection does
not expose track counts or titles, so the UI gives a conditional default-audio and
embedded-subtitle caveat rather than claiming this movie has those tracks or that
switching/rendering works.

## Database and external boundaries

No CP6 migration was created or applied. The page uses the existing ordinary anon
catalogue client and an optional `public.movie_media_profile(bigint)` call with a
three-second abort bound. Missing RPC, absent evidence, malformed result and outage
all give unknown metadata; existing catalogue selects do not name new columns.
The additive application type names that prepared RPC without asserting it is live.

Profile activation requires CP4's
`20261011192618_original_media_evidence.sql`; the admin companion remains separately
prepared. Operational download requires CP5's
`20261011200813_original_media_download_resolver.sql`, independently of CP4/admin SQL.
Unapplied RPC produces gateway 503 and a safe UI availability error. See the
[CP4](MP4_MKV_CHECKPOINT_4.md) and [CP5](MP4_MKV_CHECKPOINT_5.md) reports for migration
ordering, privileges, live-baseline checks and activation blockers.

No hosted or persistent local database was queried/modified, no listener was
rebuilt/restarted/replaced, no seven-candidate reinspection or live Telegram read
occurred, and no upload, publication, push or deployment was performed. Rights
clearance, publication authorization, original files and historical evidence are
unchanged. No Checkpoint 7–9 implementation is included.

## Validation and retained failures

- Full unit suite: **1,102 passed, 0 skipped/failed**, with explicit existing local
  FFmpeg/ffprobe tools. Earlier full run: 1,100 passed before two added regressions.
  New profile/compatibility/download tests plus changed player/component assertions
  cover safe metadata, fixture-vs-prediction categories, formats, denial, real issuer
  reauthorization, one-byte cancellation, expiry/reissue, network/timeout, no filename
  override, no persistent DOM URL and honest resume guidance.
- Existing disposable integration: **5 suites, 44 passed, 1 skipped**. Added safe
  public profile assertions for a published version and unknown version. The
  skipped Auth signup/watchlist test needs an Auth server; the existing disposable
  harness supplies PostgreSQL/PostgREST, not GoTrue. No hosted fallback was used.
- Native headless matrix: **78 passed** (13 fixtures × 6 projects). All outcomes
  are preserved, including silent/unsupported cases; a passing regression is not
  proof every fixture plays. Fresh 78-record ZIP + SHA-256 excludes old startup
  records. CP1 and CP5 archives both still match their saved hashes.
- Browser UI: the first complete 132-case run (78 native + 54 UI) had **131 passes
  and 1 WebKit synthetic-timeout failure**. Earlier Chromium UI run had 7/9 passes:
  expired-clock fixture consumed its state in rate limiting, and media-event fixture
  raced a transport error. Fixed fixtures produced 9/9 passes. The WebKit timeout
  case also failed the first targeted rerun, timer-diagnostic run, and real-time
  run: the native pending source raised its own error before the watchdog. The
  synthetic-event test suppresses native transport and injects media events;
  the separate native matrix and real playback/renewal tests remain unmocked.
  That intermediate 12-case rerun still had 11 passes/1 WebKit failure. Moving
  the watchdog from a passive effect to a layout effect anchored it to the loading
  commit; its next run passed the metadata deadline but exposed the test advancing
  time before buffering committed. Waiting for visible Buffering fixed that test:
  the next isolated WebKit run passed.
- **Final runs on the final code** (all started 21:28Z on 2026-10-11, after the
  last source edit at 21:28:12Z; nothing in the source tree changed afterwards):
  - Browser UI, `checkpoint6-ui-browser-final.{log,json}`: **54 passed, 0 failed,
    0 flaky, 0 skipped** in 3.1 minutes. That is all 9 UI cases in each of the
    six projects (Chrome, Edge, software-decode Chrome, Chromium, Firefox, WebKit).
  - Unit, `checkpoint6-unit-final.{log,json}`: **1,102 passed of 1,102** in 223
    files, 0 failed, 0 skipped.
  - Typecheck, lint and offline production build: all pass
    (`checkpoint6-typecheck-final.log`, `checkpoint6-lint-final.log`,
    `checkpoint6-build-final.log`). The build's one Turbopack warning (dynamic
    filesystem access in `lib/uploader/journal.ts`) is the same as in the
    Checkpoint 5 build log and is not from this change.
  - Not repeated after the last player edit, because their inputs did not change:
    the 78-case native matrix (it plays fixtures in a bare probe page, not through
    `MoviePlayer`) and the disposable integration suite (database and REST only).
- Responsive checks use 1440, 768, 390 and 360px widths: no horizontal overflow,
  Download at least 44px high, keyboard Tab/focus outline/Enter and emulated touch
  activation. Download status and errors have status/alert roles; VJ now has an
  explicit accessible name. Chromium desktop/phone screenshots were inspected.
  Touch emulation and iPhone-sized layout are not Android/iOS media certification.
- Final typecheck, lint and offline production build pass. Initial lint caught
  the Playwright fixture callback named `use` being mistaken for a React hook.
  Typecheck caught test argument/fetch typing and the test HTTP server's HTTP/2
  union; these were fixed. All failed/rerun logs remain alongside final results.
- Test-host setup initially lacked the server-only mapping, then loaded a real
  Next Link instead of its fixture substitute. Three debug runs were interrupted
  without completion. A short diagnostic found an ambiguous VJ accessible label;
  that product accessibility fix is included. No run is described as flawless.

The browser host renders the actual MoviePlayer and shared styles, calls the real
issuer factory and gateway core, and reads committed synthetic fixtures. Only
session/Next navigation, verified identity/catalogue ports and Telegram transport
are stand-ins. Vite is already installed through the existing test toolchain;
no package/lockfile change was needed. It does not load `.env` files, start Next
dev, use real Auth credentials or permit external browser requests. Browser Auth
SDK/real-device tests are not claimed. New SQL was not needed, so the 1,098-assertion
CP5 pgTAP suite was not rerun for this frontend change.

## Exact source and documentation files changed

- `app/movies/[slug]/page.tsx`
- `components/movie-player.tsx`
- `components/movie-player.test.tsx`
- `lib/catalogue.ts`
- `lib/supabase/database.types.ts`
- `lib/playback/player.ts`
- `lib/playback/player.test.ts`
- `lib/playback/compatibility.ts` (new)
- `lib/playback/compatibility.test.ts` (new)
- `lib/playback/download.ts` (new)
- `lib/playback/download.test.ts` (new)
- `playwright.config.ts`
- `tests/browser/harness.ts`
- `tests/browser/tsconfig.json` (new, server-only mapping confined to browser tests)
- `tests/browser/player-fixture.tsx` (new)
- `tests/browser/player-harness.ts` (new)
- `tests/browser/player.spec.ts` (new)
- `tests/integration/direct-channel-publication.test.ts`
- `docs/MP4_MKV_NATIVE_PLAYBACK.md` (current checkpoint table only; full CP1 matrix retained)
- `docs/MP4_MKV_CHECKPOINT_6.md` (this report)

The final Git snapshot lists every generated evidence file separately. Existing
`.env.example` is **not a CP6 change**: its diff still exactly matches
`evidence/preexisting-env-example.diff`, SHA-256 of its current contents
`86e5770622d8d589f59bacde0060e089e1d9bf3df2da87e1cd7a2ccce9fa73f8`.
`.claude/`, `.env.local`, package manifests/lockfiles and migrations remain untouched.

## Limitations, blockers and next approval

Real Safari/macOS, iOS and Android media playback and download-manager continuation
need real-device testing. Firefox MKV streaming remains unreliable. HEVC depends
on device decoding, AC-3 may be silent, and track switching/subtitles are unproven.
Runtime audio observations are partial; metadata consistency is not whole-file
integrity. Slow connections can hit explicit preparation/loading deadlines and
need a retry or download. A fresh URL may restart a partial browser download.

**Loading watchdog, unstarted player (found in the hand-over review; fixed at
Checkpoint 7, see [report](MP4_MKV_CHECKPOINT_7.md)).** As it stood at this checkpoint:
The 30-second watchdog runs whenever the state is `loading` or `buffering`. The
state leaves `loading` only on `loadeddata`, `playing` or `pause`. If a browser
refuses the automatic start and also delays `loadeddata` until playback begins,
the watchdog closes a player that loaded its metadata correctly, with the
connection message, 30 seconds after Play. Chrome, Edge and Firefox raise
`loadeddata` with `preload="metadata"`, so this did not occur in any tested
project. Safari and iOS are the likely place for it; add this case to the
real-device test. Before this checkpoint the same situation showed "Loading…"
indefinitely with the native controls still usable.

Persistent resolver/schema activation, deployed CORS/origin configuration and
actual Auth/publication/rights checks remain deployment blockers requiring their
own approved preflight. The frontend probe must be permitted by gateway CORS;
unreadable responses fail safely. Existing CP5 per-process admission limits and
ten-minute expiry are unchanged. A browser handoff does not guarantee completion.

Recommended Checkpoint 7 scope, **subject to your scope approval**: isolated
activation/order and failure/revocation review, a real-device test plan and
download-manager continuation evidence, and an operational readiness checklist.
Define any later verification producer/publication work explicitly: bounded
policy 3 still does not supply a verified-media publication contract. This is a
recommendation only, not implementation or permission to activate anything.

## Close-out hand-over and Git snapshot

The Codex session that implemented this checkpoint reached its usage limit at
21:31:18Z on 2026-10-11, while its final runs were finishing and before their
results and the Git snapshot were recorded. Claude Code completed the close-out
the same night. It changed no source or test file. It read the final evidence,
reviewed the uncommitted diff against the authorization, and recorded the final
results above, the watchdog limitation and this section.

Independent confirmation on the unchanged tree: the focused playback, player
component and catalogue-boundary tests (10 files, 208 tests) pass, and typecheck
and lint pass again. The full unit suite, the browser suites, the build and the
integration suite were not run a second time; their final evidence above stands.
`.env.example` still has SHA-256 `86e57706…a73f8` and its diff still equals
`evidence/preexisting-env-example.diff`. The native-results ZIP matches its
saved SHA-256.

Git snapshot: `evidence/checkpoint6-git-status.txt`. Branch `phase-a-foundation`
at `972a41b`, 12 commits ahead of its remote, nothing staged. 12 tracked files are
modified (11 for this checkpoint plus the pre-existing `.env.example`). The
untracked files are this report, 8 source and test files, and the
`evidence/checkpoint6-*` files.

**Working-tree exposure.** A `next dev` process started at 20:53:58Z, before
most of this checkpoint's edits, is running from this tree and hot-reloads it.
It was not started by either agent. If it uses the hosted project, opening a
movie page there makes one read-only call per version to the not-yet-deployed
`movie_media_profile` RPC, which fails to "unknown", and signed-in viewers see
the Download action. A click obtains a ten-minute capability from the committed
Checkpoint 5 issuer and then stops at the one-byte probe with an availability
message, because the download resolver is not deployed. Nothing is written.

Stop here. Approval is required before Checkpoint 7, persistent migration
application, deployment or live media operations. No CP6 commit was created.
