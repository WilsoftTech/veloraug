# Wrong Turn workflow test — 10 November 2026

The owner requested testing existing files in the series channel, starting with Wrong Turn, using the existing movie workflow. The owner separately authorized live upload/publication after review and confirmed that the `VJ ICE` credit means the existing VJ Ice P. These instructions do not establish a film's TMDB identity, distribution rights, or a media-integrity pass. The standing publisher pause and quarantined script guards remain intact.

## Results

- Existing offline parser, lifecycle, uploader, publication-script, store, CLI and discovery suites: **259 tests passed across 7 files**. These are software regression tests, not verification of the real Wrong Turn files.
- Hosted audit: repeatable-read transaction with `transaction_read_only=on`; **160 recorded movie media files, zero recorded series media files**, no media in the configured series channel, and no Wrong Turn catalogue/media record. VJ Ice P exists and is active (VJ ID 1). No database writes occurred.
- Local source search: no filename containing `wrong` found under the known `G:/Movies` and `G:/Movie.New` library locations. This is limited to those locations.
- Existing series bot preflight, including a recheck after the owner started the bot: **blocked, `bot_not_on_local_server`**. The configured local Bot API allowlist does not mark this bot as migrated. The guard refused it before any Telegram call; the audit did not alter that configuration or migrate the bot.
- Separate cloud Bot API identity read: **`telegram_read_unavailable`**. No identity or channel access was verified by this attempt. No updates were consumed.
- UI fallback: native computer-use pipe and browser access host unavailable; no Telegram app/browser could be inspected.

## Remaining work

### Access recheck at 00:34 UTC

Cloud Bot API access now succeeds: `velora_series_bot` passes identity validation and can access `Velora_Series` as an administrator with posting permission. The channel has no content protection or pinned file, no webhook is set, and zero updates are pending. These four read-only calls did not consume updates or retrieve any historical media posts. Local uploader access remains blocked by `bot_not_on_local_server`. A Wrong Turn post link/message ID or local source file is still needed to target the existing file; channel access alone does not provide historical message enumeration.

Obtain access to the actual Wrong Turn post(s), identify the film with reviewed metadata, and bind each numbered file to its correct part. `01` and `1` refer to Part 1; `S01E01` denotes a true season/episode. The existing movie discovery/publication path handles movies, not true TV episodes; it must not label episodes as movies to force a pass.

Use the owner's confirmed VJ Ice P identity for the Wrong Turn review. Complete the existing fenced media verification, including full decode and streaming/seek checks, then inspect rights, duplicate and revision-bound publication gates. No live upload or publication has been attempted: the actual files remain untested, rather than passed or failed.

Private local evidence is saved in `.velora-ingest/wrong-turn-readonly-results.json`, `.velora-ingest/series-readonly-preflight-results.json`, and `.velora-ingest/series-cloud-readonly-results.json`. The corresponding audit scripts enforce read-only SQL or allow only explicitly listed Bot API read methods. They do not restart listeners or launch a second media reader.

## Authorized post-9 probe completed

After automatic approval review rejected the first attempt as insufficiently authorized, the owner explicitly authorized forwarding only Velora_Series post 9 to Velora Ingestion Recovery, inspecting it, and deleting only the temporary copy. This scoped probe succeeded at 00:42 UTC. Telegram confirmed deletion of the temporary recovery message. The source post was not edited or deleted. No bytes were uploaded, no hosted records changed, and nothing was published.

The post contains `WRONG TURN 05.VJ ICE P.mp4`, 1,519,441,250 bytes, as a video/mp4 document. The shared filename parser reports a movie, VJ text `ICE P`, no season/episode, no year, and no parse issues. Under the owner's naming convention, `05` is a Part 5 suffix. There is no caption or source-fingerprint tag. VJ Ice P is owner-confirmed; the base film identity remains unconfirmed. Existing TMDB lookup offers multiple films named Wrong Turn and franchise sequels, so no candidate was selected automatically.

