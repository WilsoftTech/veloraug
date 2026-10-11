# Seven Telegram candidates — media inspection recovery

Read-only audit: 2026-10-11, Africa/Nairobi. Branch `phase-a-foundation`, HEAD
`393a9edaddd2c2e887d689f8a571e3631a500cf8`. Existing uncommitted R2 configuration
and `.claude/` files are preserved. R2 runtime flags remain explicitly false.

## Root cause before implementation

The live discovery container is healthy but uses `VELORA_DISCOVERY_INSPECTION=metadata`.
This deliberately provides no media reader/evidence. Its reader session is not
configured or mounted. Metadata completion moves each event to `needs_review`;
the existing scheduler claims received/failed/expired-processing events, not these
review records. The apparent waiting state does not mean media work is queued.

All seven have confirmed movie identity and VJ 1, zero media evidence records,
one current inspection attempt, and no active candidate lease. Their history
contains five earlier `inspection_provider_failed` attempts caused by the already
repaired JSONB transport defect, followed by explicit reinspection and metadata
confirmation. No current exhausted attempt counter was reset by this audit.

The existing discovery Reinspect command increments the review revision and
invalidates approval; its subsequent full inspection can overwrite confirmed
metadata. Media-only recovery must preserve the approved metadata match and VJ.

The Bot API and discovery containers are healthy. The discovery ready endpoint
returns 200 but describes loop health, not media readiness. No Media Gateway
listener was found on 8787; a local reader session and ffprobe binary exist, but
their live Telegram validity has not been tested. The actual inspection backend
is `channelMediaPort` over `mediaReaderRange` and the existing dedicated MTProto
reader, with bounded ffprobe. The published-only gateway resolver is not widened.
Neither R2 nor the Local Bot API upload adapter verifies these channel files.

Channel: the registered Movies channel. Its ID, the documents' Telegram unique
IDs and the candidates' discovery keys are private operational data: they are in
the database and the review dashboard, and are not recorded here. These
references were read in a read-only database transaction:

| Event ID | Message | Size | Revision | Confirmed film | TMDB | Reported type |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | 44 | 1.96 GB | 3 | All the Devil's Men | 481203 | MKV |
| 7 | 45 | 1.77 GB | 3 | Bitter Harvest | 403390 | MP4 |
| 8 | 46 | 1.16 GB | 4 | Brave: Gunjyou Senki | 726657 | MP4 |
| 9 | 47 | 1.85 GB | 3 | Echo Boomers | 558574 | MKV |
| 10 | 48 | 1.98 GB | 3 | Gaslight | 1092654 | MP4 |
| 11 | 49 | 1.59 GB | 3 | Hunting Grounds | 1305717 | MKV |
| 12 | 50 | 1.55 GB | 5 | In Cold Light | 1128377 | MP4 |

Every current candidate is blocked by media verification and separate rights
clearance. MIME labels are not actual container verification: three reported MKVs
may remain incompatible with the MP4/H.264/AAC-or-MP3 policy. No conversion,
replacement, upload, rights decision or publication is authorized here.

## Local repair (implemented 2026-10-11)

> Later the same day the migration was deployed to production and the reader
> session was created. See "Production deployment" and "Reader session" at the
> end. The rest of this section describes the state when the repair was written.

Status then: **implemented and validated locally. Nothing live changed.** Hosted still
had 16 migrations, the listener still runs `velora-discovery:gate-b` in metadata
mode, and all seven candidates are still awaiting media verification. No Telegram
read or write, no hosted read or write, no reinspection, no rights decision and no
publication happened in this work.

### What changed

Migration `20261011112745_channel_media_inspection_recovery.sql` (the repository's
23rd; `create or replace` of five existing functions, no new object, no new grant):

- `discovery_claim` also returns `confirmed_selection` for a confirmed candidate:
  the reviewer's film, year and VJ with the validated snapshot.
- `discovery_complete` records the bounded evidence for a confirmed candidate and
  returns it to review. Title, year, VJ, TMDB identity, warnings and the match
  candidates are left untouched, whatever the worker sent. An unconfirmed
  candidate completes exactly as before.
