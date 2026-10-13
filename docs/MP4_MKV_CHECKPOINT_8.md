# MP4/MKV Checkpoint 8: secure download continuation

2026-10-13. **Local implementation and isolated validation only.** Nothing was
activated. No migration was written or applied, no hosted database was queried,
no Telegram call was made, no listener, Bot API, local Supabase, Docker or
Next.js development server was started, no movie was uploaded, replaced,
reinspected or published, and nothing was staged, committed, pushed or deployed.
E3.9 remains a provisional label.

Branch `phase-a-foundation` at `dd3e478` (Checkpoints 6 and 7), 13 commits ahead
of its remote. Everything below is uncommitted in the working tree.
`.env.example` still has SHA-256 `86e57706…`; `.env.local` and `.claude/` were
not edited.

**The brief arrived incomplete.** The pasted text ends in the middle of section
5, at "Avoid adding a service worker, Blob-based". Sections 1 to 5 were followed
as written. For everything after that point the standing rules of Checkpoints 6
and 7 were applied: no Docker, no migration, no push, stop before committing. If
the missing part asked for anything else, it has not been done.

The work was done in two sessions. The first (2026-10-11 to 12) made the gateway
change and its unit tests and stopped without a report. The second (2026-10-13)
found a typecheck error left by the first, fixed it, added the browser tests and
wrote the documents.

## 1. What changed in the gateway

The decision implemented is the one recorded in `MP4_MKV_CHECKPOINT_7.md`,
section 11.2, with the answers this checkpoint's brief gave to its open
questions: four hours, capability reuse inside its lifetime, four slots.

| Before | After |
| --- | --- |
| A capability lasts ten minutes | Unchanged |
| Every request is authorized when it arrives | Unchanged, and now stated in the code and tested for a second request on the same capability |
| A running download is cut when its capability expires | **Removed.** The expiry timer is gone. Expiry is checked once, when the request starts |
| A download response may run for 600 seconds | **Four hours**, `DOWNLOAD_MAX_DURATION_MS` |
| Recheck of publication, rights, VJ, user and document identity every 30 seconds, 5-second deadline, fails closed | Unchanged. It is now the only authorization control over a running transfer, and has tests that run past expiry |
| One download per user, two per address, four per process, one read ahead, reads of at most 1 MiB, 30-second idle and read timeouts, backpressure | Unchanged |
| Playback streams: 8 MiB windows, 120-second deadline | Unchanged, with a test that the two deadlines are independent |

What ends a download now: it completes; the viewer's connection closes; a read
or the socket makes no progress for 30 seconds; a Telegram read fails; the
recheck finds the version unpublished, its rights withdrawn, its file replaced,
or the user banned, deleted or anonymous; the recheck cannot reach the database;
or four hours pass. Each of these releases the slot once.

Nothing was added to make continuation possible: no longer-lived token, no
refresh token, no token storage, no relaxed check, no service worker, no Blob,
no buffering, no conversion. `media_gateway.resolve_movie_download` and the web
issuer are unchanged.

### Order of checks on every download request

Signature, expiry, operation and version of the capability, then the request
and slot limits, then reader readiness, then the database: published movie,
ready and rights-cleared version, active VJ, and a real, non-anonymous,
non-deleted, non-banned user. Only then `Range`, and only then a media read. A
refused request reads no media. A resumed request goes through all of it again.

## 2. Consequences that follow from the policy

These were accepted with the decision. They are repeated here because they are
now what the code does.

- **Signing out does not stop a running download.** It runs to completion unless
  publication, rights or the account is revoked, which stops it within about 35
  seconds.
- **A link issued before sign-out still works for the rest of its ten
  minutes.** The gateway sees a capability and the state of the account, not a
  browser session. A new link needs a signed-in session. This was already so
  before this checkpoint.
- **A leaked link used inside its ten minutes can fetch a whole file**, where
  before it got what fitted in the remaining minutes. One download per user and
  the rechecks still apply, and a link can start nothing after expiry.
- **Slots are held for the whole transfer**, up to four hours. Four per process
  is the ceiling on viewers downloading at once.
- **A gateway restart cuts running downloads** after its 15-second grace.
- **After a connection is lost without being closed**, the gateway notices only
  when the idle timeout fires, up to 30 seconds later. Until then that user's
  slot is taken and a resume is refused with 429. This is reasoned from the code
  (one slot per user, 30-second idle timeout); it was not reproduced, because a
  silently dead peer cannot be made on loopback.
- **Phase F.** The subscription check has to go into the download resolver,
  because that is what a running transfer is rechecked against.

