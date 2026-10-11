# MP4/MKV Checkpoint 7: activation safety and release preparation

2026-10-12. **Local review, one player fix, documents and isolated validation
only.** Nothing was activated. No migration was applied to a hosted or persistent
database, no listener was rebuilt or restarted, no Telegram call was made, no
movie was uploaded, replaced, reinspected or published, and nothing was staged,
committed, pushed or deployed. E3.9 remains a provisional label.

Sections 1 to 10 are the record as it stood at the Checkpoint 7 approval gate.
**Section 11 is the final close-out** that followed: the WebKit test fix, the
final browser results, the download continuation decision and the local commit.
Where the two differ, section 11 is the later state.

Branch `phase-a-foundation` at `972a41b` (Checkpoints 4 and 5). Checkpoint 6 was
uncommitted in the working tree and stays so. `.env.example` still has SHA-256
`86e57706…a73f8`; `.env.local` and `.claude/` were not edited.

Preflight: read the Checkpoint 4, 5 and 6 reports, `MP4_MKV_NATIVE_PLAYBACK.md`
and the roadmap. Confirmed the Codex session that wrote Checkpoint 6 had not
resumed. Re-read the Checkpoint 6 diff and its final evidence: every final run
started after the last source edit and passed as recorded. One recorded pass is
not repeatable; see "Test results".

## 1. Activation and revocation findings

### The flow as built

| Step | Where it is enforced | What is checked |
| --- | --- | --- |
| Playback capability | `POST /api/media/stream-token` | Same-origin JSON of at most 256 bytes, strict schema, verified session, entitlement, catalogue. 30 requests per user per minute |
| Download capability | `POST /api/media/download-token` | The same handler, plus a call to the Auth server for the current user, who must match the session and not be anonymous |
| Entitlement | `hasStreamingEntitlement` | Interim rule until Phase F: every signed-in user |
| Publication at issuance | Public read policy on `movie_versions` | Published movie, ready and rights-cleared version, active VJ |
| Capability | HMAC-SHA256, shared secret | One operation, one version, one subject, 600 seconds. Operation swaps, other versions, tampering, expiry and over-long lifetimes are refused before any database or Telegram work |
| Publication at delivery | Gateway resolver, restricted database role | Stream: on every range request. Download: at the start and every 30 seconds |
| User at delivery | `resolve_movie_download` | Download only: the subject must be a real, non-anonymous, non-deleted, non-banned user |
| Expiry at delivery | Gateway | Stream: at each range request. Download: the response is ended at expiry |
| Continuation | Issuer, then gateway | A new capability from a current session, then `Range` with `If-Range`. An old capability cannot be exchanged |
| Failures | Gateway | Reader, catalogue and Telegram failures answer 502, 503 or 504 before any byte, or cut the connection after the headers |

### Unpublished media cannot be streamed or downloaded

Confirmed. No code path names Telegram media from a client; a client can name
only an internal version id, and both resolvers return no row unless the version
is published, ready, rights-cleared and under an active VJ. Evidence from this
checkpoint's runs:

- Database, 20 suites and 1,098 assertions, all passing. Suite 008: draft movie
  and inactive VJ give no row, and the gateway role cannot unpublish or change
  rights. Suite 020: unpublished, revoked rights, inactive VJ, and banned,
  deleted and anonymous users are each denied.
- The real restricted adapter with the gateway core: a banned user and an
  unpublished version were denied with **zero** media reads.
- Gateway unit tests: "serves nothing for an unpublished or unknown version,
  even with a valid token", "rechecks publication on every request", "token
  expiry terminates an active response and frees admission", "authorization
  database outage during transfer cuts off access", "active media replacement
  fails closed".
- An entitled caller learns only "unavailable" for every unplayable version, so
  the endpoints cannot be used to list the catalogue.

### Revocation bounds

