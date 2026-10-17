# MP4/MKV Checkpoint 10: the Policy 3 verification contract and controlled end-to-end validation

**Live follow-up:** sections 1–14 describe the local checkpoint. Sections 15–16
record later live actions authorized by the owner; section 16 supersedes the
earlier statement that no hosted migration has been applied.

Work of 2026-10-14. E3.9 remains a provisional roadmap label.

**Status: implemented locally; continuation validation is recorded in section
14. Uncommitted, awaiting review.** Nothing was pushed, deployed or
applied to a persistent database. No Telegram call was made, the discovery
listener was not rebuilt or restarted, no media was converted, uploaded or
published outside disposable databases. `.env.example` and `.claude/` were not
modified.

Checkpoint 9 was committed first, as authorized: local commit `45fc83e`, 56
files, from the manifest in `MP4_MKV_CHECKPOINT_9.md` section 10. The browser
log, the five screenshots and `.env.example` stayed out.

## Read this first

| Question | Answer |
| --- | --- |
| Can a new MP4 or MKV original become publishable now? | Yes, locally: after a whole-file verification passes, and only then. On hosted nothing changed |
| What still gates publication? | The same six things. Verification opens only the media gate; identity, VJ, rights and final approval are untouched |
| Did a privilege change? | One: the discovery worker role gained one function, `discovery_claim_verification`. Section 5 |
| Were existing tests changed? | Two security inventories were updated to register that function. They need your acceptance. Section 5 |
| Did every local gate run? | Yes, in the continuation. Section 14 records results and the existing exclusions |
| Is the channel path proven against Telegram? | No. It is proven with local files through the same code. The live read is the remaining step |

## 1. Architecture audit

Read-only, before any change. Sources: the original brief, the Checkpoint 4 to
9 reports, the readiness checklist, the emergency-stop procedure, the two
Policy 3 migrations, both workers and the publication functions.

### The media lifecycle

**Channel path (a VJ posts a file in the Movies channel)**

1. The listener receives the post and records it (`discovery_receive`). No
   bytes are read.
2. Inspection (`discovery_claim`, then the worker): title and VJ are suggested,
   and the media port reads nothing (metadata mode) or a bounded sample
   (bounded mode). Result: `discovery_complete`, one row in
   `private.media_evidence`.
3. A reviewer confirms film and VJ.
4. **Media gate.** `private.channel_review_blockers` asks
   `private.media_evidence_publishable` about the document's current evidence.
5. A reviewer with the rights capability records clearance, bound to the
   revision and the document.
6. A reviewer approves; an account with the publish capability publishes. One
   transaction creates the movie, the VJ version and the link to the document.
7. Playback and download resolve the published version only.

**Upload path (an admin uploads a file through R2 staging)**

1. The browser sends parts to R2; the worker downloads, hashes and records the
   SHA-256 (`verify`).
2. The worker inspects the staged file (`inspect`): hash re-check, full probe,
   classification, film suggestions. Result: `admin_upload_r2_worker_finish`,
   one row in `private.admin_upload_media_evidence`.
3. The owner confirms film and VJ and submits. **Media gate:**
   `private.admin_upload_media_publishable`.
