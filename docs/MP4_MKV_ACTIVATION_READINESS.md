# MP4/MKV activation readiness checklist

Prepared at Checkpoint 7, 2026-10-12; sections 3, 10, 11 and 13 updated at
Checkpoint 8, 2026-10-13. **Nothing in this list has been activated.**
It is the list to work through, with separate approval for each live step, before
original-file playback facts and downloads go live. It records what is already
proven locally, what is still open and what blocks activation.

Status words: **Proven** means tested in this repository in isolation (disposable
databases, loopback services, synthetic fixtures). **Open** means work or a check
that has not been done. **Blocked** means it cannot be done until a decision or
another item is complete. Nothing here is proven on hosted Supabase, on a hosted
gateway or on a real device.

Baseline that every step must re-verify first: the last recorded hosted audit
(`E3_8_MEDIA_RECOVERY.md`, 2026-10-11) found **17 migrations**. The repository has
**26**. No hosted query was made for this checklist.

## 1. The nine undeployed migrations

| # | Migration | Group | Needs | Status |
| --- | --- | --- | --- | --- |
| 1 | `20261011083200_admin_upload_sessions` | Admin upload (R2) | hosted 17 | Proven locally, Open |
| 2 | `20261011084309_admin_upload_disk_chunks` | Admin upload (R2) | 1 | Proven locally, Open |
| 3 | `20261011085220_admin_upload_inspection` | Admin upload (R2) | 2 | Proven locally, Open |
| 4 | `20261011093300_admin_upload_r2_staging` | Admin upload (R2) | 3 | Proven locally, Open |
| 5 | `20261011094004_admin_upload_r2_worker` | Admin upload (R2) | 4 | Proven locally, Open |
| 6 | `20261011095632_admin_upload_r2_visibility` | Admin upload (R2) | 5 | Proven locally, Open |
| 7 | `20261011192618_original_media_evidence` | Policy 3, channel | hosted 17 | Proven locally, Open |
| 8 | `20261011192619_admin_original_media_evidence` | Policy 3, admin | 6 and 7 | Proven locally, Open |
| 9 | `20261011200813_original_media_download_resolver` | Download | hosted 17 | Proven locally, Open |

The brief names six R2 migrations and two Policy 3 migrations. The download
resolver (9) is a third new migration and is the only one downloads need.

### Dependency ordering

```text
hosted 17 ──► 9 download resolver            (independent of everything else)
hosted 17 ──► 7 channel Policy 3 ──┐
hosted 17 ──► 1 ► 2 ► 3 ► 4 ► 5 ► 6 ──┴──► 8 admin Policy 3
```

- [ ] **Open.** Choose which groups to apply. They are separable: downloads need
  only 9, the compatibility facts need 7 (and 8 for admin uploads), the admin
  upload pipeline needs 1 to 6.
- [x] **Proven.** Repository order (26) and the alternate order (17, then 7, then
  1 to 6, then 8, with 9 added) give identical function definitions, owners,
  security modes, ACLs, columns, constraints and RLS flags (Checkpoint 4 and 5
  order drivers). 17 plus 9 alone passes its 25 assertions.
- [ ] **Open.** Never use `supabase db push --include-all` for a selected group.
  It would apply every pending file. Use the explicit, operator-only driver path
  used for migration 17: backup, restore rehearsal, one guarded transaction,
  verification.

### What each group changes for running services

- [ ] **Open, check before applying 6.** Migration 6 replaces the public read
  policy on `movie_versions`, `catalogue_access.movie_is_public` and the gateway's
  streaming resolver, adding the R2 rights check. It therefore touches live
  playback of the two published movies the moment it commits. Media with no
  admin upload session passes the new check (tested), but confirm both published
  versions still resolve on the restored copy and immediately after the write.
- [ ] **Open, measure before applying 7.** Migration 7 adds generated columns to
  `private.media_evidence`, which can rewrite the table under a lock. Measure the
  duration on the restored copy. Apply while the channel is quiet.
- [x] **Proven.** Migration 7 keeps the legacy `discovery_complete` contract, so
  the listener that is running today keeps working against it (43 assertions on
  the hosted-equivalent chain).
- [x] **Proven.** Migration 9 adds one function and one grant. It does not
  replace the streaming resolver; it calls whichever one is installed.
