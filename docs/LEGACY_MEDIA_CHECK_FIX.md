# Legacy media check failures: audit and fix

**Emergency continuation:** the owner approved the three expectation changes
below. Publisher automation is contained and no live reinspection is authorized.
The current policy requires a clean full-file decode; an error at the end is
not verified integrity. Current regression and authorization evidence is in
[the containment report](EMERGENCY_PUBLISHER_CONTAINMENT_2026-10-17.md).

**Reconciled status (2026-10-17):** the legacy implementation and two approved
expectation updates are committed locally in `00b0268`; the third approved reviewer
expectation is included in this follow-up. All three are approved and applied.
After preparation and validation, the owner separately authorized committing and
pushing this narrow test/documentation follow-up. That Git authorization does not
authorize live verification, deployment or publication.

No standing authorization to establish distribution rights is in force. Technical
verification does not establish distribution rights. Title-specific rights clearance
and final publication approval remain separate mandatory gates; historical rights
references are not sufficient proof of current distribution rights. Automatic
rights clearance, approval and publication remain suspended.

The original audit and pre-approval test results below are historical evidence,
not fresh hosted state. This preparation performs no migration, deployment,
listener change, Telegram read/write, rights clearance, approval or publication.
The original hosted audit used SELECT inside `BEGIN READ ONLY`; it is not rerun here.

## 1. The three candidates (read-only audit)

At the original read-only audit, hosted had 19 migrations (latest `20261014090000`): the Policy 3 evidence
schema and the whole-file verification contract are deployed. All three
candidates are channel posts by VJ Ice P with film and VJ confirmed, not
published, and blocked by `media_verification_required` and
`rights_clearance_required`.

| | In Cold Light | Hunting Grounds | All the Devil's Men |
| --- | --- | --- | --- |
| Movies channel message | 50 | 49 | 44 |
| Original file | `.mp4`, `video/mp4`, 1,549,155,053 B | `.mkv`, `video/x-matroska`, 1,593,739,073 B | `.mkv`, `video/x-matroska`, 1,961,905,342 B |
| Codecs | not read by any inspection | not read by any inspection | H.264, MP3 |
| Evidence rows | 2, both policy 2, bounded, 64 bytes read (2026-10-11 14:36 and 14:57 UTC) | 1, policy 2, bounded, 16 bytes read (2026-10-11 14:56 UTC) | 1, **policy 3, whole file**, 1,978,690,766 bytes read (2026-10-14 06:32 UTC) |
| Recorded reason | `mp4_not_fast_start` | `container_not_mp4` | `decode_failed` |
| Statuses | `legacy_unassessed` / `legacy_unassessed` | `legacy_unassessed` / `legacy_unassessed` | integrity `incomplete`, streaming `unverified` (not attempted), download `original_servable` |
| Ever evaluated by Policy 3 | No | No | Yes: decoded 5981.208 s of 5981.227 s |
| Original media available | In the Telegram channel; no local copy on this machine | Same | Same at the original audit; the queued readiness run was subsequently stopped and quarantined |
| Published title in the same format | None: all four published versions are head-index MP4 (two H.264/AAC through Policy 3, two H.264/MP3 through the uploader) | None: no MKV is published | None |

### Root causes

- **In Cold Light.** The only inspection was the earlier MP4-only policy 2,
  run by the listener on 2026-10-11. Policy 2 refused any MP4 whose index is at
  the end. Policy 3 accepts that layout (`mp4_tail_index`, with a startup
  warning). Nothing about the file's integrity is known. The result is stale,
  not a finding against the file.
- **Hunting Grounds.** The same, for policy 2's "MP4 only" rule: it read
  16 bytes, saw a Matroska header and stopped. Policy 3 accepts MKV.
- **All the Devil's Men.** A real Policy 3 whole-file result, but an
  unclassified one. The verifier ran FFmpeg with every decoder error fatal and
  counted **any** error line, or any non-zero exit, as `decode_failed`, then
  discarded the text. The decode stopped 0.019 s before the container's
  duration, so the reported problem lies after the whole film has decoded.
  With the committed fixtures damaged on purpose, FFmpeg 9.0.2 gives exactly
  that shape for an incomplete or unreadable final block (`Truncating
  packet…`, `invalid as first byte of an EBML number`, exit 0, decoded to the
  end). That is **consistent with, not proof of**, the cause: the error text
  was not kept. Corruption is not inferred from the old code.

