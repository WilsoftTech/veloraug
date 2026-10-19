# Automatic full-file verification after upload

Implementation prepared locally on 2026-10-18. The owner subsequently authorized
applying only the media-verification queue migration and activating its separate
worker after the named verifier releases the reader. Activation evidence is kept
in `.velora-ingest/automatic-verification-rollout-20261018/`.

**Enabled on hosted and running locally as of 2026-10-18, 18:50 EAT.** Only
`20261018072045_media_verification_on_upload.sql` was applied (19 to 20 hosted
migrations). The encrypted pre-change database archive was parsed and hashed.
The migration transaction verified exact function bodies, pinned search paths,
worker-only command access, queue RLS, and unchanged movie, review, rights and
publication records. The optional-media and older automatic-candidate migrations
were not applied.

The previous named pass had stopped and released its reader. Windows task
`Velora Automatic Media Verification` now runs the separate media-only worker,
resumes it at this user's Windows sign-in, prevents duplicate task instances,
and retries an unexpected process failure up to three times at one-minute
intervals. Automatic work requires this computer and user session to remain
available. The reader connected successfully and the queue claimed media 1,
`On The Hunt.VJ ICE P.2026.mkv`; this is a started check, not a passing verdict.

Local evidence and monitoring:

- `migration-result.json`: migration hash, verified grants and data invariants.
- `scheduled-task.xml`: registered task settings; no credentials.
- `worker-output.log`: reader state and fixed verification results.
- `worker-events.jsonl`: startup, exit and spool-byte heartbeats.
- `worker-diagnostics.log`: private process diagnostics.

Stop the scheduled task before manually starting another verifier on the same
reader. Stopping Task Scheduler work must account for its child processes;
never delete leases or passing/failing evidence as a shortcut. The original
publisher containment marker and quarantined entry-point guards remain intact.

## Latest publication audit and validation

Read-only hosted snapshot, 2026-10-18 at 18:23 EAT: 63 recorded movie files,
four published catalogue versions, and 50 unpublished candidates with confirmed
film/VJ identity and selected artwork. Of 57 unpublished review candidates,
57 lack rights clearance, 55 still need passing media evidence, and seven need
film confirmation. None has all publication gates and current final approval.
These counts are file entries, not distinct films, and change as uploads arrive.

100 Yards and Beast have passing whole-file integrity and streaming evidence
and still require rights clearance and final approval. All the Devil's Men
has a recorded `decode_error_at_end` and remains blocked. The existing bounded
verification-only pass is active; automatic inspection of all uploads is not
enabled on hosted (`media_verification_claim` is absent).

The exact blockers for every file are recorded locally in
`.velora-ingest/media-readiness-audit-20261018/publication-blockers.md` and
`publication-blockers.json`. Selected artwork is not a rights decision.

Validation during this audit:

- 93 targeted worker, database adapter, media reporting, review UI and containment tests passed.
- The synthetic MP4/MKV automatic-worker integration test passed in a disposable database.
- The exact 19 installed hosted migrations plus only
  `20261018072045_media_verification_on_upload.sql` applied in a disposable
  database; all 59 queue, privilege, lease, identity-binding and failure assertions passed.
- The media-gateway TypeScript check passed. The application check is blocked
  by malformed generated `.next/dev/types/validator.ts` (TS1128 at line 254);
  no application source was changed by this audit.

Activation must keep media verification required. The optional-media/right-review
migration and the older confirmed-candidate queue are not needed for this worker.
Rights and final approval remain explicit decisions; this worker does not grant them.

Every recorded MP4/MKV movie file in the registered Movies channel becomes
eligible for the media-only worker, including the existing backlog, published
versions, uploader-origin files, and files awaiting film/VJ confirmation. No
reviewer action is needed to enqueue a newly recorded document. The worker
checks for work every 30 seconds when idle and processes files sequentially.
Large files and an existing backlog can delay when a newly uploaded file starts.
Telegram upload completion must first be recorded by the existing ingestion or
discovery path; the worker cannot inspect an upload the application has not seen.