- [ ] **Open.** Migration 9 reads `auth.users.is_anonymous`, `deleted_at` and
  `banned_until`. Confirm the hosted Auth schema has all three before applying.

### Per-migration preflight (each one, every time)

- [ ] Hosted history is exactly the expected list; target project, pooler host
  and owner role match the fixed reference.
- [ ] Fresh snapshot-consistent backup, hash recorded, stored outside the
  repository.
- [ ] Restore rehearsal in a disposable database on an internal network: apply,
  verify, replay refused, rollback exact.
- [ ] Deployed definitions, owners and ACLs of every function the migration
  replaces equal the tested chain before the write.
- [ ] One transaction with a short lock timeout. Verification afterwards:
  history, changed objects exactly as listed, no other table or function changed.
- [ ] `npx supabase@2.117.0 db lint` and the security advisors on the result.
  Advisors have **not** been run for any of the nine: only disposable databases
  were used.

## 2. Existing frontend compatibility

- [x] **Proven.** The player works with none of the nine applied. A missing
  `movie_media_profile` RPC, a null result, a malformed result and a read
  failure all leave playback available with compatibility "untested".
- [x] **Proven.** With migration 9 absent, a download attempt ends at the
  one-byte probe with an availability message. No file transfer starts.
- [x] **Proven.** Existing catalogue selects name no new column. The new nullable
  fields need no change in current consumers.
- [ ] **Open, order matters for the message only.** Web before gateway shows a
  Download button that fails safely. The message depends on what is behind it:

  | State behind the button | Probe result | Viewer sees |
  | --- | --- | --- |
  | Old gateway image (no download route) | 404 | "no longer available to download" (misleading) |
  | New gateway, migration 9 absent | 503 | "temporarily unavailable" |
  | New gateway, site origin not allow-listed | unreadable | "Could not reach the download service" (misleading) |
  | All three in place | 206 | Download starts |

  Deploy in the order database, gateway, web to avoid the misleading messages.
- [ ] **Open.** After activation the two published titles will most likely still
  show "untested": the profile returns facts only for versions with recorded
  inspection evidence, and both were published through the command-line uploader,
  which records none in the database. Confirm with a read-only check, then decide
  whether that is acceptable.
- [ ] **Open.** The developer `next dev` server hot-reloads this tree against
  hosted data. Until activation it shows the Download button to signed-in users.

## 3. Gateway deployment

- [ ] **Blocked: production gateway hosting is not decided.** The roadmap leaves
  it unscheduled. The gateway runs today only as a local development container on
  a residential link, which earlier checkpoints found too slow for 8 MiB windows
  at times.
- [ ] **Open.** Rebuild the image from the activation commit. The running
  development image predates the download route and answers 404 for it.
- [ ] **Open.** `MEDIA_GATEWAY_ALLOWED_ORIGINS` must list the exact web origins.
  Playback works without it. **Downloads do not**: the readiness probe is a
  cross-origin `fetch` that must read the status and `Content-Range`. The same
  setting is what lets the player tell a stopped gateway from an unsupported file.
- [ ] **Open.** `MEDIA_GATEWAY_PUBLIC_ORIGIN` on the web side must be HTTPS in
  production (plain HTTP is accepted only for loopback outside production), and
  `MEDIA_GATEWAY_TOKEN_SECRET` must be the same value on both sides.
- [ ] **Open, single instance only.** Stream and download admission and the rate
  limits are per process. Two instances would double every limit and the
  one-download-per-user rule. A second instance needs an approved shared
  admission design first.
- [ ] **Blocked on the hosting decision: client identity behind a proxy.** The
  per-address limits use the socket peer address and read no forwarding header
  (tested at Checkpoint 8 with `X-Forwarded-For`, `X-Real-IP` and `Forwarded`
  all set to different values). That is correct for a gateway that clients reach
  directly. The gateway speaks plain HTTP and production needs HTTPS, so
  something will terminate TLS in front of it, and then every viewer arrives
  from that one address. The per-address defaults become global: 6 streams,
  2 downloads and 240 requests a minute for all viewers together. The per-user
  limits are not affected, because the user comes from the signed capability.
  The rules a trusted-proxy change must follow are in
  `MP4_MKV_CHECKPOINT_8.md`, section 4. It is not built: it needs to know which
  proxy.
- [ ] **Open, carrier NAT.** Viewers behind one carrier-grade NAT address share
  the per-address allowance even with no proxy: 2 downloads and 6 streams per
  address. How common that is for the audience has not been measured.