### Why hosted still shows the legacy result

| Cause | Applies |
| --- | --- |
| Historical candidate records | **Yes.** The latest evidence for messages 49 and 50 is the 2026-10-11 policy 2 row. Evidence is append-only; only a new inspection supersedes it |
| An older discovery-listener image | **Yes.** `velora-discovery:gate-b`, built 2026-10-11 07:10 UTC, predates the Policy 3 code (commit `226cfc2`, 21:48 +03:00). Run in bounded mode it would apply policy 2 again |
| Missing Policy 3 worker integration | **Yes, on the listener.** It runs `VELORA_DISCOVERY_INSPECTION=metadata`, so "Run media check" records no evidence at all. The only Policy 3 producer is the operator's `discovery.mts --verify`, run from source on this machine |
| Unapplied migrations | **No** for the channel path (migrations 7 and 10 are deployed). Yes for admin uploads (the six admin-upload migrations, 8 and 11) and downloads (9) |
| Missing configuration | For the listener only: reader session, `VELORA_DISCOVERY_SPOOL_DIR` and media tools are not given to the running container |
| The dashboard | **Yes.** It presented the policy 2 refusal as a current failure: streaming "Failed", queue label "Media check failed", "It needs a fast-start version" / "an approved MP4 version" |

## 2. Rules: legacy versus Policy 3

| Question | Policy 1/2 (legacy) | Policy 3 |
| --- | --- | --- |
| Containers | MP4 only (`container_not_mp4`) | Original MP4 and MKV |
| MP4 index at the end | Refused (`mp4_not_fast_start`) | Accepted; layout `mp4_tail_index`, warning `mp4_startup_tail_required` |
| How much is read | A bounded head (16 to 3,072 bytes in practice) | Bounded check first; verification reads and hashes every byte |
| Integrity | Not assessed (`legacy_unassessed`) | Whole decode of the film and every audio track, to the container's duration |
| Streaming readiness | Implied by "fast-start MP4" | Its own finding: a usable layout plus decodes after seeking to start, middle and end |
| Browser compatibility | Not recorded | Recorded separately as a prediction; never a gate |
| Download availability | Not assessed | Its own finding (`original_servable` / `not_servable`); never a gate |
| A decode failure (before this fix) | — | One code, `decode_failed`, for anything |
| A decode failure (after this fix) | — | Named, see section 3 |

## 3. What changed

**Decode failures are named** (`decodeFailureReason`,
`lib/discovery/original-verification.ts`). `decodeStreams` now returns the
exit code and FFmpeg's error lines, in memory only (they can name local
paths). Its pass/fail verdict is unchanged: a decode passes only with exit 0
and no error line.

| Code | When | Panel | Gate |
| --- | --- | --- | --- |
| `decode_corrupt_data` | The decoder reported damaged data before the end of the film | Failed: damaged | Closed |
| `content_truncated` | The data ends early, before the film does | Failed | Closed |
| `decode_container_unparsable` | Nothing decoded; the container could not be opened | Failed | Closed |
| `decode_error_at_end` | The decode reached within 1 s of the duration, then reported an error | Not verified; "not evidence of damage" | Closed |
| `decode_codec_unsupported` | The verifier's decoder has no decoder for a track | Not verified; a tool limit | Closed |
| `decode_failed` | Anything not recognised, and every row recorded before this fix | Not verified; "does not show that the file is damaged" | Closed |
| `decode_timeout` | Unchanged | Inspection incomplete | Closed |
| `decode_tool_failed` | The decoder was stopped, could not start, or exited non-zero naming nothing | **Never recorded**: channel retries it like a reader outage; upload retries it as `unexpected_error` | Unchanged |
| Incomplete read, network failure | Unchanged: `content_size_mismatch` is recorded; reader outages are retried and never recorded | | |

None of these codes verifies anything. Only a clean decode to the end does, as
before. **No rule was relaxed**: an error after the whole film still keeps the
gate closed. The emergency instruction explicitly preserves this requirement.

**Historical results are history** (`lib/discovery/media-report.ts`,
`guidance.ts`, `components/media-verification.tsx`). When the latest evidence
is a policy 1/2 refusal on a database that reports Policy 3 facts:

- integrity, streaming and browser compatibility read **"Awaiting Policy 3
  inspection"**, and the basis line says it is a historical result only;