| Revoked | Playback | Download |
| --- | --- | --- |
| Publication, rights, VJ | New capabilities: at once. Delivery: the next range request. A response already in flight can finish, at most 8 MiB or 120 seconds | New capabilities: at once. Delivery: within about 35 seconds (30-second recheck plus a 5-second deadline) |
| Authorization database unreachable | Fails closed at the next request | Fails closed within the same 35 seconds |
| Sign-out | No new capability. The current one works until it expires, at most 10 minutes | The same, and the transfer ends at expiry |
| Account banned or deleted | **Weaker: see finding 2** | New capabilities: at once. Delivery: within about 35 seconds |

These match the documented bounds, except for finding 2, which was not written
down before.

### Findings

No finding weakens a control, and no control was changed.

1. **A download must finish inside one ten-minute capability. Blocker for
   activating downloads.** The gateway ends the response at expiry, and the
   page's retry opens a new URL, which a browser treats as a new download from
   byte 0. A viewer below the required rate can never complete a file by
   retrying: 1.68 MB/s (about 13.4 Mbit/s) for On The Hunt, 3.20 MB/s (about
   25.6 Mbit/s) for Call of Heroes. Earlier reports said a browser "may restart";
   none stated this consequence. Options are in the readiness checklist,
   section 11. It needs a product decision. Nothing was changed.
2. **A banned or deleted account keeps streaming until its access token
   expires.** The stream issuer trusts the verified session claims and the
   stream resolver does not look at the user. The bound is the project's
   access-token lifetime (not read from hosted; the Supabase default is one
   hour) plus up to ten minutes. Downloads do not have this gap. Under the
   interim "every signed-in user" rule this is a consistency gap, not a breach.
   It must be closed when Phase F adds subscriptions.
3. **Downloads need the gateway's allowed-origins setting; playback does not.**
   The readiness probe is a cross-origin read. Without the setting every
   download fails with "Could not reach the download service". This was already
   an open item for the hosted gateway and is now a hard prerequisite.
4. **The per-address limits collapse behind a proxy.** The gateway uses the
   socket peer address and trusts no forwarding header. Behind a proxy or tunnel
   the defaults become totals for everyone: 6 streams and 2 downloads.
5. **The order of deployment decides the message.** Web before gateway or before
   migration 9 shows a Download button that fails safely, but two of the three
   messages are misleading (checklist, section 2).
6. **`/readyz` does not cover downloads, and there is no runtime switch for
   them.** A gateway is ready with the download resolver absent. Stopping
   downloads means redeploying the previous image or a new migration.
7. **After activation both published titles will most likely show "untested".**
   The public profile returns facts only for versions with recorded inspection
   evidence. Both titles came through the command-line uploader, which records
   none in the database. To be confirmed by a read-only check.
8. **A new original still cannot be published.** Policy 3 evidence never
   satisfies the publication predicate. This is by design and already recorded;
   it means activation changes nothing for new MP4 or MKV uploads until a
   verification contract exists.
9. **The capability travels in the URL.** The gateway logs no token and sends
   `Referrer-Policy: no-referrer`. A proxy in front must not log query strings.
10. **Per-instance limits.** The issuer's 30 requests per minute and the
    gateway's admission are per process. Serverless instances multiply the
    first; a second gateway instance would multiply the second.

## 2. Loading watchdog investigation

**What the 30-second deadline does.** It runs while the state is `loading` or
`buffering`, and reports slow metadata or a connection failure when it fires.

| Situation | Before this checkpoint | Now |
| --- | --- | --- |
| Automatic start refused | State stays `loading` with "Loading…". If the first frame is also held back, the player is **closed after 30 seconds** with the connection error | State is `paused`, no "Loading…", player stays open |
| Metadata loaded, playback not started | The same failure, when it follows a refused start | Paused, waiting |
| Viewer has not pressed the native play control | The same | Paused, waiting, for as long as they like |
| Decoder stall while playing | Connection message after 30 seconds of `buffering` | Unchanged |
| Network stall | Slow-metadata message before metadata, connection message after | Unchanged |
| Gateway error | `error` event, then the existing diagnosis | Unchanged |
| Expired capability | One renewal, then a message | Unchanged |

