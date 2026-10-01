# Velora UG — Phase E Playback Design

Phase E delivers Telegram-backed media to entitled users. The E1 delivery spike, the media gateway (E1.2) and its least-privilege database identity (E1.2A) are recorded in `docs/PHASE_C_INGESTION_DESIGN.md`, sections "E1" to "E1.2A". This document starts at E2.

## E2 — Entitlement and stream capability issuing (2026-09-30)

**Result: PASS.** Starting HEAD `c604312`.

### Flow

```text
browser ──POST {movieVersionId}──▶ Next.js /api/media/stream-token
                                     session → entitlement → catalogue eligibility
                                     ◀── { streamUrl, expiresAt }
browser ──GET streamUrl (Range)───▶ media gateway (verifies, re-checks publication)
                                     ──▶ MTProto reader ──▶ Telegram
```

Next.js authorizes and the gateway delivers bytes. No movie byte passes through Next.js or Vercel, and there is no media proxy.

### Access policy

The repository fixed two points:

- signed-out users may never play (roadmap, E acceptance criteria);
- "entitled" will mean an active subscription (`docs/VELORA_UG_MIGRATION_PLAN.md`, section 13).

It did not say what applies before Phase F, so E2 stopped once (`E2 BLOCKED — ACCESS POLICY DECISION REQUIRED`). The product owner then chose option A on 2026-09-30:

> Until Phase F, every **signed-in** user may stream published movies. Signed-out users are denied.

This rule lives in exactly one place, `hasStreamingEntitlement` in `lib/playback/entitlement.ts`. Phase F replaces that function's body with the subscription check; no caller changes. No subscription or payment state was invented.

### Authentication

This is the existing Supabase SSR architecture, reused unchanged:

- `getAuthedClient()` in `lib/auth.ts` builds a cookie-bound server client and verifies the session with `getClaims()`. It is the only source of the caller's identity.
- `proxy.ts` refreshes sessions only for account routes. Catalogue pages stay public and session-free. The endpoint reads the session itself, and the Supabase client can write refreshed cookies from a Route Handler.
- The body never carries a user id, and the strict schema refuses one.

### Entitlement boundary

`canStreamMovieVersion(user, movieVersionId)` in `lib/playback/entitlement.ts` returns a structured decision:

| Decision | When |
| --- | --- |
| `allowed` (version, subject = user id) | valid id, signed in, entitled, playable |
| `invalid_version` | not a positive safe integer |
| `authentication_required` | no verified session |
| `not_entitled` | the policy says no (never under policy A) |
| `unavailable` | the catalogue does not publish that version |

The checks run in that order: id shape, caller, entitlement, then catalogue. A signed-out or non-entitled caller therefore never causes a catalogue read and learns nothing about the version.

### Catalogue eligibility

`isMovieVersionPlayable(id)` in `lib/catalogue.ts` reuses the B-2 public read contract. It is the session-free anon client under `20260923210000_catalogue_public_read.sql`:

- a version row is visible only for a published movie, a ready and rights-cleared version, and an active VJ;
- `movie_versions_ready_media_check`, together with the composite foreign key, means a ready version always links movie-bot `telegram_media`;
- `movies_published_at_check` means a published movie always has `published_at`.

So visibility proves every catalogue rule the gateway's resolver applies, including media existence. Nothing private is read and no migration was needed.

The gateway's resolver also applies two **transport** rules that the application cannot see and deliberately does not duplicate:

- the media is in the registered Movies channel;
- `file_size_bytes > 0`.

When one of these fails, the application may issue a capability and the gateway then answers 404 with no bytes. `tests/integration/stream-eligibility.test.ts` pins this down on the E1.2A fixture matrix: the two sides agree on every catalogue rule, and differ only on those two cases. The publication path requires a registered channel at upload time, so on hosted this can happen only if a channel is later deregistered or a size is missing.

### Endpoint: `POST /api/media/stream-token`

- **Code.** The route (`app/api/media/stream-token/route.ts`) only wires dependencies. The logic is in `lib/playback/stream-token.ts`.
- **Request.** `{ "movieVersionId": <positive integer> }`, strict (`streamTokenRequestSchema` in `lib/schemas.ts`). Any other key is refused. That includes channel, message, document and file ids, access hash, file reference, DC, MIME type, size, gateway database ids, user id, operation, gateway origin, and an earlier token.
- **Response (200).** `{ "streamUrl": "<gateway origin>/v1/movie-versions/<id>/stream?token=…", "expiresAt": "<ISO 8601>" }`. Nothing else: no Telegram metadata, no entitlement internals.
- **Every response** has `Cache-Control: no-store`. POST Route Handlers are never cached, and no capability is ever minted through GET.

Errors are a fixed `{ "error": code }`:

| Status | Code | Cause |
| --- | --- | --- |
| 403 | `forbidden` | `Sec-Fetch-Site` present and not `same-origin` |
| 415 | `unsupported_media_type` | not JSON |
| 413 | `payload_too_large` | body over 256 characters, declared or actual |
| 400 | `invalid_request` | malformed JSON, schema failure, invalid version |
| 401 | `authentication_required` | signed out |
| 403 | `not_entitled` | policy denial |
| 404 | `unavailable` | unknown, unpublished, not ready, rights not cleared, inactive VJ, no version (Fuze) |
| 429 | `rate_limited` | more than 30 requests per user per minute, per server instance (`Retry-After: 60`) |
| 503 | `temporarily_unavailable` | issuer or Supabase not configured, or catalogue unreadable |

The CSRF posture matches `app/api/search-events`: the session cookie is SameSite=Lax, a JSON body needs a CORS preflight that this route never answers, and the checks above make that explicit.

Rate limiting reuses the gateway's `WindowRateLimiter`, in memory. There is no shared store, and none was added. The gateway's own per-subject and per-IP limits still apply to every byte request, because the capability's `sub` is the user id.

Nothing is logged except a configuration error's variable names. No token, user id or version id is logged.

### Capability format

The capability format is the E1.2 format, unchanged: `v1.<claims>.<HMAC-SHA256>`, with the claims `aud`, `op`, `mv`, `sub`, `iat`, `exp`, `jti`. The issuer calls the same `signMediaToken`, so there is one cryptographic implementation. The format has no `iss`. The audience is fixed as `velora-media-gateway`.

An E2 capability is always:

- `op = "stream"`: the issuer can mint nothing else;
- `mv` = the requested internal version;
- `sub` = the Supabase user id.

### Signing secret

The E1.2 shared secret is `MEDIA_GATEWAY_TOKEN_SECRET`: base64url, at least 32 bytes. Both the gateway and the issuer decode it with `parseMediaTokenSecret` in `lib/media-gateway/token.ts`, so they read it identically.

- **Server-only.** It is never `NEXT_PUBLIC_`. `.env.example` documents the name only.
- **Fails closed.** A missing or malformed value gives `StreamCapabilityConfigError`, whose message names only the variable, and the endpoint answers 503. Production is never more lenient than development.
- **Not rotated.** Nothing was generated or rotated. Any rotation must change the gateway and Vercel together. Capabilities last 10 minutes, so an uncoordinated rotation fails playback for at most one lifetime.

### Gateway origin

`MEDIA_GATEWAY_PUBLIC_ORIGIN` is the only host capabilities are issued for. It is configuration, never request input.

`parseGatewayOrigin` accepts a bare origin only. It refuses a path, query, fragment, credentials, an explicit default port, uppercase, a non-HTTP scheme, and a protocol-relative value.

- HTTPS is always allowed.
- `http://` is allowed only for `127.0.0.1`, `localhost` or `[::1]`, and only when `NODE_ENV` is not `production`, which means development and tests.

The browser cannot influence the host, so there is no open redirect, host injection or token exfiltration through this endpoint.

### Lifetime and renewal

- **Lifetime.** 600 s (`STREAM_TOKEN_TTL_SECONDS`), well under the gateway's 3,600 s cap. Movies run longer than one lifetime, so renewal is part of the design.
- **Renewal** is the same POST again, made before `expiresAt`. Each renewal:
  1. re-reads the session;
  2. re-runs entitlement;
  3. re-checks catalogue eligibility;
  4. mints a new capability with a new `jti`.

  There is no refresh token. An earlier capability cannot be exchanged: it is refused in the body, and ignored in an `Authorization` header. Tests prove that signing out, losing entitlement, or unpublishing between renewals stops the next renewal.
- **For the future player (E3).** A media element keeps using one URL for its range requests. When the capability expires, the gateway answers 401 `authorization_expired`. The player should renew about a minute before `expiresAt` and swap the source at the current position. That is E3 work and is not built here.
- **A range response in progress.** It was authorized at its start. The gateway bounds it by `maxResponseBytes` and its request timeout.

### Revocation between renewals

| Change | Effect |
| --- | --- |
| Movie unpublished | The gateway refuses at once (it re-checks publication on every request); renewal is refused |
| Rights no longer cleared | Same |
| Version no longer ready | Same |
| VJ inactive | Same |
| Media moved out of the registered channel, or size missing | The gateway refuses at once; renewal may still issue (transport rule, see above) |
| Entitlement withdrawn (Phase F) | The current capability works until it expires (≤ 10 min); renewal is refused |
| User signs out | The same, ≤ 10 min |

No deny-list: the short lifetime bounds entitlement revocation, and the gateway's per-request publication check covers catalogue revocation.

### Stream and download

Downloads stay separate. An E2 capability has `op = "stream"`, and the gateway answers `/download` with 403 `forbidden` (`wrong_operation`) before any other step. No download capability is issued and no download entitlement exists.

### Boundaries

- `lib/media-gateway/boundary.test.ts` still forbids the application from importing the gateway. The one exception is that `lib/playback/` may import `token` and `limits`. A test pins what those modules import: `token.ts` imports only `node:crypto`, `limits.ts` only `errors.ts`, and `errors.ts` nothing.
- The Next.js application has no gateway database credential. The gateway has no Supabase auth or application credential. `velora_media_gateway` is unchanged and can still only execute its resolver.
- The contract test lives in `lib/media-gateway/issuer-contract.test.ts`, on the gateway side, so the application-side boundary stays narrow.

### Proofs

- **Hosted, read-only.** A scratch script ran the real application modules on plain Node, reading the hosted catalogue as anon. A synthetic user id was used, so there was no hosted auth write.
  - Playable version ids 1 to 30: `[1]` (On The Hunt only).
  - Decisions: On The Hunt `allowed(mv=1)`; signed out `authentication_required`; version 2 and version 999999999 `unavailable`; `"1"` `invalid_version`.
  - The response had only `expiresAt` and `streamUrl`, on the configured origin, path `/v1/movie-versions/1/stream`, with a 600 s lifetime.
  - The real gateway core, run in-process with a counting reader:

    | Request | Result |
    | --- | --- |
    | valid capability, no Range | 400 `range_required` (authorization and publication passed) |
    | `/download` | 403 `forbidden` |
    | another version | 403 `forbidden` |
    | tampered (`mv` rewritten) | 401 `unauthorized` |
    | after 600 s | 401 `authorization_expired` |

    Resolutions 1, media reads 0.
  - A read-only SQL snapshot showed 12 migrations (last `20260927210453`); 1 movie (`on-the-hunt-2026`, published); 1 version (`1`, ready/cleared); 2 media rows, 1 without a version (Fuze); 0 series; Movies checkpoint 26.
- **Fuze.** It has media but no version, so a client has no identifier to name it by. Every version id other than 1 is `unavailable`, and the gateway returns 404 for it too.
- **Local database.** `tests/integration/stream-eligibility.test.ts` covers the E1.2A matrix. The application and the gateway (as `velora_media_gateway`) agree on 10 cases. They differ only on `unregistered_channel` and `no_recorded_size`, as described above. The real entitlement plus issuer allows exactly `published` and those two cases, and every issued capability verifies. Fixtures are removed afterwards (verified 0/0/0).
- **Browser secret scan.** The production build was made with a random canary as `MEDIA_GATEWAY_TOKEN_SECRET`. The scan checked 1,575 files under `.next` for 25 values: the canary; every secret, token, key, hash and password in `.env.local`, including both database passwords, the Telegram bot tokens, the API hash, and the channel and chat ids in both forms; and the active mtcute session. The scan printed counts only.
  - `.next/static` (26 files): 0 hits for every value.
  - Also 0 for the variable names, the canary origin, the `velora-media-gateway` audience and the gateway route marker.
  - `.next/server`, prerendered HTML and RSC payloads: 0 hits.
  - Local cache only: some values, including the canary, appear in Turbopack's persistent cache (`.next/cache/turbopack`, `.next/dev/cache/turbopack`), which snapshots the environment to invalidate itself. It is Git-ignored and never served or deployed, but it is plaintext on the operator machine. It predates E2 for the other `.env.local` values.
- **Tests.**
  - Unit: 29 files, 589 tests. New: `lib/playback/*.test.ts`, `lib/media-gateway/issuer-contract.test.ts`, and the boundary additions.
  - Catalogue integration: 5 files, 56 tests. Database (pgTAP): 482.
  - Lint: 0 errors (1 existing warning in an ignored spike script).
  - `npm run typecheck` and the gateway's `tsc` both pass; `db lint` is clean; the production build passes.
- **Mutation testing.** 23 of 24 mutants were killed. They covered authentication, entitlement, catalogue checks, policy, id validation, subject binding, operation, lifetime, origin rules (path, production HTTP, any host), download URL, same-origin, content type, body limit, no-store, rate limit, error mapping, configuration, strict schema, and the eligibility query (always true, not bound to the id). The survivor is equivalent: a secret of at least 43 base64url characters always decodes to at least 32 bytes, so the byte check never decides.

### External state

- Telegram: media reads 0, writes 0. The MTProto reader was not started. The local Bot API container stayed stopped.
- Hosted writes: 0, and no migration. Hosted reads: anon catalogue reads and one read-only SQL snapshot.
- Catalogue unchanged: On The Hunt published, Fuze unpublished (no version), checkpoint 26, Series untouched. Telegram permissions unchanged.
- **Obsolete GramJS session.** `.velora-ingest/mtproto/reader.session` was deleted. It was proven inactive from paths alone, without reading its contents: only the GramJS spike scripts read it, while every mtcute gateway script (E1.2 prove, diag, reconnect) uses `.velora-ingest/mtproto-gateway/reader.session`, which was not touched. Both held the same auth key, because the mtcute session was converted from the GramJS one. Deleting the copy removes redundant credential material and does not revoke the active session.

### Residuals

- The two transport rules are enforced only by the gateway (see "Catalogue eligibility").
- The endpoint's rate limit is per server instance; the gateway's limits are the backstop.
- Revocation of entitlement takes up to one capability lifetime (10 min).
- The capability travels in the query string, because media elements cannot send headers. The gateway sends `Referrer-Policy: no-referrer` and does not log it.
- Before production playback, operators must set the same `MEDIA_GATEWAY_TOKEN_SECRET` in Vercel and on the gateway, and set `MEDIA_GATEWAY_PUBLIC_ORIGIN` in Vercel.

Not built, by design: the player (E3), downloads, subscriptions and payments, HLS, remuxing, Series playback.

## E3 — Real movie playback (2026-09-30)

**Result: `E3 BLOCKED — MEDIA COMPATIBILITY`.** Starting HEAD `d0d22b9`.

The player, authorization flow, renewal, cleanup and privacy all work end to end, and Chrome plays the original On The Hunt file with video, audio and seeking. Firefox (Gecko) decodes the video but **not the MP3 audio in Matroska**, so it plays silently. That fails the PASS definition, so E3 stops here. The media was not changed.

### What was built

