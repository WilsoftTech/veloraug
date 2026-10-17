# Post-containment Git and authorization audit — 2026-10-17

Audit only. No staging, commit, history rewrite, hosted query/write, live verification, publication, push, deployment, or process restart was performed. This report and private evidence snapshots are the only new files from this audit. The emergency containment instruction overrides historical operational instructions below.

## 1. Current Git state and evidence

Branch: `phase-a-foundation`, tracking `veloraug/phase-a-foundation`, ahead 19 at inspection. HEAD: `00b02689ec73c27605d0e562a96006779f15cad9`.

Parent order, oldest first:

1. `4d0cd00414697a39bf56869cc6fe6cba00471e5a` — pre-existing gateway persistence/native-mode work.
2. `beb98834d042e6cbc38fe8993db7ebf34a56bf8c` — 2026-10-17 21:42:01 +03:00.
3. `00b02689ec73c27605d0e562a96006779f15cad9` — 2026-10-17 21:42:31 +03:00, current HEAD.

Both commits identify Karugaba as author/committer and carry a Claude Opus 5.5 co-author trailer. Reflog confirms local commit order. These facts do not establish the exact creating OS process/session or prove authorization. This Codex task did not create those commits.

The index is empty. Four tracked files have unstaged changes: `.env.example`, `AGENTS.md`, `components/discovery-review.test.tsx`, and `docs/LEGACY_MEDIA_CHECK_FIX.md`. There were 57 untracked files before adding this report: one `.claude/settings.local.json`, the emergency containment report, and 55 historical/generated evidence files. Their exact paths, sizes and hashes are preserved; none belongs in the remaining legacy code patch.

Private evidence directory: [post-containment-git-audit](../.velora-ingest/containment-evidence/post-containment-git-audit/). It contains complete binary-capable patches `beb9883.patch` and `00b0268.patch`, exact per-file zero-context hunk ranges in `commit-hunks.json`, `unstaged.patch`, the empty `staged.patch`, status/reflog, `untracked-inventory.json`, runtime checks and `staging-manifest.json`. These local ignored files must not be staged. Full patches preserve all exact hunks, including committed validation logs, without reproducing them in this report.

The original authorization evidence was not edited: `.velora-ingest/containment-evidence/AGENTS-before-containment.diff`, SHA-256 `8f3ccb3268ba6c77bddf545666d26b3c3c728c51f9bfc595c0c2bb22edc318bf`. The original quarantined-script copies and prior evidence inventory remain in place.

## 2. Commit assessment

| Commit | Actual contents | Authorization assessment |
| --- | --- | --- |
| `beb9883` | 47 files; 3,068 insertions, 47 deletions. Checkpoint 10 whole-original hashing/decode/seek verification, channel keyed claim, upload inspection, provenance UI, conditional download guidance, two migrations, security-inventory tests, integration/browser tests, validation scripts/logs and roadmap. | Checkpoint 10 implementation is separable from the legacy follow-up. **The commit is not wholly safe as an authorization record:** its new 852-line checkpoint document includes historical publishing instructions and blanket authorization claims. Do not treat the existence of the commit as permission to execute them. |
| `00b0268` | 15 files; 665 insertions, 23 deletions. Named decode failures, historical Policy 1/2 refusal display, component/guidance changes, decoder-machine-failure retry handling, regression tests, legacy report and roadmap. | The implementation matches the approved local legacy fix. No new migration, rights grant, publisher, production configuration or media-verification bypass was found in this commit. Its message and report contain stale approval/test status; two approved assertion updates are already committed despite the message saying all three await approval. |

Neither commit includes `AGENTS.md`, `.env.example`, `.claude/`, the ignored publisher/batch scripts, the pause marker, or their emergency guards. Neither commit includes the emergency containment report or emergency section 40. The legacy implementation starts in `00b0268`; `beb9883` provides the Checkpoint 10 verifier and reporting foundation rather than the later historical-result/classifier fix. Neither commit contains an executable background publisher or an automatic startup registration.

Specific committed authorization concerns in `docs/MP4_MKV_CHECKPOINT_10.md`:

- Lines 691–819 describe the eight-title activation, hosted migration/publication history, resumed batch and verification follow-up. They are historical assertions, not current authorization or instructions to resume.
- Lines 821–852 claim blanket standing authorization, dispense with title-specific rights confirmation, describe a running publisher and future-upload approval, and describe subsequent restarts. Those claims are suspended and cannot authorize any operation. The document is currently misleading about running processes.
- Lines 275–290 disclose three Checkpoint 10 security-inventory assertion edits made without prior approval. They register the new verification RPC; they are **not** the three approved legacy assertion updates. The legacy approval does not retrospectively approve unrelated Checkpoint 10 changes or its commit operation.