The worker reads and SHA-256 hashes the complete original, decodes its video
and every audio track, then tests decoding after seeking to the start, middle,
and near the end. It reuses `channelVerificationPort`, `verifyOriginal`, the
dedicated read-only Telegram reader, and the existing database evidence
constraints. A clean complete decode is required. MKV, MP4 and an MP4 index at
the end are supported; the extension never creates a passing result. A file
that cannot be opened or whose metadata is invalid can be refused before a full
read; its result is unverified, not a successful full decode.

Admin browser uploads already queue byte verification and inspection after
their transfer completes. The existing inspector now performs the same full
decode for disk staging as well as R2 staging, before metadata review. These
services still require their existing enablement/configuration and the admin
schema; this change does not activate an undeployed admin upload pipeline.

## Isolation and retries

Migration `20261018072045_media_verification_on_upload.sql` adds a private,
RLS-protected lease table and two worker-only commands:

- `media_verification_claim`: atomically claims the next eligible document with
  `SKIP LOCKED`, exact source identity and a bounded lease. It requires no
  catalogue identity and never claims or changes a review.
- `media_verification_finish`: validates the lease, current source identity,
  digest byte count and existing verification contract, then records evidence.
  Provider failures record a fixed error code without evidence.

The worker has no direct table access. PUBLIC, anonymous/authenticated clients,
the review/gateway roles and service role receive no access to the new commands.
The optional admin-worker role is explicitly revoked when present. Functions
pin `search_path=''`; the default privileges are not trusted.

An expired lease can be reclaimed. Source replacement fences the old result
and resets the attempt budget for the new identity. Transient failures wait
six hours by default, with at most five attempts before operator attention.
Completed checks, including failed decodes or terminal bounded refusals, are
not repeated automatically. A later explicit reinspection request makes the
document eligible again. Existing named verification claims and the new worker
respect each other's leases and share a transaction fence.

The jobs and evidence never edit film/VJ identity, review revisions, rights
clearance, approvals, publication status, or ingestion cursors. Checking an
unconfirmed file does not confirm its identity. Publication still requires all
existing gates. Browser compatibility remains a separate prediction; a clean
decode does not establish playback on every device.

The verification contract still caps documents at 2,097,152,000 bytes. Unsupported
extensions, unknown sizes, and files outside the registered Movies channel are
not claimed. They need operator review rather than invented passing evidence.

## Activation decision

The hosted audit recorded 19 migrations. This new migration is independent of
the optional-rights, old confirmed-candidate automatic queue and admin-upload
migrations. Do not apply those unrelated pending files as part of this rollout.

1. After explicit authorization, back up and verify the current hosted schema.
   Rehearse that schema plus this single migration in a disposable database.
2. Apply only `20261018072045_media_verification_on_upload.sql`, then verify
   function definitions, privileges and the absence of catalogue/review changes.
3. Wait for any current named verifier to release the dedicated reader session.
   Do not restart the quarantined readiness/publishing scripts or the listener.
4. Start one separate verification-only process with the existing restricted
   worker connection, dedicated reader session, trusted FFmpeg/ffprobe, and
   private spool directory. No uploading bot login is permitted.

From the repository root, with runtime configuration already provisioned:

```text
npm --prefix services/media-gateway run verify:uploads
```

Required switches: `VELORA_DISCOVERY_LIVE_AUTHORIZED=true` and
`VELORA_DISCOVERY_AUTO_VERIFY=true`. The defaults remain off in `.env.example`.
Use `VELORA_DISCOVERY_VERIFY_INTERVAL_SECONDS=30`,
`VELORA_DISCOVERY_VERIFY_RETRY_SECONDS=21600`, and an absolute private
`VELORA_DISCOVERY_SPOOL_DIR`. The process does not read `.env.local` itself and
must be run under the host's process supervisor for continuous operation.
For a bounded backlog pass, append `-- --once` to the npm command.

Activation needs a hosted-migration decision because AGENTS.md section 40 still
prohibits hosted migrations. No listener rebuild/restart, publishing, rights
clearance, media upload or contained-batch restart is required or performed.
Keep `.velora-ingest/standing-approval.pause` and every quarantine guard intact.

The owner granted that narrow decision in this session on 2026-10-18. It is
recorded in AGENTS.md section 40; unrelated hosted migrations remain prohibited.

To stop automatic work, stop only this verification process and unset its
automatic switch. Do not remove evidence or change a failed finding to a pass.
Interrupted jobs remain fenced until their lease expires, then can be reclaimed.