- **`components/movie-player.tsx`** (client). A native `<video controls playsInline preload="metadata">`, placed in the existing `/movies/[slug]` hero actions next to My List. Nothing is title-specific.
  - Play requests an E2 capability, then sets the source. Nothing is requested on page load.
  - Signed out, Play gets 401 from the issuer, and the player shows "Sign in to watch this movie." with a link to the existing `/sign-in?next=/movies/<slug>`. No video element is created and the gateway is never contacted.
  - States shown: getting ready, loading, buffering, and errors (sign-in required, not entitled, unavailable, unsupported in this browser, playback error, interrupted, temporarily unavailable). No raw gateway, Telegram or database text is ever shown.
  - "Close player" and leaving the page pause the element, drop its source and reload it, which aborts its range requests.
- **`lib/playback/player.ts`** (framework-free, unit-tested): the state reducer, the capability request and its response mapping, renewal timing, `MediaError` mapping, version choice and source detachment.
- **Version selection.** The page passes `{ id, label }` for every published version: the internal version id and the VJ name, which the public catalogue already exposes. The first version, in the catalogue's VJ order, plays by default. A native VJ `<select>` appears only when there are two or more versions. On The Hunt resolves to version 1 (VJ Ice P).
- **`next.config.ts`.** `VELORA_DISABLE_DEV_FS_CACHE=true` turns off Turbopack's dev filesystem cache, which persists the process environment. The live proof used it so the per-run secret never reached disk. Builds are unaffected.

### Renewal design

A capability lasts 10 minutes (E2). The player renews 90 s before expiry while playing. A paused player renews when it resumes, if the capability is within 90 s of expiry. After a media network error it renews once and resumes.

Renewal is the same `POST /api/media/stream-token`, so the session, entitlement and catalogue are re-checked each time. The new URL is swapped in place: the player saves the position, sets the new `src`, restores the position on `loadedmetadata`, and resumes if it was playing. A denied renewal stops playback and shows the reason.

**Bug found and fixed during the live test.** Expiry was first compared as server `expiresAt` against the device clock. With the page clock ahead (the renewal test fast-forwards it 8m40s, and real device skew would do the same), every fresh capability looked nearly expired. The `play` event after each swap then renewed again, in a loop, until the issuer answered 429 after 30 requests. Two fixes:

- Expiry is now kept on the device clock (`expiresAtMs`), using the issuer reply's `Date` header to cancel skew.
- A 30 s minimum interval between renewals guards against any loop.

Both are unit-tested, and the rerun renewed exactly once.

### Live proof setup (local)

- **Secret.** One per-run `MEDIA_GATEWAY_TOKEN_SECRET`, generated in memory by the harness and given only to the two processes below. It was never printed, written to disk, put in `.env.local` or committed.
- **Next.js.** `next dev` on `127.0.0.1:3000`, with `MEDIA_GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:8787` (the E2 development loopback exception; production still requires HTTPS) and the dev filesystem cache off.
- **Gateway.** The `velora-media-gateway:e3` image, built from HEAD, run read-only with a 256 MiB and 1 CPU cap. It used the existing mtcute session (`.velora-ingest/mtproto-gateway/reader.session`): no new login, rotation or permission change. Database access was the restricted `velora_media_gateway` role.
- **Identity.** One throwaway hosted Supabase Auth user. The harness first confirmed the admin API worked, then created the user with a random password held in memory. The user signed in through the real `/sign-in` page and was deleted afterwards: lookup returned not found, and hosted then showed 1 user and 1 profile. Deleting the user cascades to `profiles`, the watchlist and search history.
- **Browsers.** Driven by Playwright 1.63, installed in a scratch directory outside the repository.

### Browser matrix

| | Google Chrome 153 | Playwright Firefox 155 (Gecko) | Playwright WebKit 26.6 (Windows) |
| --- | --- | --- | --- |
| Metadata | yes: 5208.29 s, 1920×1080 | yes: 5208.29 s, 1920×1080 | **no**: readyState 0 after 90 s, no error |
| Video decode | yes: 297 frames in 12.4 s, 0 dropped; frames change | yes: 293 frames in 12.3 s, 0 dropped; frames change | no |
| Audio decode | **yes**: decoded audio bytes 13.8 KB → 211.9 KB; analyser peak RMS 0.32 | **no**: `mozHasAudio` false; analyser RMS 0 at the same point | no |
| Playback | yes: first `playing` 3.3 s after Play | yes (silent): 1.3 s | no |
| Seek to 30:00 | yes: `seeked` in 1.4 s, resumed | yes: 3.2 s, resumed | no |
| Seek to 81:40 | yes: 0.7 s, resumed | yes: 1.2 s, resumed | no |
| 45 s pause, then resume | yes | yes | no |
| **Verdict** | **PASS** | **FAIL (no audio)** | **FAIL (no metadata)** |

- **Safari: NOT TESTED** (no macOS). Playwright WebKit on Windows is not Safari.
- Firefox was Playwright's Gecko build because desktop Firefox is not installed.

`canPlayType`, which needs no media reads, agrees with the live results:

| Type | Chrome | Gecko | WebKit |
| --- | --- | --- | --- |
| `video/x-matroska; codecs="avc1.640028, mp3"` (the source) | probably | **no** | probably |
| `video/x-matroska; codecs="avc1.640028, mp4a.40.2"` (MKV, H.264 + AAC) | probably | probably | probably |
| `video/mp4; codecs="avc1.640028, mp3"` (MP4, H.264 + MP3) | probably | probably | probably |
| `video/mp4; codecs="avc1.640028, mp4a.40.2"` (MP4, H.264 + AAC) | probably | probably | probably |

WebKit answers "probably" for the source but never loads it, so its `canPlayType` answer can't be trusted here.

### Evidence for the next checkpoint (nothing was transformed)

H.264 High 1080p decodes in both Chrome and Gecko, so **video re-encoding looks unnecessary**. Only the audio track, or the container around it, blocks Gecko. In the brief's order:

1. **Container-only remux to MP4, keeping the MP3 audio.** Gecko reports "probably" for MP4 with H.264 and MP3. This is the smallest change and should be tried first.
2. **Audio conversion (MP3 to AAC), keeping the H.264 video**, in MKV or MP4. All three engines report "probably".
3. **Progressive MP4** (faststart) covers both, and is also the most likely container for Safari.
4. **HLS or transcoding**: no evidence yet that either is needed.

### HTTP range behaviour (final run, all three engines)