**Can it be reproduced?** Not in a real desktop engine. A probe refused the
automatic start in the real player in all six projects. Chrome, Edge, Chromium,
Firefox and Playwright WebKit all still raised `loadeddata` for MP4 with
`preload="metadata"`, so the state left `loading` and the deadline never applied.
(Playwright WebKit with MKV loaded nothing and got the slow-metadata message,
which is correct.)

**Clearly demonstrated by a deterministic test.** The failure needs a browser
that refuses the start **and** holds back the first frame until playback begins,
which is how iOS Safari is documented to behave. Two new browser tests model
exactly that with real transport and decoding: `play()` rejects with
`NotAllowedError`, and `loadeddata` and `canplay` are withheld. On the unchanged
Checkpoint 6 code they failed in **all six projects, 12 of 12**: "Loading…" was
shown, and after 30 seconds the player was removed and the connection error
appeared (`evidence/checkpoint7-watchdog-before-fix.log`). This is a model, not
a Safari result.

**The correction, minimal.** A `play()` promise rejected with `NotAllowedError`
now moves the player to `paused`, through the existing `media_paused`
transition. The deadline itself, its length, the reducer and every recovery path
are untouched. Other rejections (an aborted load, an unsupported source) are not
treated as refusals. Changes: `isAutoplayRefusal` in `lib/playback/player.ts`,
and the two `play()` calls in `components/movie-player.tsx`.

When the viewer then presses the native control and the next frame is not
available, the element raises `waiting`, the state becomes `buffering`, and the
30-second deadline applies from that moment. So the bound on loading is kept.

**Regression coverage.**

- Browser, six projects: "a refused automatic start waits for the viewer: it is
  not shown as loading or closed by the loading deadline", which also starts
  real playback afterwards, and "after a refused automatic start, the loading
  deadline still applies once the viewer has pressed play". 12 of 12 pass after
  the fix (`evidence/checkpoint7-watchdog-after-fix.log`).
- Unit: the refusal is recognised only for `NotAllowedError`; a refused start
  leaves the capability, has no failure, and follows the normal path afterwards.

**Not established.** Whether iOS Safari actually refuses the start after the
capability request, and whether it withholds the first frame. Cases A1 to A6 of
the device test plan decide it.

## 3. Operational readiness checklist

`docs/MP4_MKV_ACTIVATION_READINESS.md`. Thirteen sections: the nine undeployed
migrations and their order, frontend compatibility, gateway deployment, the
listener image, rollback, health checks, logging, browser limits, download
integrity, resources, the ten-minute deadline, the rights and publication gates,
and the order of activation. Each line is marked Proven, Open or Blocked.

The brief names six R2 migrations and two Policy 3 migrations. There is a ninth:
the download resolver, which is the only one downloads need.

## 4. Real-device test plan

`docs/MP4_MKV_DEVICE_TEST_PLAN.md`. It separates what was executed (Windows,
automated, synthetic fixtures) from what needs a device, and covers Safari on
macOS, Safari on iPhone, Chrome and Firefox on Android, and Edge on Windows:
playback, audio, seeking, automatic start, buffering, renewal, downloads and
interrupted transfers. **None of its device cases has been run.**

A prerequisite it records: a phone cannot reach the loopback test host, and the
production issuer refuses a non-loopback plain-HTTP gateway. Device tests need
either a LAN mode for the test host (a small change, not made) or a staging
gateway on HTTPS. Both need approval.

## 5. Roadmap updates

`IMPLEMENTATION_ROADMAP.md`, the E3.9 entry only:

- The heading now reads Checkpoints 0 to 7, local only, nothing activated, and
  says the label is provisional.
- Four bullets for Checkpoints 1 to 3 had been appended after the last section
  of the file. They were moved, unchanged, under the E3.9 entry.
- Added: Checkpoint 4, Checkpoint 5, Checkpoint 6, Checkpoint 7, "State after
  Checkpoint 7" and "Numbering".

