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