- the policy 2 reason moves out of "Why the inspection did not pass" into
  **"Historical result (not a current verdict)"**, worded as what the earlier
  policy refused and that Policy 3 accepts;
- the queue label is **"Awaiting Policy 3 inspection"**, not "Media check
  failed", and "Last failure" is empty.

On a database without the Policy 3 facts, policy 2 is still the policy in
force, so its refusal is still shown as failed (unchanged, tested). A policy 2
*pass* is unchanged everywhere. The "Verification inconclusive" queue label is
new, for whole-file results that show no damage.

The panel distinguishes, each tested: historical legacy failure, awaiting new
inspection, current Policy 3 verification (pending, verified), integrity
failure, streaming-readiness failure, inconclusive verification, browser
compatibility warning, download availability.

## 4. Database dependencies

**None new.** The deployed validator constrains reason codes by pattern
(`^[a-z0-9_]{1,100}$`), not by list, so the new codes are accepted by hosted's
current 19 migrations. Proven: the isolated integration tests record
`decode_error_at_end` and `decode_corrupt_data` through migration
`20261014090000`, the same file hosted runs. No grant, role or function
changes.

## 5. Reinspection design

The administrator-controlled path already exists and is reused:
`discovery.mts --verify <candidate key>` (Checkpoint 10, migration
`20261014090000`).

| Requirement | How it is met |
| --- | --- |
| Explicit authorization | Only an operator starts it, with `VELORA_DISCOVERY_LIVE_AUTHORIZED=true`, the worker's own database identity and the dedicated reader session. Nothing in the dashboard starts it |
| The correct media version | Claimed **by key** (`discovery_claim_verification`), never "next due"; the evidence is bound to the document identity (chat, message, file id, size); a lease taken over or a changed post gives `stale` and records nothing |
| Film and VJ identity kept | Claimable only once a reviewer confirmed both; completion keeps them (tested) |
| No duplicate movie records | It records evidence only. The worker role has no rights, approval or publication function |
| Policy version and fresh evidence | Policy 3, contract 1, `full_original_v1`, scope `whole_file`, tool versions, SHA-256 of every byte |
| Previous failures are not current results | Evidence is append-only; the gate reads the latest row only. Historical rows stay (tested: the policy 2 row is still there after a passing reinspection) |
| Idempotent | One lease at a time per candidate. Running it again appends a new row for the same document; two whole-file reads that hash differently block publication (`media_content_conflict`). It does not skip a candidate that already passed: the worker role cannot read evidence, and adding that would need a migration |
| Never clears rights or approves | Unchanged; tested on both paths |

Not done: a dashboard control that *requests* a Policy 3 verification. The
existing "Run media check" button asks the listener, which on hosted runs in
metadata mode and records nothing. The guidance now says the operator must
start a whole-file verification.

## 6. Tests

Regression coverage added by the original fix (results are recorded below):

- `lib/discovery/original-verification.test.ts` (+16): each code from FFmpeg's
  real lines, All the Devil's Men's recorded numbers, and that
  `decode_tool_failed` is retried, not recorded.
- `lib/uploader/media-ffmpeg.test.ts` (+3, real FFmpeg 9.0.2): fast-start MP4,
  tail-index MP4, MKV H.264/AAC and MKV with AC-3 (browser-incompatible audio)
  each verified with their warnings; corrupt MKV, damaged final block,
  truncated MKV, truncated MP4 (`mp4_layout_incomplete`), incomplete read
  (`content_size_mismatch`), unsupported codec and unopenable container.
- `lib/discovery/media-report.test.ts` (+10): the three candidates as hosted
  records them, through the same view.
- `tests/integration/original-verification.test.tsx` (+2, disposable
  database): a policy 2 refusal recorded as on hosted, shown as history, then a
  keyed Policy 3 reinspection verifies it (tail-index MP4 and MKV), keeps the
  historical row, film and VJ, and still needs rights and approval; publication
  without approval is refused. A failed reinspection for damage, an error after
  the whole film and a cut file, each named, none opening the gate.
- `tests/browser/admin.spec.ts` (+1, six browser projects) with two fixture
  scenarios: wording and layout at 360, 390 and 1440 px.

Historical pre-approval runs (retained; superseded for regression status by the containment report):