No other section was edited. `MP4_MKV_NATIVE_PLAYBACK.md` gained one table row
for Checkpoint 7, and the Checkpoint 6 report's watchdog limitation now points
here.

## 6. Test results

All on this machine, isolated. Disposable `velora-e38a-*` containers only; they
were removed afterwards, and the running listener, Bot API and local Supabase
containers were not touched.

| Gate | Result | Evidence |
| --- | --- | --- |
| Database security and boundary suites | 20 of 20 suites, 1,098 assertions | `checkpoint7-db.log` |
| Real restricted adapter with gateway core | Pass: 13 fixtures byte-identical; ban and unpublished denials with no media read; 17 plus download resolver alone | `checkpoint7-gateway-validation.log` |
| Integration | 44 passed, 1 skipped (needs an Auth server the harness does not have) | `checkpoint7-integration.log` |
| Unit, full | 1,105 passed, 0 failed, 0 skipped | `checkpoint7-unit.json` |
| Browser, full, six projects | **143 passed, 1 failed, 24 skipped** (the opt-in startup measurements) | `checkpoint7-browser.{log,json}` |
| Typecheck | Pass | `checkpoint7-typecheck.log` |
| Lint | Pass | `checkpoint7-lint.log` |
| Production build, offline | Pass, with the same single Turbopack warning as Checkpoints 5 and 6 | `checkpoint7-build.log` |
| Private-value scan of uncommitted files | 93 files, 19 values, 0 matches | Not saved: output is one line |

### The one browser failure

`[webkit] missing picture, missing audio and slow metadata have distinct bounded
fallback messages`. It is an existing Checkpoint 6 test, not one of the new ones.
Its last step expected the connection message and got the slow-metadata message.

| Run | WebKit, 10 repeats |
| --- | --- |
| With this checkpoint's fix | 4 passed, 6 failed |
| With the fix temporarily reverted | 2 passed, 8 failed |
| Temporary copy of the test that waits 250 ms before injecting its events | 10 passed |

So the failure does not come from this checkpoint's change. The test injects
`loadedmetadata` as soon as the `<video>` element exists. In WebKit the effect
that attaches the source can run after that, and it resets the "metadata loaded"
flag, so the deadline reports slow metadata. A real element cannot raise
`loadedmetadata` before its source is attached, so the player is not affected.

Consequences, stated plainly:

- Checkpoint 6 recorded 54 of 54 for the player cases. That run did pass, but
  this case passed once by timing. It is not repeatable in WebKit.
- **The test was not modified at this gate.** The proposed change was one wait
  before the synthetic events in that test's last step, held for approval because
  it changes an existing test. It was approved and made at the final close-out
  (section 11).

Evidence: `checkpoint7-webkit-synthetic-with-fix.log`,
`-without-fix.log` and `-diagnostic.log`. The temporary copy was deleted.

### Other notes on the runs

- The watchdog tests were run first against unmodified code and failed 12 of 12
  as intended. That is the demonstration, not a defect in the run.
- A temporary probe spec (18 cases, all passed) recorded how each engine behaves
  when the start is refused. It was deleted after use.
- `scripts/discovery/secret-scan.mjs` stopped with `EISDIR` on this tree before
  scanning. It was not changed. The scan above applies the same rule to the
  uncommitted files only. Compressed archives are not searched by either.
- Not run: the gateway service typecheck (no service file changed), `db lint`
  and the security advisors (they need a database outside this authorization),
  headed browser runs, and the opt-in startup measurements.

## 7. Exact files changed by Checkpoint 7

Source and tests:

- `components/movie-player.tsx` (refused start becomes paused)
- `lib/playback/player.ts` (`isAutoplayRefusal`)
- `lib/playback/player.test.ts` (three tests)
- `tests/browser/player.spec.ts` (two tests and their helper; and the layout
  test now writes its two screenshots to the ignored test output folder instead
  of overwriting `evidence/checkpoint6-player-*.png` on every run, which does not
  affect any assertion)