- `discovery_fail` backs off 30, 60, 120 and 240 s for a transient reader failure
  (`media_read_*`, `probe_timeout`), inside the unchanged five-attempt bound. A
  Telegram flood wait (at most 300 s in the reader) fits inside it. Other codes
  keep their 2 to 16 s schedule.
- `discovery_review_retry` behaves as before (new revision, approval invalidated,
  attempts reset) and its audit entry says `media_only` or `full`.
- `private.channel_view` adds `inspection`: the worker's last inspection result
  (fixed codes) and the next scheduled retry.

Worker (`lib/discovery/database.ts`, `lib/discovery/media-verification.ts`):

- With a confirmed selection the worker reads the media only. No catalogue, VJ or
  TMDB lookup runs.
- A reader failure keeps the reader's closed code as its reason. Five are
  transient (`not_ready`, `telegram_unavailable`, `flood_wait`,
  `mtproto_disconnected`, `upstream_timeout`), as is `probe_timeout`. On a
  media-only inspection a transient result is recorded with `discovery_fail` and
  never as evidence, so an outage cannot supersede a passing verification.
- A property of the document (`container_not_mp4`, `mp4_not_fast_start`, a codec
  outside the policy, a post that no longer resolves) is recorded as unverified
  evidence. The candidate stays in review, blocked at the media gate with its
  reason, and is not retried by itself.

Dashboard (`components/discovery-review.tsx`, `lib/discovery/guidance.ts`), the
existing queue and detail components only:

- Detail: last inspection (time, result, revision), last failure in plain words,
  attempts of five, next retry, and whether a person is needed. A confirmed
  candidate at the media gate gets one primary action, **Run media check**, which
  is the existing audited `discovery_review_retry` under the review capability.
- Queue: such a candidate moves from "In progress" to "Needs you" ("Media check
  needed" or "Media check failed"), because nothing claims it by itself.
- All of this appears only when the database reports `inspection`. Against a
  database without the migration the screens are exactly as before, so the
  running dashboard does not promise that a reinspection keeps the confirmation
  while hosted would still replace it.

`infra/discovery/compose.bounded.yaml` is an override that selects bounded mode and
mounts the reader-session directory. It is unused until named explicitly, and it
fails closed without `VELORA_DISCOVERY_READER_DIR`.

Two cross-boundary imports from the interrupted first draft were removed: the
gateway's error module (the reader's errors are recognised by shape, since this
module is reachable from Next.js) and a new direct importer of the TMDB ingestion
module (the snapshot contract comes from the review model). The existing boundary
tests caught both.

### Requirement check (brief, phase 4)

| Requirement | How it holds |
| --- | --- |
| Only the seven | The request is per candidate, by its key and current revision |
| Telegram identities kept | Nothing writes `telegram_media`; evidence must match the `tg1-` identity |
| Confirmed film and VJ kept | Completion never writes them for a confirmed candidate (pgTAP 017, integration) |
| Revision semantics | A request is a new revision, as before; rights of an older revision no longer count |
| No duplicate records or uploads | No insert of candidates, events or media; no send path exists here |
| Never verified on request | `verified` is derived by the evidence table from recorded facts |
| Evidence kept until replaced | Rows are appended; outages and reader-less passes record none |
| Every attempt recorded | Audit: `reinspection_requested`, `inspection_failed`, `media_inspected` |
| Bounded retries with backoff | Five attempts, then `inspection_attempts_exhausted` |
| No unsafe concurrency | Unchanged `SKIP LOCKED` claim and fenced lease; a stale lease returns `stale` |
| Permanent failures stay blocked | Unverified evidence with its reason; the media gate stays closed |

### Validation

