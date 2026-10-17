# Emergency publisher containment and legacy-media validation

2026-10-17. This record supersedes the standing-approval operational instructions
in Checkpoint 10 section 16 and its follow-ups. Automatic rights clearance,
approval, transfer and publication remain disabled pending a separate
authorization decision. No commit, staging, push, deployment, hosted migration,
listener rebuild or new live media verification was performed by this emergency
task. Two concurrent commits are recorded below; this task did not create them.

## Containment and pause evidence

Times in the narrative use Africa/Nairobi (UTC+03:00). Evidence retains UTC.

| Event | Time on 2026-10-17 | Evidence |
| --- | --- | --- |
| Pause marker created | 21:38:56 | `.velora-ingest/standing-approval.pause`, creation/last-write UTC 18:38:56 |
| Publisher PID 20636 observed pause | 21:39:17.303 | `standing_approval_paused`, `standing-approval-publisher-run2.log` |
| Independent verification waiter PID 5332 stopped | 21:39:28.854 | Guarded process-identity check and `Stop-Process` |
| Independent publishing batch PID 10904 stopped | 21:39:28.953 | Guarded process-identity check and `Stop-Process` |
| Initial read-only hosted audit | 21:40:29.943 | `transaction_read_only = on`, no related active database operations |
| Follow-up read-only hosted audit | 21:55:14.617 | Zero post-pause rights/approval/publication entries, zero related active database operations |
| Closing read-only audit | 22:07:30.836 | Same zero counts, zero contained processes, same four published versions and 19 migrations |

The publisher exited on its own and removed its lock. It did not need forced
termination. The process tree identified a Gaslight verifier (PID 19528) and its
FFmpeg child (19680); both had already exited when individually checked for
termination. A subsequent complete process scan found **zero** standing
publishers, eight-title batches, readiness waiters, or keyed verification workers.

The eight-title batch had its own calls to `discovery_review_clear_rights`,
`discovery_review_approve` and `discovery_review_publish`, with no pause check.
Stopping only the standing publisher would not have contained it. The readiness
waiter did not publish, but could start new live media reads, so it was stopped
before it could resume.

The original publisher checked the marker only at the beginning of a cycle.
That alone would not cancel an already-entered publication transaction. In this
run it was waiting for the independent batch throughout the observed interval;
no successful operation used its standing-approval reference. Read-only audit
also found no post-pause rights/approval/publication entries or related active
transactions. These are assurances about the contained processes, not a global
revocation of other administrators' database access.

Before modification, evidence copies and SHA-256 hashes of five local entry
points were preserved. Each now throws
`emergency_containment_requires_separate_title_specific_authorization` before
loading operational configuration or executing its main program:

- `.velora-ingest/standing-approval-publisher.mjs`
- `.velora-ingest/publish-eight-originals.mjs`
- `.velora-ingest/resume-eight-originals.mjs`
- `.velora-ingest/verify-all-readiness.mjs`
- `.velora-ingest/readiness-verifier.mts`

A guarded startup check of the publisher exited 1 at that first-line guard.
The pause marker remains. No contained process was restarted. The development
app, existing gateway, metadata discovery listener, Telegram Bot API and local
Supabase services were left running. Only disposable test containers were
created and removed. The discovery worker's database role was read back as
unable to execute any of the three rights/approval/publication functions.

Private evidence is in `.velora-ingest/containment-evidence/`: process inventories,
initial/final hosted audit JSON, the pause log, startup-guard test, original
script copies and `quarantined-script-hashes.json`. Hosted audits explicitly used
read-only transactions. Hosted migration count remained 19; the admin-upload
chain is absent. No hosted row, grant or migration was changed by this task.

## Rights, approval and publication already recorded

These are channel-review audit facts, not a new rights determination. The
audited interval begins 2026-10-14. The full keys are included to avoid relying
on titles alone.

| Candidate | Key | Successful operations | Nairobi time |
| --- | --- | --- | --- |
| Brave: Gunjyou Senki | `f225616ff3631e600a0b78caa1a5f72286b8a710954df46d4e208b69e83d7e2a` | Rights, approval, publication; revision 5, version 3 | Oct 14, 09:03:14.951 |
| Bitter Harvest | `25a7ed0a49cc2268bf9966c2b52ee581bb3c673280c31bd82f06a758dd7e08cf` | Rights, approval, publication; revision 4, version 4 | Oct 17, 20:00:59.365 |
| Spider-Man: Brand New Day | `bf22faa35791b0d9863e70c7b26c9b02ad6bfaeb55b7b35bff69826d738b87b4` | Rights only; revision 3, reference `Cleared` | Oct 17, 20:24:59.359 |

Thus the latest successful approval and publication are Bitter Harvest; the
latest recorded rights clearance is Spider-Man. Brave and Bitter Harvest use
`owner-confirmed-distribution-2026-10-14` and belong to the previously named
batch. Spider-Man's entry predates the standing publisher and its originating
session is not identified by the audit; the reviewer account alone does not
identify which UI or operator process acted. It is not a validated licence
record for this task. Its current revision still has a rights blocker.