Documents:

- `IMPLEMENTATION_ROADMAP.md`
- `docs/MP4_MKV_NATIVE_PLAYBACK.md` (one table row)
- `docs/MP4_MKV_CHECKPOINT_6.md` (final results and hand-over section, written
  when the Codex session stopped; pointer to this report)
- `docs/MP4_MKV_CHECKPOINT_7.md` (new, this report)
- `docs/MP4_MKV_ACTIVATION_READINESS.md` (new)
- `docs/MP4_MKV_DEVICE_TEST_PLAN.md` (new)

Evidence, all new, under `docs/evidence/`: `checkpoint6-git-status.txt`, and
`checkpoint7-` `browser.json`, `browser.log`, `build.log`, `db.log`,
`gateway-validation.log`, `integration.log`, `lint.log`, `typecheck.log`,
`unit.json`, `unit.log`, `watchdog-before-fix.log`, `watchdog-after-fix.log`,
`webkit-synthetic-with-fix.log`, `webkit-synthetic-without-fix.log`,
`webkit-synthetic-diagnostic.log`, `git-status.txt`, `stage.pathspec` and
`stage-browser-evidence.pathspec`.

No package manifest, lockfile, migration, service file or environment file
changed. No dependency was added.

## 8. Staging manifest

**Nothing is staged.** The index is empty.

Checkpoints 1 to 5 are already committed and need no staging:

| Commit | Checkpoints | Files |
| --- | --- | --- |
| `fe540fe` | 1 | 28 |
| `226cfc2` | 2 and 3 | 46 |
| `972a41b` | 4 and 5 | 58 |

Together they change 130 files since `f838c93`, 47 of them evidence. None is
`.env.example` or under `.claude/`.

Uncommitted, Checkpoints 6 and 7: 93 paths.

| Group | Paths | Where listed |
| --- | --- | --- |
| Source and tests | 18 | `evidence/checkpoint7-stage.pathspec` |
| Documents | 6 | the same |
| Evidence that is not browser output | 35 | the same |
| Browser-generated evidence | 33, about 1.0 MB | `evidence/checkpoint7-stage-browser-evidence.pathspec` |
| Excluded | 1: `.env.example` | neither |

The 18 source and test paths: `app/movies/[slug]/page.tsx`,
`components/movie-player.tsx`, `components/movie-player.test.tsx`,
`lib/catalogue.ts`, `lib/supabase/database.types.ts`, `lib/playback/player.ts`,
`lib/playback/player.test.ts`, `lib/playback/compatibility.ts`,
`lib/playback/compatibility.test.ts`, `lib/playback/download.ts`,
`lib/playback/download.test.ts`, `playwright.config.ts`,
`tests/browser/harness.ts`, `tests/browser/tsconfig.json`,
`tests/browser/player-fixture.tsx`, `tests/browser/player-harness.ts`,
`tests/browser/player.spec.ts` and
`tests/integration/direct-channel-publication.test.ts`.

**One decision for you.** The brief excludes generated browser output. Read
literally, that covers the 33 browser logs, JSON results, the result archive and
the two screenshots, so the default manifest leaves them out. The three earlier
commits did include files of exactly this kind, and the Checkpoint 6 and 7
reports cite these 33 by name. If you want them tracked, add the second file.

```sh
# Default: source, tests, documents, non-browser evidence (59 paths)
git add --pathspec-from-file=docs/evidence/checkpoint7-stage.pathspec
# Optional: the 33 browser-generated evidence files
git add --pathspec-from-file=docs/evidence/checkpoint7-stage-browser-evidence.pathspec
```

Every entry is a literal path, so `[slug]` is not read as a pattern. A dry run of
both files adds exactly the listed paths. Never part of either: `.env.example`,
`.claude/`, `.env.local`, `test-results/`, `tests/browser/.results/`, `.next/`
and anything else Git already ignores. No secret or private identifier was found
in any of the 93 paths.