| Check | Result |
| --- | --- |
| Unit tests | 966 passed, 28 skipped (58 files passed, 1 skipped) |
| Disposable database, all migrations and pgTAP | 23 migrations; 17 suites, 987 assertions (66 new in suite 017) |
| Suite 017 without the migration | 21 of 66 fail, including "nothing the worker sent replaces the confirmed film, year or VJ" |
| Isolated integration through PostgREST | 44 passed, 1 skipped (1 new: detect, confirm, request, flood wait, retry, verified) |
| Typecheck (app, gateway, upload service), ESLint | Pass |
| Production build (isolated helper) | Pass; only the existing `lib/uploader/journal.ts` tracing warning |
| `db lint` on the disposable chain | No finding in these functions; one existing warning in `admin_upload_r2_command` |
| Rendered screens at 360, 390, 768, 1440 px | No overflow, targets at least 44 px, labelled controls, one inspection control |
| Compose override | Valid; refuses to start without the reader directory |

Not tested: a real MTProto read, the reader session's validity, real ffprobe on
these seven files, and the rebuilt image. `npm run test:db` and
`db lint --local` were not run, because both act on the developer's local
Supabase stack; the disposable container covered the same chain.

## Live reinspection: plan, awaiting separate approval

Nothing below has been done.

**Cause, for all seven.** Metadata mode has no media reader, so no evidence was
ever recorded. The earlier five failures per candidate were the repaired JSONB
transport defect, not the media.

**Operation.** For each candidate a signed-in reviewer presses **Run media
check**. The bounded worker claims it, reads the document through the dedicated
reader bot, and records evidence. Canary first: event 8, message 46 (the smallest
MP4). Verify its database state, then the other six one at a time.

**Telegram.** Reads only, by the reader bot over MTProto: one message lookup,
16-byte box headers, the index plus 64 KiB, and the last 4 KiB. The budget caps
one document at about 16.1 MiB, so at most about 113 MiB for seven; an MKV costs
16 bytes. No send, forward, edit or delete.

**Database.** Per candidate: revision +1, attempts reset, one audit row for the
request and one per attempt, and one evidence row when a check completes. No
catalogue, rights or approval row.

**Expected results.** Events 6, 9 and 11 report MKV. If that is what the files
are, they end as `container_not_mp4` and need an approved MP4 rendition, which is
a new upload and a separate authorization. The four MP4s verify only if they are
fast-start H.264 with AAC or MP3 inside the existing policy.

**Prerequisites, each a separate approval.**

1. Deploy migration `20261011112745` to hosted. It depends on nothing in the six
   undeployed admin-upload migrations (`20261011083200` to `20261011095632`),
   which sort before it. The plan below deploys it alone and proves that the
   order does not matter.
2. Rebuild the listener image from this tree. **Done** (built and tested
   offline, not started; see "Listener image" below).
3. Provision the reader bot's own session file for discovery, separate from the
   gateway's, and add `TELEGRAM_MEDIA_API_ID`, `TELEGRAM_MEDIA_API_HASH`,
   `TELEGRAM_MEDIA_BOT_ID` and `TELEGRAM_MEDIA_BOT_USERNAME` to the worker's
   private env file. This is one Telegram login of the reader bot.
4. Restart the listener with the bounded override. It refuses to start without
   the session, with the Movies bot's session, or without channel access.

Order matters only in one direction: the migration goes first. The current image
against the new functions is safe (the confirmation is kept; no reader, so no
evidence). The new image against the old functions would still replace a
confirmation on reinspection, and the dashboard does not offer the check there.

**Rollback.** Restart from the base compose file (metadata mode). Evidence rows
are append-only and cannot publish anything: rights, approval and the publish
decision remain separate gates. The five functions can be restored from
`20261010090000_direct_channel_publication.sql` in a new migration.

**Sequencing note.** Run the media check before clearing rights. A request is a
new revision, and a clearance belongs to the revision it was recorded at.

## Listener image (2026-10-11): built and tested offline, not started

`velora-discovery:media-recovery` (image `1218b772c5c0`, built from commit
`99e1a34`). The running listener is unchanged: still `velora-discovery:gate-b`,
metadata mode, same container, no restart. No container was created from the new
image except the disposable test runs below.

Every test ran with no network, a read-only root filesystem, a 32 MiB tmpfs, all
capabilities dropped and synthetic configuration values.