- [ ] **Open, reverse proxy.** A proxy in front must not log query strings (the
  capability travels in the URL), must not cache or buffer responses, must pass
  `Range` and `If-Range` through, must close the upstream connection when the
  viewer disconnects (that is what frees the slot), and must allow a response to
  run for four hours with no total-duration cap below that.
- [x] **Proven.** The gateway accepts only the restricted database role and
  refuses to become ready as any other identity.
- [x] **Proven.** Graceful stop: readiness drops, new requests are refused, and
  running streams and downloads get 15 seconds.

## 4. Discovery listener image

- [ ] **Open.** The running listener is `velora-discovery:gate-b` in metadata
  mode. It must not be rebuilt, restarted or replaced without its own approval.
- [ ] **Open.** A rebuild is needed for two things already in the repository: the
  shutdown fix (`process.on` in place of `process.once`, so the consumer lease is
  released on SIGTERM) and Policy 3 inspection.
- [ ] **Blocked on migration 7.** A Policy 3 listener must not run against the
  current database: the deployed `discovery_complete` accepts only the legacy
  field set. Apply 7 first, then roll out the image.
- [ ] **Open.** Verify the lease release in isolation before replacing the
  running container: bounded mode, SIGTERM, lease row released at once. So far
  it is proven only by offline tests of the signal wiring.
- [ ] **Open.** The image carries FFmpeg 5.1.9; local tests used 9.0.2. The
  tail-index MP4 probe (a sparse temporary file) has not been run on Linux or in
  the container.
- [ ] **Open.** The upload worker image (`infra/uploads`) is separate and belongs
  to the admin upload activation. Its three flags stay `false`.

## 5. Rollback and recovery

- [x] **Proven.** Each new migration is one transaction and fails closed when a
  prerequisite is missing. A failure before commit leaves nothing behind.
- [ ] **Open.** After commit, recovery is a new forward migration that restores
  the saved previous function definitions and ACLs. Keep new columns, evidence
  rows and history. Never delete applied history or relabel Policy 3 evidence.
- [ ] **Open.** Save the pre-change definitions of every replaced function
  (owner, security mode, settings, ACL) with the backup, as for migration 17.
- [ ] **Open.** Gateway rollback is redeploying the previous image. The streaming
  contract is unchanged, so playback continues. Downloads then answer 404.
- [ ] **Open.** Web rollback is redeploying the previous build.
- [ ] **Open, gap.** There is **no runtime switch** for downloads. The download
  limits can only be tightened in code. The fastest ways to stop downloads are
  redeploying the previous gateway image or revoking the resolver's grant through
  a new migration. Decide whether a switch is wanted before activation.
- [ ] **Open.** Listener rollback is the base compose file with the `gate-b`
  image, as done on 2026-10-11.

## 6. Health checks

- [x] **Proven.** `GET /healthz` is process liveness. `GET /readyz` is 200 only
  when the reader can serve and the catalogue connection is the restricted role.
- [ ] **Open, gap.** `/readyz` does not cover downloads. A gateway is "ready"
  with migration 9 absent. Add a post-deploy smoke check: issue one download
  capability for a published version and expect `206` with `Content-Range:
  bytes 0-0/<size>` for `Range: bytes=0-0`.
- [ ] **Open.** Post-deploy playback smoke check on both published titles:
  play, seek, pause, resume, all responses 206 of at most 8 MiB.
- [ ] **Open.** Listener `/readyz` on port 8790 and upload worker `/health` on
  8792 are unchanged and stay internal.

## 7. Logging and monitoring

- [x] **Proven.** Gateway logs are structured and carry no token, user id,
  Telegram identifier or raw upstream error. Fields: event, request id, version
  id, route, status, code, outcome, bytes served, reads, first-byte and total
  latency.
- [ ] **Open.** Nothing collects or alerts on these logs yet. Minimum to watch:

  | Signal | Why |
  | --- | --- |
  | `outcome=failed` or `timeout` on `route=download` | Cut transfers; viewers see a failed download |
  | `authorization_expired` on downloads | Resume attempts with a link older than ten minutes (section 11). Expected in small numbers; many means viewers are losing partial files |
  | `outcome=timeout` on `route=download` near 14,400,000 ms | Transfers hitting the four-hour maximum |
  | `too_many_streams`, `rate_limited` | Limits too tight, or a proxy collapsing addresses |
  | `flood_wait`, `telegram_unavailable`, `mtproto_disconnected` | Telegram throttling or reader loss |
  | `catalogue_state` changes | Database unreachable or wrong identity |
  | `upstream_timeout` | Slow uplink or slow Telegram reads |