## 9. Git working-tree status

`evidence/checkpoint7-git-status.txt`. Branch `phase-a-foundation` at `972a41b`,
12 commits ahead of its remote, nothing staged. 13 tracked files are modified:
the 12 from Checkpoint 6 (one of them the pre-existing `.env.example`) and
`IMPLEMENTATION_ROADMAP.md`. The rest are untracked: 4 documents, 8 source and
test files, and the evidence files.

**Working-tree exposure.** The `next dev` process started before Checkpoint 6 is
still running from this tree and hot-reloads it. The player fix is client-side
and reads nothing new, so it adds no exposure beyond what the Checkpoint 6
report describes.

## 10. Remaining blockers before activation

1. **Download deadline decision** (finding 1; checklist section 11).
2. **Production gateway hosting**, with allowed origins, HTTPS, a single
   instance and the proxy questions settled (findings 3 and 4).
3. **Real-device tests**, and before them a host the devices can reach.
4. **The migrations**: fresh hosted baseline check, backup, restore rehearsal
   and advisors for each selected group. None has been run against hosted.
5. **A verification contract for Policy 3**, or new originals stay unpublishable.
6. **Listener image**: rebuild, then the isolated lease-release test, only after
   migration 7.
7. **Smaller items**: a download smoke check after deploy, whether a runtime
   switch is wanted, the banned-account gap before Phase F, the approval for the
   one WebKit test, and the owner's confirmation of the E3.9 label.

Stop here. Approval is required before committing, applying migrations,
restarting services or deploying. No commit was created.

## 11. Final close-out (2026-10-12)

Authorized as local-only stabilization and commit preparation. No migration was
applied, no container or listener was restarted, no Telegram operation was made,
and nothing was pushed or deployed. No production player code changed in this
close-out.

### 11.1 WebKit regression: the synchronization change

One existing test changed, `tests/browser/player.spec.ts`, "missing picture,
missing audio and slow metadata have distinct bounded fallback messages". No
assertion was changed, removed or weakened, and WebKit is not skipped.

- **Cause** (section 6). The test injected media events as soon as the
  `<video>` element existed. The player's effect that attaches the source could
  run after that in WebKit, and it resets the "metadata loaded" flag.
- **Change.** The test already replaces `play()` with a stand-in. The player
  calls `play()` in the same effect that attaches the source, immediately after
  the reset. The stand-in now also sets `data-source-attached` on the element,
  and the test waits for that attribute before each of its three injections.
  This is a wait for DOM state, not for time. A real element cannot raise media
  events before its source is attached, so the test now models the browser
  correctly.
- **Player code.** Unchanged. No player defect was reproduced: the race exists
  only between the test's injected events and the effect.

| Run | Result |
| --- | --- |
| That test in WebKit, 20 consecutive repetitions | **20 passed, 0 failed** |
| The same test before the change, 10 repetitions (section 6) | 4 passed, 6 failed |
| Complete browser suite, six projects | **144 passed, 0 failed, 0 flaky, 24 skipped** in 7.9 minutes |
| Per project | 24 passed and 4 skipped in each of Chrome, Edge, software-decode Chrome, Chromium, Firefox and WebKit |
| Typecheck and lint on the final tree | Pass |

The 24 skipped cases are the opt-in startup measurements, as in every earlier
run. There were no failures and no reruns in this close-out. Not repeated,
because nothing they cover changed: the unit suite (1,105 passed), the database
suites, the integration suite and the production build.

Evidence, kept on disk and not committed: `checkpoint7-final-webkit-repeat.log`
and `checkpoint7-final-browser.{log,json}`. `checkpoint7-typecheck.log` and
`checkpoint7-lint.log` were regenerated on the final tree.

### 11.2 Download continuation decision

Adopted on 2026-10-12 for the next implementation checkpoint. **Not implemented
here.** Until it is, the code behaves as section 1 describes: a download is cut
at ten minutes, and downloads must not be activated.

The decision:

1. The capability lifetime stays at ten minutes.
2. A transfer authorized before expiry may continue beyond expiry.
3. New and resumed requests require fresh authentication and a new capability.
4. Periodic revocation checks, resource limits and one download per user stay.
5. HTTP Range continuation is supported without buffering the file in the
   browser.
6. Seamless browser-managed resume across changing URLs is not promised.
7. No permanent links, no token persistence, no relaxed entitlement checks.

**Implementation checkpoint: E3.9 Checkpoint 8, "download continuation".**
Checkpoints 8 and 9 had no defined scope before this.

Precise changes Checkpoint 8 has to make:

| # | Where | Change |
| --- | --- | --- |
| G1 | `lib/media-gateway/server.ts` | Remove the download `expiryTimer`, which aborts a running response with `authorization_expired` at the capability's expiry. The capability is still verified once, when the request starts |
| G2 | `lib/media-gateway/download.ts`, `server.ts` | `DOWNLOAD_LIMITS.requestTimeoutMs` is 600,000 ms and ends every download at ten minutes on its own, whatever the token says. Replace it with a finite maximum transfer duration. The limits check that only lets the defaults be tightened means the default itself must change |
| G3 | `server.ts` | Keep unchanged: verification of signature, expiry, operation and version at the start of every request, including a resumed one. An expired capability is refused with 401 before any database or Telegram work |
| G4 | `server.ts` | Keep unchanged: the 30-second recheck of publication, rights, VJ, user and document identity for the whole transfer, its 5-second deadline, and failing closed. After G1 this is the only control over a running transfer, so it must have a test that runs past expiry |
| G5 | `server.ts` | Keep unchanged: one download per user, two per address, four per process, one read ahead, reads of at most 1 MiB, the 30-second idle and read timeouts, backpressure |
| W1 | `lib/playback/download.ts` | Wording only: `DOWNLOAD_GUIDANCE` and the `expired` message say that a link lasts ten minutes. They must say that a started download continues, and that a link can start or resume one for ten minutes. No logic change: still a one-byte probe, no Blob, no storage, a fresh authorization on every press |
| T1 | `lib/media-gateway/download.test.ts` | "token expiry terminates an active response and frees admission" becomes: a transfer started before expiry completes after it, byte-identical, and frees admission at the end |
| T2 | the same | New: after expiry, a new request and a `Range` resume with the old capability are both refused with no media read |
| T3 | the same | New: unpublishing, rights revocation and a banned account each stop a transfer that is already past expiry, within the recheck bound |
| T4 | the same | New: the maximum transfer duration ends an over-long transfer and frees admission. The existing stalled-socket test stays |
| T5 | `tests/browser/player.spec.ts`, `lib/playback/download.test.ts` | Update the wording assertions for W1 |
| D1 | Documents | Readiness checklist sections 10 and 11, the device test plan cases I1 and I5, and a note that the Checkpoint 5 report's "terminates downloads at expiry" is superseded |

No migration is needed. `media_gateway.resolve_movie_download` is unchanged, and
the web issuer is unchanged.

What Range continuation means after the change, stated so that nothing is
promised that is not built:

- The gateway already serves `Range` with `If-Range` and streams to the socket.
  The page never reads the file. That stays.
- A browser's own resume re-requests the same URL. It works while that link is
  still inside its ten minutes, and gets 401 afterwards.
- After that, the viewer presses Resume/Retry Download, which authenticates
  again and opens a new URL. A browser may treat it as a new download from byte
  0. Only a client that can attach a new link to a partial file continues from
  where it stopped. That is device-plan case I4, and it is not promised.

Consequences to accept, because they follow from point 2:

- **Sign-out no longer stops a running download within ten minutes.** It runs to
  completion unless publication, rights or the account is revoked, which still
  stops it within about 35 seconds.
- **A leaked link used inside its ten minutes can complete a whole file**, where
  today it gets only what fits in the remaining minutes. One download per user
  and the rechecks still apply. A link can never start anything after expiry.