| Check | Result |
| --- | --- |
| Bounded mode with a complete reader configuration (`--check`) | Valid, exit 0 |
| Bounded mode without reader configuration, or without a session path | Refused, names the missing variables, exit 78 |
| Reader bot equal to the Movies bot | Refused (`discovery_bot_identity_invalid`), exit 78 |
| Database login other than the worker role | Refused (`discovery_wrong_database_identity`) |
| Start without live authorization (unset or `false`) | Refused (`discovery_gate_b_required`), exit 78 |
| Reader started with no session file | Refuses (`media reader session missing`); no login, no network call |
| Image contents | User `node`, ffprobe and ffmpeg 5.1.9, no test files, root not writable |
| Real ffprobe on generated files | H.264 with AAC and with MP3: canonical, playback-ready, about 74 KB read each |
| | Non-fast-start MP4: `mp4_not_fast_start` (64 bytes read). MKV: `container_not_mp4` (16 bytes). HEVC: `video_codec_hevc` |
| The gateway's real error class through the verifier | `flood_wait` is transient; `document_resolution_failed` is not |
| A probe cut off after 1 ms | `probe_timeout`, transient |
| Worker media-only path with a fake database | Verified file: claim then complete, evidence canonical, confirmed film and VJ sent back unchanged, no metadata lookup |
| | MKV: complete with `container_not_mp4`. Reader outage: `discovery_fail` with `media_read_mtproto_disconnected`, no evidence |

**Isolation from other Telegram consumers.** The listener consumes Bot API
updates as the Movies bot. The reader is a different bot (the local
configuration's reader ID differs from the Movies bot's) on MTProto,
with updates disabled, and the worker refuses a reader that is the Movies bot.
It needs its own session file, separate from the Media Gateway's.

**Still unproven.** A real MTProto read. The listener's environment file has
none of the four reader variables and no discovery session file exists, so
bounded mode cannot start today. Creating that session is one Telegram login of
the reader bot and needs its own authorization. The only code that performs such
a login is the gateway's explicit `MEDIA_GATEWAY_ALLOW_BOT_LOGIN` path.

## Production migration plan (2026-10-11): prepared, not executed

No production connection was opened for this plan. It follows the procedure used
for migration 16 (snapshot backup, restore rehearsal, one guarded transaction),
in an operator-only driver outside Git:
`.velora-ingest/e3.8-recovery/media-recovery-migration.mjs`. Its production
stages refuse to run unless `VELORA_PRODUCTION_MIGRATION_AUTHORIZED` is exactly
`20261011112745` and `MEDIA_RECOVERY_SHA256` equals the file's hash.

**Exact change.** Migration file SHA-256 `b7222eeb…0bc3c1`. It replaces five
functions and nothing else: `public.discovery_claim`, `discovery_complete`,
`discovery_fail`, `discovery_review_retry` and `private.channel_view`. No table,
column, index, constraint, policy, trigger, role or grant changes, and no row is
written except the history row.

**Ordering.** Production has 16 migrations. Six admin-upload migrations sort
before this one and are not deployed. This migration is applied alone, ahead of
them. Later, those six must go through the same explicit driver path:
`supabase db push` would need `--include-all` for them, which the runbook forbids.

**Verified offline (`--offline`, disposable databases only).**

| Check | Result |
| --- | --- |
| Hosted-equivalent chain (16) plus this migration: functions changed | Exactly the five; 0 other objects; owners, security modes, settings and ACLs unchanged |
| Suites on that chain | 009 to 012: 275 of 275. 017: 66 of 66 |
| Order independence | 16, this one, then the six: 86 functions and the whole table shape identical to repository order |
| Replay of the deployment transaction | Refused by the history row's key; nothing changes |
| Generated rollback (`rollback.sql`, SHA-256 `83035080…7e24a8`) | Restores the five definitions exactly and removes the history row; reapplying afterwards gives the tested state again |
| Last production archive (taken before migration 16, 15 migrations) | Hash verified; 61 tables restore to the recorded digests |
| Its five functions, after migration 16 | Identical to the tested chain before and after this migration |
| Data after this migration on the restored copy | Unchanged in all 61 tables |
| New review view over the restored candidates | All 7 render with `inspection` |

**Sequence, once authorized.**