- [ ] **Open.** The web issuer logs only a configuration error. There is no
  record of download issuance. Decide whether an aggregate count is wanted.
- [ ] **Open.** Sentry and analytics are Phase G and are not introduced here.

## 8. Browser compatibility limitations

- [x] **Proven on Windows only.** MP4 with H.264 and AAC or MP3 plays in Chrome
  154, Edge 155, Chromium 156 and Playwright Firefox 157, fast-start or not.
- [x] **Proven on Windows only.** MKV with H.264 and AAC plays in the Chromium
  family from the first 2 MiB.
- [ ] **Open, known limits the UI already states.** Firefox does not stream MKV
  (it fetched a whole 55 MB file before metadata) and MKV with MP3 is silent
  there. HEVC depends on the device decoder. AC-3 was silent everywhere. Only the
  default audio track plays. Embedded subtitles are not shown.
- [ ] **Blocked on devices.** Safari on macOS, Safari on iPhone, Chrome and
  Firefox on Android are **not tested**. Playwright WebKit is not Safari. See
  `MP4_MKV_DEVICE_TEST_PLAN.md`. This remains a pre-launch gate.

## 9. Original-file download integrity

- [x] **Proven in isolation.** All 13 synthetic fixtures came through the real
  restricted database adapter and the gateway core with identical SHA-256, size,
  media type, file name and extension. A download interrupted and resumed with a
  fresh capability, `Range` and `If-Range` completed to the same SHA-256.
- [x] **Proven.** A failure after the headers cuts the connection. The gateway
  never reports a truncated file as complete.
- [ ] **Open.** The `ETag` identifies the stored document. It is not a checksum
  of the bytes, and viewers are given no checksum to verify a download.
- [ ] **Open.** No full-size transfer from Telegram has been made through the
  download route. Throughput, flood waits and a transfer near the 2,000 MiB
  ceiling are untested.
- [ ] **Open.** Inspection evidence is bounded. It is not proof that a whole file
  is intact, so a download can deliver a file with a defect the inspection never
  read.

## 10. Resource and bandwidth constraints

| Limit | Streaming | Download |
| --- | --- | --- |
| Concurrent, whole gateway | 32 | 4 |
| Per signed user | 3 | 1 |
| Per client address | 6 | 2 |
| Response size | 8 MiB window | whole file, up to 2,000 MiB |
| Response deadline | 120 s | 4 hours (Checkpoint 8; was 600 s) |
| Reads ahead | 2 | 1 |
| Telegram reads in flight, shared | 8 | 8 |

- [x] **Proven.** No response is buffered whole. Each download holds one read of
  at most 1 MiB plus the socket buffer, and backpressure stops scheduling.
- [ ] **Open.** Every byte of every stream and download crosses the gateway
  host's uplink twice (in from Telegram, out to the viewer). One 1 GB download is
  1 GB of egress. Size the host and its transfer allowance for that.
- [ ] **Open.** Four concurrent downloads can occupy half of the shared Telegram
  reads. Watch playback start time when downloads are running.
- [ ] **Open, since Checkpoint 8.** A download slot is now held for the whole
  transfer, up to four hours, so four per process is the ceiling on viewers
  downloading at the same time. A fifth gets "temporarily unavailable". The
  ceiling can be lowered by configuration and raised only in code, after a load
  test (`MP4_MKV_CHECKPOINT_8.md`, section 3).
- [x] **Proven (Checkpoint 8).** Slots are counted correctly: four for the
  process, one per signed user whatever address or link is used, two per
  address, released once when the response ends, is cut or the client leaves.
  The page's one-byte readiness probe takes a download slot for its duration.
- [ ] **Open.** Memory under download load has not been measured in the
  container. Streaming peaked at about 76 MiB of a 256 MiB cap.

## 11. Download continuation (was: the ten-minute download deadline)