## 3. Resource limits and their settings

| Limit | Default | Setting | Accepted range |
| --- | --- | --- | --- |
| Longest download response | 4 hours | `MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS` | 60,000 to 14,400,000 |
| Downloads at once, whole process | 4 | `MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE` | 1 to 4 |
| Downloads at once, per user | 1 | `MEDIA_GATEWAY_DOWNLOAD_MAX_PER_USER` | 1 |
| Downloads at once, per address | 2 | `MEDIA_GATEWAY_DOWNLOAD_MAX_PER_IP` | 1 to 2 |

**A setting can only tighten its default.** The defaults are the ceilings. A
value above one, a value below the minimum or anything that is not a plain
integer stops the gateway at startup, naming the group
(`MEDIA_GATEWAY_DOWNLOAD_* limits`) and never a value. Raising the duration or
any concurrency limit is therefore a code change, to be made with load-test
evidence, not a deployment setting. The gateway core applies the same rule to
limits passed to it directly.

The capability lifetime (600 seconds), the recheck interval (30 seconds), the
authorization deadline (5 seconds) and the read-ahead (1) have no setting.

The settings reach the process through `services/media-gateway/main.mts`, and
`npm run gateway:dev` passes them to the development container. **They are not
in `.env.example`**: that file has an unrelated uncommitted edit which the
checkpoint rules keep out of commits. Adding four comment lines there is owed
once that edit is settled.

For scale, at four hours the ceiling file of 2,000 MiB needs about 146 kB/s
(1.17 Mbit/s) sustained, Call of Heroes about 1.07 Mbit/s and On The Hunt about
0.56 Mbit/s. Real read throughput through a hosted gateway has still not been
measured.

## 4. Slot counting and client identity

The brief asked whether gateway-wide slots, per-user slots and proxy-derived
addresses are counted correctly.

**Gateway-wide: correct.** Downloads have their own admission counter, separate
from playback. A slot is taken when a request has passed the capability and
rate checks and is released exactly once, in the request's `finally`, whether
the response completed, was cut, timed out or lost its client. Tested: four
transfers held open, a fifth refused with 429, and a slot freed by a disconnect
usable at once. The page's one-byte readiness probe takes a download slot for
the moment it lasts.

**Per user: correct.** The key is the `sub` of the signed capability, which a
client cannot change. Tested: a second request from the same user is refused
whether it uses the same link or a new one, and whatever address it comes from.
Changing address does not get a user a second slot.

**Per address: correct for a gateway that clients reach directly, and wrong
behind anything else.** The key is the TCP peer address of the socket. No header
is read. Tested: three users sending three different `X-Forwarded-For`,
`X-Real-IP` and `Forwarded` values from one real peer are counted as one
address, and the third is refused. So a client cannot buy slots by forging a
header.

Findings:

1. **The gateway will be behind something in production.** It speaks plain HTTP
   and the web side requires an HTTPS gateway origin in production, so a TLS
   terminator (a reverse proxy, a tunnel or a load balancer) is a practical
   requirement, not an option. Behind it every viewer has the proxy's address.
   The per-address limits then become limits on everybody together: 2
   downloads, 6 streams, 240 requests a minute. The request limit alone would
   throttle ordinary playback for a handful of viewers.
2. **Carrier-grade NAT has the same effect on a smaller scale**, with no proxy
   involved: viewers of one mobile operator behind one public address share 2
   downloads and 6 streams. How common that is for this audience is unmeasured.
3. **IPv6.** The key is the full address, so one subscriber with a /64 has many
   keys. The per-address limit is weak there. The per-user limit is the one
   that holds.
4. **The per-user limits are unaffected by all three.** They are the
   authoritative control. The per-address limits are a coarse backstop.

### Trusted-proxy configuration (documented, not built)

No forwarding header is trusted today, and none should be until the proxy is
known. The gateway core already takes the client identity from a function the
deployment supplies (`clientIp`, defaulting to the socket peer), and a test
shows the limits follow it. Nothing reads an environment setting for it yet:
choosing a header format before choosing the proxy would be a guess. When the
hosting decision is made, the change has to follow these rules.

1. **The gateway accepts connections only from the proxy**: bound to loopback or
   a private interface, or firewalled to the proxy's addresses. Otherwise a
   client connects directly and writes the header itself.
2. **A forwarding header is read only when the socket peer is on an explicit
   allow-list** of proxy addresses, set by the operator. From any other peer the
   header is ignored and the peer address is used.
3. **The proxy overwrites the header** with the address of its own peer. It does
   not append to a value the client sent. If the format is a list, the gateway
   takes the entry its own trusted hop added, counting from the right, never the
   left-most entry.