1. `--backup`: read-only. Requires the history to be exactly the first 16.
   Writes a snapshot-consistent, EFS-encrypted archive outside the repository.
2. `--rehearse`: restores that archive in a disposable database on an internal
   network and repeats the checks above against current data.
3. `--apply`: the one write. It first requires the history to be exactly 16,
   the archive hash and rehearsal to match, and production's five functions to be
   identical to the tested ones. Then one transaction with a 5 s lock timeout:
   the migration and its history row. Then verification: history is the 16 plus
   this one, the five functions equal the tested chain including owner and ACL,
   no other function changed, and non-volatile data is unchanged.
4. `--rollback`, if needed inside the change window: requires production's five
   functions to be this migration's, restores the previous definitions and
   removes the history row in one transaction. Afterwards, use a new migration.

**Effect on what is running.** Replacing a function takes no table lock. The
current listener keeps working against the new functions and cannot lose a
confirmation. The dashboard starts showing **Run media check** as soon as the
migration is live. Pressing it before the bounded listener runs is harmless but
useless: it is audited as `no_evidence`, keeps the confirmation and uses one
revision.

**Not covered.** The archive is from this morning: it holds 7 candidates with 1
confirmed, while the audit above found all 7 confirmed. The fresh backup in step
1 is what the real rehearsal runs on. A channel post arriving between the
driver's two reads shows up as data drift and stops verification after the
commit; apply while the channel is quiet.

## Production deployment (2026-10-11): PASS

Operator-authorized, for this migration only. Hosted now has **17 migrations**:
the previous 16 and `20261011112745`. The six admin-upload migrations were not
applied. The running listener was not restarted and stayed healthy.

| Stage | Result |
| --- | --- |
| Target | Project, pooler host and owner role checked against the fixed reference before every stage |
| Backup | Read-only, snapshot-consistent, EFS-encrypted, outside the repository. History exactly the expected 16; 62 tables; 7 candidates, all 7 confirmed |
| Restore | Archive hash verified; all 62 tables restored to the recorded digests in a disposable database on an internal network |
| Rehearsal on that copy | Functions before and after identical to the tested chain; no table changed; confirmations unchanged; replay refused; rollback exact |
| Reinspection rehearsed on the copy | For each of the 7 real candidates: request, claim (with the confirmed choice), then a completion naming another film, no VJ and no evidence. All 7 kept their film, year, VJ and match candidates |
| Final precheck on production | History 16; the five functions, their owners and ACLs identical to the tested chain; no table changed since the backup |
| Write | One transaction: the migration and its history row |
| Verification | History is the 16 plus this one. Exactly the five functions changed, and they equal the tested chain including owner and ACL. No table changed. The 7 confirmations are identical before and after (same digest as the backup). All 7 candidates render through the new view with `inspection` |

The archive, its evidence, the rehearsal result and the production verification
are kept with the backup, outside Git.

**Consequence for the dashboard.** The review pages now offer **Run media
check** for the seven. Until the listener runs in bounded mode it checks nothing:
it is audited as `no_evidence`, keeps the confirmation and uses one revision.
It was not pressed.

## Reader session (2026-10-11): ready, not used

Operator-authorized: one login of the dedicated reader bot, through the gateway's
own entry point with `MEDIA_GATEWAY_ALLOW_BOT_LOGIN` (no other login code). The
gateway container had no published port, so no stream could be requested and no
media was read. It reached `reader_ready`, which includes its checks that the
session is the expected reader bot, is not an ingestion bot, and can see the
Movies channel. It was then stopped and removed.

- The session file is in a private directory outside the repository checkout,
  readable only by the operator's account and SYSTEM. It is distinct from the
  Media Gateway's session, which was not modified.
- The new listener image accepts the listener's real environment plus the real
  reader identity in bounded mode (`--check`, no network). It refuses the same
  configuration when the reader is the Movies bot, or without a session path.
- The compose override validates against the new directory. Nothing was started.

Not proven: that the stored session connects again (the bounded listener checks
this at start and refuses otherwise), and any media read.

Finding, not changed: the Media Gateway's own session file inherits the
checkout's permissions, which include a sandbox users group with modify access.

