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