4. **A missing or malformed header falls back to the proxy's address**, which is
   the strictest outcome. It is never treated as "no limit".
5. **Addresses are normalized** before counting: no port, IPv4-mapped IPv6
   folded to IPv4, and IPv6 counted by /64.
6. **The header name and the allow-list are configuration that fails closed**:
   one without the other, or an unparsable network, stops the gateway at startup.
7. The per-address defaults are then reviewed against carrier NAT (finding 2).
   That review is about the per-address numbers, not the four process-wide
   slots.

The proxy itself must pass `Range` and `If-Range`, must not buffer or cache
responses, must not log query strings (the capability is in the URL), must close
its upstream connection when the viewer disconnects (that is what frees the
slot), and must not cap the total duration of a response below four hours.

## 5. Browser-managed continuation

New file `tests/browser/download-continuation.spec.ts`: five cases in six
browser projects, with the real player, issuer and gateway core on loopback. The
file is 6 MiB of synthetic bytes served at about 1 MiB per 150 ms. The harness
cuts a transfer by failing a read mid-body, and moves the issuer's and the
gateway's clock together to pass a capability's expiry without waiting.

What was observed, on Chrome 154, Edge 155, Chromium 156 and the Playwright
builds of Firefox 157 and WebKit 27.2, all on Windows:

| Case from the brief | Chrome, Edge, Chromium | Playwright WebKit | Playwright Firefox |
| --- | --- | --- | --- |
| Uninterrupted transfer, capability expires while it runs | Completes, byte-identical | The same | The same |
| The expired link afterwards, new request and `Range` resume | 401, no media read | The same | The same |
| Connection cut inside the ten minutes | **The browser resumes by itself**, same link, `Range` from the cut and `If-Range` with the validator. 206. Saved file byte-identical. No action by the viewer or the page | No resume request. Download fails: "Transferred a partial file" | No resume request in the 3 seconds watched (15 in an exploratory run). The download neither finishes nor reports a failure |
| Resume after the capability expired | The browser's own resume gets 401, no media read. Download fails | Not attempted by the browser | Not attempted by the browser |
| Newly issued capability (Resume/Retry Download) | A **new download from byte 0**: no `Range`, no `If-Range`, a different link. Byte-identical | The same | The same |
| Failed resume (gateway unavailable when the browser comes back) | Resume gets 503, download fails. The page's retry reports "temporarily unavailable", stays usable, and works once the gateway is back | The page's retry behaves the same | The same |
| Entitlement revoked between requests | Resume on a still-valid link gets 404, no media read. The page's retry reports "revoked" without contacting the gateway. Works again when access returns | The page's retry behaves the same | The same |

For WebKit and Firefox, which sent no resume request, the test sends the request
a download manager would send (same link, `Range`, `If-Range`) and checks the
gateway's answer: 206 with the right bytes inside the ten minutes, 401 after
expiry, 503 during the outage, 404 after revocation. That shows the gateway's
side. It shows nothing about what those browsers do when a person presses
resume.

What this does and does not establish:

- **Established:** a browser's own resume on the same link works inside the ten
  minutes and is refused after them. Verified with a real download manager in
  the Chromium family.
- **Established:** in no automated browser does a new link continue a partial
  file. It starts again from byte 0. The page text says "Your browser may
  restart instead of resuming the partial file" and promises nothing more. No
  claim of seamless resume across links is made anywhere.
- **Not established:** behaviour on a lost network, as opposed to a connection
  the server closed. Behaviour of real Firefox, Safari, iOS and Android. A
  resume started by a person in a download manager. A transfer that really runs
  for more than ten minutes.

**One unexplained observation.** In the Playwright Firefox build, once a transfer
had been cut, pointer clicks sent by Playwright no longer reached the page:
no click event, no request. Script on the page still ran and the keyboard still
worked. No dialog was visible to the automation, and cancelling the stalled
download did not help. The tests therefore activate Resume/Retry from the
keyboard in Firefox only. The cause was not found. It may be an artefact of
automated downloads in that build; it must be checked in real Firefox
(`MP4_MKV_DEVICE_TEST_PLAN.md`, I9) before being dismissed.

**A consequence worth a decision.** A viewer whose connection drops after the
link's ten minutes loses the partial file and starts again. On a slow and
unreliable link a large file may never complete, however long the gateway
allows. Closing that gap needs either a resumable client in the page or a
resume credential that outlives ten minutes. Neither is approved, and neither
was built.

## 6. Page wording

