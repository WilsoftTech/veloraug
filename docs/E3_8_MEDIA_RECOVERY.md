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

## Local repair (implemented 2026-10-11, not deployed)

Status: **implemented and validated locally. Nothing live changed.** Hosted still
has 16 migrations, the listener still runs `velora-discovery:gate-b` in metadata
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
   which sort before it. Decide whether to deploy it alone, out of order, or all
   seven in order.
2. Rebuild the listener image from this tree.
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