- **Pattern.** Each open starts with `bytes=0-`, then Matroska's cue lookup at the tail (`bytes=1004404736-`, 58 KB), then data ranges. Every request is open-ended and answered 206 with a gateway-bounded `Content-Range`.
- **Full-file requests:** 0. **Largest response:** 8,388,608 bytes, the gateway's `maxResponseBytes`.
- **Seeks.** Seeking to 30:00 requested `bytes=329646080-`; seeking to 81:40 requested `bytes=958464000-`. Both were served in 8 MiB windows.
- **Totals.** 31 gateway requests, 154.2 MB served, 177 MTProto `upload.getFile` reads (167 RPCs).
  - Outcomes: 23 complete, 7 `client_closed`, 1 denied (the deliberate download probe).
  - Per engine: Chrome 61.0 MB / 70 reads; Gecko 75.2 MB / 85 reads (it includes the audio probe's CORS requests); WebKit 17.9 MB.
- **Earlier runs.** Four debugging runs (two Chrome full, two Chrome short) came before this one. Telegram reads across all E3 runs total about 0.35 GB, all through bounded 8 MiB windows.
- **Gateway memory.** At most 80.2 MiB of the 256 MiB cap in the final run, and 120.4 MiB in the first run.

### Boundedness and cleanup

- **Pause (45 s):** 0 new browser requests and 0 gateway reads while paused. Resuming made one range request and playback continued.
- **Close player:** the video element was removed; 0 browser gateway requests afterwards, and 0 gateway requests starting 2–10 s later.
- **Navigating to `/movies` mid-play:** 0 browser gateway requests afterwards, 0 gateway requests starting 2–10 s later, and the in-flight range ended as `client_closed` or `complete`.
- **A stream capability on `/download`:** 403 `forbidden`.

### Renewal, live in Chrome

The page clock was fast-forwarded 8m40s, which fired the real renewal timer:

- 1 issuer call, and a new capability (a different token);
- the source was swapped in place, at position 4909.07 s → 4911.77 s, and kept playing;
- element events: `abort`, `emptied`, `loadstart`, `loadedmetadata`, `seeking`, `seeked`, `playing`.

Unit tests prove the rest against the real E2 handler: renewal re-reads the session, entitlement and catalogue, and a renewal refused for signed-out, not entitled or unavailable ends playback.

### Signed out (all three engines)

- The page load made 0 issuer calls.
- Play made 1 issuer call and got 401. The player showed the sign-in message and link.
- 0 video elements were created, 0 browser requests went to the gateway, and the gateway logged 0 media requests.

### Privacy and secrets

- **Browser-visible responses.** 26 HTML, RSC and JS responses from the movie and `/movies` pages were checked for: the per-run secret, the channel id in both forms, the `file_unique_id`, the API hash, the gateway database URL, the service-role key, both bot tokens, and the session. Every one was absent, and no `message_id`, `file_id`, `access_hash` or `file_reference` field name appeared.
- **Stream URL.** It carries only `/v1/movie-versions/1/stream?token=…` on the configured origin.
- **Logs.** 0 capability tokens in the `next dev` and gateway logs, and the secret is in neither.
- **Disk.** The per-run secret was found in 0 of 1,600 `.next` files, scanned while the run was still alive.
- **Production build.** Built with a random stand-in secret: 0 secret values in all 27 `.next/static` files, and none of the gateway variable names, audience or route markers. Server-side hits are only in Turbopack's local caches (`.next/cache/turbopack`, `.next/dev/cache/turbopack`), as recorded in E2. They are Git-ignored and never deployed.

### Tests and gates

- Unit: 625 passing. New: `lib/playback/player.test.ts` and `components/movie-player.test.tsx`.
- Database (pgTAP): 482. Catalogue and gateway integration: 56.
- Lint: 0 errors (the one existing warning in an ignored spike script). Both typechecks and the production build pass.
- **Mutation testing: 22 of 22 killed.** Covered: the reducer's request, denial, failure, renewal and close handling; the 401, 403 and 404 mapping; URL scheme validation; clock-skew correction; the renewal margin, inversion, floor and loop guard; the `MediaError` mapping; source detachment; the default version; the request body; credentials; and the VJ choice and empty-version rendering.

### External state

- Telegram content writes: 0. Reads: only bounded playback, seek and disconnect ranges, plus the reader's startup identity and channel checks.
- Hosted catalogue writes: 0. Hosted auth: one throwaway user created and deleted.
- On The Hunt published (version 1 ready/cleared); Fuze has media but no version; checkpoint 26; Series 0; 12 migrations.

### Not done, by design

No remux, transcode, HLS, download, payment or Series playback. The player stays in place: once a browser-compatible rendition exists, it plays without code changes.

## E3.1 — Browser-compatible packaging proof (2026-09-30)

**Result: `E3.1 PACKAGING PROOF: PASS — MP4 REMUX ONLY`.** Starting HEAD `183df79`.

Moving both streams, unchanged, from Matroska into a fast-start MP4 fixes the E3 incompatibility. Chrome and Gecko then decode video **and** audio, and seek. No audio or video encoding was needed. This is a format proof only. Nothing was uploaded, stored or linked to the catalogue, and no storage or ingestion decision was made.

### Tooling

- FFmpeg and ffprobe **9.0.2**: the gyan.dev "release essentials" Windows build. Its SHA-256 matched the published checksum. It was unpacked in the session scratch directory, with no system install and nothing in the repository.
- Browsers were driven by the scratch Playwright 1.63 from E3.
- Media was served by a local byte-range server (`127.0.0.1:8790`). There was no media gateway, Telegram call or Supabase access.

### Source (inspection only; unchanged afterwards)

The source is `On The Hunt.VJ ICE P.2026.mkv`: 1,004,462,878 bytes, SHA-256 `1d0dcd00256adc0c…`. The SHA-256, size and modification time were identical after the proof.

| | |
| --- | --- |
| Container | Matroska (written by `Lavf57.71.100`), 5208.294 s, 1.54 Mb/s overall |
| Stream 0 | H.264 High, level 4.0, 1920×1080, 24/1 fps, progressive, yuv420p, BT.709 limited range, AVCC with 4-byte NAL lengths, B-frames (`has_b_frames` 2), start 0.084 s. Bitrate not recorded; about 1.41 Mb/s (the MP4 reports 1,411,270 b/s) |
| Stream 1 | MP3, stereo, 44.1 kHz, fltp, 128 kb/s CBR, start 0.000 s |
| Frames | 124,997 video packets, 199,380 audio packets |

### Candidate A: MP4, both streams copied

```text
ffmpeg -hide_banner -nostdin -loglevel warning -i "<source>.mkv" \
  -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart -f mp4 -y A.mp4
```

- **Cost.** 3.8 s wall-clock and 4.2 s CPU with a warm file cache; 6.7 s cold. It is limited by disk speed. Two runs gave byte-identical output, so the remux is deterministic. No warnings.
- **Output.** 1,007,441,962 bytes, which is **+2,979,084 bytes (+0.30%)** because MP4 sample tables are larger than Matroska's.
- **ffprobe.**
  - Video: `h264`, High, level 40, `avc1`, 1920×1080, 124,997 frames, start 0.084 s.
  - Audio: `mp3` as `mp4a` (object type 0x6B), stereo, 44.1 kHz, 128 kb/s, 199,380 frames.
  - Duration 5208.29 s. A full audio decode pass reported no errors.
- **Layout (fast-start).** Top-level boxes, in order: `ftyp` at 0, `moov` at 32 (5,335,509 bytes), `free`, then `mdat` at 5,335,549. The index comes before the media data, so a player can start from the head of the file.

### Candidate A identity proof

Every hash is over packet payloads demuxed with `-c copy`, with no decoding, using `-f hash -hash sha256` and `-f framemd5`:

| Check | Source | Candidate A |
| --- | --- | --- |
| H.264 packet payloads (AVCC) | `b9232513…f7b837` | `b9232513…f7b837` |
| H.264 Annex B elementary stream (`h264_mp4toannexb`) | `ed50271d…ad1971` | `ed50271d…ad1971` |
| avcC extradata (SPS/PPS) | 49 B, `4351fda9…dc8cbc` | 49 B, `4351fda9…dc8cbc` |
| Video packets: count, sizes and MD5s in order | 124,997 | 124,997, identical |
| MP3 packet payloads | `ba605f2a…892ea4` | `ba605f2a…892ea4` |
| Audio packets: count, sizes and MD5s in order | 199,380 | 199,380, identical |

**The video and audio are bit-for-bit the source's.** Only timestamps are rewritten, into MP4's time base, and they aren't part of the compared payloads.

### Candidate A in browsers

The local server capped each 206 response at 8 MiB, like the gateway.

| | Google Chrome 153 | Playwright Firefox 155 (Gecko) | Playwright WebKit 26.6 (Windows) |
| --- | --- | --- | --- |
| Metadata | 284 ms: 5208.294 s, 1920×1080 | 296 ms: 5208.294 s, 1920×1080 | 2.5 s: 5208.294 s, 1920×1080 |
| Playback starts | 400 ms | 424 ms | time advances |
| Video decode | 196 frames in 8.2 s, 0 dropped; frames change | 208 frames in 8.7 s, 3 dropped; frames change | **0 frames decoded** |
| Audio decode | decoded audio bytes 4.6 KB → 313 KB; analyser peak RMS 0.37 | `mozHasAudio` **true** (MKV: false); RMS 0.33 | **0 audio tracks**, 0 decoded bytes; no Web Audio |
| Seeks 15:00 / 30:00 / 81:40, resumed | yes: 111 / 200 / 11 ms to `seeked` | yes: 477 / 940 / 195 ms | not run |
| **Verdict** | **PASS** | **PASS** | **FAIL (no decoders)** |

- **Safari: NOT TESTED** (no macOS).
- **Playwright WebKit on Windows** decodes neither the H.264 video nor the audio. It is an engine-build limitation, not a packaging one: it now reads the MP4's metadata, which it never did for the MKV.

### Progressive and range behaviour (Candidate A)

- **Opening.** Metadata needed `bytes=0-` and nothing else: one 8 MiB window in Chrome (0.8% of the file) and two in Gecko (16 MiB, 1.7%). Playback started straight after.
- **Seeks.** Each needs one or two open-ended ranges at the target, answered 206 in ≤ 8 MiB windows: `bytes=178683904-` for 15:00, `bytes=334200832-` for 30:00, `bytes=961609728-` for 81:40. Unlike the MKV, the MP4 needs no extra tail fetch, because its index is already in `moov`.
- **Whole test.** 0 full-file requests and only 206 statuses.
  - Chrome: 5 requests, 26.6 MB (2.6%).
  - Gecko: 9 requests, 57.9 MB (5.8%).
  - Largest response: 8 MiB.
- **Pause:** 0 requests and 0 bytes during a 12 s pause in both engines.

The harness's own "progressive" flag showed false for Gecko only because its threshold was "less than 16 MiB before metadata", and Gecko fetched exactly 16 MiB. Nothing more was fetched.

### Why Candidate B (AAC audio) was not created

The brief says not to transcode audio when Candidate A meets the target, and A does: Chrome and Gecko both decode its MP3 audio. The only engine that still fails, Playwright WebKit on Windows, fails on the **video** as well (0 H.264 frames), so AAC audio could not fix it. No audio was encoded.

**Open question for the architecture decision (not proven here).**

- **Safari** support for MP3 inside MP4 is unverified until tested on a real Apple device. AAC is the fallback if it fails.
- **MSE and HLS.** `MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.6B"')` is **false** in Chrome and Gecko, while H.264 with AAC is **true**. Progressive playback in a plain `<video>`, which is what Velora uses, does not rely on MSE. Any future MSE, HLS or adaptive path would need AAC audio.

### Size and cost

| | Bytes | vs source | Time | Video | Audio |
| --- | --- | --- | --- | --- | --- |
| Original MKV | 1,004,462,878 | — | — | — | — |
| Candidate A (MP4) | 1,007,441,962 | +0.30% | 3.8–6.7 s, about 4 s CPU | copied, bit-identical | copied, bit-identical |
| Candidate B | not created | — | — | — | — |

A remux has no encoding cost and is lossless. It could run on the uploader machine or anywhere that can read the source.

### Recommended minimum compatible format (from this proof only)

**Progressive MP4, fast-start (`moov` before `mdat`), with the H.264 and MP3 copied from the source.** It is produced by `-c copy -movflags +faststart`, with no re-encoding.

Where that file is stored, whether it replaces or sits beside the original in Telegram, and whether AAC is needed for Safari or MSE, are for the next architecture checkpoint.

### External state and cleanup

- Telegram reads 0 and writes 0. Hosted reads 0 and writes 0. No auth user, no gateway, no catalogue change. On The Hunt, Fuze, checkpoint 26 and Series untouched.
- The 1 GB Candidate A file, the packet lists and the FFmpeg zip were deleted after the proof. No media file remains in the scratch directory, and none was ever in the repository.
- Kept in the session scratch directory: the FFmpeg binaries, the harness scripts and the logs.
- The repository changed only in documentation (this record and the roadmap).

## E3.2 — Production media storage and delivery architecture (2026-09-30)

> **Superseded by E3.2A (below).** The B-prime decision in this section is **deferred, not implemented**: Telegram + Media Gateway stays the production playback path. The research here (providers, cost, bandwidth, failure domains, security) is kept unchanged as the documented future scaling and migration path. Section 8 (normalization policy) and section 9 (canonical format) carry forward into E3.2A. Section 16's R2 proof was never run.

**Result: `E3.2 PRODUCTION MEDIA ARCHITECTURE: DECIDED` — Hybrid "B-prime".**

- Playback is served from **private Cloudflare R2**: one browser-canonical MP4 per movie version, through short-lived presigned URLs issued by the existing E2 boundary.
- **Local masters are authoritative.**
- **Telegram** keeps an **archive-only** copy of each original, off the playback path.
- The **Media Gateway leaves the production playback path.** Its code stays as the archive-restore reader and as a documented fallback.

Starting HEAD `c8c1928`. This is a design decision. No storage was created, nothing was uploaded, and no runtime code changed.

### 1. What Model A already is (current implementation)

Model A is not a sketch; it is built and tested:

| Piece | Where | State |
| --- | --- | --- |
| Dedicated MTProto reader (mtcute 0.32.3); identity, channel and `other`-only rights asserted at startup; one warm persistent session, re-persisted atomically | `services/media-gateway/mtcute-reader.mts` | E1.2 PASS |
| Range planner (1 KiB-aligned `upload.getFile`, ≤ 1 MiB, one window) | `lib/telegram/mtproto-range.ts` | E1.1 byte-equal |
| HTTP core: token → limits → readiness → publication → Range → bytes | `lib/media-gateway/server.ts` | E1.2 PASS |
| Concurrency: global read semaphore, read-ahead of 2, per-subject and per-IP stream and rate limits, request and idle timeouts, 8 MiB response cap | `lib/media-gateway/limits.ts`, `pump.ts` | E1.2 and E3 proven |
| Cancellation and backpressure (drain, abort, and cancel in-flight reads on disconnect) | `pump.ts` | E3: 0 reads after close or navigation |
| HMAC capability (`stream` ≠ `download`, version- and user-bound) | `lib/media-gateway/token.ts` | E1.2 and E2 |
| Least-privilege database resolver: the `velora_media_gateway` role can execute exactly one function | migration 12 | E1.2A PASS |
| Publication re-checked on **every** request | `server.ts` step 5 | E1.2 and E2 |
| E2 entitlement and issuer, native player, renewal | `lib/playback/*`, `components/movie-player.tsx` | E2 PASS; E3 working in Chrome |

- **Size:** about 1,260 lines of gateway core, 555 of adapters, 1,220 of gateway tests, an 80-line range mapper, a 250-line issuer and a 430-line player.
- **Deployment needs:** a long-running container (256 MiB was enough) that holds the MTProto session file as a secret volume, the restricted database login, the reader bot's credentials, and a public HTTPS origin.
- **Operations:** session custody, reader re-authentication, flood waits, Telegram availability, and scaling the gateway's bandwidth.

### 2. Providers (researched 2026-09-30, official pages; facts, not estimates)

| | Cloudflare R2 | Backblaze B2 | Wasabi | Bunny Storage + CDN |
| --- | --- | --- | --- | --- |
| Storage | $0.015/GB-month Standard; $0.01 Infrequent Access | $6.95/TB-month | $7.99/TB-month, **minimum 1 TB billed** | $0.01/GB (1 region) up to $0.025 (3 regions) |
| Egress | **free** (all classes) | free up to 3× stored per month, then **$0.01/GB**; free to partner CDNs | "free" only while **monthly egress ≤ active storage**; persistent excess → "may limit or suspend" | storage→Bunny CDN free; CDN **$0.06/GB Middle East & Africa**, $0.01 EU/NA; Volume network $0.005/GB (10 PoPs) |
| Requests | Class A $4.50/M, Class B $0.36/M (Standard); 1M A and 10M B free | A, B and C free; D $0.004/10k | none | none |
| Minimum duration | none (Standard); 30 days (IA) | none | **90 days**, charged if deleted early | $1/month minimum |
| S3 API / presigned | yes; presigned 1 s–7 days, **S3 endpoint only** (not custom domains) | yes | yes | not stated on the pricing page; CDN token auth (SHA256, expiry, optional IP binding) |
| Range | yes (plus conditional headers) | yes (S3 API) | yes (S3 API) | yes (CDN) |
| CORS | bucket CORS rules | yes | yes | yes |
| Private buckets | yes | yes | yes | yes |
| Data location | wnam, enam, weur, eeur, apac, oc: **no Africa** | account-bound region (US or EU) | no Africa region | per-region choice |
| Serving to Uganda | requests enter Cloudflare's network, which lists a **Kampala** PoP (also Nairobi, Mombasa, Kigali, Dar es Salaam) | direct from the US or EU | direct from its region | edge PoPs; Africa rate applies |

- **Cloudflare terms.** Outside Enterprise, video must be served through its paid services, such as the Developer Platform (which includes R2), Images or Stream. **R2-origin video is inside the terms.** Proxying a self-hosted gateway through the plain CDN for video is not.
- **Hetzner (Model A host).** EU cloud includes 20 TB per server; overage is **€1 ($1.20)/TB**; ingress is free. CX33 (4 vCPU, 8 GB) is **€8.49/month** after 15 June 2026. US and Singapore include only 1 and 0.5 TB.
- **Telegram.** The API terms don't address using Telegram as a media host or CDN, and they reserve the right to cut off API access. That is **an unresolved risk**, not a known violation. Telegram publishes no per-GB price or throughput guarantee for bots.

### 3. Cost model

All figures are USD per month. Storage uses the rates above with free tiers ignored. The **size basis** is decimal TB.

**Storage only:**

| Movies × avg size | TB | R2 | B2 | Wasabi | Bunny (1 region) |
| --- | --- | --- | --- | --- | --- |
| 100 × 0.7 / 1.0 / 1.5 GB | 0.07 / 0.10 / 0.15 | 1.05 / 1.50 / 2.25 | 0.49 / 0.70 / 1.04 | 7.99 (1 TB minimum) | 0.70 / 1.00 / 1.50 |
| 1,000 × 0.7 / 1.0 / 1.5 GB | 0.70 / 1.00 / 1.50 | 10.50 / 15.00 / 22.50 | 4.87 / 6.95 / 10.43 | 7.99 / 7.99 / 11.99 | 7.00 / 10.00 / 15.00 |
| 5,000 × 0.7 / 1.0 / 1.5 GB | 3.5 / 5.0 / 7.5 | 52.50 / 75.00 / 112.50 | 24.33 / 34.75 / 52.13 | 27.97 / 39.95 / 59.93 | 35.00 / 50.00 / 75.00 |

Model B keeps the original in Telegram, which has no direct charge, **not** in R2, so R2 holds one copy (the MP4, about +0.3%). If originals were also kept in R2, the R2 column would double (or cost +$0.01/GB in Infrequent Access).

**Delivery only, per monthly playback traffic:**

| Traffic | R2 (egress $0; Class B worst case at 1 request per MiB) | B2 direct (1 TB stored, so 3 TB free) | Bunny CDN, Africa | Wasabi | Model A gateway, Hetzner EU CX33 |
| --- | --- | --- | --- | --- | --- |
| 1 TB | $0 + ≤ $0.36 | $0 | $60 | within policy only if ≥ 1 TB stored | $10 (inside 20 TB) |
| 10 TB | ≤ $3.60 | $70 | $600 | **outside the free-egress policy** | $10 |
| 50 TB | ≤ $18 | $470 | $3,000 | outside | $10 + 30 × $1.20 = $46 |
| 100 TB | ≤ $36 | $970 | $6,000 | outside | $10 + 80 × $1.20 = $106 |

- **R2 requests (estimate).** Measured browsers issue a few open-ended ranges per session plus one or two per seek (E3 and E3.1), far below 1 per MiB, so real Class B cost should be well under the bound.
- **Model A** covers traffic only. It excludes more servers for concurrency (section 4), redundancy, and the Telegram throughput risk. **Telegram → gateway** traffic is free as Hetzner ingress, but it roughly equals delivered bytes, up to about 20% more on seek-heavy use (E3: 177 reads of up to 1 MiB for 147 MiB served).
- **Scale reference (estimate).** At the source's 1.54 Mb/s, 1 TB is about 1,440 viewing hours, roughly 1,000 full movie plays. 100 TB/month averages about 309 Mb/s, around 200 concurrent viewers on average, with peaks likely several times higher.

**Model totals at 1,000 movies × 1 GB** (storage + delivery; compute for token issuing is on the existing Next.js deploy in every model):

| Traffic | A (gateway) | B / C (R2) | B2 direct | Bunny Storage + CDN, Africa |
| --- | --- | --- | --- | --- |
| 1 TB | ~$10 | ~$15 | ~$7 | ~$70 |
| 10 TB | ~$10 | ~$19 | ~$77 | ~$610 |
| 50 TB | ~$46 + more servers | ~$33 | ~$477 | ~$3,010 |
| 100 TB | ~$106 + more servers | ~$51 | ~$977 | ~$6,010 |

Model A is cheapest only at small scale. R2's cost is dominated by storage, is flat with traffic, and is predictable. Every priced-egress option becomes the largest cost as traffic grows.

### 4. Bandwidth and concurrency

The source's average is 1,004,462,878 B × 8 / 5,208 s = **1.54 Mb/s**, plus start and seek bursts (8 MiB windows in E3).

| Concurrent viewers | Viewer-side sustained | Model A: Telegram → gateway, then gateway → viewers | Model B/C: on Velora infrastructure |
| --- | --- | --- | --- |
| 10 | 15 Mb/s | about 15–18 Mb/s in and 15 Mb/s out | about 1 issuer POST per viewer per 8.5 min (~0.02/s) |
| 100 | 154 Mb/s | about 154–185 Mb/s in and 154 Mb/s out | ~0.2 POST/s |
| 1,000 | 1.54 Gb/s | about 1.5–1.8 Gb/s in and 1.5 Gb/s out: several gateway hosts | ~2 POST/s |

- **Model A bottlenecks** (in order): throughput per reader session and Telegram's per-DC download limits, which are **untested beyond a few streams and undocumented**; the gateway's network interface; then horizontal scaling. E1 established that one reader bot needs one MTProto login, so N gateways need N sessions or N reader bots, each with channel membership.
- **Model B/C** moves the bottleneck to the storage provider's edge. Velora's own infrastructure handles only authorization, which the existing Next.js endpoint already does and rate-limits.

### 5. Failure domains

| Dependency | Model A | Model B-prime (decision) |
| --- | --- | --- |
| Playback needs | Telegram DC availability, reader session validity, reader membership and rights, gateway host, gateway DB role, Supabase, Next.js issuer | R2 (Cloudflare), Supabase (session and catalogue), Next.js issuer |
| Blast radius | a lost session, bot ban, rights change or API cut-off stops **all** playback; the gateway is a single stateful service | an R2 outage stops playback; an issuer outage stops **new** starts and renewals, while running capabilities last ≤ 10 min |
| Recovery | re-login the reader (operator), redeploy the gateway; nothing to fall back to | regenerate derivatives from local masters, or the Telegram archive, into another S3 bucket; keys are opaque, so switching provider is configuration |

### 6. Security comparison

| | E2 token → gateway (Model A) | E2 → presigned R2 URL (decision) |
| --- | --- | --- |
| Lifetime | 10 min, HMAC, bound to version, user and `stream` | presigned GET; **keep 10 min** (5 min is possible). R2 allows up to 7 days; long lifetimes are rejected |
| Replay and sharing | anyone holding the URL can stream until expiry (bearer) | same (bearer until expiry) |
| Entitlement revocation | at the next renewal (≤ 10 min) | same: renewal goes through `canStreamMovieVersion` |
| Publication or rights withdrawal | **immediate**: re-checked per request | at the next renewal (≤ 10 min). Emergency levers: delete or rename the object (immediate, per title); rotate the R2 signing key (immediate, every URL) |
| Origin hiding | Telegram completely hidden | the bucket host (account id), bucket name and object key are visible. Use **opaque keys** (`mv/<uuid>.mp4`) with no title, VJ, catalogue or Telegram id |
| Hotlinking and CORS | CORS only matters for script reads; `<video>` needs none | same; CORS is set on the bucket for Velora's origins only |
| Download prevention | none | none |

In both models, a browser allowed to stream the bytes can save them. Hiding a Download button or making URLs short-lived **does not prevent** determined copying; it only limits unauthorized **new** access. Real prevention needs DRM, which is out of scope.

### 7. Authorization consequence

The gateway re-checks publication per request, and R2 can't. To stay close to that:

1. **Keep capabilities short.** The same 10 min as E2, renewed by the existing player logic (90 s before expiry, on resume, and once after a network error). E3 proved in-place renewal live.
2. **Issuer semantics are unchanged.** `canStreamMovieVersion` → presign. The only change is that `issueStreamCapability` signs an S3 GET instead of a gateway HMAC. The response stays `{ streamUrl, expiresAt }`, so the player does not change.
3. **Worst case** is 10 min of continued access to an unpublished title. Delete the object for immediate effect.

This is the one security property the decision gives up relative to Model A, and it is bounded and documented.

### 8. Media normalization policy (for ingestion; not implemented)

Inspect with `ffprobe -show_format -show_streams`:

- **Container:** `format_name`.
- **Video:** `codec_name`, `profile`, `level`, `pix_fmt` (bit depth), `width`/`height`, `field_order`, `r_frame_rate`/`avg_frame_rate`, `start_time`, `is_avc`/`nal_length_size`.
- **Audio:** `codec_name`, `profile`, `channels`/`channel_layout`, `sample_rate`, `bit_rate`, `start_time`.
- **Streams:** the number of video, audio and subtitle streams; attachments; the default audio stream.
- **File:** duration, and whether decoding is error-free (`-v error -f null` over the audio at minimum).

| Class | Rule (all must hold) | Action |
| --- | --- | --- |
| 1: canonical | MP4 with `moov` before `mdat`; H.264 8-bit yuv420p, progressive, profile ≤ High, level ≤ 4.1; audio AAC-LC or MP3, ≤ 2 channels | none (verify the layout) |
| 2: remux | codecs as in class 1, but the container or layout is not (MKV, AVI, MP4 without fast-start) | `-map 0:v:0 -map 0:a:<chosen> -c copy -movflags +faststart` (the E3.1 command) |
| 3: audio only | video as in class 1; audio not AAC or MP3 (AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, PCM) or > 2 channels | copy video; **AAC-LC**, stereo downmix, 44.1 or 48 kHz, 128–160 kb/s; fast-start |
| 4: video incompatible | HEVC, VP9, AV1, 10-bit, interlaced, level > 4.1, MPEG-4 Part 2 and others | **stop**: needs a future explicit transcoding policy (cost and quality decision) |
| 5: review | several candidate audio tracks with no clear choice, decode errors, missing streams, duration mismatch, unknown codec | manual review |

**Identity check after every class 2 or 3 job:** the E3.1 method, where the copied stream's packet hash must equal the source's. A mismatch fails the job, so video is never silently re-encoded.

### 9. Canonical browser format

- **Format:** progressive fast-start MP4, H.264 (8-bit, ≤ High at 4.1), audio **as copied if MP3 or AAC-LC**.
- **Proven:** MP3-in-MP4 in Chrome 153 and Gecko 155 (E3.1).
- **When audio must be transformed anyway** (class 3), produce **AAC-LC**. It is the conservative choice for Safari, iOS and MSE, where MP3-in-MP4 fails `isTypeSupported` in Chrome and Gecko.
- **MP3 is not converted to AAC** for theoretical purity.
- **Safari/iOS gate.** One real-device test of an MP3-in-MP4 derivative before iOS is a launch target. If it fails, MP3 sources move from class 2 to class 3 (the video is still copied).

### 10. Original retention

- **Authoritative:** the operator's local masters. They are the regeneration source and are **not a backup** (a single disk today).
- **Archive:** Telegram keeps the original MKV, as C2 already does (idempotent, crash-recoverable, checkpointed). It is a free off-site copy used only for disaster recovery and for regenerating derivatives through the retained MTProto reader. Keeping it costs nothing new and removes the single-disk risk. It is **not** a delivery path and carries no uptime promise.
- **Delivery:** R2 holds **only** the browser derivative. There are no originals in R2, so storage isn't duplicated.
- **A future download feature** would serve the same MP4, with a separate `download` entitlement and operation. It doesn't justify keeping originals online.
- **A future codec migration** (for example, AAC or HEVC renditions) regenerates from masters or the archive.

### 11. Mobile implications

- **Android (Media3/ExoPlayer)** and **iOS (AVPlayer)** play progressive MP4 from an HTTPS URL with Range; no player library or HLS is needed.
- **Renewal:** native players need the same source swap (replace the item and seek), or a slightly longer lifetime for native clients.
- **iOS** MP3-in-MP4 is untested (the gate in section 9).
- **Casting:** Chromecast receivers fetch the URL themselves. A presigned URL needs no cookies, so casting works.
- **Offline later** means downloading the MP4. Protecting it offline needs DRM, which neither model provides.
- **Model A** is equivalent for mobile but adds the gateway to every mobile byte.

### 12. Player library

**None is required.** Progressive MP4 plays in the native `<video>` element (E3.1), and the E3 player's renewal and failure handling carries over unchanged. A library (hls.js, Shaka) would be justified only by a concrete need for adaptive bitrate or HLS/DASH, which is not demonstrated. Mobile data use may create that need later, and it would then also require AAC.

### 13. Observed third-party evidence (boundary)

A comparable VJ streaming service was observed in browser DevTools: a protected playback flow ending in a direct browser request for a `.mkv` object on an S3-compatible Wasabi endpoint, using an AWS SigV4-style presigned URL, answered `206 Partial Content` with `Accept-Ranges: bytes`.

That shows the pattern is used in this market. It says nothing about that service's backend, costs or terms compliance. Note that Wasabi's free egress is limited to egress ≤ stored volume. No token, key or URL from that service is recorded here, and this decision does not depend on it.

### 14. Evaluation

| Criterion | A: Telegram + gateway | B-prime: R2 playback + Telegram archive (chosen) | C: R2 only |
| --- | --- | --- | --- |
| Implementation left | normalize before upload; scale gateways | presign in the issuer, add a derivative upload step, add object-key storage | same as B-prime, minus the archive |
| Existing investment | fully used | issuer, player, entitlement and the normalization proof reused; gateway kept for archive restore | gateway code idle |
| Monthly cost at scale | lowest at ≤ 20 TB; grows with servers | flat, storage-driven (~$15 per 1,000 GB) | same |
| Bandwidth and concurrency | on Velora's gateway and Telegram's unknown limits | on Cloudflare's edge (Kampala PoP) | same |
| Browser compatibility | same once normalized | same | same |
| Revocation | immediate (per request) | ≤ 10 min, plus an object-delete lever | same |
| Operational burden | high: session custody, flood waits, stateful service | low: bucket, key, CORS | lowest |
| Terms and legal risk | Telegram as a delivery host is unaddressed by its terms | within Cloudflare's terms; Telegram as private archive only | same |
| Disaster recovery | originals in Telegram; masters local | masters + Telegram archive + reproducible derivatives | masters only |
| Vendor dependency | Telegram (non-standard API) | Cloudflare (S3 API, portable) | same |

**Why B-prime.** It removes the two things Velora can't control in Model A: Telegram's unspecified throughput and terms, and a single stateful gateway on every byte. It costs a known, small amount, gives up only per-request publication checks (bounded at 10 min, with an immediate object-delete lever), keeps the already-built Telegram pipeline as a free off-site archive, and changes neither the player nor the entitlement boundary.

### 15. Architecture

```text
INGESTION (operator machine)
  local master (authoritative)
    ├─► archive: Telegram Movies channel (existing C2 uploader; originals, DR only)
    └─► ffprobe classify ─► 1 none | 2 remux | 3 audio→AAC | 4/5 stop for review
            └─► derivative MP4 (identity-checked) ─► PUT private R2 bucket
                   key = mv/<uuid>.mp4, recorded privately against the movie version
PUBLICATION: unchanged owner flow; a version is ready only when its derivative exists

PLAYBACK
  browser ─POST /api/media/stream-token─► Next.js (session → entitlement → catalogue)
          ◄── { streamUrl: presigned R2 GET (10 min), expiresAt } ──
  browser ─GET + Range─► R2 via Cloudflare edge (Kampala PoP) ─► 206
  (renewal: the same POST, in-place source swap, as in E3)

RESTORE (rare): MTProto reader (E1.2 code) reads the Telegram original ─► regenerate the derivative
```

- **Telegram:** a private off-site **archive** of originals, no longer an origin.
- **R2:** the **playback origin** for one browser-canonical rendition per version.
- **Media Gateway:** leaves production playback. It isn't deployed; its reader is kept for archive restore and, if ever needed, as a Telegram-origin fallback. Tests stay green.
- **E1 and E2:** E2's entitlement, issuer contract, rate limit, strict schema and player are reused as they are. E1's HMAC token becomes the gateway-only (fallback) format. Migration 12's role and resolver remain; their retirement or reuse is decided with the fallback's fate.
- **Ingestion:** adds classify → derivative → identity check → R2 upload → a private object-key record. The Telegram upload stays but becomes archival.
- **Existing titles:** On The Hunt needs a derivative (class 2, E3.1 command) uploaded and linked. Its Telegram original remains as the archive. Fuze gets the same derivative path before any publication.
- **New uploads:** a movie becomes publishable only once its derivative is stored and verified.

### 16. Next checkpoint: E3.3 one-object R2 playback proof

**Superseded (E3.2A): not run.** E3.3 became the Telegram MP4 playback proof. The steps below are kept as the outline of a future R2 proof, should the migration path be taken.

Smallest proof; operator-authorized account and bucket; no catalogue change.

1. The operator creates one private R2 bucket (Standard, location hint `weur` or automatic) and a bucket-scoped key (object read and write) with CORS limited to the local development origin. The secret stays in `.env.local` only.
2. Regenerate On The Hunt's class 2 derivative locally (E3.1 command), verify identity, and upload it once under an opaque key.
3. A temporary, isolated presign path (SigV4 with `node:crypto`, no SDK dependency unless it proves necessary) issues 10-minute GET URLs from the existing E2 boundary. The catalogue is not changed.
4. Browser proof (Chrome, Gecko; WebKit reported separately): metadata, video, audio, seeks to 15:00, 30:00 and 81:40, range pattern, expiry refused, renewal swap, and first-byte latency from this network compared with the gateway.
5. Revocation levers: an expired URL refused, a deleted object refused.
6. Cost and requests observed; then delete the object, or keep it pending the ingestion checkpoint (operator's choice).

Telegram reads and writes 0; hosted catalogue writes 0.

### External state

Telegram reads 0, writes 0; hosted reads 0, writes 0; object storage: none created. Only this document and the roadmap changed.

### Sources (retrieved 2026-09-30)

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)
- [Cloudflare network](https://www.cloudflare.com/network/)
- [Cloudflare service-specific terms](https://www.cloudflare.com/service-specific-terms-application-services/)
- [WAF token authentication](https://developers.cloudflare.com/waf/custom-rules/use-cases/configure-token-authentication/)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- [B2 presigned URLs](https://help.backblaze.com/hc/en-us/articles/360047815993-Does-the-B2-S3-Compatible-API-support-Pre-Signed-URLs)
- [Wasabi pricing](https://wasabi.com/pricing)
- [Wasabi pricing FAQ](https://wasabi.com/pricing/faq)
- [Bunny CDN pricing](https://bunny.net/pricing/)
- [Bunny Storage pricing](https://bunny.net/pricing/storage/)
- [Bunny token authentication](https://bunny.net/docs/cdn-token-authentication)
- [Hetzner traffic](https://docs.hetzner.com/robot/general/traffic/)
- [Hetzner price adjustment 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner billing FAQ](https://docs.hetzner.com/cloud/billing/faq/)
- [Telegram API terms](https://core.telegram.org/api/terms)

## E3.2A — Architecture reconciliation (2026-09-30)

**Result: `E3.2A ARCHITECTURE RECONCILIATION: PASS`.** Starting HEAD `c3477f0`. Documentation only.

E3.2's Hybrid B-prime (R2 playback, Telegram as archive) is **superseded: deferred, not implemented**. There is exactly one active production playback architecture:

```text
local authoritative master
  ↓ inspect (ffprobe) and classify: 1 none | 2 remux | 3 audio only | 4/5 stop
browser-ready fast-start MP4 (identity-checked)
  ↓ existing C2 uploader (fingerprint, checkpoint, uncertain-outcome recovery)
Telegram Movies channel
  ↓ dedicated MTProto media reader (read-only, `other`-only rights)
Velora Media Gateway (publication re-checked per request, bounded ranges)
  ↓ HTTP Range / 206
native <video>

Browser → Next.js (session → E2 entitlement → catalogue eligibility)
        → short-lived stream capability (10 min, stream-only, version- and user-bound)
        → Media Gateway (token → limits → readiness → publication → Range) → Telegram
```

| Piece | Role now |
| --- | --- |
| Local masters | Authoritative; the regeneration source for every derivative. Not a backup. |
| Telegram | The **production playback origin**. It holds the browser-ready file used for playback. |
| Media Gateway | In the **normal production byte path**, not archive-restore only. |
| E2 | Unchanged authorization layer: entitlement, catalogue eligibility, 10-minute capability, renewal. |
| Cloudflare R2 | Researched and technically viable (E3.2 §§2–15). **Not selected, not implemented, not required before launch.** No account, bucket, SDK, environment variable, schema or code exists. |

### Why B-prime was deferred

The evidence shows a **packaging** defect, not a storage or delivery defect:

- **E3.** Telegram MTProto delivery and the gateway's bounded Range delivery worked end to end. Chrome played the original MKV with video, audio and seeks. Firefox failed only on MP3 audio inside Matroska.
- **E3.1.** MKV/H.264/MP3 → fast-start MP4/H.264/MP3 with `-c copy`. Video and audio were bit-for-bit identical, with no transcoding. The file grew by 0.30%, packaging took about 4–7 s, and Chrome and Firefox then had video, audio and seeking with bounded progressive ranges.

So the demonstrated defect is fixed by **normalizing media before upload**. It does not require replacing Telegram as the origin, so migrating storage now would add cost and a new vendor without fixing a demonstrated problem.

### Scaling position (no claim of unlimited scale)

The gateway stays in the byte path (Telegram → gateway → viewer). Known constraints, in the order E3.2 §4 gives them:

- Telegram throughput per reader session and per DC, which is untested beyond a few streams and undocumented;
- gateway network bandwidth and concurrency;
- MTProto behaviour at much larger scale;
- operational dependence on Telegram and its unaddressed API terms (E3.2 §2).

These are **scaling risks, not demonstrated production blockers**. The system is not redesigned for hypothetical 1,000-viewer concurrency. If real usage makes them material, E3.2's R2 research is the documented migration path.

### Abstraction boundary (what keeps that migration cheap)

`player → POST /api/media/stream-token (E2) → { streamUrl, expiresAt } → origin`. The player knows only an opaque, expiring URL. It has no Telegram, gateway-internal or storage-provider concept. A future origin change replaces what sits behind `streamUrl` (gateway → Telegram) without touching the player or entitlement model. No R2 concept enters the player.

### Normalization policy (active for ingestion)

Before a new movie is publishable, inspect it (E3.2 §8 fields) and classify it:

| Class | When | Action |
| --- | --- | --- |
| 1: canonical | Fast-start MP4 (`moov` before `mdat`), H.264 8-bit yuv420p progressive ≤ High@4.1, AAC-LC or MP3 ≤ 2 channels | none; verify the layout |
| 2: remux | codecs as class 1, container or layout not (MKV, AVI, MP4 without fast-start) | `ffmpeg -i <source> -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart -f mp4 <temporary>.mp4`. No re-encoding. |
| 3: audio only | video as class 1, audio not (AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, PCM, > 2 channels) | copy video, audio → AAC-LC. **Not implemented** until a target movie needs it. |
| 4: incompatible video | HEVC, VP9, AV1, 10-bit, interlaced, level > 4.1, MPEG-4 Part 2 … | **stop**; a separate transcoding checkpoint |
| 5: review | corrupt, ambiguous audio choice, missing streams, duration mismatch, unknown codec | **stop** for manual review |

**Safety (class 2).** Verify after every job:

- the source is unchanged (size, mtime, SHA-256);
- the codecs are unchanged;
- packet counts, order, sizes and per-packet MD5s are identical;
- the whole-stream payload hashes are identical;
- duration, resolution, frame rate, sample rate and channels are unchanged;
- `moov` comes before `mdat`;
- the output size is recorded.

A stream-copy failure **stops**; it never falls back to transcoding.

**Canonical playback target.**

- Progressive fast-start MP4, one video stream and one audio stream.
- Video: H.264.
- Audio: MP3 or AAC, where verified compatible.
- Proven: H.264 + MP3 in MP4 in Chrome and Firefox (E3.1).
- **Safari/iOS: NOT TESTED.** A **real Safari / iOS device playback test is a pre-launch gate**. If MP3-in-MP4 fails there, MP3 sources become class 3 (H.264 copied, MP3 → AAC).

**Telegram retention.**

- For new ingestion, Telegram holds the browser-ready file. Where normalization is needed it holds **only** the derivative; the local master stays the regeneration source.
- Existing Telegram originals (On The Hunt's MKV, Fuze's MKV) stay until a separately approved cleanup checkpoint.

**Players and formats.** Native `<video>`, no player library, no HLS or DASH, progressive MP4 + HTTP Range.

### External state

Documentation only: Telegram 0, hosted 0, no storage created.


## E3.3 — Telegram MP4 playback proof (2026-09-30)

**Result: `E3.3 TELEGRAM MP4 PLAYBACK PROOF: PASS`.** Starting HEAD `c3477f0` (after E3.2A).

On The Hunt (VJ Ice P) now plays from a browser-ready fast-start MP4 in the Telegram Movies channel, through the dedicated MTProto reader, the Media Gateway and the unchanged E2 capability. Chrome and Firefox both have video, audio and seeking. The original MKV message stays in the channel, unlinked.

### 1. Source and normalization (Class 2)

- **Tooling.** FFmpeg and ffprobe 9.0.2, the gyan.dev essentials build, as in E3.1. The SHA-256 matched the published checksum. It was unpacked in the session scratch directory only.
- **Source.** `On The Hunt.VJ ICE P.2026.mkv`, 1,004,462,878 bytes, SHA-256 `1d0dcd00256adc0c…`, mtime 2026-05-31. This is identical to E3.1, and it was unchanged after every step (size, mtime and full hash re-checked).
- **Classification.** Matroska, one H.264 High@4.0 stream (8-bit yuv420p, progressive, 1920×1080, 24 fps, AVCC) and one MP3 stream (stereo, 44.1 kHz, 128 kb/s). No subtitles or attachments, and a clean audio decode. That is **Class 2**.
- **Command.** `-map 0:v:0 -map 0:a:0 -c copy -movflags +faststart -f mp4`, with no encoding and no warnings. Output: 1,007,441,962 bytes (+0.30%, the E3.1 size). A second run took 3.7 s and was byte-identical (SHA-256 `c475dcfc…`).
- **Identity.** The new artifact was verified directly, not taken from the E3.1 report:
  - the H.264 payload, Annex B stream and 49-byte avcC are identical (`b9232513…`, `ed50271d…`);
  - all 124,997 video packets match in order, size and MD5, as do all 199,380 MP3 packets (`ba605f2a…`);
  - duration, resolution, frame rate, profile/level, sample rate and channels are unchanged;
  - the layout is `ftyp@0 moov@32 free mdat@5,335,549`, so it is fast-start.
- **Staging.** The derivative was placed in `G:\Movies\.velora-renditions\`. That is the only place the Bot API container can read, through its single read-only path map. It stayed out of Git and never replaced the master, and it was **deleted** after the proof.

### 2. Upload (one `sendDocument`) and recovery

- **Preconditions.**
  - An isolated journal scanned only the staging folder.
  - An exact-fingerprint dry run selected 1 of 1 and passed preflight to the configured Movies channel via the local Bot API. The source bytes re-fingerprinted exactly.
  - Movies bot identity and recovery access were OK. Series is not on the local Bot API.
  - Hosted: 12 migrations, checkpoint 26, no unresolved upload, new fingerprint `absent`.
  - The runtime gate was set only in that one command's environment.
- **Reviewer hold.** With a journal that knows the MKV, the planner classifies this file `same_title_same_vj` and holds it. That replacement decision was made explicitly by this checkpoint's authorization, and the isolated journal carried it out. The server still enforces one row per fingerprint.
- **Outcome.** `sendDocument` started at 19:24:44Z. The client got **`uncertain` / `network_error` at 505 s**, and nothing was retried.
- **Cause (found and proven).**
  - The pinned Bot API source sets `HttpServer.h: IDLE_TIMEOUT = 500` seconds on inbound HTTP connections, and no option overrides it.
  - The server dropped the idle client connection while it kept uploading to Telegram at about 0.45 MB/s; the file closed at 19:58:59Z.
  - The Docker loopback forwarder was ruled out. A local probe held headers for 720 s through the same `127.0.0.1` port forwarding, and it succeeded with and without TCP keepalive.
  - **Consequence for ingestion:** any upload whose Telegram leg takes longer than 500 s always ends `uncertain` on the client. On this uplink that is roughly every file over 225 MB. The recovery protocol settles it without a resend. A future checkpoint may raise the constant in the pinned build or accept recovery as the normal path.
- **Recovery (existing marker protocol).**
  - `resume --server` planned exactly one `reconcile`.
  - Execution posted marker **28** to the Movies channel. The interval (26, 28) contained only **message 27**, which was forwarded once to the recovery group; the copy's deletion was then requested.
  - The document, 1,007,441,962 bytes, matched the exact `velora-src` token.
  - `ingest_upload_record` then recorded it. Event 3 is `uploaded` with attempt count **1**, media 3 is `document`, `video/mp4`, and the checkpoint is **28**.
  - `sendDocument` calls: **1** in total.

### 3. Media mapping and cutover

- **Model.** The existing structures are reused, with no new schema. `movie_versions.telegram_media_id` (unique, FK to `private.telegram_media`) points at exactly one file. The MP4 has its own `telegram_media` row and its own uploader `ingestion_events` row. No migration was needed.
- **Evidence.** `evaluate --execute` recorded the MP4 event's parse and 20 candidates through the worker RPC. The server derived `matched`: a unique score-1 candidate, TMDB 1428857, and VJ Ice P resolved.
- **Proof before any database change.** The real gateway HTTP core and mtcute reader were pointed at a fixed locator for message 27, with the catalogue untouched.
  - The reader's identity check passed: unique file id, size and `video/mp4`.
  - These ranges were **byte-equal** to the local MP4, each 206 `video/mp4`: `0-65535`, `0-` (8 MiB), middle 1 MiB, unaligned `123456789-124505364`, tail 64 KiB, `-65536`, and an EOF clamp.
  - An unsatisfiable range got 416 `bytes */1007441962`.
  - Totals: 16 reads, 17 RPCs, 10.7 MB.
- **Cutover.** One owner transaction, run as `postgres` with `psql -X -v ON_ERROR_STOP=1` (script SHA-256 `4db19a92…`, Git-ignored):
  - It approves 1428857 for the MP4 event.
  - It locks the version and both events, then asserts all of the following:
    - version 1 is `on-the-hunt-2026` / `vj-ice-p`, ready and cleared, on the MKV media;
    - the old media is message 23 (MKV), and the new media is message 27, `document`, `video/mp4`, 1,007,441,962 bytes, in the same registered Movies channel;
    - the approved TMDB id and resolved VJ are the version's own;
    - the new media is not linked to any version.
  - It swaps `telegram_media_id` 1 → 3 (exactly one row) and marks event 3 `published`.
  - The same script was first run against hosted **ending in ROLLBACK** (all guards passed, nothing kept), then committed at 20:03:08Z.
  - The swap is a single row update, so there was never a published state pointing at missing media.
- **Rollback (prepared, not used).** A guarded owner script swaps 3 → 1 and returns event 3 to `matched`, with the same assertions. The MKV message is intact:
  - the reader still resolves message 23 to its recorded identity;
  - its head, middle and tail 64 KiB are byte-equal to the local master.
- **Old event.** The MKV event 1 stays `published` as history. A publication replay for it now fails closed with `catalogue_publication_inconsistent`, which is correct for a superseded rendition.
- **Gateway defect fixed.** The reader cached resolved documents per movie version only. After a media cutover, a warm gateway would have served the **old file's bytes** under the new locator (new size and type) for up to 10 minutes. The cache is now valid only for the exact locator identity: version, channel, message, unique file id, size and type. In-flight resolutions are shared per identity. The fix is `locatorIdentity` in `lib/media-gateway/ports.ts`, with a unit test; 7 of 7 mutants were killed. In this proof the gateway started after the cutover, so the defect never showed.

### 4. Browser proof (real `/movies/on-the-hunt-2026` player)

**Setup.**
- The gateway ran from image `velora-media-gateway:e3.3` (HEAD plus the fix), read-only, with 256 MiB and 1 CPU, on the existing mtcute session (no new login) and the restricted database role.
- `next dev` ran on `127.0.0.1:3000` with the dev filesystem cache off.
- One per-run token secret was generated in memory and given only to those two processes and the harness's negative-test signer.
- One throwaway hosted auth user per run signed in through `/sign-in` and was deleted afterwards (lookup 404).
- Browsers were Google Chrome 154.0.8037.59 and Playwright Firefox 155.0 (Gecko, the E3/E3.1 build), driven by scratch Playwright 1.63.

| | Chrome 154 | Firefox 155 (Gecko) |
| --- | --- | --- |
| Media requests before Play | 0 (0 issuer, 0 gateway) | 0 |
| On Play | 1 issuer call → 200; `{ streamUrl, expiresAt }` on the gateway origin | same |
| Metadata | `bytes=0-` only; 1920×1080, 5208.29 s | `bytes=0-` only; same |
| Video | 211 frames in 8.8 s, 0 dropped | 217 frames in 9.0 s, 0 dropped |
| Audio | decoded audio bytes 15,047 → 156,317 → 465,608 across the run | `mozHasAudio` **true** (the MKV was false). A separate CORS probe element with a fresh capability had a Web Audio peak RMS of **0.323** (E3.1: 0.33). The player's own element is no-cors, so the analyser only works on the probe. |
| Pause | 20 s: 0 requests, 0 reads | 60 s: 0 requests started, 0 reads (the in-flight window was closed by the browser at `pause()`) |
| Seek 15:00 / 30:00 / 81:40 | resumed; `bytes=178683904-` / `334200832-` / `961609728-` (then two more ranges) | resumed; `bytes=178683904-` / `334200832-` / `961609728-` |
| Renewal (page clock +8m40s) | exactly 1 issuer call (200), new token, position 4903.0 → 4904.8 s, playing; 0 further calls in 45 s | exactly 1 (200), new token, 4901.8 → 4903.3 s, playing; 0 further in 45 s |
| Close player | 0 video elements, 0 requests afterwards, 0 gateway requests afterwards | same |
| Navigate to `/movies` mid-play | 0 requests afterwards, 0 gateway requests afterwards | same |
| **Verdict** | **PASS** | **PASS** |

**Range evidence (sanitized).**
- Every gateway response was `206`, `Content-Type: video/mp4`, with `Content-Length` ≤ **8,388,608**, the gateway's unchanged `maxResponseBytes`.
- Examples:
  - `bytes=0-` → `bytes 0-8388607/1007441962`, length 8,388,608;
  - `bytes=178683904-` → `bytes 178683904-187072511/1007441962`;
  - `bytes=961609728-` → `bytes 961609728-969998335/1007441962`.
- Every request carried a Range header and a token. Full-file requests: **0**.
- Aborted requests are the browser cancelling open-ended windows it no longer needs; the gateway logged them `client_closed`.

**Fast start.**
- Metadata came from the head of the file (`bytes=0-`, 8–16 MiB) with **no tail fetch**. The MKV in E3 needed `bytes=1004404736-` for its cues.
- Each seek needed one open-ended range at the target. This matches E3.1's local-server pattern exactly, now served from Telegram.

**Signed out (both engines).**
- Page load: 0 issuer and 0 gateway requests.
- Play: 1 issuer call → 401, the sign-in message and link, 0 video elements, 0 gateway requests, and 0 gateway log entries.

### 5. Negative security

| Case | Result |
| --- | --- |
| App capability, control | 206; lifetime 600 s; response keys `expiresAt`, `streamUrl` only |
| Missing / malformed / tampered signature / tampered claims | 401 |
| Expired | 401 `authorization_expired` |
| Token for another version | 403 (`wrong_version`) |
| Stream token on `/download` | 403 (`wrong_operation`) |
| Download-operation token | 501 (reserved, not implemented) |
| Unavailable version 2 (no published version; Fuze has none) | 404 |
| Extra query parameter (`message_id`) | 400 |
| Issuer: version 2 / unknown / extra body field | 404 / 404 / 400 |

- **Gateway.** 10 denials logged, with 0 Telegram reads or RPCs on any denial. On The Hunt's publication state was not changed to test anything.
- **Privacy.** The checked values were the per-run secret, the channel id (both forms), both media `file_unique_id` and `file_id` values, the API hashes, the service-role key, both database URLs, all bot tokens and the reader session.
  - **Browser responses:** 47 in Chrome and 29–30 in Firefox, all HTML, RSC, JS and JSON, with **0** of those values. The field-name scan matched only `messageId`, which is `@supabase/auth-js`'s OTP reply field (an SMS message id) in the client bundle, not Telegram data.
  - **Logs and disk:** the `next dev` and gateway logs held **0** issued tokens, **0** secrets and **0** of those values, and **0** of 1,592 `.next` files held the per-run secret.

### 6. Resources

| | This proof | E1.2 / E3 bounds |
| --- | --- | --- |
| Gateway memory (256 MiB cap) | peak **74.3 MiB** (combined Chrome + Firefox run) | 76.5 MiB (E1.2), 80.2 MiB (E3) |
| Largest response | 8,388,608 B | 8 MiB `maxResponseBytes` (unchanged) |
| Combined run | 34 gateway requests (10 denials), 128.1 MB served, 155 `upload.getFile` reads, 133 RPCs | E3: 31 requests, 154.2 MB, 177 reads |
| Firefox-only rerun (60 s pause, audio probe) | 26 requests, 98.2 MB, 113 reads | |

No limit was changed and no regression was found.

### 7. External state

| | Count |
| --- | --- |
| **Telegram Movies writes** | `sendDocument` **1** (message 27, the MP4); recovery marker `sendMessage` **1** (message 28) |
| **Recovery group writes** | `forwardMessage` 1; `deleteMessage` 1 (best effort, the forwarded copy) |
| **Telegram Movies reads** | the recovery probe; about 0.26 GB of bounded gateway reads across the pre-cutover proof, five harness runs and the MKV check. One Firefox run's gateway log was overwritten; that run's reads are estimated at ≤ 25 MB. |
| **Telegram Series** | reads 0, writes 0 |
| **Hosted database** | migrations **0** (still 12). Worker: `ingest_upload_start` 1, `ingest_upload_record` 1, checkpoint advance 26 → 28 (recovery), `ingest_record_evaluation` 1 (20 candidates). Owner: 1 committed cutover transaction (approval, version 1 media 1 → 3, event 3 published) and 1 rehearsal rolled back. Catalogue: 0 other writes. |
| **Hosted auth** | 5 throwaway users, each created and deleted, one per harness run (three of the five stopped early on harness bugs and were rerun). All confirmed deleted; auth users 1, profiles 1. |
| **Media** | derivative created and **deleted**; master unchanged; old Telegram MKV (message 23) **retained**, intact, unlinked; new Telegram MP4 (message 27) **retained**, **active for playback**. |
| **Unchanged** | Fuze: event 2 `received`, media 2 (message 25), no version. Series: 0 rows. |

The Bot API container, which had been stopped before this checkpoint, was started for the upload and stopped again.

### 8. Tests and gates

- **Unit:** 634 passing (9 new, for `locatorIdentity`).
- **Database:** pgTAP 482, with no schema errors from `db lint --local`.
- **Catalogue and gateway integration:** 56.
- **Static checks:** lint 0 errors (the pre-existing warning in an ignored spike script), and both the application and gateway typechecks pass.
- **Build:** the production build passes, run with a random stand-in secret.
- **Secret scan:** 22 `.env.local` secret values and the reader session were checked against tracked files, the diff, `.next/static` (27 files), `.next/server` (377) and the evidence logs. There were 0 secret hits; the only matches were public bot usernames and a file path already in the docs.

### 9. Open items

- **Pre-launch gate: a real Safari / iOS device plays MP3-in-MP4.** If it fails, MP3 sources become Class 3 (MP3 → AAC, video copied).
- **Bot API 500 s idle timeout.** Decide whether to raise `IDLE_TIMEOUT` in the pinned build or keep recovery as the normal path for long uploads.
- **Old MKV (message 23) and Fuze's MKV.** Retention or cleanup needs a separately approved checkpoint.
- **Replacement command.** The replacement was a guarded one-off owner script. If more legacy titles need it, a reusable owner command (a migration) should replace the script.

## E3.4 — Gateway recovery and player error classification (2026-10-01)

**Result: `E3.4 GATEWAY RECOVERY + PLAYER ERROR CLASSIFICATION: PASS`.** Starting HEAD `6520d2a` (E3.3 PASS). E3.3 was not repeated: no remux, no upload and no media cutover.

### 1. Original failure

The player showed "This movie can't be played in this browser." for On The Hunt. Reproduced on the operator's `next dev` (`http://localhost:3000`) with Docker Desktop stopped, one throwaway hosted user, Chrome 154 and Playwright Firefox 155 (Gecko):

- the issuer answered 200 with `{ expiresAt, streamUrl }` on `http://127.0.0.1:8787` and a 600 s lifetime;
- the media element requested `bytes=0-` and got `ERR_CONNECTION_REFUSED` (Chrome) or `NS_ERROR_CONNECTION_REFUSED` (Gecko);
- `MediaError` code 4, `readyState` 0, `networkState` 3, then the "can't be played in this browser" message.

**Diagnosis: B, an unreachable gateway.** The media was never at fault. `failureFromMediaError` mapped code 4 to `unsupported`.

### 2. What the browser can tell (measured)

A bare `<video>` against a local HTTP server in both engines:

| Failure | `MediaError` (Chrome and Gecko) | CORS `Range: bytes=0-1` fetch | `no-cors` `/healthz` |
| --- | --- | --- | --- |
| Connection refused | 4 | rejects | **rejects** |
| 401, 403, 404, 429, 503 | 4 | status readable only if the gateway allows the origin | resolves (opaque) |
| 206 undecodable bytes | 4 | 206 readable only if allowed | resolves |

Code 4 is identical for every class, so it never proves incompatibility on its own. Chrome's `MediaError.message` differs ("Format error" for HTTP errors, empty for demux failures), but it is engine-specific diagnostic text and is not used.

### 3. Error model (`lib/playback/player.ts`)

- `classifyMediaError(code, metadataLoaded)`. Code 1 is ignored. **Before metadata** from the current source, any error is diagnosed. After metadata, 2 is `network` (the existing renew-once path) and anything else is `playback_error`.
- `diagnoseMediaFailure(streamUrl)`: at most two requests, straight to the gateway (never through Next.js), each with a 5 s timeout, no credentials and no referrer.
  1. The stream URL for `bytes=0-1`. A readable status decides: 206/200 → `unsupported`, 401 → `capability_rejected`, 404 → `unavailable`, 429/5xx → `temporarily_unavailable`, anything else → `playback_error`.
  2. If that is unreadable (unreachable, timed out, or the origin is not allowed), `GET /healthz` in `no-cors` mode. A failure means the gateway is unreachable (`temporarily_unavailable`); success means it is up and the reason is unknown (`playback_error`, a neutral message).
- **`unsupported` now requires the gateway to be serving the file's bytes.**
- `capability_rejected` uses the existing single renewal. If that chance is spent, it shows `temporarily_unavailable`.
- The diagnosis is aborted when the player closes. The `/healthz` probe carries no capability and causes no catalogue or Telegram work. Probe 1 causes at most one small read, and only after a failure.

| Failure | Message |
| --- | --- |
| Signed out (issuer 401) | Sign in to watch this movie. (unchanged) |
| Gateway unreachable, 5xx, 429, rejected capability after renewal | Playback is temporarily unavailable. Try again in a moment. |
| Gateway 404 | This movie isn't available to watch right now. |
| Gateway serves bytes the browser cannot play | This movie can't be played in this browser. |
| Undetermined (gateway up, status unreadable), or an error after metadata | Playback failed. Try again. (was "Playback stopped because of an error. Try again.") |

**Retry.** There is no new automatic retry. Each Play allows at most one renewal, under the existing 30 s minimum interval, and at most two diagnostic requests per failure. After an error the capability is dropped and Play reappears, which is the user's retry.

**Precision depends on configuration.** The status is readable only when the gateway lists the site's origin in `MEDIA_GATEWAY_ALLOWED_ORIGINS` (the existing CORS allow-list). Production must set it to the site's origin; otherwise service errors other than "unreachable" show the neutral message, never "unsupported".

### 4. Development startup

- **`npm run gateway:dev`** (`scripts/media-gateway-dev.mjs`) runs the existing gateway image with the E3.3 hardening: read-only root filesystem, 256 MiB, 1 CPU, `127.0.0.1` only, the existing session directory mounted. It then waits for `/readyz`.
  - It reads `.env.local`, the file Next.js reads, so both hold the same token secret by construction.
  - Only the gateway's own variables are passed, **by name**. The reader bot token and `MEDIA_GATEWAY_ALLOW_BOT_LOGIN` are never passed, so it cannot log in. It refuses to run without an existing session file.
  - It never starts Docker Desktop; without Docker it says so and exits.
  - It defaults `MEDIA_GATEWAY_ALLOWED_ORIGINS` to the two loopback app origins.
  - `--stop` sends SIGTERM (graceful drain and session persistence) before removing; `--build` rebuilds the image.
- **`instrumentation.ts`** (development and Node runtime only) checks `/healthz` in the background once at startup and warns with the origin and the command. It never blocks startup and never prints a secret. The logic is in `lib/playback/gateway-dev-check.ts`.
- The README has a "Playback (local)" section.

**Harness finding.** On `http://127.0.0.1:3000`, Next.js development refuses its HMR connection and the page never hydrates, so Play does nothing. `localhost` works. The README records this.
### 5. Recovery from a stopped machine

- **Stopped state.** Docker Desktop was not running and `next dev` (the operator's own, on `localhost:3000`) was. Starting Docker Desktop did not start the local Bot API container: it stayed `Exited`, so the ingestion bot was not touched.
- **Image.** `velora-media-gateway:e3.3` matched HEAD for all 15 gateway source files (line endings normalized). `npm run gateway:dev` then built `velora-media-gateway:dev` from this checkout and became ready in one run. A later stop and restart from the stopped state was ready in 19 s.
- **Readiness.**
  - Container: read-only root filesystem, `node` user, 256 MiB, `127.0.0.1:8787` only.
  - Startup log: `catalogue_state reachable` (which requires the restricted identity), MTProto `connected`, `reader_ready`.
  - Container environment: gateway names only. There was no owner `DATABASE_URL`, service-role key, bot token or login flag.
- **Restricted identity, checked independently as the role (hosted, read-only).**
  - `current_user` and `session_user` are `velora_media_gateway`: no inherit, no elevated attribute, no `postgres` or `service_role` membership, transaction read-only.
  - `resolve_movie_version(1)` returns five columns: message **27**, 1,007,441,962 bytes, `video/mp4`, registered Movies channel. **This is the E3.3 MP4.**
  - Versions 2 (Fuze) and 999999 return nothing.
  - Reading `private.telegram_media` and `public.movie_versions` is refused with 42501.
- **Shared secret.** Both processes read `.env.local`, and nothing was generated or rotated. Correspondence is proven by the gateway answering 206 to app-issued capabilities. The value was never printed.

### 6. Browser proofs (real player, real gateway, Telegram message 27)

| | Chrome 154 | Firefox 155 (Gecko) |
| --- | --- | --- |
| Before Play | 0 issuer, 0 gateway requests | same |
| Issuer | 200, `{ expiresAt, streamUrl }` on the gateway origin | 200 (plus 1 for the audio probe) |
| Metadata | `bytes=0-` only; 1920×1080, 5208.29 s; 7.5 s | same; 5.5 s |
| Playback (6 s) | +6.01 s, 144 frames, 0 dropped | +6.01 s, 144 frames, 0 dropped |
| Audio | decoded bytes 13,793 → 109,923 → 206,889 | `mozHasAudio` true; CORS probe peak RMS 0.242 |
| Seek 30:00 | `bytes=334200832-`, resumed at 1801.6 s | same range, resumed at 1801.5 s |
| Responses | 3 × 206 `video/mp4`, max 8,388,608 B, 0 full-file | 6 × 206, same bounds |
| Close | 0 video elements, 0 requests afterwards | same |

The same proof also passed before the code change. One earlier post-fix attempt failed on the host's link, which dropped to 1.8–154 KB/s: 8 MiB windows exceeded the gateway's 30 s request timeout (504 `upstream_timeout`), and the player correctly showed the neutral message. That is the Telegram/uplink throughput risk recorded in E3.2A, appearing as a real outage, not a defect. It was re-run once the link recovered.

**Failure scenarios.** The real issuer was used, with the browser's view of the gateway replaced through Playwright routes. Both engines gave the same results before and after the fix:

| Scenario | Before | After |
| --- | --- | --- |
| Gateway unreachable | can't be played in this browser | temporarily unavailable |
| 503 | can't be played | temporarily unavailable |
| 404 | can't be played | isn't available to watch right now |
| 401 | can't be played | exactly 1 renewal (2 issuer calls), then temporarily unavailable |
| 206 undecodable bytes | can't be played | can't be played in this browser (correct) |

- **Real gateway stopped** (`npm run gateway:dev -- --stop`), fixed player: both engines show "Playback is temporarily unavailable. Try again in a moment.", with 1 issuer call and 3 refused attempts (media element, two-byte probe, `/healthz`).
- **Neutral path.** It cannot be simulated with Playwright, whose `route.fulfill` adds CORS headers by itself. It is covered by unit tests and by the measured probe behaviour in section 2.

### 7. External state

| | Count |
| --- | --- |
| **Telegram Movies writes** | **0** |
| **Telegram Movies reads** | gateway reads of message 27 only, all bounded 8 MiB windows: 30 media requests, about 134 MB served, 164 `upload.getFile` reads, 138 RPCs |
| **Telegram Series** | reads 0, writes 0 |
| **Local Bot API** | not started |
| **Hosted database writes** | **0** (no migration, no catalogue or ingestion write) |
| **Hosted database reads** | the gateway's resolver as `velora_media_gateway`, and two read-only identity/resolver checks as that role |
| **Hosted auth** | 11 throwaway users, one per harness run, each created and deleted (lookup 404). Persistent writes 0. Needed because the issuer requires a signed-in session. |
| **Media and mapping** | unchanged: version 1 → MP4 (message 27); the MKV (message 23) is retained and unlinked; Fuze unchanged |

### 8. Tests and gates

- **Unit:** 660 passing. This includes the new `classifyMediaError`, `diagnoseMediaFailure` and `gateway-dev-check` tests, a successful-playback state path, and a check that only `unsupported` mentions the browser.
- **Static checks:** application typecheck, gateway `tsc` and lint all pass on every tracked and new file. Lint errors remain only in Git-ignored `.velora-ingest/` scratch scripts.
- **Build:** the production build passes with a random stand-in secret.
- **Secret scan.** It checked 25 values (every `.env.local` secret, database passwords, channel ids in both forms, the canary, the reader session and the MP4's `file_unique_id`) against:
  - `.next/static` (27 files) and `.next/server` (387);
  - the diff and new files, and the docs;
  - the harness logs;
  - the gateway container log.

  Result: **0 hits**. No issued token appears in the gateway log.
- **Turbopack cache.** The operator's `next dev` ran without `VELORA_DISABLE_DEV_FS_CACHE`, so its dev cache holds `.env.local` values, as recorded since E2. E3.4 put no new secret on disk.

Unchanged by design: E2 policy, the token format and 10-minute lifetime, the gateway, resolver and role, the range planner and limits, the media mapping and the publication state.

### 9. Open items

- **Production gateway origin allow-list.** Set `MEDIA_GATEWAY_ALLOWED_ORIGINS` to the site's origin on the deployed gateway, so the player can read failure statuses.
- **Throughput.** A slow operator uplink makes 8 MiB windows exceed the 30 s request timeout (504). Production hosting of the gateway must not depend on a residential link. A smaller window under poor throughput is a possible later tuning.
- **Unchanged pre-launch gate.** Safari and iOS real-device playback.

## E3.5 — Production media normalization and automated movie ingestion (2026-10-01)

**Result: `E3.5 PRODUCTION MEDIA NORMALIZATION + AUTOMATED MOVIE INGESTION: PASS`.** Starting HEAD `c4d6a02` (E3.4).

E3.1 and E3.3 proved one movie by hand. E3.5 makes that procedure the ingestion path for every movie, inside the existing C2 uploader rather than beside it.

- **Playback.** Unchanged, and generic for every published version. No player, gateway, E2, resolver or catalogue code changed, and nothing in the browser path is title-specific.
- **Telegram writes:** 0.
- **Hosted database writes:** 0.

### 1. Flow

```text
discover (scan) → inspect (ffprobe + MP4 box headers) → classify
  → canonical: plan upload              → [authorize] upload → recover → record
  → remux: plan normalize → normalize (stream copy) → verify
      → rendition journaled as its own entry → [authorize] upload → recover → record
  → audio_normalization / video_transcode_required / manual_review: hold, with reasons
record → evaluate → review → rights clearance → owner publication (unchanged, separate)
```

| Step | Automated | Operator |
| --- | --- | --- |
| Inspect, classify, plan | `scan`, every file, read-only | reads the plan (`scan`, `show`) |
| Class 2 repackage and verification | `normalize --execute`; local files only | chooses which source |
| Upload | the existing `uploadEntry`, exactly once | `upload --fingerprint … --execute` with `REAL_TELEGRAM_UPLOADS_AUTHORIZED=true` for that one command |
| Uncertain outcome | the existing marker recovery (`resume`) | runs `resume --execute` |
| Evaluation, review, publication | unchanged (C2B.2H) | `evaluate`, owner `publication-sql` with the rights attestation |
| Derivative cleanup | `cleanup --execute`, only when safe | chooses when |

### 2. Inspection (`lib/uploader/media-tools.ts`, `lib/ingestion/media.ts`)

- **ffprobe.** `ffprobe -show_format -show_streams -print_format json` reads headers only.
- **What is kept.** Only what the policy and its verification need:
  - container: format and major brand, duration, size on disk and size probed;
  - every stream: type, codec and tag, profile, level, dimensions, pixel format, field order, frame rate, time base, start and duration, sample rate, channels and layout, bitrate, attached-picture flag.
- **MP4 layout.** Read from the top-level box headers, one 16-byte read per box, so a 2 GB file costs a few kilobytes. It records box order, fast start (exactly one `moov`, before the first `mdat`), fragmentation (`moof`) and completeness.
- **Classification never uses the file name or extension.** The inspection does not even contain the name. An `.mp4` that is not ISO-BMFF is not an MP4.
- **Stored on every journal entry** (`JournalEntry.media`), with the tool versions. On a rescan of unchanged bytes the stored inspection is re-classified, not re-probed, so a policy change (`MEDIA_POLICY_VERSION`) costs no I/O.

### 3. Policy (`classifyMedia`, version 1)

Classification is deterministic, and every class has machine-readable reasons:

| Class | Meaning | Action |
| --- | --- | --- |
| `canonical` | ISO MP4 (isom/mp4x/avc1/M4V brand), fast-start, complete, unfragmented; exactly one H.264 (`avc1`) video and one audio stream; nothing else | Uploaded as it is, never remuxed for consistency |
| `remux` | The same acceptable streams in Matroska, AVI, QuickTime, or a non-fast-start, fragmented or `avc3` MP4 | `normalize` (stream copy) |
| `audio_normalization` | Video acceptable, audio not: not MP3 or AAC-LC, more than 2 channels, or a rate outside 16–48 kHz | **Stops.** AAC conversion is not automated (see 6) |
| `video_transcode_required` | Not H.264, or H.264 outside Constrained Baseline/Main/High, 8-bit 4:2:0, level 5.1, 4096×2304, progressive | **Stops.** No video transcoding exists or was invented |
| `manual_review` | No or several video or audio streams; subtitle, data, attachment or other streams; cover art; unknown or inconsistent duration; unknown frame rate or dimensions; probed size ≠ file size; a probe failure | **Stops.** Known video and audio findings are listed too |

- **MP3 stays approved.** H.264 + MP3 in fast-start MP4 is proven in Chrome and Firefox (E3.1, E3.3).
- **Safari/iOS real-device verification remains a pre-launch gate.** If it fails, MP3 moves to `audio_normalization` by editing `APPROVED_AUDIO`. Nothing is re-encoded in advance.
- **Gates enforcing the policy.**
  - The planner (`planSource`) plans an upload only for canonical bytes. Without a media record it holds (`media_not_inspected`); Class 2 plans `normalize`; the other classes hold with `media_<class>` plus their reasons. Journal facts still win: an uploading entry is still reconciled, and an uploaded one is skipped.
  - `uploadEntry` checks again, after authorization and plan and before any server read or Telegram call: `mediaAllowsUpload` requires canonical under the current policy, and for a rendition a passed stream-copy verification. Otherwise it returns `media_not_verified`.
  - Journal entries written before E3.5 read as not inspected, so they fail closed until rescanned.

### 4. Class 2 (`normalizeEntry`, `lib/uploader/normalize.ts`)

**Order of steps.** Each one fails closed:

1. The source is `remux`, under the current policy, with no upload history. A source that was itself uploaded is a replacement decision (E3.3), not routine normalization.
2. An earlier rendition is reused if it is intact on disk or has any upload history. One with upload history is never redone, even if its file is gone.
3. The source bytes are re-fingerprinted (the same `sf1` as upload).
4. Free space is checked: source size + 2% + 256 MiB, via `statfs`.
5. FFmpeg runs `-n -i <source> -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart -f mp4 <stem>.mp4.partial`. These are the E3.1/E3.3 arguments, an argument array with no shell, and no codec, filter or bitrate option exists in the builder.
6. The output is probed and must classify `canonical`.
7. The packet digests of both files must match (section 5).
8. The source must be unchanged: the same `sf1`, size and mtime.
9. The partial file is renamed to `<stem>.mp4`, fingerprinted, and journaled as its own entry.
10. The source is linked to it.

**Every failure** deletes the partial file, records `normalizationFailure` on the source, and journals no rendition.

**Rendition entry.** It has its own fingerprint, upload track and caption token, and `media.role = rendition` with `derivedFrom` holding the source fingerprint and the full verification. So `upload`, the uncertain-outcome rule, marker recovery, `resume --server` after a lost journal, and the server's one-row-per-fingerprint rule all apply to it **unchanged**. E3.3 did exactly this by hand.

**Location.**
- One directory per source, named after its fingerprint: `VELORA_RENDITIONS_DIR`, default `<Bot API path-map root>/.velora-renditions/sf1-<16 hex>/`. Only there can the local Bot API read it.
- It is refused inside the repository. Library scans skip hidden directories, so renditions never look like new library files.
- The file name is the source's own base name with `.mp4`, so title, year and VJ survive for `evaluate`. Names that could leave the directory (`..`, separators) are refused.

**FFmpeg 9 finding.** `-n` refuses to overwrite an existing output but exits **0**. `remux()` therefore refuses an existing output itself and requires a non-empty output afterwards.

**Cleanup** (`cleanupRendition`, `ingest cleanup`) deletes a rendition file only in one of two cases:
- it was uploaded and the server acknowledged it (playback uses the Telegram copy);
- it never had an upload attempt, so it can be regenerated.

An uncertain, uploading or failed-with-attempts rendition is never deleted, because recovery may need it. A removed never-uploaded rendition is re-planned `hold` (`rendition_removed`).

### 5. Stream-copy identity

FFmpeg lists every packet of both selected streams by stream copy (`-f framemd5 -c copy`, no decoding). `createPacketDigest` folds each stream into:
- the packet count;
- the payload bytes;
- a SHA-256 over the stream's codec configuration (`#extradata`: avcC/SPS/PPS) and every packet's (size, payload MD5), in order.

Timestamps are excluded, because each container has its own time base. Packet side data (`S=…`, for example MP3 skip samples) is excluded too, because a container may express it differently while the payload is untouched. Memory is constant.

`verifyRemux` passes only if all of the following hold:
- the output is canonical;
- video codec, profile, level, dimensions, pixel format and frame rate are unchanged;
- audio codec, profile, sample rate, channels and layout are unchanged;
- duration is within 0.5 s;
- both digests are equal.

A real re-encode (H.264 at another CRF, audio copied) fails it with `video_packets_changed` while the audio still matches.

### 6. Class 3 and 4

- **Class 3.** Classified and stopped. Automatic MP3/other → AAC conversion is **not** enabled: there is no policy evidence yet (Safari untested), and the brief forbids silent transcoding.
- **Class 4.** Stopped with `video_transcode_required`. No transcoding farm was built or implied.

### 7. Tools, paths, safety

- **Discovery.**
  - First, `VELORA_FFPROBE_PATH` / `VELORA_FFMPEG_PATH`: absolute, an existing file, and named `ffprobe`/`ffmpeg`.
  - Otherwise the first match on `PATH`.
  - Each must report `-version`, and the version is stored with every result. Nothing is downloaded.
  - The verified gyan 9.0.2 essentials build (E3.1) is kept outside Git at `~/.velora-ingest/tools/ffmpeg-9.0.2-essentials/bin`.
- **Processes.** Every tool is a direct `spawn` (`shell: false`) with an argument array. Probe output is capped at 4 MiB; packet listings are read line by line. No movie is read into Node memory.
- **Hostile file names.** Tested end to end with real FFmpeg: `Tom Clancy's [Jack_Ryan] (Ghost war) — Ünïcode & spaces.VJ ICE P.2026.mkv`. A name containing shell syntax (quotes, `&`, `;`, command substitution, a fake `-c:v libx264` option) stays exactly one argument.

### 8. CLI (`npm run ingest -- …`)

- `scan` adds the media class to every line. Without tools it says so, and plans no upload.
- `inspect` adds `media` (class, reasons, streams, inspection, tools) to its JSON.
- `normalize --fingerprint <source>` prints, before anything is written: source, fingerprint, class and reasons, video, audio, tools, action, the rendition path, whether the local Bot API can read it, free and needed disk space, the writes it would make (rendition and local journal only, no Telegram or database), and the publication impact (none). The dry run creates nothing, not even the directory. `--execute` does the work and prints the verification summary and the next command.
- `show --fingerprint <any>` is a readable item state: media class, normalization or derivation, plan, upload permission, Telegram, review and publication.
- `cleanup --fingerprint <rendition>` is dry run by default.
- `status` tallies media classes. The `upload --fingerprint` dry run shows the media line and refuses `media_not_verified`.

### 9. Real proof (local only; Telegram writes 0)

**Library scan.** `G:\Movies` was scanned into an isolated scratch journal: reads only, and the library was unchanged (names, sizes, mtimes).

| Class | Files | Reasons |
| --- | --- | --- |
| `remux` | 100 Yards, Beast, Fuze, On The Hunt, The Killer, TIMUR | `container_matroska` |
| `remux` | The Protector | `mp4_not_fast_start` (`ftyp>free>mdat>moov`) |
| `video_transcode_required` | Jack Ryan | `video_codec_hevc` (Main 10, 10-bit) |
| `manual_review` | Blades of the Guardians, Call of Heroes, Desert Warrior, Sakra, The Furious, Wild Cat | `attached_picture` (an MJPEG cover image as a second video stream); Desert Warrior is also HEVC 10-bit; Blades, Sakra and The Furious also exceed the 2000 MiB ceiling (`file_too_large`) |
| `canonical` | none | none |

The cover-art result is a real safety catch: with a picture as a video stream, `-map 0:v:0` could select the picture.

**On The Hunt, end to end** (the only title with a known reference, message 27):
- **Dry run:** the full report, nothing created.
- **`--execute`:** 17.0 s. The output was 1,007,441,962 bytes; 124,997 video and 199,380 audio packets were identical; it was fast-start.
- **The output is byte-identical to message 27.** SHA-256 `c475dcfcde063ee8…` and `sf1-fbc665a8…5905bb`, both equal to E3.3's artifact. The automated path reproduces the production file exactly.
- **Source:** SHA-256 `1d0dcd00256adc0c…`, size and mtime unchanged.
- **Idempotency.**
  - A second `normalize` returned `already_normalized (rendition_intact)` and ran no FFmpeg.
  - A rescan showed `media_rendition_recorded` and skipped `.velora-renditions`.
  - The `upload` dry run selected the verified rendition with E3.3's exact caption token.
- **Exactly once against the real server** (read-only `ingest_upload_status`). The rendition's fingerprint is already **message 27** (`video/mp4`) → `adopt_server`, so an executed upload adopts and never sends. The On The Hunt MKV (message 23) and Fuze (message 25) are recognized too: a lost journal never re-uploads them.
- **Cleanup:** the dry run, then `--execute` (`never_uploaded` in the isolated journal). The derivative was deleted, along with its directory and the empty `.velora-renditions` root. `G:\Movies` holds exactly its 14 files.

### 10. Regression

- **On The Hunt playback** (the E3.4 harness, `localhost:3000`, the `velora-media-gateway:dev` container):
  - Chrome 154 decoded audio bytes 14,211 → 109,923 → 207,725, with a seek to 30:00 that resumed at 1801.7 s.
  - Firefox 155 had `mozHasAudio` true and audio-probe RMS 0.34, with a seek that resumed at 1801.6 s.
  - Every response was 206 `video/mp4` of at most 8 MiB, with 0 full-file requests, and 0 issued tokens in the gateway log.
- **Gateway, E2, resolver.** Not touched. The read-only check as `velora_media_gateway` shows version 1 → message 27 (1,007,441,962 bytes, `video/mp4`); versions 2 and 999999 resolve to nothing; private and public reads are refused with 42501. The E3.4 error classification is unchanged.

### 11. Tests and gates

**Unit: 729 passing**, of which 16 run only with real tools and are skipped without them, saying why. New tests:
- `lib/ingestion/media.test.ts`: classification matrix, determinism, no extension, box layouts including 64-bit and size-0 boxes and corrupt files, copy-only arguments with a hostile name, packet digests with real FFmpeg 9 lines (extradata, side data), and remux verification;
- `lib/uploader/normalize.test.ts`: success, idempotency, upload history, regeneration, refusals by class/policy/name, changed source, disk, FFmpeg failure, probe failure, non-canonical output, packet mismatch, digest failure, source changed mid-run, over-ceiling output, adopted bytes, and the cleanup rules;
- `lib/uploader/media-ffmpeg.test.ts`: synthetic fixtures made with FFmpeg's test sources (canonical MP4, MKV H.264+MP3 with a hostile Unicode name, non-fast-start MP4, AC-3, MPEG-4 Part 2, two audio, two video, subtitles, garbage), real classification, real normalization of two inputs with source SHA-256 unchanged, real re-encode detection, FFmpeg failure, existing-output refusal, a derivative changed after verification, and tool discovery;
- the uploader media gate, including the authorization-first order, a verified rendition uploaded once, and an uncertain one never resent;
- the planner media gate;
- CLI dry runs on plain Node.

Existing fixtures gained canonical media; no expectation was weakened.

**Other gates.**
- Catalogue integration: 56 passing (the recovery integration fixture gained canonical media).
- pgTAP 482, `db lint` clean.
- Lint: 0 problems on tracked and new files.
- Application typecheck, gateway `tsc` and the production build (random stand-in secret) pass.

**Secret scan.** 25 values against `.next/static` and `.next/server`, the diff and new files, the docs, the ingestion source and tests, the harness logs and the gateway log: **0 hits**. The isolated scratch journal holds the Movies channel id by design (the C2 journal records each entry's intended channel); it is Git-ignored scratch and was deleted.

### 12. External state

| | Count |
| --- | --- |
| **Telegram Movies** | writes **0** (the local Bot API container stayed stopped). Reads: the playback regression only, 9 gateway requests, 47.6 MB, 59 `upload.getFile` reads, 49 RPCs, all of message 27 |
| **Telegram Series** | reads 0, writes 0 |
| **Hosted database** | writes **0** (no migration). Reads: 15 `ingest_upload_status` worker RPCs (`resume --server` dry run), the gateway's resolver and two read-only checks as `velora_media_gateway` |
| **Hosted auth** | 1 throwaway user, created and deleted (lookup 404); persistent writes 0 |
| **Media** | 1 real derivative (On The Hunt, byte-identical to message 27), **deleted**. Library unchanged. Message 27 unchanged and active. Message 23 retained. Fuze unchanged (message 25, no version) |

### 13. Limitations and next

- **Cover art.** Six library MP4s stop on `attached_picture`. Allowing a rendition that drops the picture (selecting the film stream explicitly) is a policy decision for a later checkpoint, not a guess here.
- **Class 3 and 4** are classification only.
- **Safari/iOS.** The real-device test remains the pre-launch gate for MP3 in MP4.
- **Lost journal.** If the journal is lost and a different FFmpeg build is used, a regenerated rendition might not be byte-identical to an uploaded one. It would then get a new fingerprint, and only duplicate review (same title and VJ) would hold it. The tool version is recorded with every rendition; keep the verified build.
- **The C2 design document** (`docs/PHASE_C_INGESTION_DESIGN.md`) was not edited, because it has unrelated uncommitted work in the working tree. This section is the E3.5 record, and the CLI header documents the commands.
- **Next checkpoint:** production Media Gateway hosting and deployment, including `MEDIA_GATEWAY_ALLOWED_ORIGINS` and a non-residential uplink. The operator's checkpoint plan calls it E4, but the roadmap's own E4 work item is series continuity, so the numbering needs a decision. The real Safari/iOS test is still owed before launch.

## E3.6 — Multi-stream media selection and library readiness (2026-10-02)

**Result: `E3.6 MULTI-STREAM MEDIA SELECTION + LIBRARY READINESS: PASS`.** Starting HEAD `1603793` (E3.5).

E3.5 stopped six library MP4s on `attached_picture`: its Class 2 arguments mapped `0:v:0`, which can be a cover image. E3.6 selects the film's streams by what they are, not where they sit, and re-scans the library read-only. Nothing was normalized in the library, and nothing was uploaded.

- **Telegram writes:** 0. **Hosted database writes:** 0. **Library:** unchanged.

### 1. What the six covers are (measured, read-only)

ffprobe of Blades of the Guardians, Call of Heroes, Desert Warrior, Sakra, The Furious and Wild Cat gives the same picture for all six:

| Stream | Codec | Size | Disposition | Packets | Tag / handler |
| --- | --- | --- | --- | --- | --- |
| 0 | H.264 (Desert Warrior: HEVC Main 10) | 1918–1920 wide | `default` | 134,472–187,570 | `avc1`/`hev1`, `VideoHandler` |
| 1 | MP3 or AAC-LC, stereo | — | `default` | 214,706–336,580 | `mp4a`, `SoundHandler` |
| 2 | MJPEG, Baseline, `yuvj420p` | 500×500 | **`attached_pic`** | **1** | tag `0`, no handler, `r_frame_rate` 90000/1, no frame count |

A walk of the box headers proves what stream 2 is. Every file has exactly **two** `trak` boxes (handlers `vide`, `soun`), and the cover is a 9,307-byte iTunes **`covr`** atom at `moov/udta/meta/ilst/covr`. So it is metadata, not a track: no player can select it as video. All seven library MP4s (the six plus The Protector, which has no cover) are also **not fast-start** (`ftyp, free, mdat, moov`).

**`attached_pic` is therefore sufficient as the primary signal, with one guard.** FFmpeg defines an attached-picture stream as a single still picture. The policy trusts the flag only together with a still-image codec (MJPEG, PNG, BMP, GIF, WebP). A flagged stream in any other codec is malformed metadata, and the file goes to review.

### 2. Selection policy (`selectPlaybackStreams`, `lib/ingestion/media.ts`, policy version 2)

```text
video streams ─▶ drop streams flagged attached_pic with a still-image codec (cover art)
             ─▶ exactly one motion-video stream left?  ─ no ─▶ manual_review
audio streams ─▶ exactly one?                            ─ no ─▶ manual_review
any attached_pic stream that is not a still image?       ─ yes ▶ manual_review
             ─▶ selection { video: <index>, audio: <index>, artwork: [<indexes>] }
```

- **Order plays no part.** Indexes come from the streams' meaning. Tests cover the cover first, the audio first, the film last, and covers on both sides.
- **No extra stream is ever dropped by heuristic.** A second unflagged video stream stays `multiple_video_streams`, whatever its size, length or order. A real case: the Matroska muxer turns a mapped JPEG into an ordinary MJPEG track and drops the flag, so it is a second video stream, and stays in review. Subtitle, data and attachment streams still stop the file.
- **Audio is unchanged.** One audio stream is selected. Two or more stay `multiple_audio_streams`, with or without a cover. There is no language or order rule, because none existed, and a second VJ track is never silently dropped.

### 3. Classification

- **Cover art makes a file `remux`, never `canonical`** (reason `attached_picture`). The browser-proven shape (E3.1, E3.3) is exactly one H.264 and one audio stream. Playback has no need for the cover, and an uploaded cover would rely on untested browser handling of `covr` (or, in other containers, of an image track). Stripping it costs one stream copy of a few seconds. For this library it changes nothing, because all seven MP4s need repackaging for fast start anyway.
- **Stripping verified cover art is container normalization, not editing.** The film's video and audio packets are carried unchanged and proven so (section 4). The authoritative local master is never written and keeps its artwork.
- **Unchanged meanings.** `mp4_not_fast_start` is still `remux` (stream copy, no encoding). HEVC is still `video_transcode_required`, with or without a cover. Audio outside policy is still `audio_normalization`. MP3 stays approved; Safari/iOS remains the pre-launch gate.
- **Policy version 1 → 2.** Stored classifications are recomputed from stored inspections on the next scan, with no re-probe. The upload gate (`mediaAllowsUpload`) refuses a version-1 record. A rendition made under version 1 and never sent is regenerated and re-verified rather than reused. One with upload history is never redone.

### 4. Class 2 mapping and identity

- **Mapping by index.** `remuxArguments` and `packetListArguments` take the selection and map `-map 0:<video> -map 0:<audio>`, video first. Indexes must be distinct, non-negative safe integers or the builder throws. The arguments are still an array (no shell), copy-only, with no codec, filter or bitrate option.
- **`normalizeEntry`** selects before any write (`stream_selection_ambiguous` refuses, even when a stale record says `remux`). It digests the source by its selection and the output by the output's own selection (`output_streams_unselectable` discards).
- **`verifyRemux`** compares the selected source streams with the selected output streams:
  - video: codec, profile, level, dimensions, pixel format and frame rate;
  - audio: codec, profile, rate, channels and layout;
  - duration within 0.5 s;
  - per-stream packet digests over the codec configuration and every (size, payload MD5).

  The output must be canonical, so a rendition that still carried the cover fails (`output_not_canonical:attached_picture`). The cover's absence is never a false failure, because the cover is never compared.

### 5. Operator output

`show` and `normalize` list every stream with its role. Classification and plan lines are as before; scan adds a `media:` line with the Class 2 reasons.

```text
media          REMUX  (mp4_not_fast_start, attached_picture)
streams        stream 0  video h264 High L4.1 1920x816 24/1 fps yuv420p  (selected)
               stream 1  audio mp3 44100 Hz 2 ch stereo  (selected)
               stream 2  video mjpeg 500x500 image  (attached artwork: ignored for playback, kept in the source)
action         stream copy (-c copy) of stream 0 (video) and stream 1 (audio) into a fast-start MP4; artwork stream 2 left out
encoding       none
```

An ambiguous file shows `MANUAL_REVIEW (multiple_video_streams)`, marks each candidate `one of several candidates: review, never guessed`, prints `action none`, and the upload line reads `blocked by media policy`. One small fix: the stream level is shown for H.264 only, so HEVC no longer prints as "L12.0".

### 6. Tests

| Case | Synthetic fixture (FFmpeg test sources, nothing committed) | Result |
| --- | --- | --- |
| A | MP4: H.264 + MP3 + `covr` cover, not fast-start | `remux` (`mp4_not_fast_start`, `attached_picture`); selection {0, 1, artwork 2} |
| B | The same file with `udta` moved before the tracks, so the **cover is stream 0** | selection {1, 2, artwork 0}. FFmpeg's `v:0` on this file is the MJPEG, which is the E3.5 hazard reproduced |
| Order | MP4 with audio 0, film 1, cover 2; Matroska with a cover attachment | selection follows meaning |
| C | Two unflagged video streams (and an MJPEG muxed as an ordinary track) | `manual_review` (`multiple_video_streams`), no selection |
| D | Two audio streams, with and without a cover | `manual_review` (`multiple_audio_streams`), no selection |
| E | Real `normalize` of A, B, audio-first and Matroska-cover | canonical output with exactly `[video h264, audio mp3]` and no `covr` box; packets equal to an independent digest of the source's selected streams; a digest that took the cover as video differs (1 packet); source SHA-256 and mtime unchanged |
| Guards | A flagged non-image stream; a cover as the only video; HEVC or AC-3 beside a cover; bad or equal indexes | review, `no_video`, `video_transcode_required` / `audio_normalization`, and the builder throws |

- **Upload gate** (`uploader.test.ts`): `media_not_verified` before any server read, preflight or send for:
  - not inspected (pre-E3.5);
  - Matroska;
  - an outdated policy (0, and v1);
  - an unverified rendition or one with no derivation;
  - a cover-art source (Class 2);
  - an ambiguous film;
  - HEVC beside a cover.
- **Unit tests:** 756 passing, all with the real FFmpeg 9.0.2 build (729 at E3.5). No expectation was weakened. The two E3.5 cover-art cases changed meaning by design (`manual_review` → `remux` for a verified cover). The E3.5 normalize CLI test now reads the per-stream lines.

### 7. Regression on real files (scratch only)

- **On The Hunt.** Normalized from the library MKV into a scratch directory on C: (never under `G:\Movies`) with the new index mapping:
  - **12.1 s**, 1,007,441,962 bytes;
  - 124,997 video and 199,380 audio packets identical;
  - SHA-256 `c475dcfcde063ee8…`, fingerprint `sf1-fbc665a8…5905bb`: **byte-identical to message 27**.
- **Exactly once.** `resume --server` (dry run, the read-only `ingest_upload_status` only) returned:
  - the regenerated rendition: `adopt_server` → **message 27**;
  - the MKV: `adopt_server` → message 23;
  - Fuze: `adopt_server` → message 25;
  - every other file: nothing on the server.

  Nothing would be re-sent. Fingerprint, checkpoint, recovery, uncertain-outcome and adoption code are unchanged.
- The derivative, the scratch journal (it holds the intended channel id) and its directory were deleted.

### 8. Library readiness (read-only scan of `G:\Movies`, 14 files)

The scan used an isolated scratch journal and no `--match`, Telegram or database. It read ffprobe headers and MP4 box headers only. Before and after, the library's names, sizes and mtimes were identical, with no new entries.

| File | sf1 | Class | Container | Video (selected) | Audio | Artwork | Action | Upload |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 Yards | `b974dc0f24f9` | remux | Matroska | #0 H.264 Main 1920×800 | #1 AAC-LC | no | stream copy | after normalization |
| Beast | `e3c515fbac29` | remux | Matroska | #0 H.264 High 1280×534 | #1 MP3 | no | stream copy | after normalization |
| Blades of the Guardians | `60672106b465` | remux | MP4, moov after mdat | #0 H.264 High 1920×804 | #1 AAC-LC | #2 | — | **blocked:** `file_too_large` (2,253,661,001 B) |
| Call of Heroes | `2a913ae1af15` | remux | MP4, moov after mdat | #0 H.264 High 1920×816 | #1 MP3 | #2 | stream copy, cover left out | after normalization |
| Desert Warrior | `e123e721dc26` | video_transcode_required | MP4, moov after mdat | #0 HEVC Main 10 1920×800 | #1 MP3 | #2 | — | **blocked:** `video_codec_hevc` |
| Fuze | `33472dfeba50` | remux | Matroska | #0 H.264 Main 1920×804 | #1 AAC-LC | no | stream copy | MKV already message 25: replacement decision |
| On The Hunt | `a9a1b20b0f4d` | remux | Matroska | #0 H.264 High 1920×1080 | #1 MP3 | no | — | live: rendition = message 27 (adopts) |
| Sakra | `d4e79eea6742` | remux | MP4, moov after mdat | #0 H.264 High 1920×804 | #1 AAC-LC | #2 | — | **blocked:** `file_too_large` (2,320,223,941 B) |
| The Furious | `c1b987e9b6e4` | remux | MP4, moov after mdat | #0 H.264 High 1920×800 | #1 MP3 48 kHz | #2 | — | **blocked:** `file_too_large` (2,132,230,094 B) |
| The Killer | `5a470bde4b64` | remux | Matroska | #0 H.264 High 1920×1040 | #1 MP3 | no | stream copy | after normalization |
| The Protector | `035a441efa64` | remux | MP4, moov after mdat | #0 H.264 High 1280×486 | #1 AAC-LC | no | stream copy | after normalization |
| TIMUR | `e91d7bd0ee29` | remux | Matroska | #0 H.264 High 1920×1040 | #1 MP3 | no | stream copy | after normalization |
| Jack Ryan: Ghost War | `d14f58a922c1` | video_transcode_required | Matroska | #0 HEVC Main 10 1920×800 | #1 MP3 48 kHz | no | — | **blocked:** `video_codec_hevc` |
| Wild Cat | `c768989e0f53` | remux | MP4, moov after mdat | #0 H.264 High 1918×1036 | #1 MP3 | #2 | stream copy, cover left out | after normalization |

```text
Total:                     14
Canonical:                  0
Remux:                     12
Audio normalization:        0
Video transcode required:   2   (Desert Warrior, Jack Ryan)
Manual review:              0

Ready after stream-copy normalization:  9   (7 new titles, plus On The Hunt — already live — and Fuze — replacement decision)
Blocked from upload:                    5   (3 over the 2000 MiB ceiling, 2 HEVC)
```

- **Correction to E3.5.** Desert Warrior is HEVC Main 10 as well. E3.5's blanket cover-art stop hid this, so the library has two HEVC titles, not one.
- **Over the ceiling.** Blades, Sakra and The Furious are acceptable media, but larger than Telegram's 2000 MiB document limit. A stream copy cannot shrink them: the cover is 9.3 KB. They need a separate decision (a size-reducing encode, splitting, or another origin), which is out of scope here.

### 9. External state

| | Count |
| --- | --- |
| **Telegram Movies** | reads 0 and writes **0** by this checkpoint (no Bot API call, no MTProto read). The already running dev gateway container was not touched |
| **Telegram Series** | reads 0, writes 0 |
| **Hosted database** | writes **0** (no migration). Reads: 15 `ingest_upload_status` worker RPCs (`resume --server` dry run) |
| **Library** | 14 sources unchanged (names, sizes, mtimes). No derivative was written under `G:\Movies`; the one scratch derivative on C: was deleted |

### 10. Open items and next

- **FFmpeg paths.** `.env.local` does not set them, so the CLI fails closed. Add:
  - `VELORA_FFPROBE_PATH=<home>\.velora-ingest\tools\ffmpeg-9.0.2-essentials\bin\ffprobe.exe`
  - `VELORA_FFMPEG_PATH=<home>\.velora-ingest\tools\ffmpeg-9.0.2-essentials\bin\ffmpeg.exe`

  Absolute paths are required. This checkpoint passed them per command.
- **Next movie checkpoint: E3.7 — Controlled batch movie normalization and Telegram ingestion** (not started).
  - **Scope:** the 7 new titles: 100 Yards, Beast, Call of Heroes, The Killer, The Protector, TIMUR, Wild Cat.
  - **Per title, one at a time:**
    1. `normalize --execute`;
    2. `show`;
    3. `upload --fingerprint` with the one-command authorization;
    4. `resume` if uncertain;
    5. `cleanup`.
  - **Start with Call of Heroes.** It is the first real cover-stripping rendition.
  - **Expect `uncertain` and marker recovery** on files over roughly 1 GB, because of the Bot API's 500 s idle timeout (E3.3).
  - **Excluded:**
    - On The Hunt (live);
    - Fuze (an E3.3-style replacement decision for message 25);
    - the three over-ceiling files;
    - the two HEVC files.
  - **Separate per title:** evaluation, review, rights and publication.
- Safari/iOS real-device verification remains a pre-launch gate.