`lib/playback/download.ts`, text only. No logic changed: still a one-byte
probe, no Blob, no storage, a fresh authorization on every press.

- Guidance: "Downloads use the browser's download manager. A download that has
  started keeps running, for up to 4 hours. A link can start or resume a
  download for 10 minutes; after that, use Resume/Retry Download for a fresh
  authorized link. Your browser may restart instead of resuming the partial
  file; check its download manager. This page cannot track completion."
- Expired: "The download link expired before it could be used. Resume/Retry
  Download requests fresh authorization."

## 7. Tests

### Added or changed

`lib/media-gateway/download.test.ts`, 46 tests before, 67 now:

- **Replaced, as Checkpoint 7 section 11.2 (T1) specified:** "token expiry
  terminates an active response and frees admission" asserted the behaviour this
  checkpoint removes. It is now "a transfer authorized before expiry continues
  past it, byte-identical, and frees admission; the expired capability starts
  nothing new", with the clock moved an hour past expiry mid-body, the recheck
  seen to keep running, and the old link then refused for a new request and for
  a `Range` resume with no read and no database call.
- New: user and publication revocation each end a transfer that is already past
  expiry (T3).
- New: one capability serves a full request and a `Range` resume, each
  authorized on arrival; revoking the user or the publication between requests
  refuses the next one with no media read.
- New: the limit is four hours, a tightened limit cuts an over-long transfer
  mid-body and frees the slot (T4); the playback deadline is unchanged and
  independent.
- New: per-address slots follow the socket peer and ignore forwarding headers;
  the identity a deployment supplies is what is counted; four slots for the
  process; one slot per user whatever address or link.
- New: the four settings, tighten-only, with nine refused values; the gateway
  core refuses a looser limit however it is passed.

`lib/media-gateway/config.test.ts`: one test and three table rows for the new
settings. `lib/playback/download.test.ts`: assertions for the new wording added
to an existing test; none removed. `tests/browser/player.spec.ts` is unchanged:
its wording assertion still holds, and the new wording is asserted in the new
spec.

`tests/browser/harness.ts` and `player-harness.ts` gained options that existing
tests do not use: a gateway clock, download limits, a list of download-route
requests, a mid-body cut and a clock offset. Stream requests are recorded as
before.

### Results

All on this machine. Loopback and synthetic fixtures only.

| Gate | Result | Evidence |
| --- | --- | --- |
| Unit, full | 1,130 passed, 0 failed, 0 skipped (1,105 at Checkpoint 7 plus 25 new) | `checkpoint8-unit.{log,json}` |
| Gateway unit tests repeated | 12 of 12 runs clean, 231 tests each | Not saved: twelve one-line results |
| Browser, continuation spec, six projects | 30 passed, 0 failed | `checkpoint8-continuation-browser.log` |
| Browser, full, six projects | **174 passed, 0 failed, 24 skipped** (the opt-in startup measurements): the 144 of Checkpoint 7 plus the 30 new | `checkpoint8-browser.{log,json}` |
| Typecheck | Pass | `checkpoint8-typecheck.log` |
| Lint | Pass | `checkpoint8-lint.log` |

The unit run needs `VELORA_FFPROBE_PATH` and `VELORA_FFMPEG_PATH`. Without them
36 tests that generate real media are skipped (1,094 passed). Only those two
variables were exported for the run; no credential was loaded.

**Not run, because Docker is stopped and the brief forbids starting it:**

- the 20 database suites (1,098 assertions at Checkpoint 7),
- the 44 isolated integration tests,
- the real restricted database adapter with the gateway core,
- the offline production build, which needs the disposable database.

No migration, SQL, route, server component or dependency changed. The only file
the Next.js build compiles that changed is `lib/playback/download.ts`, two
string constants, which the typecheck, lint, unit tests and the browser tests
through Vite cover. These four gates should still be run, with Docker approved,
before this work is relied on.

### A test that failed intermittently, and was not changed

`lib/media-gateway/pump.test.ts`, "respects the global read semaphore across
streams", failed with `upstream_timeout` in at least 5 of 17 runs of the gateway
tests on 2026-10-11, once with the new download tests excluded. That test and
`pump.ts` are untouched by this checkpoint. It allows one second per read while
other test files compete for the processor.

On 2026-10-13 it did not fail: 12 of 12 runs of the working tree, and 12 of 12
runs of a pristine copy of `dd3e478`. So it is sensitive to machine load, the
new tests add load, and whether it predates this checkpoint is not settled by
these numbers. Nothing was changed to make it pass. If it recurs, the proposal
is a longer read timeout in that one test (the assertion on the semaphore stays
as it is), to be approved first.