- [x] **Implemented and proven locally at Checkpoint 8 (2026-10-13). Not
  deployed.** The capability keeps its ten-minute lifetime. Every request, new or
  resumed, is authorized when it arrives: signature, expiry, operation, version,
  then publication, rights, VJ and the user. A response that has started is no
  longer ended when its capability expires. It ends when it completes, when the
  viewer disconnects, when a read or the socket stalls for 30 seconds, when the
  30-second recheck finds the version or the user no longer allowed, or at the
  maximum duration of four hours. Record: `MP4_MKV_CHECKPOINT_8.md`.

  What the four-hour maximum means for the published files:

  | File | Size | Sustained rate needed to finish in 4 hours |
  | --- | --- | --- |
  | On The Hunt (published) | 1,007,441,962 bytes | 70 kB/s, about 0.56 Mbit/s |
  | Call of Heroes (published) | 1,917,405,700 bytes | 133 kB/s, about 1.07 Mbit/s |
  | Ceiling | 2,097,152,000 bytes | 146 kB/s, about 1.17 Mbit/s |

  Before Checkpoint 8 the same files needed 13.4, 25.6 and 28 Mbit/s, because
  the response was cut at ten minutes.
- [x] **Proven locally.** One capability serves several requests inside its ten
  minutes, which is what lets a browser's own resume work. After expiry the same
  link starts and resumes nothing (401, no media read).
- [x] **Proven in the automated browsers (Chrome, Edge, Chromium).** After a
  connection cut inside the ten minutes, the browser's download manager resumes
  by itself on the same link with `Range` and `If-Range`, and the saved file is
  byte-identical. Playwright's WebKit and Firefox builds send no resume request.
- [x] **Proven in all six automated browser projects.** A newly issued link
  never continues a partial file. Resume/Retry Download starts a new download at
  byte 0. The page's text says so and promises no seamless resume.
- [ ] **Open, consequence.** A viewer whose connection drops after the link's ten
  minutes loses the partial file in every browser tested and starts again from
  byte 0. On a slow, unreliable link a large file may never complete. Fixing
  that needs a resumable client in the page or a longer-lived resume credential,
  and neither is approved.
- [ ] **Open.** Measure real read throughput for one published file through a
  hosted gateway (a read-only operation that still needs approval). It shows
  whether four hours and four concurrent slots are enough.
- [ ] **Open.** Real Safari, iOS, Android and Firefox behaviour after an
  interruption is not tested (`MP4_MKV_DEVICE_TEST_PLAN.md`, section 8).
- [ ] **Open.** `.env.example` does not list the four download settings yet. It
  has an unrelated uncommitted edit that the checkpoint rules keep out of
  commits. The settings are documented in `MP4_MKV_CHECKPOINT_8.md`, section 3.

## 12. Rights-clearance and publication gates

- [x] **Proven.** Rights clearance, review, and publication approval are
  unchanged and remain three separate capabilities. Nothing in Checkpoints 4 to 7
  adds a public rights or publication API, a role, a login or a capability.
- [x] **Proven.** Streaming, download and the public profile all require a
  published movie, a ready and rights-cleared version and an active VJ. The
  download also requires a real, non-anonymous, non-deleted, non-banned user.
- [x] **Proven.** A browser playing a file never upgrades inspection evidence
  and never authorizes publication.
- [ ] **Blocked: new originals cannot be published yet.** Bounded Policy 3
  evidence says "metadata consistent" and "potentially playable". The publication
  predicate requires verified integrity and verified streaming, and nothing can
  produce either. A new MP4 or MKV original therefore stays held at the media
  gate after activation. A verification contract and its producer need their own
  approved design.
- [ ] **Open.** Expired or revoked R2 rights hide a version from the catalogue and
  from playback once migration 6 is applied. Confirm who renews attestations.

## 13. Order of activation, once each step is approved

1. Decide gateway hosting (section 3), including how the gateway learns the
   client address behind the TLS terminator. The download continuation policy
   is implemented locally (section 11, Checkpoint 8).
2. Real-device tests against a reachable test host (`MP4_MKV_DEVICE_TEST_PLAN.md`).
3. Database: migration 9 for downloads; 7 for channel facts; 1 to 6 then 8 for
   admin uploads. Each with the preflight in section 1.
4. Gateway: rebuilt image, allowed origins, smoke checks (section 6).
5. Listener image, only after migration 7 and the isolated lease test.
6. Web deployment.
7. Watch the signals in section 7 for the first transfers.

Each numbered step is a separate approval. None has been given.
