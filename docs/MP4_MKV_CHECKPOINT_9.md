# MP4/MKV Checkpoint 9: admin media verification dashboard and the download switch

Work of 2026-10-13 and 2026-10-14. E3.9 remains a provisional roadmap label. Checkpoint 9 is the admin
dashboard scope of the original brief (its "Checkpoint 7"), restored by the
owner's brief of 2026-10-13. **Checkpoint 10 is reserved for controlled
end-to-end validation and has not started.**

**Status: implemented and validated locally. Uncommitted, awaiting review.**
Nothing was pushed, deployed or applied to a persistent database. No Telegram
call was made, no listener was touched, no media was converted, uploaded,
reinspected or published. `.env.example` and `.claude/` were not modified.

The Checkpoint 8 verification was committed first, as authorized: local commit
`61387ac` (nine paths; `d38dd90` not amended).

## What a reviewer gets

- One **Media inspection** panel on the candidate review screen and on the
  upload detail page, with four separate statuses and the file's facts.
- **Six publication requirements**, each with its own state.
- A **download switch**, off by default, enforced on the server in two places.

The short version of what is true after this checkpoint:

| Question | Answer |
| --- | --- |
| Does the dashboard need a migration? | No. It renders on the hosted schema (17 migrations) and says "Not reported" for what that schema lacks |
| Can a new MP4 or MKV original be published now? | No, exactly as before. The dashboard shows it as "Verification pending" |
| Did any authorization path change? | No new one. Approve, Publish and rights are the same buttons, capabilities and database checks |
| Are downloads on? | No. Off unless `MEDIA_GATEWAY_DOWNLOADS_ENABLED=true` is set on **both** servers |
| Is streaming affected by the switch? | No |

## 1. Exact files changed

Working tree against `61387ac`: 39 modified files, 8 new source or
documentation files, 15 new evidence files.

**Dashboard (new)**

- `lib/discovery/media-report.ts`: status mapping, the six requirements.
- `components/media-verification.tsx`: the panel.
- `lib/discovery/media-report.test.ts`: 18 tests.
- `tests/browser/admin-fixture.tsx`, `tests/browser/admin.spec.ts`: the
  reviewer screen in real browsers.
- `scripts/checkpoint9-validation.mts`: the data path against real SQL.

**Dashboard (modified)**

- `lib/discovery/model.ts`: optional evidence fields (policy version, container
  name, earlier verdict, Policy 3 facts).
- `lib/discovery/database.ts`: reads the Policy 3 fields of the reviewer view
  when present.
- `lib/discovery/guidance.ts`: "Verification pending" state, Policy 3 reason
  texts.
- `components/discovery-review.tsx`: the panel in place of three rows, the six
  requirements, the channel named without its identifier.
- `app/admin/discovery/[id]/page.tsx`: passes the server's download setting.
- `lib/uploader/admin-upload.ts`, `app/admin/uploads/[id]/page.tsx`: the panel
  on the upload page; a pending Policy 3 upload no longer reads "Failed".
- Tests: `components/discovery-review.test.tsx` (+11),
  `components/admin-upload-page.test.tsx` (+2),
  `lib/uploader/admin-upload.test.ts` (+1).

**Download switch**

- Gateway: `lib/media-gateway/download.ts`, `config.ts`, `errors.ts`,
  `server.ts`, `services/media-gateway/main.mts`, `scripts/media-gateway-dev.mjs`.
- Web: `lib/playback/stream-capability.ts`, `stream-token.ts`, `download.ts`,
  `app/api/media/download-token/route.ts`, `components/movie-player.tsx`,
  `app/movies/[slug]/page.tsx`.
- Tests: `lib/media-gateway/download.test.ts` (+8), `config.test.ts` (+1),
  `lib/playback/download-token.test.ts` (+3), `download.test.ts` (+1),
  `components/movie-player.test.tsx` (+1), `tests/browser/player.spec.ts` (+2).

**Existing test set-ups that now turn the switch on** (one option each; no
assertion in an existing test was changed, weakened or removed):