4. Rights (bound to the file's SHA-256, expiring), then approval.
5. The worker transfers the file to Telegram, then publishes.

### Where each fact lives

| Fact | Source of truth | Who writes it |
| --- | --- | --- |
| Integrity | `integrity_status` of the evidence row (from `assessment.integrity`) | The inspection worker, validated by the database |
| Streaming readiness | `streaming_status` (from `assessment.streaming`) | The same |
| Browser compatibility | `browser_profile` (from `assessment.compatibility`): a prediction from container and codecs | The same; never a gate |
| Download availability | `download_status` of the evidence row, plus at run time the download switch, the resolver and publication | Evidence: the worker. Run time: the gateway |
| Whether the media gate is open | `private.media_evidence_publishable` (channel), `private.admin_upload_media_publishable` (upload) | The database, from the stored row |
| Rights | `private.rights_clearances`; the session's rights fields | A reviewer with the rights capability |
| Approval and publication | The review row; the session | Reviewers with the review and publish capabilities |

### What was missing

Checkpoint 4 built the gate and deliberately left nothing able to open it. The
predicate required `integrity = verified` and `streaming = verified`; the only
producer was a bounded inspection, which the database contract forbade from
saying either. So every new original stopped at the media gate.

Two further findings shaped the design:

- **A whole-file check does not fit in the listener.** The listener's
  inspection lease is at most 10 minutes and its loop does not poll while it
  inspects. Reading and decoding a 1 to 2 GB file takes far longer. Run inside
  the loop it would lose its lease and stall detection.
- **The listener claims "the next candidate due", not a named one.** That is
  how the 2026-10-11 canary landed on message 50 instead of message 46.

Nothing was built in parallel: the contract extends the existing evidence
tables, the existing completion functions and the existing gate predicate.

## 2. The verification contract

Contract version 1. Code: `lib/discovery/original-verification.ts`. Database:
`private.original_media_verification_valid`.

A worker that holds the **whole** original file reports one `verification`
object inside the assessment it already records. The file is only read.

| Part | What is reported | Verified when |
| --- | --- | --- |
| 1. Identity and provenance | Channel: the document identity (chat, message, file id, size). Upload: session, lease, SHA-256, file key, size. Both: SHA-256 of every byte read and the byte count | The digest covers exactly the recorded size; for an upload it equals the session's verified SHA-256 |
| 2. Container and codecs | Unchanged: container, tracks, codecs, languages from a full probe | Not a status; a refused file carries reasons |
| 3. Integrity | A decode of the film's video and **every** audio track from first packet to last, with decoder errors fatal | The decode ends without any error and reaches the container's duration (within 1 s, or 2% for a long film) |
| 4. Streaming readiness | The layout (MP4 index at the head or the tail, or Matroska) and a decode after seeking to the start, the middle and near the end | Integrity is verified, the layout is one the player starts from, and all three seeks decode at least one frame |
| 5. Browser compatibility | Unchanged prediction per browser | Never "verified"; never a gate |
| 6. Download availability | Whether the gateway can serve the original as an attachment: size within 2,000 MiB, MP4 or MKV, recorded media type and extension matching | Its own status, `original_servable` or `not_servable` |
| 7. Policy and time | Policy 3, contract 1, method `full_original_v1`, scope `whole_file`, tool versions, the worker's start and finish; the database adds its own timestamp | |
| 8. Reasons | Fixed codes per part; warnings stay separate | |

### The evidence rules, and where each is enforced

| Rule | Enforced by |
| --- | --- |
| Missing evidence is never a verified result | The validator refuses a verification with any part missing. Statuses with no verification behind them are refused. A default is never substituted |
| Browser compatibility is not streaming readiness | Streaming is verified only by its own three decoded seeks; a compatibility value cannot stand in (tested) |
| Download availability is not rights clearance | It is a separate column that no gate reads. A verified original that cannot be downloaded still publishes; one that can is still blocked without rights (tested) |
| Technical verification never bypasses approval | The media gate is one blocker among the others. Approval and publication functions are unchanged and re-check every gate (tested on both paths) |
| Prior evidence and provenance are kept | Evidence tables are append-only. Every inspection, passing or failing, stays |
| Stale or mismatched evidence is refused | A lost lease returns `stale`. A digest of another size is refused. An upload digest that is not the session's is refused. Two whole-file reads of one document that hash differently block publication (`media_content_conflict`) |
| Producer permissions stay narrow | The producers are the two roles that already recorded evidence. Section 5 |

Three statuses the bounded inspection could not say, and now can only with a
valid verification: `integrity: verified`, `streaming: verified`,
`download: original_servable | not_servable`.

A later inspection supersedes an earlier one, as before. A bounded
re-inspection of a verified candidate therefore returns it to "pending" until
it is verified again. That fails closed and is documented, not hidden.

## 3. Worker integration

Neither pipeline was rewritten. Both call the same verifier.

**Upload path.** `lib/uploader/admin-inspection.ts`, inside the existing
`inspect` step of the R2 worker, which already holds the file and has already
re-checked its SHA-256. When the Policy 3 assessment accepts the file, the
worker decodes it whole and after three seeks, and records the result in the
same completion call. This mirrors what the earlier policy already did for MP4
(`validatePlayback`). No new claim, lease, role or entry point.

**Channel path.** A new one-shot mode of the existing listener program:
`discovery.mjs --verify <candidate key>`.

- It runs **beside** the listener, never in its loop: no Bot API call, no
  consumer lease.
- It claims the candidate **by key** (`discovery_claim_verification`), only when
  a reviewer has confirmed film and VJ, under its own lease of up to 4 hours.
  It cannot land on another film.
- The bounded inspection runs first. A document it refuses is never read whole.
- Then every byte is read through the same reader the gateway serves from, into
  a private temporary file that is always removed, hashed and decoded.
- It ends through the existing `discovery_complete` or `discovery_fail`, so the
  confirmed film and VJ are kept, as for any media-only inspection.
- A reader outage or a full disk is scheduled as a failed attempt and never
  recorded as evidence.
- It needs the same explicit switch as the listener, the reader configuration
  and `VELORA_DISCOVERY_SPOOL_DIR`.

**The boundary.** `--verify` reads a whole document from Telegram. That is a
live media operation (Gate C of the original brief). The mode is written,
type-checked and its logic is exercised end to end with local files through
`verifyOne`. The program itself has not been run, and no byte was read from
Telegram.

## 4. Exact files changed

Working tree against `45fc83e`: 25 modified files (plus the untouched
`.env.example`), 8 new source files, evidence logs.

**Contract and database (new)**

- `supabase/migrations/20261014090000_original_media_verification.sql`
- `supabase/migrations/20261014090001_admin_original_media_verification.sql`
- `supabase/tests/database/021_original_media_verification.test.sql` (114 assertions)
- `lib/discovery/original-verification.ts`, `lib/discovery/original-verification.test.ts` (14 tests)
- `tests/integration/original-verification.test.tsx` (17 tests, both paths)
- `scripts/checkpoint10-validation.mjs`

**Workers (modified)**

- `lib/discovery/media-verification.ts`: `verifyChannelOriginal`, `channelVerificationPort`.
- `lib/discovery/database.ts`: `verifyOne`; reads the new evidence fields.
- `services/media-gateway/discovery.mts`, `discovery-pg.mts`: the `--verify` mode.
- `lib/uploader/admin-inspection.ts`: verification inside `inspect`.
- `lib/uploader/media-tools.ts`: `decodeStreams`, `spoolDocument`.

**Dashboard and player (modified)**

- `lib/discovery/model.ts`, `media-report.ts`, `guidance.ts`,
  `lib/uploader/admin-upload.ts`, `components/media-verification.tsx`,
  `components/discovery-review.tsx`: scope, digest and download evidence rows;
  new reason texts; the queue's "Verified" follows the database's predicate.
- `lib/playback/player.ts`, `compatibility.ts`, `components/movie-player.tsx`:
  no advice to download where no Download control is offered.

**Tests (modified, additions only unless noted)**

- `lib/uploader/media-ffmpeg.test.ts` (+5), `lib/playback/player.test.ts` (+1),
  `lib/playback/compatibility.test.ts` (+1), `tests/browser/player.spec.ts` (+1).
- `vitest.discovery.config.mts`: the new integration file added to the run order.
- `supabase/tests/database/003_security_boundaries.test.sql`,
  `011_discovery_worker_role.test.sql`: **inventory entries changed**, section 5.

**Earlier validation scripts (modified so they still select the right migrations)**

- `scripts/checkpoint4-validation.mts`, `checkpoint5-validation.mts`,
  `checkpoint9-validation.mts`: the two new migrations added to their
  "not on hosted" lists and to the migration count. **Not re-run** (section 6).

**Documentation**: this file, `MP4_MKV_ACTIVATION_READINESS.md`,
`MP4_MKV_DOWNLOAD_EMERGENCY_STOP.md`, `E3_8_CHANNEL_DISCOVERY.md`,
`IMPLEMENTATION_ROADMAP.md`.

**Dependencies installed:** none.

## 5. Database and authorization changes

Two migrations, **local only, not applied to any persistent database**. In the
numbering of the readiness checklist they are 10 and 11.

### Migration 10, `20261014090000_original_media_verification` (channel)

Needs only migration 7. It does not need the admin upload chain (proven on the
hosted-equivalent 17 plus the two channel migrations).

- **New** `private.original_media_verification_valid(jsonb)`: validates a
  verification object. Invoker, owner-only, pinned `search_path`.
- **Replaced** `private.original_media_assessment_valid(jsonb)`: a bounded
  assessment is validated exactly as before; `verified` statuses are accepted
  only with a valid verification that says the same.
- **Table** `private.media_evidence`: scope may be `bounded` or `whole_file`;
  the read ceiling rises from 1 GiB to 4 GiB; a generated `content_sha256`
  column; the Policy 3 contract constraint is replaced. Existing rows satisfy
  every new constraint as they are. No row is updated.
- **Replaced** `public.discovery_complete`: also accepts whole-file evidence,
  bound to the document's recorded size. Same signature, same grants.
- **Replaced** `private.channel_review_blockers`: one added blocker,
  `media_content_conflict`.
- **New** `public.discovery_claim_verification(text, integer)`: the keyed claim.
  Security definer, pinned `search_path`, executable by `service_role` and
  `velora_discovery_worker` only.
- **Unchanged**: `private.media_evidence_publishable` (the gate),
  `private.channel_view`, every reviewer, approval and publication function,
  both gateway resolvers.

### Migration 11, `20261014090001_admin_original_media_verification` (upload)

Needs migration 10 and migration 8 (so also 1 to 6).

- **Table** `private.admin_upload_media_evidence`: `download_status` follows the
  assessment (it was a constant); a generated `content_sha256`; a constraint
  that a stored verification is about this session's SHA-256 and size.
- **Replaced** `private.admin_upload_record_inspection`: refuses a verification
  whose digest or size is not the session's.
- **Replaced** `private.admin_upload_media_publishable`: the same predicate,
  with the digest equality stated.
- No new function, role or grant. The worker's two completion functions are
  untouched and reach the above as before.

### The one privilege change, and the two test inventories it touches

`velora_discovery_worker` could execute nine functions. It can now execute ten.
The tenth, `discovery_claim_verification`, can only start an inspection lease on
a candidate a reviewer has already confirmed, which is narrower than the
`discovery_claim` the role already had. The role still has no table access, no
review, rights, approval or publication function, and no membership.

Two existing security suites assert that inventory and failed until updated:

| Suite | Assertion | Change |
| --- | --- | --- |
| `011_discovery_worker_role` | "exactly nine worker RPCs" | now "exactly ten worker RPCs" |
| `011_discovery_worker_role` | "no unrelated privileged RPCs" (an allow-list) | the new function added to the list |
| `003_security_boundaries` | the list of every security-definer function | the new function added to the list |

**These are edits to existing tests, made without prior approval.** They are
registry updates, which is what those assertions exist to force, and the change
they register is described above. If the new function is not accepted, the
alternative is to drop the keyed claim, and with it worker-run verification of
channel documents; the upload path would be unaffected.

No other existing assertion was changed. One existing test,
`lib/discovery/database.test.ts` "refuses a view that claims anything but a
bounded check", still passes unedited: it uses the scope value `full`, which is
still refused. Its title is now narrower than the code, which also accepts
`whole_file`; renaming it is proposed, not done.

## 6. End-to-end test results

### What ran, and what did not

Docker Desktop stopped during this checkpoint (the session was interrupted).
It was **not started again**: starting it restarts the discovery listener, which
the brief forbids. Every database-dependent result below is therefore from
before the stop.

| Gate | Result | When |
| --- | --- | --- |
| Typecheck (app, and the three service configurations) | Pass | Final tree |
| Lint | Pass | Final tree |
| Unit suite | **1,197 passed**, 0 failed, 0 skipped (was 1,176; 21 new) | Final tree |
| Browser suite, six projects | See "Browser" below | Final tree |
| Database suites, all 28 migrations | 21 of 21 suites, **1,212 assertions** (was 20 and 1,098) | Before the stop, after the last SQL change. Output seen, **log not saved** |
| `scripts/checkpoint10-validation.mjs` (hosted 17 plus the two channel migrations) | Pass: suites 018 (43) and 021 (114) | Before the stop. Log not saved |
| New end-to-end integration file | **17 of 17** | Before the stop. Afterwards only a parameter was renamed in the test and in `spoolDocument` |
| The five existing integration files against 28 migrations | **Not run** | |
| `checkpoint4`, `checkpoint5`, `checkpoint8`, `checkpoint9` validation scripts | **Not run** after their migration lists were updated | |
| Offline production build | **Not run** | |

To close the gap once Docker is running, one after another:

```text
npm run test:db:isolated
node scripts/checkpoint10-validation.mjs
VELORA_E38_ISOLATED_TESTS=true npm run test:integration:isolated
node --import ./scripts/ingest/register.mjs scripts/checkpoint5-validation.mts
node --import ./scripts/ingest/register.mjs scripts/checkpoint8-validation.mts
node --experimental-transform-types --import ./scripts/ingest/register.mjs scripts/checkpoint9-validation.mts
node --import ./scripts/ingest/register.mjs scripts/checkpoint4-validation.mts
(isolated database up with seed) ; node scripts/discovery/build-isolated.mjs
```

The integration, Checkpoint 9 and Checkpoint 4 runs need
`VELORA_FFPROBE_PATH` and `VELORA_FFMPEG_PATH`.

### The controlled cases

All from `tests/integration/original-verification.test.tsx`: real files, the
real tools, the real database functions through PostgREST and psql, synthetic
Telegram posts, and no network beyond loopback. The files are the committed
synthetic fixtures and damaged copies of them made in a temporary folder.

| Case | Path | What happened | Publishable |
| --- | --- | --- | --- |
| Original MP4 with valid evidence | Channel | Every byte hashed, film decoded, three seeks decoded. Integrity and streaming verified | Media gate open; still needs rights and approval |
| Original MKV with valid evidence | Channel, upload | Verified. Firefox limitation recorded as a warning | Media gate open |
| Multiple audio tracks | Channel, upload | Both tracks decoded and counted | Media gate open |
| Embedded subtitles | Channel | Counted; warning recorded | Media gate open |
| Missing or invalid container metadata | Channel | Refused by the bounded inspection in under 20 kB read; never read whole | No |
| Corrupt media | Channel | Whole file read, decode failed. Integrity failed, streaming not attempted | No |
| Truncated media | Upload | Decode stops early. Recorded as failed; submit refused | No |
| Document shorter than recorded | Channel | Recorded as an unreadable document, with no digest | No |
| Reader unavailable | Channel | Nothing recorded; scheduled again | No |
| Integrity mismatch | Channel | A second whole-file read with a different digest: `media_content_conflict` | No, although both reads verified |
| Integrity mismatch | Upload | A verification whose digest is not the session's: refused, nothing stored | No |
| Streaming-readiness failure | Channel | A fragmented MP4: integrity verified, streaming failed | No |
| Browser compatibility warning | Channel | HEVC in MKV: both facts verified, warning shown | Media gate open; the warning changes nothing |
| Missing download evidence | Channel | The whole record is refused by the database | No |
| Download not servable | Channel | A document recorded as a generic file type: verified, shown as not downloadable | Media gate open; download is not a gate |
| Stale media-version evidence | Channel | Lease taken over mid-read: `stale`, nothing recorded. Evidence naming another document: dropped | No |
| Stale media-version evidence | Upload | The session's file changes after verification: no longer publishable | No |
| Rights not cleared | Both | Approval refused | No |
| Admin approval missing | Both | Publication refused | No |
| Fully verified and approved | Channel | **Published**; the gateway's resolver returns the document; the public profile reports the facts | Yes |
| Fully verified and approved | Upload | Reaches `approved`. **Stopped at the boundary:** the next step is the worker's transfer to Telegram | Not published |

Fourteen further forged or inconsistent records were each refused by the
database (verified without evidence, a browser profile in place of seek
samples, a decode short of the duration, a bounded row carrying a verification,
fewer bytes read than digested, and others). None was stored.

Only a candidate that passed every gate was published: one, in a disposable
database.

### What the first end-to-end run found

- **A defect in the new SQL validator**, caught before anything else passed: a
  variable and a table alias shared a name, so every whole-file record was
  refused. Fixed. The database suite added afterwards covers it.
- A browser test of Checkpoint 9 failed in three projects because a new row
  repeated the words "Not inspected". The row was reworded; the assertion was
  not changed.
- A lint rule mistook a parameter named `use` for a React hook. Renamed.

### A load-sensitive test

`lib/media-gateway/pump.test.ts`, "respects the global read semaphore across
streams", is the test Checkpoint 8 recorded as intermittent. It and `pump.ts`
are untouched. With the first version of the new real-decode tests it failed in
2 of 4 full runs, and passed 6 of 6 alone. After the new tests were cut to two
fixtures it passed in 6 of 6 full runs. Nothing in it was changed. The proposal
from Checkpoint 8 (a longer read timeout in that one test) still stands and
still needs approval.

### Browser

The full suite's result is recorded in `docs/evidence/checkpoint10-browser.log`
and in the roadmap entry. A first full run was cut off by the interruption
after 68 tests, with the three failures described above; the dashboard tests
then passed 18 of 18 after the rewording.

## 7. Dashboard evidence

The Checkpoint 9 panel was tested against records the workers produced, not
only constructed data. In the integration file the reviewer's view is read back
through the reviewer RPC and rendered with the real components.

| Record produced by | The panel shows |
| --- | --- |
| A bounded inspection | Verification pending; "Metadata consistent, not verified"; scope "Bounded sample"; no digest; download "Not assessed" |
| A whole-file verification that passed | Integrity and streaming "Verified", with what was done; scope "Whole file"; the SHA-256; "The original can be served as it is" |
| A corrupt file | Both "Failed", with "the file is damaged" |
| A fragmented MP4 | Integrity "Verified", streaming "Failed" |
| A refused container | Integrity "Failed"; container "Not reported"; scope "Bounded sample" |
| A document recorded with a generic type | Verified; download "Not available" as a warning |
| No evidence | "Not inspected" (unchanged) |
| A database without the contract | "Not reported" (unchanged) |

The six distinctions the brief names are each present and each tested: not
reported, not inspected, pending, verified, failed, warning.

Three rows were added to the panel: inspection scope, content SHA-256 and
download evidence. The queue's one-word "Verified" now follows the database's
own predicate, so a verified Policy 3 candidate no longer reads "Awaiting
verification" there.

**Player copy.** A viewer with no Download control (the switch off, or signed
out) is no longer told to download. Six failure messages and three
compatibility messages have a version without that advice; with the control
present the text is exactly what it was. Tested in unit tests and in six
browser projects.

No admin approval route was added. No screenshot was taken at this checkpoint.

## 8. Download-security regression results

The contract touches no download code. `lib/media-gateway/*`,
`lib/playback/stream-token.ts`, `stream-capability.ts`, `download.ts` and both
resolvers are unchanged at this checkpoint.

| Property | Evidence at this checkpoint |
| --- | --- |
| Capability validation | Unchanged code; gateway and issuer unit tests pass in the 1,197 |
| Publication and rights checks | Resolver migrations untouched; suite 020 passed in the 21-suite run |
| Account revocation | Unchanged; unit tests pass. The real-role script (`checkpoint8-validation`) was **not re-run** |
| Ten-minute capability lifetime | Unchanged constant and tests |
| Four-hour maximum transfer | Unchanged constant and tests |
| Range continuation | Unchanged; unit and browser tests |
| Gateway concurrency limits | Unchanged; unit tests |
| Disabled by default | Unchanged; unit and browser tests, including the new copy test |

New at this checkpoint: download **evidence** is recorded per file. No resolver
reads it, so it can neither grant nor refuse a download. That is deliberate: the
two published titles have no evidence rows, and requiring evidence would change
who can download what.

How to stop active transfers during an incident is in
`MP4_MKV_DOWNLOAD_EMERGENCY_STOP.md`, now with a short incident sequence at the
top of "Stopping downloads".

## 9. Known limitations

- **Not run against Telegram.** The whole-file read of a channel document is
  proven with local bytes through the same functions. Throughput, flood waits
  and the reader's behaviour over a 1 to 2 GB read are unknown.
- **Verification is expensive.** It reads the whole file and decodes all of it.
  For a feature film that is the download plus a decode of every frame: tens of
  minutes, on the machine that runs it. Not measured on a real film.
- **It is a decode by FFmpeg, not by a browser.** "Streaming verified" means the
  file has a usable layout and decodes after seeking. It does not mean a given
  browser plays it; that stays the compatibility prediction.
- **No source to compare a channel document with.** Its digest is recorded on
  first verification and compared on later ones. It cannot show that the file
  is the one the VJ meant to post.
- **An upload is verified before its transfer to Telegram.** That the bytes in
  Telegram equal the verified file rests on the existing transfer checks, which
  compare size, not content.
- **A bounded re-inspection after a verification returns the candidate to
  pending.** By design; see section 2.
- **A killed verification holds its candidate** until the failed attempt is
  recorded or its lease (up to 4 hours) runs out. Then the listener's ordinary
  claim picks it up.
- **Fragmented MP4 is not accepted for streaming**, because the player has not
  been tested with it.
- **Tests use 12-second synthetic files.** No feature-length file was verified.
- **The listener image is not rebuilt.** The `--verify` mode exists in source
  only.
- Safari, iOS, Android and real-device Firefox remain **not tested**.

## 10. Remaining activation blockers

1. **Review the completed local gates in section 14.** All pending gates from
   section 6 have now run; the existing Auth and optional startup exclusions remain.
2. Acceptance of the worker role's tenth function and the two inventory edits.
3. Production gateway hosting, with the trusted-proxy change. Unchanged.
4. Migrations: none of the eleven pending is applied. Verification of channel
   documents needs 7 and 10. Uploads need 1 to 6, 7, 8, 10 and 11. Downloads
   need 9.
5. A rebuilt listener image carrying the shutdown fix, Policy 3 inspection and
   the `--verify` mode, and a place for its temporary file.
6. A first live whole-file verification, on one approved candidate.
7. A rebuilt gateway image (the download switch).
8. Real-device browser tests.
9. The Telegram backlog restrictions stand. The seven candidates keep their
   recorded results.
10. `.env.example` lists neither the download switch nor
    `VELORA_DISCOVERY_SPOOL_DIR` (file not touched, by rule).

## 11. Migration and deployment sequence

The full plan, with what is proven locally and what needs live infrastructure,
is section 16 of `MP4_MKV_ACTIVATION_READINESS.md`. In short, each step its own
approval:

```text
hosted 17 ──► 9 download resolver                      (downloads only)
hosted 17 ──► 7 channel Policy 3 ──► 10 verification contract ──┐
hosted 17 ──► 1 ► 2 ► 3 ► 4 ► 5 ► 6 ──► 8 admin Policy 3 ───────┴──► 11 admin verification
```

1. Confirm hosted history is still the recorded 17. Backup and restore
   rehearsal.
2. Migration 7, then migration 10, by the migration 17 procedure. Each is one
   transaction and fails closed without its prerequisite.
3. Rebuild the listener image; verify the lease release in isolation; replace
   the running listener.
4. One whole-file verification of one approved candidate with `--verify`.
5. Separately: the admin chain (1 to 6, 8, 11) and its worker; the download
   path (9, gateway, switch).

Rollback after commit is a forward migration that restores the previous
function definitions. Evidence rows and the new columns stay. Restoring the
previous `original_media_assessment_valid` makes whole-file evidence
unrecordable again, which closes the media gate for new originals: the safe
direction.

## 12. Git status

`HEAD` is `45fc83e` on `phase-a-foundation`, 16 local commits ahead of
`veloraug/phase-a-foundation`. Nothing is staged and nothing was pushed.

```text
 M .env.example                    (pre-existing edit, untouched, never staged)
 M IMPLEMENTATION_ROADMAP.md
 M components/discovery-review.tsx
 M components/media-verification.tsx
 M components/movie-player.tsx
 M docs/E3_8_CHANNEL_DISCOVERY.md
 M docs/MP4_MKV_ACTIVATION_READINESS.md
 M docs/MP4_MKV_DOWNLOAD_EMERGENCY_STOP.md
 M lib/discovery/database.ts
 M lib/discovery/guidance.ts
 M lib/discovery/media-report.ts
 M lib/discovery/media-verification.ts
 M lib/discovery/model.ts
 M lib/playback/compatibility.test.ts
 M lib/playback/compatibility.ts
 M lib/playback/player.test.ts
 M lib/playback/player.ts
 M lib/uploader/admin-inspection.ts
 M lib/uploader/admin-upload.ts
 M lib/uploader/media-ffmpeg.test.ts
 M lib/uploader/media-tools.ts
 M scripts/checkpoint4-validation.mts
 M scripts/checkpoint5-validation.mts
 M scripts/checkpoint9-validation.mts
 M services/media-gateway/discovery-pg.mts
 M services/media-gateway/discovery.mts
 M supabase/tests/database/003_security_boundaries.test.sql
 M supabase/tests/database/011_discovery_worker_role.test.sql
 M tests/browser/player.spec.ts
 M vitest.discovery.config.mts
?? docs/MP4_MKV_CHECKPOINT_10.md
?? lib/discovery/original-verification.test.ts
?? lib/discovery/original-verification.ts
?? scripts/checkpoint10-validation.mjs
?? supabase/migrations/20261014090000_original_media_verification.sql
?? supabase/migrations/20261014090001_admin_original_media_verification.sql
?? supabase/tests/database/021_original_media_verification.test.sql
?? tests/integration/original-verification.test.tsx
?? docs/evidence/checkpoint10-*.log
```

Still untracked and excluded from earlier checkpoints: the Checkpoint 6 to 9
browser evidence and the five Checkpoint 9 screenshots.

The gates of section 6 were completed in the continuation recorded in section
14. Changes remain uncommitted, awaiting review.

## 13. Recommended production validation gate

One gate, in this order, each step approved on its own:

1. **Finish the local gates** (section 6) with Docker running, and review this
   checkpoint with those results.
2. **Hosted, read-only:** migration history, and the reviewer screen opened
   against hosted data.
3. **Database:** migration 7, then 10, on a restored copy first, then hosted.
   Expected result afterwards: the seven backlog candidates unchanged, each
   still at the media gate.
4. **Listener:** rebuilt image, lease release verified in isolation, then
   replaced.
5. **The canary: one whole-file verification of Movies channel message 46**
   with `--verify`, by its key. This is the first read of a whole film from
   Telegram through this code. Record its duration, the bytes read and the
   outcome. It writes one evidence row and changes nothing else.
6. **Stop.** Rights and publication of that candidate are a separate decision.

Message 50 (In Cold Light) keeps its recorded `mp4_not_fast_start` result. Under
Policy 3 a tail-index MP4 is acceptable, so a new, approved verification may
well pass it; that has to come from a new inspection and never from relabelling
the old row.

Decisions needed from the owner:

- Accept or reject the worker role's tenth function and the two inventory edits.
- Whether verification should also be offered inside the listener for small
  files, or stay an operator command only.
- Whether a bounded re-inspection should keep superseding a verified row.
- Whether download evidence should ever gate a download (today it does not).

## 14. Codex continuation validation (2026-10-14)

Resumed from this handoff. The owner explicitly authorized starting Docker
Desktop, including a possible discovery listener restart. Docker was started;
the running-container inventory showed the four local Supabase containers and
the disposable validation containers, with no discovery listener running.
No persistent database reset, hosted migration, live verification, publication,
deployment, push or commit was performed. Existing implementation files,
`.env.example` and `.claude/` were preserved.

| Gate | Continuation result |
| --- | --- |
| App typecheck | Pass |
| Three media-gateway service typechecks | Pass |
| Lint | Pass |
| Unit suite with the existing FFmpeg/ffprobe binaries configured | 1,197 passed; no skips |
| All 28 migrations and all database suites | 21 suites passed; 1,212 assertions |
| Channel-only Checkpoint 10 script | Pass; suites 018 and 021 pass; ten worker functions and no table access |
| Six isolated integration suites | 61 passed; one existing watchlist signup test excluded by the harness, which does not provide an Auth server |
| Checkpoint 5 | Pass; 13 original fixtures byte-identical through the restricted adapter and gateway |
| Checkpoint 8 | Pass; seven real database revocations end active transfers |
| Checkpoint 9 | Pass; older-schema and full-chain reviewer checks, including six bounded original inspections |
| Checkpoint 4 | Pass; both migration orders, database suites, and seven real-fixture producer/SQL contracts |
| Production build against seeded disposable catalogue | Pass |
| Browser suite, six projects | 210 passed; zero failed; 24 optional large-file startup measurements skipped because their fixture directory was not configured |
| Diff whitespace check | Pass |

Saved evidence is `docs/evidence/checkpoint10-continuation-*.log`. The initial
unit run without configured media tools passed 1,159 tests and skipped 38; the
configured run above supersedes it. Disposable database containers were removed
after each validation chain and after the build. Docker and the local Supabase
containers remain running.

This closes the pending local validation gaps in section 6. Production activation
and the owner decisions in sections 10 and 13 remain separate work.

## 15. Local live playback follow-up (2026-10-14)

The owner requested available, playable movies and selected the local app.
Docker, Next.js at `http://localhost:3000`, and the rebuilt development gateway
at `http://127.0.0.1:8787` are running. The gateway reuses the existing reader
session; it reports ready with the restricted catalogue connection and Telegram
reader available. Downloads remain disabled.

Hosted readback still shows 17 migrations. Two published, ready, rights-cleared
movies are available: Call of Heroes and On the Hunt. No movie was newly
published and no hosted migration was applied in this follow-up.

Both movies passed a real signed-in Chrome playback check against Telegram:
stream-token response 200, ranged media responses 206, video advancement and
decoded frames, nonzero decoded audio, pause, seek to ten minutes, and player
close. Signed-out requests return 401. The catalogue fits a 390 px viewport.
Temporary verification accounts were removed after each check.

| Movie | Video dimensions | Advancement observed | Frames decoded during observation |
| --- | --- | --- | --- |
| Call of Heroes | 1920 x 816 | 8.01 seconds | 192 |
| On the Hunt | 1920 x 1080 | 8.02 seconds | 193 |

Evidence: `docs/evidence/live-playback-call-of-heroes-2016.log` and
`docs/evidence/live-playback-on-the-hunt-2026.log`. The proof reuses the earlier
ignored playback operator script, with current app origin and an updated alert
selector; the initial broad alert selector also matched Next.js's route
announcer, so that first attempt ended before authentication.

Ten unpublished channel candidates were read back. Eight have confirmed film
and VJ identities; Kung Fu Soccer remains proposed and Spider Man 4 Brand New
Day remains ambiguous. Publication of the eight confirmed titles is pending
the owner's answer to the explicit title list. Their technical verification,
rights recording, approval and publication gates are preserved.

## 16. Eight-title publication activation (2026-10-14)

The owner explicitly confirmed distribution rights and requested publication
after verification for All the Devil's Men, Bitter Harvest, Brave: Gunjyou
Senki, Echo Boomers, Gaslight, Hunting Grounds, In Cold Light, and Saving
General Yang. Kung Fu Soccer and Spider Man 4 Brand New Day are outside this
authorization and retain their unconfirmed identities.

A snapshot-consistent EFS-encrypted backup was created outside the repository
at `C:/Users/willi/VeloraBackups/ORIGINAL-MEDIA-utxtqsfelovmhhcrknrz-20261014T053741Z`.
The archive contains 62 tables and the recorded 17 hosted migrations. Its
SHA-256 is `4bd2bac631c8819607eb345d94c40916d66cf7119485ae9ba551d4718406bb02`.

The archive restored successfully into a disposable database on an internal
Docker network, with plaintext confined to container RAM. Both channel
migrations applied there; all historical row digests matched after excluding
only their additive evidence columns. The verification-claim privilege check
passed and replay was refused. The disposable containers were removed.

The two rehearsed migration files were then applied together in a guarded
transaction with migration-history entries:

- `20261011192618_original_media_evidence.sql`
- `20261014090000_original_media_verification.sql`

Hosted migration count is now 19. The admin-upload migrations and download
resolver remain unapplied. The existing playback gateway remains running.

An ignored operator script reuses the existing keyed `--verify` worker mode,
one candidate at a time, using the dedicated existing discovery reader session
at `C:/Users/willi/VeloraSecrets/discovery-reader/reader.session`. It reads the
whole original, hashes it, decodes it, and exercises the seek samples. Originals
are never converted, remuxed, sent, replaced or deleted. Temporary spool files
are removed by the existing worker implementation.

For each successful verification the script re-reads the authoritative blockers.
Only when the sole remaining blocker is rights clearance does it record the
owner's confirmation, approve and publish through the existing authenticated
reviewer functions. The owner's existing capability row is required; no new
capability is granted. A failed verification remains unpublished.

**In progress:** Brave: Gunjyou Senki passed whole-file verification, rights
recording, approval and publication as version 3, slug
`brave-gunjyou-senki-2021`. Its real signed-in Chrome proof also passed video,
decoded audio, pause, seek and close; the temporary verification account was
removed. All the Devil's Men failed full decoding (`decode_failed`), remains
at the media and rights gates, and was neither cleared, approved nor published.
Bitter Harvest is now being verified. Final per-title results
will be recorded here after completion. Private
operational evidence is in `.velora-ingest/eight-publication.log` and
`.velora-ingest/eight-publication-results.json`.

**Transfer measurement:** a four-request variant passed byte-identity and
concurrency tests (1,201 unit tests total), but live throughput remained around
1.5 MB/s. The variant and its extra tests were removed; the original sequential
implementation is retained. All the Devil's Men, already running when this was
reverted, completes with the tested four-request variant. Subsequent processes
use the original reader. Neither variant changes the verification contract.

A separate operator playback check waits for each successful publication and
then verifies signed-in video and audio, pause, seek and close through the local
app. Its temporary verification account is removed after each movie.

**Post-activation database lint:** the pinned CLI returned exit 0 with no errors
for `public`, `private`, `catalogue_review` and `media_gateway`. It reported one
volatility warning on `private.original_media_verification_valid`: the reason
loop uses the generic `jsonb_build_array`, classified STABLE. All three arguments
in this function are already JSONB values extracted from its sole JSONB input;
it reads neither tables nor session-dependent timestamps. The function therefore
remains a pure validation of that input. This is an assessment of the restricted
call site, rather than a claim that the generic builder is immutable; PostgreSQL
documents its general argument conversions in [JSON creation functions](https://www.postgresql.org/docs/17/functions-json.html).
No privilege, validation rule or applied migration was changed to suppress the
warning. Evidence is `.velora-ingest/eight-publication-db-lint.log`.

### Resumption on 2026-10-17

The owner explicitly approved resuming publication of the six remaining titles.
Hosted readback confirmed Brave remains published and All the Devil's Men remains
unpublished with `decode_failed`. The other six have no passing whole-file
verification yet. The previous Bitter Harvest process stopped without recording
evidence and left an expired processing lease.

The resumed operator script closes only that expired lease through the existing
completion function with no evidence, preserving the confirmed identity and all
publication blockers. It then runs the existing keyed verification worker for
Bitter Harvest, Echo Boomers, Gaslight, Hunting Grounds, In Cold Light, and Saving
General Yang, sequentially. Passing results proceed through the existing rights,
approval and publication functions; failed results remain unpublished. Earlier
results are preserved. No schema or privilege changes are made.

The worker connected successfully to the reader and started Bitter Harvest.
This is an in-progress record, not a publication result. Operational evidence:
`.velora-ingest/eight-publication-resumed-20261017-run2.log` and the existing
`.velora-ingest/eight-publication-results.json`. Originals are read without
conversion or Telegram writes; temporary files are removed by the worker.

### All-movies readiness follow-up on 2026-10-17

Bitter Harvest subsequently passed whole-file verification and published as
version 4, slug `bitter-harvest-2017`. Echo Boomers completed its media read but
the worker reported `store_error` when persisting the result; no passing
evidence was recorded, so it remains unpublished. The active original batch
continued with Gaslight.

The owner requested readiness for every movie, explicitly including All the
Devil's Men. A verification-only follow-up is queued behind the original batch
to serialize access to the dedicated reader. Its snapshot covers the 15 current
confirmed channel titles and skips titles already published when it starts.
It retries All the Devil's Men first, then Echo Boomers and the remaining
unpublished titles. Expired interrupted leases are recovered without evidence;
unexpired leases are allowed to expire before recovery.

The diagnostic worker reuses the same verifier and restricted database adapter,
preserving completion payloads and database errors in private local JSONL files
and recording FFmpeg exit codes and bounded stderr. If All the Devil's Men
fails decoding again, its unchanged local original is retained for diagnosis;
the Telegram original is never replaced. Earlier evidence shows its decode
reached 5981.208 seconds of 5981.227 seconds, but reported `decode_failed`;
reaching the end alone does not establish a successful decode.

Automatic approval review rejected expanded publication of the seven additional
titles outside the earlier named batch. The rejected expanded publication script
was removed. The launched follow-up has no rights-clearance, approval, or
publication calls. The original approved batch continues unchanged. Readiness
and publication are still in progress, not complete. Private operational records:
`.velora-ingest/all-movies-readiness-20261017.log`,
`.velora-ingest/readiness-verification-results.json`, and
`.velora-ingest/readiness/`.

### Standing owner approval on 2026-10-17

The owner explicitly extended automatic owner approval to all current movies and
all future uploads. `AGENTS.md` section 40 records this standing authorization
for subsequent sessions, including the reference
`owner-standing-approval-2026-10-17`. Per-title confirmation from the owner is
no longer required for rights, review, transfer, or publication within the
existing trusted ingestion paths. Technical and identity checks still apply;
explicit rejection, revocation, expiry, and version-replacement restrictions
remain authoritative.

A local channel publisher is running in
`.velora-ingest/standing-approval-publisher.mjs`. Its read-only dry run passed
and found no additional eligible titles. It waits for the original publication
batch to finish, then polls once per minute. Only confirmed, unpublished
candidates whose sole possible blocker is rights clearance are considered.
Within a transaction it takes the existing candidate lock, re-reads the current
revision and blockers, and calls the existing authenticated rights, approval,
and publication functions under the owner's existing capabilities. No database
schema, grants, or verification predicate is changed. Rejected candidates and
failed media cannot be published by this process.

The publisher and diagnostic verification follow-up were restarted with
coordination safeguards; the active media transfer was not stopped. Current
logs are `.velora-ingest/standing-approval-publisher-run2.log` and
`.velora-ingest/all-movies-readiness-20261017-run2.log`. Creating
`.velora-ingest/standing-approval.pause` pauses the publisher on its next cycle.
This is a local operator process, not an installed or deployed service; it does
not automatically restart after reboot. The standing authorization also covers
future admin uploads, but their existing database state machine and rights
expiration requirements remain in place; this channel publisher does not
implement an unattended R2 upload approval service.
