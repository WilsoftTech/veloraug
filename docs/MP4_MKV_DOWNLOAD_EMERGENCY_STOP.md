# Original-file downloads: the switch and the emergency stop

Written at Checkpoint 9, 2026-10-14. **Downloads are not activated anywhere.**
This is the procedure for the day they are, and for stopping them. Nothing here
has been run against a hosted gateway, hosted Supabase or a deployed web build:
every statement marked "tested" was tested in this repository in isolation
(unit tests, the gateway core on loopback, six automated browser projects).

## The switch

One setting, read by two separate servers. Each reads its own environment, so
each has to be set where that server runs.

| Where | Variable | What it decides | Read |
| --- | --- | --- | --- |
| Web application (Next.js server) | `MEDIA_GATEWAY_DOWNLOADS_ENABLED` | Whether `POST /api/media/download-token` issues a download capability, and whether the movie page shows a Download control | On every request (the control: when the page is rendered, at most 5 minutes old) |
| Media gateway | `MEDIA_GATEWAY_DOWNLOADS_ENABLED` | Whether `GET /v1/movie-versions/{id}/download` admits a request | Once, at startup |

Rules, the same on both sides:

- **Off unless the value is exactly `true`.** Unset, empty and `false` are off.
- On the web side any other value (`TRUE`, `1`, `yes`) is also off. On the
  gateway any other value stops startup with exit code 78 and names the
  variable, so a typing mistake cannot turn downloads on and cannot go unnoticed.
- **Both must be on** for a download to start. The web side on and the gateway
  off: a link is issued and the gateway refuses it. The gateway on and the web
  side off: no link is ever issued.
- It is server-only. It is never `NEXT_PUBLIC_`, and the browser is told only the
  result (a control is shown or not, a request is refused or not).
- It adds nothing. Switched on, every existing check still runs on every
  request: session, entitlement, publication, rights, VJ, capability signature,
  expiry, operation, version, the per-user and per-address limits, and the
  30-second recheck during a transfer.
- **Streaming does not read it.** Playback is the same with the switch on or off.

What a viewer or a client sees while it is off:

| Request | Answer |
| --- | --- |
| The movie page | No Download control and no download text |
| `POST /api/media/download-token` (any body, signed in or not) | `503 {"error":"downloads_disabled"}`, before the session or the catalogue is read |
| A page opened before the switch went off, Download pressed | "Downloads are switched off at the moment." |
| `GET …/download` on the gateway (any token, valid or not, any `Range`) | `503 {"error":"downloads_disabled"}`, before the token is read; no catalogue or Telegram call |
| `GET …/stream` | Unchanged |

The gateway logs `event=downloads state=enabled|disabled` once at startup, and
`code=downloads_disabled outcome=denied route=download` for each refused request.

## What the switch does not do

- **It does not end a transfer that is already running.** It decides admission
  only. A download admitted while the switch was on runs on under the Checkpoint
  8 rules: until it completes, the viewer disconnects, a read or the socket stalls
  for 30 seconds, the 30-second recheck finds the version or the user no longer
  allowed, or four hours pass. Tested with the switch turned off during a
  transfer: the transfer completed byte-identical, a new request and a resume
  were refused, and a revocation still ended a running transfer.
- **The gateway's copy cannot be changed while it runs.** It is read at startup.
  Changing it means restarting the gateway, and a restart ends every running
  download and interrupts playback after the 15-second grace. So on the gateway
  the switch is a hard stop, not a quiet one.
- It is not a per-movie or per-user control. For one movie, withdraw it or its
  rights; for one account, ban it. Both already end a running transfer within
  about 35 seconds.

## Stopping downloads

Choose by how fast it has to be and what may be interrupted.

### 1. Quiet stop: no new downloads, running ones finish

1. Set `MEDIA_GATEWAY_DOWNLOADS_ENABLED=false` (or remove it) in the web
   application's environment and redeploy the web application.
2. From that deployment on, no capability is issued. A capability issued
   earlier can still start or resume a download until it expires, so admission
   stops completely within **10 minutes**. Movie pages rendered before the
   change may show the control for up to 5 minutes; pressing it gets the
   "switched off" message.
3. Transfers already running continue, for up to four hours each.
4. Check: `POST /api/media/download-token` answers 503 with `downloads_disabled`,
   and the gateway log shows no new `route=download` request with `status=200` or
   `206` after ten minutes.

Playback is not touched. Nothing on the gateway changes.

### 2. Hard stop: nothing is admitted from now on

1. Do step 1 of the quiet stop.
2. Set `MEDIA_GATEWAY_DOWNLOADS_ENABLED=false` (or remove it) in the gateway's
   environment and restart the gateway.
3. The restart refuses new requests at once, gives running streams and
   downloads 15 seconds, then cuts them. **Every running download fails and
   every viewer who is watching is interrupted**. Once the gateway is ready
   again viewers press Play again, and downloads stay refused.
4. Check: the startup log line `event=downloads state=disabled`, `/readyz`
   answers 200, and a download request answers 503 with `downloads_disabled`.
   Then run the playback smoke check (readiness checklist, section 6).

Use this when a running transfer itself must end, or when the web application
cannot be redeployed quickly. The gateway switch alone is enough to stop every
download, whatever the web side says.

### 3. One movie or one account

Unchanged from Checkpoint 8, and independent of the switch: withdraw the movie,
withdraw the version's rights or ban the account. A running transfer ends at its
next recheck, within about 35 seconds; new requests are refused at once. Each is
its own authorized operation with its own effect on the catalogue.

### What does not work as a stop

- Rotating `MEDIA_GATEWAY_TOKEN_SECRET` invalidates every link, playback links
  included, and **does not end a running transfer**.
- Lowering a download limit: the smallest setting still allows one download.

## Turning downloads on (activation, not authorized)

The order is the reverse, and it comes after everything in
`MP4_MKV_ACTIVATION_READINESS.md`, section 13: migration 9, the rebuilt gateway
image with its allowed origins, the real-device tests.

1. Gateway: set `MEDIA_GATEWAY_DOWNLOADS_ENABLED=true`, restart, confirm
   `event=downloads state=enabled` and the one-byte download probe (readiness
   checklist, section 6).
2. Web application: set `MEDIA_GATEWAY_DOWNLOADS_ENABLED=true`, redeploy.
3. Only now does a viewer see a Download control.

Gateway first, so that no viewer is shown a control that fails.

## Limits of this procedure

- Not rehearsed on a hosted gateway or a deployed web build. The times above
  (10 minutes, 5 minutes, 15 seconds, 35 seconds) are the configured values, not
  measurements from production.
- Two places to set is two places to forget. The readiness checklist lists both.
- There is no admin screen for the switch and none is planned here: it is
  deployment configuration, changed by whoever operates the two servers. The
  reviewer screen shows the web application's current value, read-only.
- `.env.example` does not list the variable. That file carries an unrelated
  uncommitted edit that the checkpoint rules keep out of commits, so it was not
  touched.