| Gate | Result |
| --- | --- |
| Typecheck (app and three service configurations) | Pass |
| Lint (changed files) | Pass |
| Unit suite, media tools configured | 1,224 passed, **2 failed** (the two assertions below) |
| Database suites, all 28 migrations, disposable | 21 of 21, 1,212 assertions (no SQL changed) |
| Integration, disposable | 62 passed, 1 skipped (existing Auth exclusion), **1 failed** (below) |
| `scripts/checkpoint9-validation.mts` (17 and 28 migrations) | Pass |
| Browser, `admin.spec.ts`, six projects | 24 of 24 |

### Three existing assertion updates (approved and applied)

The table preserves the old expectations and the approved replacements. The
media-report and integration changes are in `00b0268`; the reviewer change is
included in this follow-up. The earlier pending-approval wording and failures are historical and
remain recoverable in that commit and the preserved audit patches.

| Test | Previous expectation | Approved replacement |
| --- | --- | --- |
| `lib/discovery/media-report.test.ts:94-97` | a policy 2 `mp4_not_fast_start` row on a Policy 3 database reads streaming "Failed", integrity "Not assessed", and `reasons[0]` names the index | "Awaiting Policy 3 inspection" for both, and the text in `history[0]` |
| `components/discovery-review.test.tsx:83-87` | the same record renders exactly one `>Failed<` and "Not assessed" | no `>Failed<`; "Awaiting Policy 3 inspection", "Policy 2", "index at the end", "Version 2" |
| `tests/integration/original-verification.test.tsx:270` | a zeroed-middle MKV records `["decode_failed"]` | `["decode_corrupt_data"]`; the lines after it ("Failed" twice, "the file is damaged", "Media check failed") remain unchanged and passed during containment validation |

Before the approved updates, these failed in every recorded run (unit suite
twice, integration three times). All three approved replacements now pass in the
working tree; the containment report preserves the subsequent regression results.
No other existing assertions or publication/security requirements are changed by
this reconciliation.

`lib/discovery/operations.test.ts` "metadata matching config…" failed once in
the first full run (5.8 s, against a 5 s limit, while the live batch was
decoding) and passed 4 of 4 alone and in the second full run. Unchanged; it
starts a subprocess.

## 7. Deployment readiness

This change is code only. Where it takes effect:

| Surface | When |
| --- | --- |
| Reviewer dashboard | When the app is deployed. The local `next dev` against hosted data shows it now |
| Channel whole-file verification | The previously running operator batches are stopped and quarantined. No next title or live reinspection is authorized. A separately authorized future keyed run from this tree would use the classifier; technical success would still not establish rights or publication approval |
| Listener (`velora-discovery:gate-b`) | Not affected until the image is rebuilt |
| Admin uploads | When the admin-upload chain and its worker are deployed |

Possible future activation sequence, blocked pending separate authorization;
this is not an instruction to run it:

1. The three assertion changes are approved. The subsequent Git-only authorization
   covers this follow-up; all live actions still require a separate decision.
2. In Cold Light (message 50) and Hunting Grounds (49) would each need separately
   authorized keyed `--verify`, reading the whole original from Telegram (about
   1.5 to 1.6 GB each).
3. All the Devil's Men (44): one keyed `--verify` with FFmpeg's error text
   kept privately, to confirm the cause, only after separate authorization.
   `decode_error_at_end` remains failed integrity under the current policy;
   a clean full-file decode is required. No exception is approved.
4. Any technically verified title still requires current title-specific rights
   evidence, rights clearance and final publication approval. Historical reference
   strings do not satisfy those decisions; automation remains suspended.

Any future rollback requires separate approval; no Git history or data is changed here. Rows recorded with the new codes
stay valid under the deployed validator, and the previous panel shows them as
failed with their code.

## 8. Remaining blockers and decisions

- The three existing-test changes (section 6) are now approved and applied;
  current regression results are recorded in the containment report above.
- No live reinspection by this work; the three candidates keep their recorded
  evidence until an approved run.
- `decode_error_at_end` does not verify integrity. No policy relaxation is
  authorized; the complete file must decode cleanly.
- Listener image rebuild, if the listener rather than the operator should
  produce Policy 3 evidence; until then "Run media check" records nothing on
  hosted.
- A dashboard request for Policy 3 verification would need a new audited
  request path (a migration); not built.
- Safari, iOS and Android remain not tested.