| File | Change |
| --- | --- |
| `lib/media-gateway/download.test.ts` | `start()` builds the gateway with the switch on unless a test says otherwise |
| `lib/media-gateway/server.test.ts` | the same in its `start()` |
| `lib/media-gateway/issuer-contract.test.ts` | the gateway is built with the switch on |
| `lib/playback/download-token.test.ts` | `world()` passes the switch, on by default |
| `lib/playback/download.test.ts` | the issuer in one test is built with the switch on |
| `components/movie-player.test.tsx` | `render()` passes the new `downloads` prop, on by default |
| `tests/browser/harness.ts`, `player-harness.ts`, `player-fixture.tsx` | the switch on both sides, on by default, and a second fixture page for the reviewer screen |
| `scripts/checkpoint5-validation.mts`, `checkpoint8-validation.mts` | the gateway is built with the switch on |

These follow from "disabled by default": a gateway or issuer built without the
setting now refuses downloads, so a test that exercises downloads has to turn
it on. Two existing tests failed until their set-up did (`issuer-contract`,
"cannot authorize the download route", and `download.test.ts`, "checks fresh
identity…"): both built a download path without the setting. They pass
unchanged with it on. They are listed here because the standing rule is that
existing tests are not altered silently.

**Documentation**: this file, `MP4_MKV_DOWNLOAD_EMERGENCY_STOP.md` (new),
`MP4_MKV_ACTIVATION_READINESS.md`, `E3_8_CHANNEL_DISCOVERY.md` (reviewer
screen), `README.md` (one line), `IMPLEMENTATION_ROADMAP.md`.

**Dependencies installed:** none. **Migrations:** none.

## 2. Dashboard screenshots and test evidence

Screenshots are of synthetic candidates in the isolated browser fixture
(Playwright Chromium), not of hosted data. They are generated browser evidence
and, by the standing rule, are proposed to stay out of the commit.

| File in `docs/evidence/` | Shows |
| --- | --- |
| `checkpoint9-dashboard-pending-1440.png`, `-390.png` | A Policy 3 MKV as recorded today: two audio tracks, three subtitle tracks, pending, gates closed |
| `checkpoint9-dashboard-verified-1440.png` | Verified MP4, approved, account with the publish permission |
| `checkpoint9-dashboard-failed-1440.png` | A refused file with its reasons |
| `checkpoint9-dashboard-earlier-schema-1440.png` | A database without the Policy 3 update |

Logs: `checkpoint9-unit.log`, `-browser.log`, `-db.log`, `-integration.log`,
`-dashboard-validation.log`, `-gateway-validation.log`,
`-adapter-continuation.log`, `-build.log`, `-typecheck.log`, `-lint.log`.

## 3. Media status mapping

Source of each field, for a channel candidate (`discovery_review_get`):

| Shown | Available on hosted today (17 migrations) | Needs |
| --- | --- | --- |
| Original filename | Yes | |
| Original container | Yes | |
| Video codec, audio codec | Yes | |
| Inspection policy version | Yes | |
| Inspection timestamp | Yes | |
| Failure reasons | Yes | |
| Earlier policy's verdict (`verified`) | Yes | |
| Media integrity status | No | migration 7 |
| Streaming readiness status | Only as the earlier verdict | migration 7 for the separate fact |
| Browser compatibility status and per-browser list | No | migration 7 |
| Audio-track count, subtitle-track count | No | migration 7 |
| Playback warnings | No | migration 7 |
| The database's own media predicate (`publishable_media`) | No | migration 7 |
| Download availability | Yes (the server's switch and the candidate's state; not from the database) | |

For an admin upload (`admin_upload_get`): file name, media class, reasons and
policy version are in the current readback; container, codecs, track counts,
statuses, browser profile and warnings come with the assessment that migration
8 adds (which needs 1 to 6 and 7). The upload readback has no inspection time,
so it shows "Not reported".

Migration numbers are those of `MP4_MKV_ACTIVATION_READINESS.md`, section 1:
7 is `20261011192618_original_media_evidence`, 8 is
`20261011192619_admin_original_media_evidence`.

How a recorded value is shown:

| Recorded | Media integrity | Streaming readiness |
| --- | --- | --- |
| `verified` | Verified | Verified |
| `metadata_consistent` | Metadata consistent, not verified | |
| `potentially_playable` | | Potentially playable, not verified |
| `potentially_playable_startup_warning` | | Potentially playable, slow start, not verified |
| `untested` | | Untested layout, not verified |
| `incomplete` / `unverified`, file refused | Failed | Failed |
| `incomplete` / `unverified`, file could not be read | Inspection incomplete | Not verified |
| `legacy_unassessed`, earlier verdict passed | Not assessed | Verified by the earlier MP4 policy |
| `legacy_unassessed`, earlier verdict refused | Not assessed | Failed |
| field absent (no migration 7), earlier verdict passed | Not reported | Verified by the earlier MP4 policy |
| no evidence row | Not inspected | Not inspected |
| any other text | Unrecognised: (the text) | Unrecognised: (the text) |

"Could not be read" is a reason beginning `media_read_`, or `media_unreadable`,
`probe_timeout`, `moov_over_budget`. Every other reason is a property of the
file.

Browser compatibility: "Tested combination on desktop", "Browser-dependent",
"Limited in some browsers" (Firefox streaming unreliable, or picture with silent
audio), "Unknown", "Not reported", "Not inspected". It is always labelled as a
prediction that does not block publication.

Rules the mapping keeps, each with a test:

- Only the exact value `verified`, or the earlier policy's recorded verdict, is
  shown as verified.
- A missing field, a field of the wrong type and an unknown value are each
  shown as missing. None is shown as verified, and none stops the page.
- A Policy 3 inspection that accepted the file is "pending", never "failed" and
  never "verified".
- Track titles are not carried out of the database view. Only counts are.

**One existing behaviour was wrong for Policy 3 and is corrected.** An accepted
Policy 3 candidate would have read "Media check failed … Run the check again
once the file is fixed", and an accepted Policy 3 upload "Media: Failed". Both
now read as pending verification. This affects no candidate today: no Policy 3
evidence exists on hosted.

## 4. Publication readiness behaviour

The "Publication gates" section lists six requirements:

1. Media integrity verified
2. Streaming readiness verified
3. Film identity confirmed
4. VJ identity confirmed
5. Rights clearance approved
6. Final publication approval granted

- Requirements 3 to 5 are the database's own gates, as before.
- Requirements 1 and 2 are the two halves of the database's single media gate.
  Under Policy 3 each is done only when its own fact is `verified`. Under the
  earlier policy both follow the database gate together with the recorded
  verdict. If both read verified and the database still reports the media gate,
  the gate is listed under "Also blocking".
- Requirement 6 is done when this revision is approved, or the candidate is
  published. An approval of an older revision is shown as such and is not done.
- Browser compatibility is not a requirement. The section says so, and a
  verified file with a playback warning is offered for approval like any other
  (tested).

The screen adds no authorization path. Approve is offered when the database
reports no gate and the account has the review capability; Publish when this
revision is approved and the account has the publish capability; the rights
form when the account has the rights capability. Those conditions are
unchanged, and the database checks each action again.

Proven against real SQL (`scripts/checkpoint9-validation.mts`):

- Six real Policy 3 inspections of the committed fixtures: with rights
  recorded, the only gate left is the media gate, for all six alike, whatever
  their browser warnings. Approval is refused (`review_gates_not_met`),
  publication is refused (`catalogue_not_approved`), no movie row is created.
- No Policy 3 evidence row is verified, in any column.
- On the hosted-equivalent schema the earlier publication path still works end
  to end, and each account is refused outside its own capability.

## 5. Download feature-switch behaviour

`MEDIA_GATEWAY_DOWNLOADS_ENABLED`, on two servers. Full procedure:
`MP4_MKV_DOWNLOAD_EMERGENCY_STOP.md`.

| Requirement | How it is met |
| --- | --- |
| Disabled by default | Off unless exactly `true`. A gateway or issuer built without the setting refuses downloads |
| Controls capability issuance | `POST /api/media/download-token` answers `503 downloads_disabled` before the session or the catalogue is read |
| Controls request admission | The gateway answers `503 downloads_disabled` before the token is read; no limiter, catalogue or Telegram work |
| Existing authorization stays mandatory | Switched on, every earlier check runs unchanged (tested) |
| Streaming unaffected | The stream route and the stream issuer never read it (tested, also in six browsers) |
| No browser-only enforcement | Both server sides refuse a request made by hand; the page's control is only hidden as a courtesy |
| No automatic activation | Nothing sets it. `TRUE`, `1`, `yes` are off on the web side and stop the gateway at startup |
| No secret exposed | The browser receives a boolean. The variable is never `NEXT_PUBLIC_` |
| Existing transfers follow the documented rules | Turned off during a transfer: the transfer completed byte-identical, new and resumed requests were refused, and a revocation still ended a running transfer (tested) |

Limits, stated plainly:

- **The gateway reads the setting at startup.** Changing the gateway's copy
  needs a restart, which cuts running transfers and interrupts playback after
  the 15-second grace. The quiet stop is the web side's copy: no new capability,
  and admission ends within the 10 minutes an issued capability lasts. A switch
  the gateway could change while running was not built.
- Two places to set. Both are in the readiness checklist.
- While the switch is off, some player messages still say "download the
  original file" (for example after slow metadata), with no Download control on
  the page. Signed-out viewers already see those messages without a control.
  The wording was left as it is; changing it is a small follow-up.

The gateway change is narrow: one optional dependency, one early return, one
error code, one configuration field, one startup log line.

## 6. Security review

Reviewed: the new modules, every changed line of the gateway and issuer, and
the reviewer screen's output.

- **No new privilege.** No migration, role, grant, RPC, server action, route or
  admin page. `lib/discovery/security.test.ts` still finds the same eleven
  guarded admin files, each calling the authorization guard.
- **No new publication path.** The requirements list is read-only. Buttons and
  their conditions are unchanged (section 4).
- **Reviewer permissions and rights separation** unchanged, and re-proven on
  both schemas: anonymous, a signed-in non-reviewer, review-only, rights-only
  and publish-only accounts are each refused outside their capability.
- **RLS and restricted roles** untouched. The database suites pass unchanged
  (20 suites, 1,098 assertions).
- **Audit records** untouched. The screen writes nothing.
- **Identifiers.** The panel shows no Telegram file identifier, document
  identity, channel identifier or track title (tested on the rendered page and
  on the parsed view).
- **One existing exposure removed.** The review screen printed the Movies
  channel's numeric identifier to reviewers ("Channel -100…, message N"). It
  now prints "Movies channel, message N". The identifier is still in the data
  the server holds for the page; it is no longer rendered. This is a change to
  existing UI, made because the brief forbids exposing private channel
  identifiers on this screen.
- **Malformed data.** A Policy 3 field of the wrong shape is dropped and shown
  as "Not reported"; it cannot raise an error on the page or be read as
  verified (tested).
- **The switch fails closed** at every level: environment parsing, gateway
  construction, issuer construction.
- **Refusals reveal nothing.** With the switch off, every download request gets
  the same answer whether its token is valid, expired, forged or absent.
- **Not reviewed here:** hosted configuration, a deployed gateway, Supabase
  advisors. None was reachable under this authorization.

Observation, not a defect: the reviewer screen names the environment variable
of the switch. It is a name, shown only to signed-in admins.

## 7. Database dependencies

None to deploy the dashboard or the switch.

| To see | Apply first |
| --- | --- |
| The panel with earlier-policy facts, the six requirements, the switch status | nothing (hosted 17) |
| Policy 3 statuses, track counts, browser profile, warnings for channel candidates | migration 7 |
| The same on the upload page | migrations 1 to 6, then 7, then 8, and `VELORA_ADMIN_UPLOADS_ENABLED` |
| A working download | migration 9, the rebuilt gateway, and the switch on both sides |

The developer `next dev` server hot-reloads this working tree against hosted
data. That is the case validated on the hosted-equivalent schema: the screen
renders and reports the Policy 3 facts as not reported. The Download control is
no longer shown there.

## 8. Test results

All runs on 2026-10-14, Windows, this working tree.

| Gate | Result |
| --- | --- |
| Typecheck (`npm run typecheck`) | Pass |
| Lint (`npm run lint`) | Pass |
| Unit (`npx vitest run`, with the two media tool paths set) | **1,176 passed**, 0 failed, 0 skipped, 66 files (was 1,130; 46 new) |
| Browser (`npx playwright test`, six projects) | **204 passed**, 0 failed, 24 skipped (was 174; 30 new). The 24 skips are the existing ones |
| Database suites (`npm run test:db:isolated`) | 20 of 20 suites, 1,098 assertions |
| Checkpoint 9 validation (`scripts/checkpoint9-validation.mts`) | Pass on 17 and on 26 migrations |
| Checkpoint 5 validation (real restricted adapter) | Pass, 13 fixtures byte-identical |
| Checkpoint 8 validation (continuation and revocation) | Pass, 2 fixtures, 7 revocations |
| Integration (`npm run test:integration:isolated`) | 44 passed, 1 skipped (the existing exclusion) |
| Production build (offline, isolated database) | Pass, 19 static pages |

Every Docker-dependent gate used only the disposable `velora-e38a-*`
containers, which were removed afterwards. The persistent containers were
running and were not touched.

The brief's test list, and where each is covered:

| Case | Unit | Rendered page | Real SQL | Browser |
| --- | --- | --- | --- | --- |
| MP4 verified profile | yes | yes | not producible (see below) | yes |
| MKV verified profile | yes | yes | not producible | |
| Unknown inspection profile | yes | yes | | yes |
| Failed media integrity | yes | yes | | yes |
| Failed streaming readiness | yes | yes | yes (earlier policy) | |
| Browser warning with otherwise verified media | yes | yes | yes (warnings never change a gate) | |
| Multiple audio tracks | yes | yes | yes (real fixture, 2 tracks) | yes |
| Embedded subtitles | yes | yes | yes (real fixture) | yes |
| Missing Policy 3 database functions | yes | yes | yes (17 migrations) | yes |
| Unauthorized admin access | existing guard tests | | yes (anonymous, non-reviewer) | |
| Reviewer without publishing permission | | yes | yes | yes |
| Download switch disabled | yes | yes | | yes |
| Download switch enabled in isolated tests | yes | yes | yes (checkpoints 5 and 8) | yes |
| Existing streaming unaffected | yes | | | yes |

**Not producible:** "verified" Policy 3 evidence. The database contract refuses
it and no worker can record it (Checkpoint 4). The verified cases are therefore
built as review-model or view JSON in tests. What the real database returns for
a real inspection is "metadata consistent" and "potentially playable".

**Found by the tests and fixed before this report:**

- A horizontal overflow at 768 px: the setting's long name did not wrap inside
  the status card. Found by the browser layout test; the text now wraps.
- The upload page's status row read "Failed" for an accepted Policy 3 upload.
- The validation script first posted fixtures under their fixture file names,
  which the title parser cannot review; they are now posted under ordinary
  release names. A test-data error, not a product defect.

**Tooling note.** `scripts/checkpoint9-validation.mts` needs
`node --experimental-transform-types`: it imports `lib/discovery/database.ts`,
which uses a constructor parameter property that plain type stripping does not
accept. The earlier validation scripts do not import that module.

No test failed intermittently in these runs. Each gate was run once after the
last code change, except the reviewer-screen browser tests, which were run
twice (once alone, once in the full suite).

## 9. Remaining browser and device limitations

- The reviewer screen was rendered in the installed Chrome and Edge and in
  Playwright's Chromium, Firefox and WebKit builds, on Windows only, at 360, 390, 430, 768, 1024 and 1440
  px, in the dark and light themes, with synthetic candidates.
- **Not tested:** Safari on macOS, any iPhone or Android browser, a touch
  device, a screen reader, and the screen against hosted data with a real
  admin session. Playwright WebKit is not Safari.
- The upload detail page was tested as server markup only, not in a browser.
- Colour contrast of the status chips was not measured; they use the existing
  tokens and each status carries text and an icon, not colour alone.
- The player and download limitations of Checkpoints 1 to 8 are unchanged:
  Safari, iOS and Android remain **not tested** and remain the pre-launch gate.

## 10. Git status

`HEAD` is `61387ac` on `phase-a-foundation`, 15 local commits ahead of
`veloraug/phase-a-foundation`. Nothing is staged and nothing was pushed.

```text
 M .env.example                    (pre-existing edit, untouched, never staged)
 M README.md
 M app/admin/discovery/[id]/page.tsx
 M app/admin/uploads/[id]/page.tsx
 M app/api/media/download-token/route.ts
 M app/movies/[slug]/page.tsx
 M components/admin-upload-page.test.tsx
 M components/discovery-review.test.tsx
 M components/discovery-review.tsx
 M components/movie-player.test.tsx
 M components/movie-player.tsx
 M docs/E3_8_CHANNEL_DISCOVERY.md
 M docs/MP4_MKV_ACTIVATION_READINESS.md
 M IMPLEMENTATION_ROADMAP.md
 M lib/discovery/database.ts
 M lib/discovery/guidance.ts
 M lib/discovery/model.ts
 M lib/media-gateway/config.test.ts
 M lib/media-gateway/config.ts
 M lib/media-gateway/download.test.ts
 M lib/media-gateway/download.ts
 M lib/media-gateway/errors.ts
 M lib/media-gateway/issuer-contract.test.ts
 M lib/media-gateway/server.test.ts
 M lib/media-gateway/server.ts
 M lib/playback/download-token.test.ts
 M lib/playback/download.test.ts
 M lib/playback/download.ts
 M lib/playback/stream-capability.ts
 M lib/playback/stream-token.ts
 M lib/uploader/admin-upload.test.ts
 M lib/uploader/admin-upload.ts
 M scripts/checkpoint5-validation.mts
 M scripts/checkpoint8-validation.mts
 M scripts/media-gateway-dev.mjs
 M services/media-gateway/main.mts
 M tests/browser/harness.ts
 M tests/browser/player-fixture.tsx
 M tests/browser/player-harness.ts
 M tests/browser/player.spec.ts
?? components/media-verification.tsx
?? docs/MP4_MKV_CHECKPOINT_9.md
?? docs/MP4_MKV_DOWNLOAD_EMERGENCY_STOP.md
?? lib/discovery/media-report.test.ts
?? lib/discovery/media-report.ts
?? scripts/checkpoint9-validation.mts
?? tests/browser/admin-fixture.tsx
?? tests/browser/admin.spec.ts
?? docs/evidence/checkpoint9-*.log      (10 files)
?? docs/evidence/checkpoint9-*.png      (5 files)
```

Also untracked, from earlier checkpoints and still excluded: the Checkpoint 6,
7 and 8 browser evidence.

**Proposed manifest for a later commit, if approved:** the 39 modified paths
above except `.env.example`, the eight new source and documentation paths, and
nine of the ten logs. Proposed to stay out: `checkpoint9-browser.log` and the
five screenshots (generated browser evidence), unless one is wanted to
substantiate this report.

## 11. Remaining activation blockers

Unchanged from Checkpoint 8 unless marked.

1. Production gateway hosting is undecided, and with it the trusted-proxy
   change for client addresses.
2. The gateway image must be rebuilt: now also to carry the switch.
3. Migration 9 is not applied (downloads). Migration 7 is not applied (Policy 3
   facts on the dashboard and for the listener). Migrations 1 to 6 and 8 are
   not applied (admin uploads).
4. A new original still cannot be published: no verification contract or
   producer exists. The dashboard shows this state; it does not resolve it.
5. Safari, iOS and Android are not tested.
6. Partial files are lost when a connection drops after a link's ten minutes.
7. **New, small:** the switch has to be set on two servers, and the gateway's
   copy changes only on restart.
8. **New, small:** `.env.example` does not list the switch (file not touched by
   rule).
9. The reviewer screen has not been opened against hosted data.
10. The Telegram backlog restrictions stand: no reinspection, no canary, no
    relabelling of recorded results.

## 12. Recommendation for Checkpoint 10

Controlled end-to-end validation, in steps that each need their own approval.
Nothing below is started.

1. **Review and commit Checkpoint 9** from the manifest in section 10.
2. **Decide the verification contract first, or scope it out.** Without it,
   end-to-end validation of a *new original* can only end at "Verification
   pending". If Checkpoint 10 is meant to reach a published original, the
   contract and its producer are a prerequisite and deserve their own
   checkpoint. If it is meant to validate everything up to that gate, say so in
   the brief.
3. **Isolated rehearsal of the whole path** with the existing fixtures:
   detection, Policy 3 inspection, review, rights, the closed media gate,
   streaming and download of an already published fixture with the switch on,
   then the switch off. Most parts exist; Checkpoint 10 would join them in one
   run and one report.
4. **Hosted, read-only first:** confirm the migration history is still the
   recorded 17, and open the reviewer screen against hosted data with the
   owner watching. No write.
5. **Then, separately approved:** migration 7 on a restored copy and on
   hosted, by the migration 17 procedure; the listener image; and only after
   that the single-candidate canary on Movies channel message 46, through a
   path that cannot land on another film.
6. **Message 50 (In Cold Light)** keeps its recorded `mp4_not_fast_start`
   result throughout. What Policy 3 would say about that file comes only from a
   new, approved inspection.
7. Downloads stay switched off for all of Checkpoint 10 unless the brief says
   otherwise. Gateway hosting, migration 9 and the device tests come first.

Decisions needed from the owner:

- Whether the six existing-test set-up edits in section 1 are accepted.
- Whether the channel identifier's removal from the review screen is wanted.
- Whether Checkpoint 10 includes the verification contract or stops at the
  media gate.
- Whether the screenshots stay out of the commit.