- **Slots are held for the whole transfer.** Four per process becomes the
  practical ceiling on concurrent downloads.
- **A gateway restart cuts running downloads** after its 15-second grace. They
  need a fresh link and a `Range` resume.
- **A proxy in front must allow long responses**, well beyond ten minutes.
- **Phase F.** When subscriptions arrive, the subscription check has to be in
  the download resolver, because the resolver is what a running transfer is
  rechecked against.

Open questions for Checkpoint 8's brief:

1. **The maximum transfer duration.** For scale, 2,000 MiB takes about 2 hours
   20 minutes at 2 Mbit/s and about 4 hours 40 minutes at 1 Mbit/s. Real read
   throughput through a hosted gateway has not been measured.
2. **What "resumed requests need a new capability" means inside the ten
   minutes.** Today a capability can be used for several requests until it
   expires, which is what lets a browser's own resume work. If a capability
   must be single-use, no browser download manager can ever continue a partial
   file, and point 5 would then need a custom client. The recommendation is to
   keep reuse inside the lifetime and require a new capability only after
   expiry.
3. **Whether four concurrent downloads per process is still the right total.**

### 11.3 Commit and staged-file summary

One local commit holds the approved Checkpoints 6 and 7 work. It was not pushed.

- **59 files**, staged from `evidence/checkpoint7-stage.pathspec` and from
  nothing else: 18 source and test files, 6 documents and 35 evidence files that
  are not browser output. 12 are modifications of tracked files and 47 are new.
  No file is deleted or renamed.
- **Not committed, kept on disk:** `.env.example` (pre-existing edit, unchanged,
  SHA-256 `86e57706…a73f8`), and 36 browser-generated evidence files: the 33
  listed at the gate and the 3 from this close-out. They are listed in
  `evidence/checkpoint7-stage-browser-evidence.pathspec`. None was judged
  necessary to substantiate a report: each result they hold is stated in the
  Checkpoint 6 or 7 report with its counts, and the tests that produced them are
  committed and repeatable.
- **Reviewed before the commit:** the staged diff holds no credential and no
  private identifier (every private value in the local environment file was
  searched for, with no match), no deletion, no image, archive or executable,
  and no path outside the E3.9 work. `.claude/`, `.env.local` and everything Git
  ignores were never candidates.
- **Encoding note.** Git labels 20 of the Checkpoint 6 evidence logs as binary.
  They are plain text logs of at most 8 KB that PowerShell wrote as UTF-16, the
  same kind as 33 logs the earlier checkpoint commits already track. They were
  searched for private values in both encodings.
- **The commit's hash is not written in this file**, because a commit cannot
  contain its own hash. `git log -1 -- docs/MP4_MKV_CHECKPOINT_7.md` shows it,
  and the hand-over message that accompanies this close-out states it.

`evidence/checkpoint7-git-status.txt` is the working tree immediately before
staging.

### 11.4 Remaining activation blockers

1. **Checkpoint 8: implement and test the download continuation policy**
   (11.2). Downloads stay inactive until then.
2. **Production gateway hosting**: allowed origins, HTTPS, a single instance,
   long responses through any proxy, and the per-address limits behind one.
3. **Real-device tests**, and before them a host the devices can reach. Safari,
   iOS and Android are still not tested. The refused-automatic-start fix is
   still unconfirmed on an iPhone.
4. **The nine migrations**: fresh hosted baseline check, backup, restore
   rehearsal and advisors for each selected group. None has run against hosted.
5. **A verification contract for Policy 3**, or new originals stay unpublishable.
6. **Listener image**: rebuild, then the isolated lease-release test, only after
   the channel Policy 3 migration.
7. **Smaller items**: a download smoke check after deploy, whether a runtime
   switch for downloads is wanted, the banned-account streaming gap before
   Phase F, and the owner's confirmation of the E3.9 label.

Stop here. Approval is required before Checkpoint 8, applying migrations,
restarting services, pushing or deploying.