## Remaining before the single-candidate canary

Each needs authorization; none was done.

1. Add the four reader variables to the listener's private environment file.
   The API ID and hash must be the pair the session was created with.
2. Set `VELORA_DISCOVERY_READER_DIR` to the private session directory.
3. Recreate the listener from `velora-discovery:media-recovery` with the bounded
   override. This restarts the listener; the base file returns it to metadata
   mode on `gate-b`.
4. Press **Run media check** on one MP4 candidate (event 8, message 46), then
   read back its evidence, confirmation and audit entries.

## Bounded listener and first live inspection (2026-10-11)

Operator-authorized. **The listener runs in bounded mode. One live inspection
ran, on message 50 ("In Cold Light"), not on the intended canary, message 46
("Brave: Gunjyou Senki"), which is untouched.** Further inspection stopped there.

**Listener switch.** The four reader settings were added to the listener's
private environment file (backed up first; no token, since the listener never
logs in). The metadata listener stopped cleanly: exit 0, consumer lease released,
checkpoint unchanged. It was recreated from `velora-discovery:media-recovery`
(image `1218b772c5c0`) with the bounded override, which now pins that image.

| Check | Result |
| --- | --- |
| Reader session | Reconnected on first use; `ready` (expected reader bot, not an ingestion bot, channel visible) |
| Health | `healthz` and `readyz` 200, state `running`, 0 restarts, 0 failures |
| Update consumer | One listener container; it holds the single consumer lease; no conflict event; checkpoint unchanged |
| At startup | Nothing claimed: all 7 in review, 0 evidence rows |

**What was inspected.** At 14:36:17Z a reviewer session requested the media
check for message 50. The same candidate had been requested once earlier, at
14:32:59Z under the metadata listener, which recorded `no_evidence` and kept the
confirmation. Message 46 was never requested.

| Message 50, "In Cold Light" | Before | After |
| --- | --- | --- |
| Status | `needs_review` | `needs_review` |
| Revision | 6 | 7 |
| Film, year, VJ, match candidates | confirmed, TMDB 1128377, 2026, VJ Ice P, 3 candidates | identical |
| Evidence | none | 1 row: `unverified`, reason `mp4_not_fast_start`, container `mp4`, scope `bounded`, policy 2, not playback-ready |
| Bytes read from Telegram | 0 | **64** of 1,549,155,053 (box headers only) |
| Audit | | `reinspection_requested: media_only`, then `media_inspected: unverified:unverified`, both at revision 7 |
| Gates | media, rights | media, rights |

The other six candidates are byte-for-byte unchanged, including message 46.
Counts are unchanged except one evidence row: 7 candidates, 11 media rows,
2 movies, 2 versions, 0 rights clearances, 17 migrations.

**Root cause of the failed check.** The file is an MP4 whose index (`moov`) sits
after the media data. A browser cannot start playing it progressively, so the
existing policy refuses it. It is a property of the file: not a reader, session
or listener fault, and a retry will not change it. It needs a fast-start
version, which is a stream-copy remux and a new upload, each needing
authorization.

**What this proves and does not.** Proven live: the reader session, a real
bounded MTProto read, evidence bound to the document, the exact reason recorded,
and a confirmed film and VJ surviving two reinspections. Not proven: a passing
verification, and the full read of an index plus sample that a fast-start file
needs (up to about 16 MiB).

**State left running.** Bounded mode. Every press of **Run media check** is now
a real Telegram read, and a new post to the channel is media-checked by itself.
The base compose file returns the listener to metadata mode.

## Second canary attempt and return to metadata mode (2026-10-11)

**Message 46 ("Brave: Gunjyou Senki") has still not been inspected.** Two more
reviewer requests reached the bounded listener, on other films, and the listener
was then returned to metadata mode as the approved plan provides.

Before the attempt nothing was queued (0 candidates due, 0 leased, uploads
disabled), so only a reviewer request or a new channel post could start an
inspection. The reviewer was given the exact dashboard address of message 46.