Checkpoint 10 changes publication eligibility predicates to require whole-file evidence and bound digests; this is a media-gate change, not a rights grant. `20261014090000` retains revision/media-bound `rights_clearance_required`, and `discovery_complete` preserves confirmed reviewer identity. Its new `discovery_claim_verification` is keyed, lease-fenced and granted only to `service_role` and `velora_discovery_worker` after explicit revokes. Private helpers and evidence tables have explicit revokes and functions pin `search_path`. The admin migration binds the evidence digest/size to the staged original. No new execute grant to rights-clearance, approval or publication RPCs was found. Those RPC implementations are not replaced by these commits. The added CLI requires the existing explicit live-authorization environment flag and does not start verification during normal listener polling.

Player/download-guidance changes and Checkpoint 10 security-inventory changes belong to Checkpoint 10, not the remaining legacy patch. The `.env.example` working-tree change separately replaces documented R2 settings with placeholders and removes several disabled-by-default examples; it is unrelated, uncommitted and excluded. No production environment/configuration file is introduced by either commit. A credential-signature scan of changed committed file contents found only the explicitly synthetic loopback credential in `scripts/checkpoint5-validation.mts:44`; this limited scan is not a complete secret audit.

## 3. Containment verification

Read [the emergency containment report](EMERGENCY_PUBLISHER_CONTAINMENT_2026-10-17.md). Fresh read-only Windows checks at **2026-10-17 19:33:18 UTC / 22:33:18 Nairobi** found zero matching publisher/verification processes, zero matching scheduled tasks, and zero matching startup entries. The initial broad process search matched its own PowerShell audit command; the final scan excludes that audit PID and records an empty result.

The pause marker exists. The publisher's final log remains `standing_approval_paused` at `2026-10-17T18:39:17.303Z`, following its waiting entries. Current `AGENTS.md` section 40 suspends standing approval and prohibits restarting the contained batches. All five scripts still begin with the unconditional `emergency_containment_requires_separate_title_specific_authorization` throw:

```text
.velora-ingest/standing-approval-publisher.mjs
.velora-ingest/publish-eight-originals.mjs
.velora-ingest/resume-eight-originals.mjs
.velora-ingest/verify-all-readiness.mjs
.velora-ingest/readiness-verifier.mts
```

Their current hashes and first lines are in `staging-manifest.json`. No script was executed to test its guard. Static inspection confirms the two eight-title batches independently contain rights/approval/publication calls and cannot safely rely on the standing publisher's marker; their own guards are essential. The standing publisher also checks for its old section-40 heading, which is absent. Its original pause check is only at cycle start, not cancellation of an already-started transaction. The prior containment audit established it was waiting and had no pending transaction when paused.

No active reactivation mechanism was found in the inspected processes, scheduled/startup entries, package/scripts/service source references. This is not a machine-wide proof against arbitrary privileged manual commands or renamed software. The direct native keyed verification CLI still exists behind its existing configuration/authorization gate; the five automatic wrappers are quarantined. It must not be invoked under this task. Local guards and instructions are reversible and are not present in another checkout.

No fresh hosted audit was performed here. The prior closing read-only hosted audit, at `2026-10-17T19:07:30.836Z`, found no post-pause rights, approval or publication operations. That is historical evidence, not a claim about fresh hosted state. Previously recorded operations and candidate keys remain in the emergency report: Brave rights/approval/publication on October 14, Bitter Harvest rights/approval/publication on October 17 at 20:00:59.365 Nairobi, and the latest rights entry for Spider-Man at 20:24:59.359 Nairobi. No standing-reference publication was attributed to the standing publisher. The legal sufficiency of those rights records is not established by this audit, and nothing was reversed or deleted.

The blanket section was previously added by this Codex conversation after the user's future-upload approval message. That request supports provenance of the requested automation, not independent evidence of any title's distribution rights. Its blanket interpretation remains suspended. The original bytes/diff are preserved, not silently replaced in the evidence record.

## 4. Legacy reconciliation

The current code preserves original MP4/MKV inspection, separate integrity and streaming findings, and rights/admin approval. A Policy 1/2 refusal on a Policy 3 database appears as historical evidence awaiting new inspection. Earlier passes and databases without separate facts retain their prior behavior. These UI changes do not create passing media evidence.

`decodeStreams` succeeds only with exit code zero and no error lines. `verifyOriginal` defaults integrity to failed, requires a successful sufficiently complete decode and no integrity reasons before verifying, then attempts streaming seeks separately. Named `decode_error_at_end` remains a failure reason; it cannot open the gate. EOF proximity classifies an error but never accepts it. Clean complete decoding remains required under the existing duration/progress check; no tolerance or verification predicate was relaxed. Tool failures are retried rather than persisted as findings.

Exactly three changes to existing legacy expectations were approved; additional newly added regression cases are distinct:

| Existing expectation update | Git state |
| --- | --- |
| `lib/discovery/media-report.test.ts:94–97`: earlier refusal now expects both statuses to await Policy 3; index explanation moves to `history[0]`, basis says historical result. | Already committed in `00b0268`. |
| `components/discovery-review.test.tsx:83–87`: earlier refusal renders no `>Failed<` and shows `Awaiting Policy 3 inspection`, retaining Policy 2/index/version evidence. | Only remaining unstaged test update; entire current file diff is authorized. |
| `tests/integration/original-verification.test.tsx:270`: damaged-middle MKV expects `decode_corrupt_data` instead of generic `decode_failed`; failed integrity, blocked gates and damage assertions remain. | Already committed in `00b0268`. |

All legacy implementation source, newly added tests and browser fixtures are already committed. No legacy production-code changes remain unstaged. The other remaining legacy file is documentation: `docs/LEGACY_MEDIA_CHECK_FIX.md` has 14 additions/6 deletions, reflecting approval, unchanged clean-decode policy and containment context. Its existing section 6 and opening still describe uncommitted work/pending approval; those stale historical statements need an explicit dated reconciliation before a future documentation commit. They are not silently corrected by this audit.

## 5. Proposed staging manifest — DO NOT EXECUTE YET

The exact machine-readable plan is `post-containment-git-audit/staging-manifest.json`.

| Path | Proposed scope |
| --- | --- |
| `components/discovery-review.test.tsx` | Entire existing diff, hunk `@@ -79,12 +79,12 @@`; the third approved assertion update only. |
| `docs/LEGACY_MEDIA_CHECK_FIX.md` | Partial hunks only: `@@ -92,7 +98,7 @@`, `@@ -215,9 +221,9 @@`, and `@@ -226,10 +232,12 @@`. They preserve clean decoding, prohibit EOF acceptance, require separate live authorization and record approval of the three assertions. Review the dated validation reference with the preserved report. |

Do not stage the mixed opening hunk `@@ -1,5 +1,11 @@` with the legacy patch: it combines approval status, publisher containment and a report link. Keep it locally; reconcile it in the separately reviewed containment/documentation patch. Do not stage either file wholesale without reviewing the final index patch. No index patch has been applied.

Exclude `AGENTS.md`, both containment/audit reports, `docs/MP4_MKV_CHECKPOINT_10.md`, `.env.example`, `.claude/`, all `.velora-ingest/` runtime/evidence files, secrets, generated browser output and unrelated Checkpoint 10 paths. A separate future containment documentation patch should make the committed blanket claims explicitly revoked while retaining their historical provenance. Do not remove local protections to make Git clean.

## 6. Validation and next actions

No tests were rerun for this read-only Git audit. The preceding emergency task validated the working tree including the unstaged third assertion, rather than proving HEAD alone is green: focused 76 passed; full unit 1,226 passed on serialized rerun after two timing failures; disposable database 21 suites/1,212 assertions; channel validation 157 assertions; isolated integration 63 passed/one existing Auth exclusion; browsers 216 passed/24 optional large-startup skips; app and three service typechecks, lint and both offline production builds passed. Initial database transport and build-environment failures and reruns are retained in the emergency report/evidence. Do not use HEAD's stale commit message as the regression result.

This audit encountered a global Git-ignore permission warning, CRLF-normalization warning, absent `.github` search directory, and denied read of the protected `.velora-ingest/discovery.env` during static filename searching. It did not change permissions or read around that protection. No validation rule or test timeout was weakened.

Recommended order, subject to explicit approval before staging/committing:

1. Keep the current pause, guards and emergency section 40 in place. Preserve original evidence and do not restart automation.
2. Prepare a forward-only containment/documentation correction that revokes the committed blanket instructions and labels prior publication claims as historical. Separately review how durable quarantine is to be distributed; local ignored guards do not protect a new checkout. Do not rewrite these commits merely to conceal their contents.
3. Complete the narrow legacy reviewer expectation/documentation reconciliation using the manifest, reviewing the exact staged patch only after authorization. Keep Checkpoint 10 acceptance, especially its new RPC/security inventories, a separate decision.
4. Require title-specific distribution-rights evidence and a separate activation decision before any future live verification or publication. The three candidates keep existing evidence; All the Devil's Men remains unverified. Hosted admin-upload chain availability and listener Policy 3 activation remain separate live blockers.

Outstanding risks: stale committed blanket authorization and process-status claims; local-only containment; privileged operator credentials/capabilities can still call existing reviewer functions outside these scripts; unverified legal sufficiency of historical rights references; tests pass on a working tree containing the unstaged reviewer assertion, not HEAD alone. No active matching automation was found, but this audit does not revoke credentials or continuously monitor hosted writes.

**Stopped at the authorization boundary.** No staging, commit, history rewrite or automation reactivation is authorized by this report. Obtain a separate decision for the concrete forward corrections before performing them.