The subsequent read-only cloud `getFile` call failed with `telegram_file_too_big`. Whole-file integrity, streaming and seek decoding remain **not tested**. This is an access failure, not evidence that the media itself is corrupt or valid.

The local large-file path has two concrete blockers:

1. The local Bot API container is stopped. Docker reports that its required `G:/Movies` bind mount is unavailable (`/run/desktop/mnt/host/g/Movies`); the container could not start. No restart or mount change was attempted.
2. The series bot remains on the cloud. The movie migration runbook in `docs/PHASE_C_INGESTION_DESIGN.md` requires a separately authorized cloud `logOut`, followed by verified local `getMe`, before adding that bot to the local allowlist. The cloud cannot accept it back for ten minutes after logout. No logout, local login, or allowlist change was attempted.

The dedicated automatic media verifier is already running; its reader was not duplicated or interrupted. The stopped movie discovery listener remains stopped.

### Proposed next operation for review

Restore the local Bot API server using the existing base Compose definition and existing named state volume, without the unavailable optional movie-library mount. Do not rebuild an image, remove a volume, or start the discovery listener. First verify loopback-only binding, local mode, server health and preserved state. Only after the owner authorizes the series migration and these checks pass: confirm the exact series bot identity and absence of pending updates/webhook, call cloud `logOut` once for that bot, verify the same identity locally, then update only its local allowlist entry. Stop on an uncertain logout or identity mismatch. Use the already-recorded post-9 file binding for download and local full-file verification; do not repeat the recovery forward. This plan grants no film identity, rights clearance, publication approval, schema change, or standing publisher reactivation.

Probe and inspection summaries are `.velora-ingest/wrong-turn-post-9-probe-results.json` and `.velora-ingest/wrong-turn-post-9-inspection-results.json`. Bot-specific file handles are retained only in a private ignored staging record. Both operator scripts pass `node --check`; they reuse the existing filename parser, Telegram media schema/mapping, and TMDB lookup.

## Owner-confirmed film and local migration

The owner explicitly authorized restoring the local Bot API server and migrating only the series bot. The owner identified this file as **Wrong Turn 5: Bloodlines (2012)**, TMDB 125509. This specific identity supersedes the earlier filename-only Part 5 interpretation: the file is not assigned as Part 5 of Wrong Turn (2003) or Wrong Turn (2021). VJ Ice P remains owner-confirmed.

The existing pinned image was reused, with its original named state volume and loopback-only port 8081. The unavailable optional movie/staging bind mounts were omitted. No image was rebuilt and no volume was removed. Docker's engine was briefly unavailable during preflight and recovered before any bot logout. The script verified a healthy server, local mode, the pinned image, preserved named state and absence of bind mounts before proceeding.

At 00:49 UTC, the series-only cloud `logOut` succeeded after exact bot identity, no-webhook and zero-pending-update checks. The same bot identity was verified locally before changing only its local allowlist/identity settings in the ignored `.env.local`. The existing client then passed both series identity and recovery/channel access checks. No movie bot migration, discovery-listener startup, update polling, publication, hosted migration or standing publisher reactivation occurred.

The previously observed post-9 binding is now being downloaded through the local Bot API into private staging. The operator uses existing `longRunningFetch`, media probing, full hashing, strict `decodeStreams` and `verifyOriginal` routines. Local results will not be represented as hosted evidence or a publication pass. The restored server/migration record is `.velora-ingest/series-local-migration-results.json`; file-bound verification evidence is under `.velora-ingest/wrong-turn-post-9-verification/`.

Verification regression checks: local transport/long-request suites passed 87 tests (33 optional FFmpeg tests skipped without configured tools); the whole-file verification contract suite passed 30 tests. These results concern software behavior and do not replace the pending actual-file decode.

## Bloodlines verification completed — PASS

The recorded post-9 original downloaded completely through the migrated series bot and was staged privately without changing its bytes. Whole-file verification finished at 01:04 UTC:

| Check | Result |
| --- | --- |
| Recorded and staged size | 1,519,441,250 bytes, equal |
| SHA-256 before and after verification | `03e805a988b62fcad077060ae763bfe796bfb249027d3c9fd58356f1c61778b7`, equal |
| Container / streams | MP4; 1920×1080 H.264; stereo MP3 |
| Whole-file integrity | Verified: clean decode through all 5,448.515624 seconds |
| Streaming / seek decode | Verified: start, middle and end samples all decoded |
| Streaming layout | MP4 tail index; original preserved, not remuxed |
| Original download policy | Original servable |

The strict existing movie verifier reported no integrity or streaming failure reasons. This is a complete local digest-bound result, not a hosted evidence write, actual browser playback check, upload or publication.

The previously skipped real-FFmpeg suite was rerun with the same verified tools and passed all **38 tests**. The **30 verification-contract tests** and repository TypeScript check also passed. The local server remains healthy with no container restarts; the independent verifier remains running and publisher containment remains intact. The older cloud-only audit scripts now refuse to run for a locally migrated series bot, and that refusal was checked without making a cloud request.

The owner's film/VJ decisions and actual file evidence are ready for the next movie-workflow review. The existing publisher requires movie ingestion/media bindings; it cannot relabel this series-bot observation as a movie-bot upload. No title-specific streaming-rights decision has been supplied yet. Neither the original series media binding nor the current rights/publication gates were bypassed, and nothing was published.

## Continuation: real uploader preparation completed

On the owner's request to continue, a fresh transaction-enforced read-only hosted audit found no ingestion record for source fingerprint `sf1-078b7fda598f6f5fecfbfe5084b489a43724cf39aa4d83070aa4ddbbd2f55fa6`, no TMDB 125509 movie/version, and a correctly registered movie channel. This replaces the earlier provisional duplicate assumption with a current audit; the normal uploader still rechecks authoritative source status at execution.

The original was rehashed and its fingerprint rechecked. A hard link with the owner-reviewed filename `Wrong Turn 5 Bloodlines (2012) VJ ICE P.mp4` was created locally, preserving the original bytes and source-post provenance. The existing ingestion CLI scanned only this alias into a separate one-file journal and selected `upload`, with no planner stop reasons.

The existing `stage` command copied and fully verified the bytes, verified the internal-volume prerequisite, and passed its isolated network-disabled, read-only mount probe. Only the local Bot API service was recreated to attach the existing read-only `/media/staging` mount, preserving its state volume and pinned image and omitting the unavailable G: mount. Its actual mounted file independently hashed to the same full SHA-256. Movie-bot identity/channel access and server health passed again. The discovery listener and standing publisher were not started.

The real selected-fingerprint uploader dry run passed: exactly 1 of 1 journal entries selected, original-media policy accepted, movie destination correct, path/size preflight passed, and source fingerprint matched. Its caption uses the reviewed film title/year, VJ Ice P, movie kind, and the stable source token. This is preparation, not an upload.

### Upload blocked by automatic approval review

The attempted command to execute the existing one-fingerprint uploader was rejected **before a process was created**. Automatic approval review stated that this would externally distribute a 1.5 GB movie while rights remained uncleared and that the prior generic live-step approval did not authorize the transfer under containment. No workaround or indirect execution was attempted.

Post-rejection checks confirm `not_uploaded`, zero upload attempts, zero attempt records and no Telegram binding in the selected journal. Staging remains verified; the pause marker and healthy server remain intact. No hosted upload start, evaluation, rights clearance, approval or publication occurred.

To proceed, the owner must supply the title-specific distribution/streaming-rights decision for Wrong Turn 5: Bloodlines (2012), VJ Ice P, and explicitly authorize this one verified source to be uploaded to the configured Movies channel. All prepared files remain private under `.velora-ingest/bloodlines-upload/`; the exact source post remains unchanged.

## Continuation: disposable publication rehearsal — PASS

The owner asked to continue without supplying a new title-specific rights decision. The rejected live upload was not retried. Instead, the existing movie workflow was rehearsed in a fresh disposable, internal-network database. The runner never loads `.env.local` or hosted credentials, uses synthetic Telegram/file/provider identities, and removes only the dedicated temporary database/network after testing. It checked that these isolated resources were absent before creation.