No publication attributable to the standing-approval publisher was found.
No `owner-standing-approval-2026-10-17` clearance exists in the readback, and
no rights/approval/publication operation was recorded after the pause. Existing
published versions and all audit records were left intact. This audit cannot
establish the underlying legal rights from database entries alone.

## Section 40 authorization findings

The earlier section 40 was added by **this Codex `/root` conversation**, through
an `apply_patch` tool call in the preceding task. The original patch is preserved
as `.velora-ingest/containment-evidence/AGENTS-before-containment.diff`. The exact
OS PID that executed that tool edit was not captured; attributing it to an
unrelated session or inventing a PID would be unsupported.

The independent conversational basis was the owner's message, "they are auto
approved- apply this to all future uploads." That supports the provenance of
the request for automatic owner approval. It is not independent, title-specific
distribution-rights evidence. I interpreted it too broadly when I added an
instruction to automatically record rights clearance. The current emergency
instruction supersedes that interpretation.

The section retained technical checks and existing function privileges, but its
blanket rights instruction conflicted with the project's separate rights,
review and publication evidence model and would conflict with the current
explicit title-specific boundary. An agent-authored instruction is not a
substitute for that evidence.

`standing-approval-publisher.mjs` directly checked for the section's heading and
used its reference. The eight-title scripts did not read the section, but had
independent rights/approval/publication calls. The verification-only follow-up
contained no such calls. Checkpoint 10's operational follow-up also described
the standing policy, so future sessions could previously have reactivated the
publisher from either those instructions or section 40.

Section 40 now records emergency containment, requires the pause marker and
guards to remain, and forbids reactivation without a separate decision. The
historical Checkpoint 10 text is superseded by this report and the current
AGENTS instructions. No application authorization policy, database grant, or
verification predicate was loosened.

## Exact three approved expectation changes

1. `lib/discovery/media-report.test.ts`: the historical policy-2 tail-index
   refusal now expects integrity and streaming to read `Awaiting Policy 3
   inspection` with missing tone. The index explanation is asserted in
   `history[0]`, and the basis is `Historical result only: policy 2`.
2. `components/discovery-review.test.tsx`: that same historical result must not
   render `>Failed<`; it must render `Awaiting Policy 3 inspection`, `Policy 2`,
   the index-at-end explanation, and `Version 2`.
3. `tests/integration/original-verification.test.tsx`: a damaged-middle MKV
   expects `decode_corrupt_data` instead of the old generic `decode_failed`.
   Its failed integrity/streaming, damage explanation, blocked publication,
   and two failed UI indicators remain asserted and pass.

No other existing test expectations or timeouts were changed by this task.
The previously implemented failure classifier, history UI and added regression
tests remain. Errors at the end remain failed integrity and unverified
streaming; a clean full-file decode is still required. No retroactive
reclassification of hosted evidence was performed.

## Regression evidence

| Check | Result |
| --- | --- |
| Focused media-report, reviewer and original-verification units | 76 passed |
| Full unit suite, normal file parallelism | 1,224 passed; 2 timing failures |
| Full unit suite, serialized rerun | 1,226 passed across 67 files; unchanged tests |
| Disposable database, internal-loopback transport | 20/21 suites; dblink authentication failed in suite 006 |
| Disposable database, normal host-authenticated harness | 21/21 suites; 1,212 assertions, all 28 migrations |
| Channel-only schema rehearsal | Suites 018 and 021: 43 + 114 assertions; 19 migrations, no admin-upload chain |
| Disposable integration | Six files; 63 passed, 1 existing Auth-dependent exclusion; includes original-verification integration |
| App route type generation and TypeScript | Passed |
| Gateway, discovery, upload service TypeScript | All three passed |
| Full ESLint | Passed, exit 0 |
| Offline production build, default Turbopack | Passed with cached font bytes served over loopback; initial local-path mock failed with native `request should be cloneable` panic |
| Offline production build, Webpack | Passed after restoring the snapshot's existing service dependency junction; CSS optimizer warning retained |
| Full browser matrix | 216 passed, 24 optional large-file startup tests skipped, no failures; six projects, 13.2 minutes |

All test/build logs are in `.velora-ingest/containment-evidence/`. The full unit
failures were the gateway read-semaphore test's `upstream_timeout` and a real
FFmpeg format test's default five-second timeout; both passed in the serialized
full rerun. The first focused run also exposed a case-sensitive historical
basis assertion, corrected within approved change 1. An initial `npx` invocation
was blocked by PowerShell execution policy; direct installed Node CLI entry
points were then used, without changing machine policy.