During the first session one new slot test was also unreliable until two causes
were removed, both in the test: open responses that nothing referenced were
closed by the client's garbage collector, which freed their slots, and a fake
reader that built a megabyte of bytes per read took too much processor. Neither
was a gateway defect.

## 8. Exact files changed by Checkpoint 8

Source:

- `lib/media-gateway/server.ts` (expiry timer removed; comments)
- `lib/media-gateway/download.ts` (four-hour limit; settings)
- `lib/media-gateway/config.ts` (reads the settings)
- `services/media-gateway/main.mts` (passes them to the gateway)
- `scripts/media-gateway-dev.mjs` (passes them to the development container)
- `lib/playback/download.ts` (wording)

Tests:

- `lib/media-gateway/download.test.ts`
- `lib/media-gateway/config.test.ts`
- `lib/playback/download.test.ts`
- `tests/browser/download-continuation.spec.ts` (new)
- `tests/browser/harness.ts`, `tests/browser/player-harness.ts`

Documents:

- `docs/MP4_MKV_CHECKPOINT_8.md` (new, this report)
- `docs/MP4_MKV_ACTIVATION_READINESS.md` (sections 3, 7, 10, 11, 13)
- `docs/MP4_MKV_DEVICE_TEST_PLAN.md` (sections 1, 2, 8, 9)
- `docs/MP4_MKV_CHECKPOINT_5.md` (a superseded note)
- `IMPLEMENTATION_ROADMAP.md`

Evidence, new, under `docs/evidence/`: `checkpoint8-unit.log`,
`checkpoint8-unit.json`, `checkpoint8-typecheck.log`, `checkpoint8-lint.log`,
`checkpoint8-stage.pathspec`, and the browser-generated `checkpoint8-continuation-browser.log`,
`checkpoint8-browser.log` and `checkpoint8-browser.json`.

No package manifest, lockfile, migration, SQL, environment file or image
changed. No dependency was added.

## 9. Proposed staging manifest

**Nothing is staged.** For approval, by the rules of the earlier checkpoints:

Stage (22 paths, listed in `evidence/checkpoint8-stage.pathspec`): the six
source files, the six test files, the five documents, the four evidence files
that are not browser output, and the manifest itself.

A scan of those 22 files and the three browser evidence files for every value
in the local environment file, in UTF-8 and UTF-16, found no credential, token,
key, database address or private identifier. It matched three ordinary
configuration words that are not secret: an environment name, a listener mode
name and the Movies bot's public username, which the roadmap has carried since
C2B.2B.

Do not stage:

- `.env.example` (pre-existing edit, unchanged),
- `checkpoint8-continuation-browser.log`, `checkpoint8-browser.log` and
  `checkpoint8-browser.json` (browser-generated; their results are stated above
  and the tests are repeatable),
- the 36 browser evidence files left over from Checkpoints 6 and 7,
- `.claude/`, `.env.local` and everything Git ignores.

## 10. Remaining blockers before downloads can be activated

1. **The four Docker-dependent gates** for this checkpoint (section 7).
2. **Production gateway hosting**, and with it the trusted-proxy change (section
   4), HTTPS, allowed origins, a single instance and a proxy that allows
   four-hour responses.
3. **A rebuilt gateway image.** Any running development image predates both the
   download route and this change.
4. **Real-device tests**, now including I1, I3, I4, I5 and I9. Safari, iOS and
   Android are still not tested.
5. **Migration 9** (the download resolver) and the other eight, each with its
   own preflight. None has run against hosted.
6. **A decision on partial files lost after ten minutes** (section 5).
7. **Measured throughput** through a hosted gateway, which decides whether four
   hours and four slots are enough.
8. Carried over unchanged: the Policy 3 verification contract, the listener
   image, a download smoke check after deploy, the banned-account streaming gap
   before Phase F, `.env.example`, and the owner's confirmation of the E3.9
   label.

Stop here. Approval is required before committing, starting Docker, applying
migrations, rebuilding or restarting services, pushing or deploying.

## 11. Close-out (2026-10-13)

Sections 1 to 10 are the record as it stood at the approval gate, when nothing
was staged. The owner then approved the commit. One local commit holds the 22
paths of `evidence/checkpoint8-stage.pathspec` and nothing else. It was not
pushed. `.env.example` and the browser-generated evidence stayed out, on disk.

The commit's hash is not written here, because a commit cannot contain its own
hash. `git log -1 -- docs/MP4_MKV_CHECKPOINT_8.md` shows it.

Still not run: the four Docker-dependent gates of section 7. Everything in
section 10 still stands.