All **449 assertions across five suites passed**:

| Suite | Assertions |
| --- | ---: |
| Existing uploaded-movie publication suite, adapted to Bloodlines title/year/runtime | 77 |
| Whole-file original-media verification | 114 |
| Media-policy and rights review | 144 |
| Verification on upload | 61 |
| Multipart movie safeguards | 53 |

The adapted publication fixture uses Bloodlines display metadata (2012, 91 minutes), with the original suite's explicitly synthetic provider/channel/file identities. It exercises the same existing functions, including refusal when rights are false, worker privilege boundaries, successful publication only with synthetic test clearance, idempotent replay, duplicate/conflict checks, and published-only visibility. Every fixture transaction is rolled back; synthetic clearance is not a rights decision for the real film. No migration history or production function was changed.

Logs and the machine-readable result are under `.velora-ingest/bloodlines-offline-rehearsal/`. The live one-file journal remains staged and verified, `not_uploaded`, with zero upload attempts. The title-specific live rights/transfer authorization remains outstanding under the automatic approval rejection recorded above.

## Owner rights confirmation received; containment-text exception required

The owner reaffirmed authorization for the exact upload and then explicitly answered the Bloodlines rights question with “i have the rights,”. That title-specific decision is recorded in `.velora-ingest/bloodlines-upload/owner-authorization.json`; it is not a blanket rights decision for other titles, and no hosted rights record has been written yet. The operator wrapper now checks the exact film, VJ, fingerprint, SHA-256, destination and owner rights/upload authorization before enabling the existing one-file CLI.

A fresh read-only hosted audit still found no duplicate source or Bloodlines version, and the movie-bot/channel checks passed. Automatic approval review nevertheless rejected execution before process creation. Its stated reason acknowledged explicit rights and upload authorization, but treated the containment instructions as prohibiting transfers while the standing pause remained active. No alternate uploader or indirect execution was attempted.

The remaining block is therefore no longer a missing owner rights statement. A proposed explicit **one-title containment exception** is prepared at `.velora-ingest/bloodlines-upload/containment-exception.proposed.md` for owner review. It preserves the standing pause, quarantined guards, every source/media/rights/revision gate, and excludes all other titles, batches, migrations, deployments and listener restarts. It has not been added to AGENTS.md and grants no authority on its own.

## Owner-instructed rule exception applied; live upload started

The owner instructed: “edit this rule- it should allow.” AGENTS.md §40 now contains the prepared Bloodlines-only exception, bound to TMDB 125509, VJ 1, the exact fingerprint/full digest/size and unchanged source post. It explicitly permits the normal one-file upload, rights recording, fenced verification and gated approval/publication while keeping the standing pause and quarantined guards intact. All other titles, batches, migrations, deployments and discovery-listener restarts remain excluded.

After this rule edit, automatic approval review permitted the existing one-fingerprint movie uploader to run. The selected journal entered `uploading` with exactly one pending attempt. This is the first executed live upload attempt; all earlier rejected commands were refused before process creation. No second upload or recovery retry has been started. The slow Telegram transfer is still in progress; evaluation and publication must wait for an acknowledged Telegram binding and the normal verification/review gates. Read-only owner/worker connection checks pass. No film has been published yet.


## Upload recovery and Discovery visibility ? 11 November 2026

The existing one-entry recovery command confirmed the original upload at Movies message 214 and recorded its server acknowledgement at 19:22:56 UTC. Exactly one upload attempt remains in the journal; no second file was sent. The recorded media is 161, ingestion event 162, origin uploader. Its original source fingerprint, full digest, 1,519,441,250-byte size and unchanged source-post provenance remain intact.

The existing guarded evaluation command then recorded a high-confidence exact title/year match to Wrong Turn 5: Bloodlines (2012), TMDB 125509, VJ Ice P (1). This is metadata evaluation, not a rights, approval, publication or hosted media-verification claim.