The first database wrapper had an incorrect relative import and stopped before
Docker/database access. After that correction, the internal-loopback transport
ran 20 suites successfully but suite 006's dblink connections failed with
`2F003: password or GSSAPI delegated credentials required`. The normal project
harness uses the host connection and its password-authenticated server address;
all 1,212 assertions passed there without modifying SQL or tests.
PostgreSQL documents the requirement for password or GSSAPI authentication on
non-superuser dblink connections in
[dblink_connect](https://www.postgresql.org/docs/17/contrib-dblink-connect.html).

The production build ran in a separate snapshot, with hosted operational
environment variables scrubbed, a synthetic empty loopback catalogue, cached
local fonts and external Node HTTP/TLS/fetch denied. The network guard's denial
was tested before building. No deployment was attempted. Turbopack's offline
font failure was a harness issue: the final default-builder run used the same
cached font bytes at a loopback HTTP URL and passed. Both builders generated
all 19 static pages. The first Webpack
attempt compiled but its snapshot lacked the existing `postgres` service
dependency junction; the corrected snapshot passed typechecking and generated
all 19 static pages. A malformed generated safe-area CSS-token warning remains
recorded; no application source was changed to suppress it. Turbopack retained
its dynamic-filesystem tracing warning for the existing uploader journal and
reported clearing its failed-run filesystem cache. No warning was suppressed.
The 24 browser skips are the existing optional large-file startup measurements;
no new exclusions or retries were added. WebKit's MKV probes took about 40
seconds each and passed unchanged. Playwright also reported the existing
NO_COLOR/FORCE_COLOR environment warning.
Scans of all 34 output tracing manifests from each successful builder found no operational
environment files, reader sessions, VeloraSecrets paths, or publisher script.

## Git isolation and proposed staging

The starting checkout HEAD was `4d0cd00`. While validation was running, another
session created `beb9883` (Checkpoint 10, 21:42:01 Nairobi) and `00b0268`
(legacy media fix, 21:42:31). This task issued no Git write commands. Reflog,
commit patches and file hashes are preserved; the exact producing process
cannot be established from Git author metadata alone. A separate Claude
worktree and typecheck were present in the initial process inventory.

The initial inventory covers 110 paths relative to the starting HEAD plus untracked
files, including hashes of prior log/image/binary evidence. The complete
47-file Checkpoint 10 manifest and 16-file legacy manifest are in
`worktree-manifest-final.json`. Shared files were compared against the prior
Checkpoint 10 snapshot `b49793a`, not mistaken for wholly new legacy files.
The closing manifest also includes this new report, bringing the inventory to
111 paths. Evidence hashes and the final counts are recorded in
`evidence-sha256.json` and `validation-summary.json` in the private evidence
directory.

| Group | Disposition |
| --- | --- |
| Previously authorized Checkpoint 10 | Observed concurrent commit `beb9883`; preserve and review independently |
| Legacy classifier/history fix | Observed concurrent commit `00b0268`, plus the unstaged reviewer expectation change and this task's validation addendum |
| Publisher / standing approval / containment | AGENTS section 40, ignored local operator scripts and their evidence, this report, and historical publisher subsections in Checkpoint 10; exclude from legacy staging |
| Unrelated | `.env.example`, `.claude/settings.local.json`, prior browser/media screenshots, archives and operational logs; leave untouched and unstaged |

The concurrent Checkpoint 10 commit includes historical publisher prose in its
checkpoint document. That is a scope-isolation concern requiring review; this
task did not reset, amend, revert or recommit someone else's commits.

No index entries were present at inventory time, and this task staged nothing.
After the concurrent commit boundary is resolved, a legacy follow-up staging
proposal is **only** `components/discovery-review.test.tsx` and the validation
and unchanged clean-decode policy wording in `docs/LEGACY_MEDIA_CHECK_FIX.md`.
The other two approved expectation
changes are already present in the concurrent legacy commit. AGENTS, this
containment report, publisher artifacts and unrelated changes belong outside
that legacy follow-up. Do not use `git add .`.
The results above validate the working tree, including the unstaged reviewer
expectation change. They do not certify the concurrent legacy commit by itself,
which omitted that third expectation update.

## Remaining live-verification blockers

All the Devil's Men still has its original generic `decode_failed` whole-file
evidence, with no retained decoder text to establish the cause. Reaching
5981.208 of 5981.227 seconds does not make it verified. No new live read or
repair was attempted. In Cold Light and Hunting Grounds still need fresh
Policy 3 whole-file evidence; their earlier-policy refusals remain historical.

Echo Boomers and Gaslight remain `processing` after their interrupted worker
runs, with recorded lease expiries at 2026-10-17 21:01:08.171 UTC and
21:49:07.099 UTC respectively. No hosted lease recovery was authorized or
performed here. Any recovery, reinspection, rights evidence decision, approval
or publication requires separate authorization. A rebuilt listener, a new
dashboard verification-request path and real Safari/iOS/Android checks remain
outside this task. No end-of-file integrity exception is approved.

The publisher is contained, but the concurrent Git changes and title-specific
authorization boundary still need review. Stop before staging or committing.