| Requested (UTC) | Candidate | Revision | Result | Telegram bytes read |
| --- | --- | --- | --- | --- |
| 14:56:30 | Message 49, "Hunting Grounds" | 3 to 4 | `container_not_mp4` (the post is a Matroska file) | 16 of 1,593,739,073 |
| 14:56:46 | Message 50, "In Cold Light" (third request) | 7 to 8 | `mp4_not_fast_start` again | 64 |

Both kept their confirmed film, year, VJ and match candidates, and both stay in
review at the media gate. Messages 44 to 48 are unchanged. Total read from
Telegram across all three live inspections: 144 bytes. The dev server log does
not record which candidate an action was posted for, so why the requests landed
on these films is not known from the server side; the database records are
unambiguous.

**Listener.** With unrelated candidates being inspected and the canary not, the
bounded listener was stopped and the previous listener restored from the base
compose file: `velora-discovery:gate-b`, metadata mode, healthy, holding the
consumer lease, checkpoint unchanged. A media check requested now reads nothing.

**Defect found: the bounded listener does not release its lease on SIGTERM.**
The MTProto library installs its own SIGINT and SIGTERM handlers
(`@mtcute/node/utils/exit-hook.js`), which end the process before the worker's
shutdown runs. The consumer lease then lingers until it expires (120 s). The
restored listener was refused with `discovery_consumer_busy` and restarted 10
times over about two and a half minutes before it acquired the lease. Those
attempts touch only the database. No update was lost: the checkpoint is
committed with each batch. This needs a fix before bounded mode is used again.

## In Cold Light: fast-start repair plan (read-only, nothing executed)

**What Telegram holds.** Message 50, `IN THE COLD LIGHT___VJ ICE P.2026.mp4`,
1,549,155,053 bytes, posted 2026-10-10. An MP4 whose index is at the end. Its
codecs are unknown: the inspection stopped at the layout, as designed.

**Original source file: not found on this machine.** A search of `G:`, `F:`,
`D:` and the user's Downloads, Videos and Documents folders found no video file
with that exact size or title. The repair needs the file from wherever it was
posted, or a one-time full download from Telegram (1.55 GB, a separately
authorized read; the Local Bot API's `getFile` is the existing mechanism).

**Repair, with the existing tools.**

1. `ingest scan` on the file, then `ingest normalize`: a stream copy with
   `-movflags +faststart`. No re-encoding. It proves every video and audio
   packet and the codec configuration identical to the source, and leaves the
   source unchanged.
2. Expected output: a fast-start MP4 of about 1.55 to 1.56 GB (E3.1 measured
   +0.3 percent), under the 2000 MiB upload ceiling.
3. This only helps if the streams are already inside the policy (H.264 video,
   AAC or MP3 audio). `scan` reports that before anything is written. Another
   codec would need a transcode, which is not built and not proposed here.

**Storage.** Source and rendition together about 3.1 GB on the library drive
(150 GB free), plus a 1.55 GB staging copy on the internal disk with its 2 GiB
reserve (63 GB free on `C:`). Peak about 4.7 GB.

**Getting the repaired file into Telegram and the catalogue.**

- *Existing upload and reconciliation path (as E3.3 and E3.7D).* `ingest stage`,
  then `ingest upload --fingerprint` with the real-upload gate set for that one
  command: exactly one `sendDocument` by the Movies bot. A lost acknowledgement
  is settled by the bounded marker protocol, never by a resend. The result is a
  new channel message of uploader origin. Discovery ignores the uploader's own
  posts by design, so the film is then evaluated and published through the
  owner path of C2B.2H, with its own rights confirmation, and the old candidate
  (message 50) is rejected in the dashboard. The old message stays in the
  channel, unlinked.
- *Alternative: stay in the dashboard.* Post the repaired file to the channel by
  hand. Discovery detects it as a new candidate; the film and VJ are confirmed
  again, the media check runs, and rights, approval and publication happen in
  the dashboard. No exactly-once upload guarantee, and message 50 is rejected.
- Replacing the document inside message 50 is possible only by hand in
  Telegram, and by design resets the confirmation.

Hunting Grounds (Matroska) needs the same treatment, with the same open
question about its codecs.