The database Discovery queue intentionally reads channel-origin review records and ignores uploader-owned posts. There is no existing supported conversion into that queue. A local visibility fix adds a separate Uploaded movies section using the existing reviewer session and a new read-only RPC. It displays completed, unpublished uploader movies and their recorded metadata/media state without creating channel reviews or exposing file handles. Channel review actions and publisher containment remain unchanged.

Prepared migration: supabase/migrations/20261111193305_discovery_uploader_visibility.sql. It creates only public.discovery_upload_list(text,integer), checks the existing reviewer capability, pins the empty search_path, revokes default client privileges, and grants authenticated callers access to the guarded read. It changes no movie, source, review, rights or publication records. It has NOT been applied to hosted. Applying this exact migration requires a new authorization under AGENTS.md section 40, followed by the existing backup and hosted-schema validation procedure. The web target remains local only.

A transaction-enforced read-only SELECT of the prepared query against the actual hosted schema returned Bloodlines as matched, with no hosted integrity/streaming evidence yet; the UI must therefore show Awaiting verification despite the separate digest-bound local source pass. Sanitized preview and disposable database validation records are saved under .velora-ingest/discovery-uploader-visibility/. No listener or contained publisher was started.


## Discovery visibility migration applied - 11 November 2026

The owner explicitly authorized only 20261111193305_discovery_uploader_visibility.sql. An EFS-encrypted, owner-restricted backup was created using a read-only exported snapshot; its 1,209,415-byte custom archive parsed and hashed successfully. A private internal-network restore rehearsal matched all 65 backed-up tables, then applied this exact migration. Every existing function and data digest remained unchanged, the guarded reviewer read returned Bloodlines, and the temporary restore container/network were removed.

The exact migration was applied transactionally at 19:59:46 UTC (22:59:46 EAT), with migration-history and function-drift checks, unchanged domain-data digests, exact function matching to the rehearsal, and explicit role-grant validation. Only authenticated requests can reach the command, and the existing reviewer check remains authoritative. Anonymous, service, discovery-worker, media-gateway and review-service roles have no EXECUTE grant. The schema cache was notified to reload. No other migration was applied.

The restored snapshot already contained verified whole-file integrity and streaming evidence for Bloodlines, superseding the earlier pending-evidence preview. This visibility migration neither created nor changed that evidence. The existing uploader provenance and publication workflow remain in place; Discovery shows the uploaded record in the separate Uploaded movies section. This is visibility, not approval or publication. Private backup, rehearsal, apply and verify records are retained in the directory referenced by .velora-ingest/discovery-uploader-visibility/backup-directory.txt. The standing publisher pause remains in place.


## Bloodlines approved and published - 11 November 2026

After the owner instructed continuation, a fresh transaction-enforced read-only audit confirmed uploader event 162, movie media 161 / Movies message 214, the unique score-1 candidate TMDB 125509, VJ Ice P (1), and no existing catalogue version. Current hosted evidence 221 verifies whole-file integrity and streaming with SHA-256 03e805a988b62fcad077060ae763bfe796bfb249027d3c9fd58356f1c61778b7, matching the authorized original. The sequel filename correctly recognizes a complete movie (part_number 0).

A fresh existing CLI publication script used TMDB metadata and the owner's recorded title-specific rights confirmation. At 20:08:37 UTC (23:08:37 EAT), the existing owner functions approved the uniquely evaluated match and published the exact upload in one transaction. The scoped operator additionally locked and rechecked the source, candidate, current media evidence, digest, duplicate state and existing function definitions. Result: movie 112, slug wrong-turn-5-bloodlines-2012, VJ version 118, media 161, rights_status cleared, availability_status ready, ingestion and movie status published. Exactly one Telegram upload attempt remains; no reupload occurred.

Rights were recorded by the existing uploader publication attestation and version rights status; no fabricated channel review or channel rights record was inserted. The original source post, fingerprints, media binding and standing-approval pause remain intact. No other title, migration, deployment, listener or contained publisher was activated. Private execution/readback and public verification results are saved under .velora-ingest/bloodlines-upload/.
