# Phase C — Telegram Ingestion: Contract and Pipeline Foundation (C1)

Date: 2026-09-25
Baseline: `phase-a-foundation` at `0b70ac1` (Phases A and B complete). Hosted: 8 migrations.
Status: **C1 on the remote. C2A (transport, recovery, tooling) and C2A.1
(migration 9 worker boundary and RPC store) implemented and validated locally.
Migration 9 deployed to hosted on 2026-09-25 (C2A.2, below); hosted has 9
migrations. The channel allow-list is intentionally empty. Branch not pushed; no
Telegram call and no real upload has happened. C2B.1A (below) replaced the
end-of-channel heuristic with a bounded marker recovery protocol, locally; the bot
migration has not started.**

This checkpoint defines how a local VJ-translated media file becomes a reviewed,
publishable catalogue record. It adds the pure domain modules and their tests, and
**no** network, storage, upload or database write path. Bulk uploading, the uploader
CLI, webhooks and publication are later checkpoints.

## Scope vs the roadmap

The roadmap's Phase C items are C1 (server boundary), C2 (idempotent persistence),
C3 (parsing and review), C4 (TMDB matching) and C5 (operations). This checkpoint
covers the **contract** parts of C1–C4 before any of them touch Telegram or the
database:

| Roadmap item | Delivered here | Still to build |
| --- | --- | --- |
| C1 server boundary | Telegram message schema and row mapping (`telegram.ts`) | Webhook routes, secret and channel allow-list checks, body limits |
| C2 idempotent persistence | Fingerprint, caption token, duplicate classes, state machine, crash recovery rules | Local journal, uploader CLI, server write path |
| C3 parsing and review | Filename parser, kind decision, VJ resolution, review reasons | Reviewer authorization (D4), audited corrections |
| C4 TMDB matching | Scoring and outcomes over injected search | TMDB search adapter, candidate persistence, transactional publish |

The uploader described in the brief as "C2" is the local uploader of this contract.
Roadmap identifiers stay canonical.

## Existing schema reused (audit)

Audited: all 8 migrations, `lib/catalogue.ts`, `lib/tmdb/*`, `lib/supabase/*`,
`types/*`, the pgTAP suites and `docs/PHASE_B_CATALOGUE_DESIGN.md`.

| Concept | Existing object | Notes |
| --- | --- | --- |
| VJ identity | `public.vjs` (`slug` unique, `lower(name)` unique, `is_active`) | No alias column. The resolver accepts aliases as input; none are stored yet |
| Catalogue identity | `movies`, `series` → `seasons` → `episodes` | `tmdb_id` unique per root: one TMDB title maps to one Velora title |
| VJ version | `movie_versions (movie_id, vj_id)` unique; `episode_versions (episode_id, vj_id)` unique | Same title + other VJ is a new version; same title + same VJ cannot be a second version |
| Telegram media identity | `private.telegram_media`, unique `(bot_type, chat_id, message_id)`; `(bot_type, file_unique_id)` indexed, **not** unique (D3) | Composite FK pins movie versions to movie-bot media and episode versions to series-bot media |
| Received update | `private.ingestion_events`, unique `(bot_type, telegram_update_id)`, typed `status`, `attempt_count`, `parsed jsonb`, safe `error_code` | No raw payload |
| Metadata candidates | `private.metadata_match_candidates`: `score numeric(5,4)`, `reasons jsonb`, `decision`, one `approved` per event | `decided_by` null = automatic |
| Publication | `movies/series.publication_status`, `*_versions.availability_status = 'ready'` needs media, `rights_status = 'cleared'` | Public RLS shows only published titles with ready, cleared versions from active VJs |
| Security | The 3 private tables: RLS with no policies; all privileges revoked from `PUBLIC`, `anon`, `authenticated`, `service_role`; no client `USAGE` on `private` | Covered by `supabase/tests/database/003_security_boundaries.test.sql` |

## C1 database decision: no migration required

C1 is contract and pure code. It performs no database reads or writes, so every
concept above maps onto existing columns (see "Lifecycle"). The following are
**known C2 decision points**. None blocks C1:

1. **Write path.** `service_role` has no privilege on the private tables either. The
   uploader/webhook must write through narrow `SECURITY DEFINER` functions (or a
   dedicated role). That is a migration, with its own privilege audit, in C2.
2. **Upload transport.** Bot API cloud uploads are limited to 50 MB. Files of
   hundreds of MB up to 2 GB need either a user-account (MTProto) upload, which the
   movie/series bot then observes as a `channel_post` (fits `ingestion_events`
   as-is), or a self-hosted Bot API server where the bot uploads itself. In the
   second case the bot receives no update for its own post, so there is no
   `telegram_update_id`. That path would need an ingestion record not keyed on an
   update: a migration. Decide during C2 (it overlaps the E1 delivery spike).
3. **Fingerprint lookup.** Recovery looks up `ingestion_events.parsed->>'source_fingerprint'`.
   A sequential scan is fine at the expected volume. An expression index is a later
   migration only if needed.
4. **VJ aliases.** Only if real filenames show spellings that name/slug keys miss.

## Three identities, never conflated

| Identity | Key | Lives in | Public? |
| --- | --- | --- | --- |
| Source | `sf1-…` fingerprint (+ local path in the journal only) | Uploader machine; fingerprint also in the Telegram caption and `parsed` | No |
| Telegram media | `(bot_type, chat_id, message_id)`, `file_id`, `file_unique_id` | `private.telegram_media` | No |
| Metadata | `(tmdb_media_type, tmdb_id)` | `metadata_match_candidates`; copied to `movies/series.tmdb_id` only when approved | `tmdb_id` only, as enrichment |
| Catalogue | `movies.id` / `series.id`, `*_versions.id`, slugs | `public` catalogue tables | Only when published |

A TMDB match proposes metadata for a catalogue record. It never creates, approves
or publishes one.

## Ingestion lifecycle

`lib/ingestion/state.ts` is an explicit reducer (`transition(state, event)`) with
**two independent tracks**. The brief's linear order
(`discovered → parsed → matched → uploaded → review_pending → approved → published`)
is the happy path of a clean file. Splitting the tracks keeps upload and publication
separate:

```text
review: discovered → parsed → matched ─────────→ approved → published
                            ↘ review_pending → matched (reviewer)
        any non-final stage → rejected (permanent)

upload: not_uploaded → uploading → uploaded
                                 ↘ upload_failed → uploading (retry, ≤ 5 attempts)
        uploading → upload_confirmed | upload_abandoned   (crash recovery)
```

Invariants (each has a test, and the key ones were mutation-checked):

- **Upload is not publication.** No upload event changes the review track. An
  uploaded file can stay unmatched, in review or rejected indefinitely.
- `publish` requires `review = approved` **and** `upload = uploaded`.
- `approve` is legal only from `matched`. `review_pending` must first be resolved
  with complete evidence (`review_resolved`). An automatic approval also requires
  the match to have been reached automatically (`matchedBy = "auto"`).
- **Retryable vs permanent.** A retryable failure (TMDB error, network, database
  unavailable) is a `failure` flag with `retryable: true`, and the stage is kept. A
  permanent one (not a video, file too large) moves to `rejected`. `rejected` and
  `published` are final. Re-opening is a C3 audited correction.
- **Interrupted upload.** While `uploading`, another `upload_started` is illegal.
  The record must be `upload_confirmed` (found in the channel) or
  `upload_abandoned` (verified absent) first.

### Approval blockers

`approvalBlockers(evidence, by)` lists every reason a record cannot be approved.
Automatic approval needs an empty list:

| Blocker | Cause |
| --- | --- |
| `kind_conflict` / `kind_not_declared` | Declared kind disagrees with the filename, or no kind was declared |
| `vj_missing` / `vj_unresolved` / `vj_ambiguous` / `vj_inactive` | VJ not resolved to exactly one active VJ |
| `match_not_found` / `match_ambiguous` / `match_error` | No single TMDB match |
| `match_needs_confirmation` | Match confidence `medium`. Blocks automatic approval only; a reviewer may confirm it |
| `missing_season` / `missing_episode` | A series without both numbers |
| `duplicate_*` / `already_ingested` | See "Duplicates" |

### Storage mapping (C2 implements it)

| Concept | Before the channel post exists | After |
| --- | --- | --- |
| discovered, parsed | Local journal | `ingestion_events.status = 'parsed'`, suggestions in `parsed` |
| matched | Local journal (advisory dry-run result) | Candidate rows. `status = 'matched'` with one `approved` candidate is the approved state |
| review_pending | — | `status = 'needs_review'`, reasons in `parsed.review_reasons` |
| approved | — | `status = 'matched'` + `metadata_match_candidates.decision = 'approved'` + resolved VJ/episode in `parsed` |
| published | — | `status = 'published'`; version `ready` + `cleared`; title `published` |
| rejected | Journal `rejected` | `status = 'rejected'` (reviewer) or `'ignored'` (not media) |
| retryable failure | Journal `failure` | `status = 'failed'`, `attempt_count`, `error_code` |
| uploading / uploaded / upload_failed | Local journal | `telegram_media` row + event (uploaded) |

## Source-file contract

`SourceFile` (`types/ingestion.ts`) holds the absolute path, relative path, file
name, extension, size, mtime, **declared** kind, fingerprint and discovery time.
The parser supplies the normalized name and the title, VJ, year, season and
episode suggestions.

- Paths and mtimes exist **only in the uploader's local journal**. They are never
  written to Supabase, never put in a caption and never returned to a client.
  `sourceIdentity()` is the only shape that leaves the machine: fingerprint, size
  and file name. Telegram keeps the file name anyway.
- The declared kind comes from the scan input: separate movie and series library
  roots (mirroring the two channels) or an explicit CLI flag.

## Filename parser

`lib/ingestion/parser.ts` (`parseFilename`) is pure: no Next.js, Supabase, Telegram,
TMDB or file-system access. It is deterministic for given options (`maxYear`
defaults to next year).

- **Separators:** dots, underscores and repeated spaces become one space. A hyphen
  next to a space is a segment boundary; an in-word hyphen (`Spider-Man`) is kept.
  Brackets are dropped. Case is preserved for display and ignored for comparison.
- **Noise:** resolution, codec, source and audio tokens, plus `Luganda` and
  `Translated`, are removed. `by` directly before `VJ` is removed.
- **Episode markers:** `S01E01`, `s1e1`, `S01 E01`, `2x07`,
  `Season 4 Episode 22`, `S01` alone (missing episode) and `E05`/`Episode 5` alone
  (missing season). Episodes may have up to 4 digits.
- **VJ:** the words after `VJ` up to a boundary, a year, a marker or the end
  (`VJ-Junior`, `VJ.Junior` and `vj junior` all work). With no boundary
  (`VJ Junior John Wick`) only the first word is trusted, flagged
  `vj_boundary_uncertain`.
- **Year:** the last `19xx`/`20xx` token up to `maxYear`, unless it is the only
  title word (`1917`).
- **Title:** every remaining segment, in order. Nothing is dropped silently, so
  leftover words cause a TMDB title mismatch (review) instead of a wrong match.
- **Kind:** `inferredKind` is `series` when any marker is present. `decideKind`
  combines it with the declared kind: `confirmed`, `inferred` (no declaration;
  never auto-approvable) or `conflict`. A conflict never falls back to movie.
- **Issues and confidence:** issues carry `blocking` (`missing_vj`, `empty_title`,
  `unsupported_extension`, `multiple_vjs`, `missing_season`, `missing_episode`,
  `multi_episode`, `multiple_episode_markers`) or warning status
  (`vj_boundary_uncertain`, `multiple_years`). Confidence is a label: `high`
  (no issues), `medium` (warnings only) or `low` (any blocking issue).

## VJ resolution

`resolveVj(vjText, vjs)` in `lib/ingestion/vj.ts` compares one key: normalized,
leading `VJ` dropped, spaces removed. For example, `VJ Junior`, `vj-junior` and
`Junior` all give `junior`. It is compared with each VJ's name, slug and optional
aliases.

- Exactly one **active** match gives `resolved`.
- Two or more give `ambiguous`.
- A match to an inactive VJ only gives `inactive`. It blocks approval and never
  reactivates the VJ.
- No match gives `unresolved`, with prefix `suggestionIds` for a reviewer. They are
  never applied automatically.

The resolver never creates a VJ. New VJs are an admin action. Parsed text
(`vjText`) and identity (`vjId`) are separate fields throughout.

## TMDB matching

`lib/ingestion/match.ts`: `matchTitle(query, search)` takes an injected
`TmdbSearch`. The C4 adapter over `lib/tmdb/client.ts` will map raw results to
`TmdbCandidate`. The parser never calls TMDB, and the matcher never parses. The
existing B5 boundary test keeps TMDB out of public routes.

Signals, and only these:

1. media type: a hard filter (`movie` ↔ `movie`, `series` ↔ `tv`);
2. normalized title equals the candidate's `title` or `original_title`;
3. year: `match`, `near` (±1, which covers regional release dates), `conflict` or
   `unknown`.

Result order and popularity are ignored.

| Outcome | Rule |
| --- | --- |
| `matched`, `high` | Exactly one exact title with the same year |
| `matched`, `medium` | Exactly one exact title with the year ±1, or the only exact title when the file has no year |
| `ambiguous` | Several exact titles at the best evidence level (`multiple_exact`), only conflicting years (`year_conflict`), or results with no exact title (`no_exact_title`) |
| `not_found` | No results (`no_results`) or only the other media type (`wrong_media_type`) |
| `error` | The search threw. Retryable; carries only the code `tmdb_search_failed` |

`score` is stored through `MATCH_TIER_SCORE`: 1.0, 0.8, 0.6, 0.3 or 0, one per tier.
**It is an ordinal label, not a probability.** Only `high` can be approved
automatically.

## Source fingerprint and idempotency

`lib/ingestion/fingerprint.ts` stages the work so a scan of multi-GB files stays
cheap:

1. **`discoveryKey`**: a hash of relative path + size + mtime, kept in the local
   journal only. A rescan uses it to skip re-sampling unchanged files.
2. **`sf1` fingerprint**: SHA-256 over the version, size and the SHA-256 of three
   4 MiB samples (start, middle, end), or of the whole file when it is 12 MiB or
   smaller. That is about 12 MiB read per file whatever its size. It is independent
   of path, name and mtime. This is the idempotency key.
3. **`fullContentHash`** (optional): a SHA-256 of every byte. Use it only to settle
   a suspected collision or a replacement decision.

**Collisions.** Two different files of identical size that differ only outside the
three samples get the same `sf1`. Real re-encodes, cuts and different releases
change the size or the sampled bytes. A collision is treated as "same source" and
reported in the dry run. An operator who doubts it runs the full hash.
`sampleRanges` is part of the version: changing it requires `sf2`.

**Replacement.** A better copy of the same title and VJ has a different
fingerprint. It is classified `same_title_same_vj` and held for a reviewer, who
decides whether it replaces the existing version (a C3 audited correction).

**Caption token.** The uploader appends `velora-src:sf1-<64 hex>` to the Telegram
caption. `fingerprintFromCaption` reads it back and returns null for none,
malformed or conflicting tokens. It contains no path, name or secret.

## Duplicates

`classifyDuplicate(subject, known)` in `lib/ingestion/duplicates.ts` checks from
the strongest identity to the weakest. `titleKey` prefers the catalogue id, then
the TMDB id, then parsed text. A parsed key only gives a `possible` duplicate.

| Scenario | Class | Behaviour |
| --- | --- | --- |
| Same file scanned twice | `same_source` | `skip`: no new job |
| File renamed or moved after ingestion | `renamed` | `skip`. Same fingerprint, so no second upload; the journal updates its path |
| Same Telegram file delivered again | `same_telegram_file` | Review (D3); never merged silently |
| Same movie, same VJ, different file | `same_title_same_vj` | `hold`: no upload until a reviewer decides (repeat, or replacement) |
| Same movie, different VJ | `same_title_other_vj` | Proceeds: a new `movie_versions` row |
| Same episode, same VJ, different file | `same_episode_same_vj` | `hold` |
| Same episode, different VJ | `same_episode_other_vj` | Proceeds: a new `episode_versions` row |
| Unresolved VJ with the same title | `same_*_same_vj`, `possible` | Never assumed to be "another VJ" |
| Upload succeeded, crash before the journal/DB update | Journal says `uploading` | `verify_upload`: look for the caption token (webhook-recorded `telegram_media`/event, or the channel history) → `upload_confirmed`. Upload again only after `upload_abandoned` |
| DB/journal record exists, upload failed | `upload_failed` | `retry_upload` up to 5 attempts, then `skip` with `upload_attempts_exhausted` for the operator |

## Telegram identity contract

These are the fields persisted after upload. They are the existing
`private.telegram_media` columns, mirrored by `TelegramMediaRecord`:

`bot_type`, `chat_id`, `message_id`, `file_id`, `file_unique_id`, `media_kind`,
`file_name`, `mime_type`, `caption`, `file_size_bytes`, `duration_seconds`,
`width`, `height`, `telegram_date`. `source_fingerprint` is parsed from the caption
and stored in `ingestion_events.parsed`.

- A row is written **only from a message the owning bot observed** (webhook
  `channel_post`, or the bot's own send response), because `file_id` is
  bot-specific. `telegramMediaMessageSchema` (Zod) accepts only `chat.type = "channel"`
  with a `video` or `document`, and strips everything else. The caller checks the
  webhook secret and the channel allow-list first (roadmap C1).
- The upload limit is `TELEGRAM_MAX_FILE_BYTES` = 2000 MiB. Larger files are
  rejected before upload (`file_too_large`, permanent).
- No chat id, message id, file id or caption reaches a public shape. The B-2
  column grants already exclude `telegram_media_id` from client roles.

## Review and publication boundary

- Review is required whenever `approvalBlockers(…, "auto")` is non-empty, or when a
  duplicate class needs review.
- Approval needs complete evidence: one active VJ, a single TMDB match, and season
  plus episode for a series. A reviewer can confirm a `medium` match but cannot
  approve `ambiguous`, `not_found` or `error` without first resolving it.
- Publication (C4) must happen in one transaction:
  1. create or reuse the title (unique `tmdb_id`);
  2. for series, the season and episode;
  3. create the version with `telegram_media_id`;
  4. set `ready` + `cleared`, then `published`.

  The existing constraints already refuse `ready` without media and cross-bot media.

## Dry run

`planSource(input)` in `lib/ingestion/plan.ts` is the pure planner behind the
future `scan`/`inspect` output. For each file it reports:

- file, relative path, fingerprint and size;
- kind decision, parsed title, VJ text and VJ resolution;
- year, season and episode;
- match outcome and duplicate class;
- the **intended action**: `upload`, `upload_then_review`, `hold`, `verify_upload`,
  `retry_upload`, `skip` or `reject`;
- every **stop reason**.

Offline runs pass `{ outcome: "error", code: "tmdb_not_configured" }` as the match.
A dry run uploads nothing and writes nothing. It never prints tokens or keys; the
relative path is shown only in the operator's own terminal.

## C2 uploader contract

This is a Node CLI run on the operator's machine. It is never part of the Next.js
bundle.

| Command | Effect | Writes |
| --- | --- | --- |
| `scan <root> --kind movie\|series` | Walk the library, sample and fingerprint new or changed files (`discoveryKey` cache), parse, resolve VJs, optionally match, and print `planSource` entries | Local journal only |
| `inspect <file> [--full-hash]` | One file's plan in detail; optional full hash | Nothing |
| `upload [--dry-run] [--limit n]` | For `upload`/`upload_then_review`/`retry_upload` entries: journal `uploading` **before** sending, then upload with the caption token, then journal `uploaded` with chat/message ids | Journal; Telegram. `--dry-run` writes nothing |
| `resume` | For each `uploading` entry: find the caption token (server records, then channel history) → confirm or abandon. Never re-uploads first | Journal |
| `status` | Counts per action/stage, stop reasons and review backlog | Nothing |

Rules:

- The default is `--dry-run` until the operator passes an explicit `--execute`.
- It runs against a non-production target until production credentials are
  deliberately configured.
- Credentials come from environment variables only and are never logged:
  per-bot tokens, and any user-session secret if MTProto is chosen. `.env.example`
  is unchanged in C1 because nothing reads them yet. C2 adds the names it
  actually consumes.
- The journal is a local file outside the repository, holding paths. It is never
  committed or uploaded.

## Security boundary

- There is no database change, so every existing deny-by-default guarantee is
  unchanged and still tested by pgTAP. Browser roles cannot:
  - insert or update ingestion events;
  - change review decisions;
  - read Telegram references;
  - see local paths, which are never stored at all.
- `lib/ingestion/boundary.test.ts`:
  - the ingestion modules import only each other, domain types, `zod` and
    `node:crypto`;
  - they read no `process.env`;
  - they make no network calls;
  - no app route, component or public data-layer module imports them.
- No secrets were added or printed. No Telegram or production credentials are
  connected.

## Tests

| File | Tests | Covers |
| --- | --- | --- |
| `lib/ingestion/parser.test.ts` | 28 | Normalization; movie and series parsing (every brief example); malformed names; kind decision |
| `lib/ingestion/identity.test.ts` | 18 | VJ resolution; fingerprints (determinism, change sensitivity, path independence, short reads, full hash, no path leakage); Telegram token, schema and mapping |
| `lib/ingestion/lifecycle.test.ts` | 39 | Matching outcomes; state machine (legal and illegal transitions, retry, rejection, crash recovery, attempt cap, approval guards); every duplicate scenario; dry-run plans |
| `lib/ingestion/boundary.test.ts` | 4 | Framework and security boundary |

Mutation check: removing the publish-requires-upload guard fails one test.
Allowing approval from `review_pending` fails one test.

## Remaining for C2

1. Choose the upload transport: MTProto user upload observed by the bot, or a
   self-hosted Bot API server. The choice decides whether a migration is needed
   (decision point 2).
2. Migration for the narrow ingestion write path (functions or role, privilege
   audit, pgTAP), after separate authorization.
3. The Node CLI (`scan`, `inspect`, `upload`, `resume`, `status`) over these
   modules, plus the file-system `ReadRange` adapter and the local journal.
4. Webhook routes (roadmap C1): secret, channel allow-list, body limit, then
   `telegramMediaMessageSchema` and idempotent `telegram_media`/`ingestion_events`
   writes.
5. TMDB search adapter (C4) mapping raw results to `TmdbCandidate`, allowlisted in
   `lib/catalogue-boundary.test.ts`.
6. A trial on a small, non-production sample of real filenames, to measure parser
   coverage before any bulk upload.

---

# C2A — Secure upload foundation

Date: 2026-09-25. Base: C1 (`5beff50`, `091622c`) on remote `0b70ac1`.
Status: **transport, recovery, journal, TMDB adapter and CLI implemented and tested
locally. Migration 9 NOT written: blocked on the schema decision below.** No upload,
no Telegram call, no hosted change.

## Approved architecture

- **Transport:** a self-hosted Telegram Bot API server (`telegram-bot-api --local`),
  not MTProto user sessions. Each bot uploads its own files, so `file_id` is valid for
  the bot that will later serve it.
- **Confirmation:** the `sendDocument` reply is the evidence of an upload. Velora does
  not wait for a webhook or update, and none arrives: a bot receives no update for
  its own channel post.
- **Database writes:** narrow, worker-only `SECURITY DEFINER` commands. There are no
  table grants for `service_role`, and no publication command.

## C2A blocker: migration 9 needs a table change first

> **Resolved in C2A.1** (2026-09-25): Option A was approved and implemented,
> together with the channel allow-list. See "C2A.1" below. This section is kept
> as the decision record.

The brief allows migration 9 only for the worker boundary, and requires a stop before
any table change. Mapping the uploader onto the existing schema gives this:

| Need | Existing schema | Fits? |
| --- | --- | --- |
| Persist the `sendDocument` message | `private.telegram_media`: every column maps from the reply (`toTelegramMediaRecord`) | **Yes** |
| "DB knows the upload is starting" before any message exists | Only `ingestion_events` can hold ingestion state, and `telegram_update_id bigint NOT NULL` with `update_kind in ('channel_post','edited_channel_post')` | **No**: there is no update, and a synthetic `update_id` is forbidden |
| One registration per source fingerprint (idempotency) | The fingerprint exists only inside `parsed jsonb`, with no unique key | **No**: a unique key cannot be enforced |
| Match evidence for an uploaded file | `metadata_match_candidates.ingestion_event_id NOT NULL` | **No**: it needs an event row first |

So an uploader-originated item has no valid row, before or after upload. Worker RPCs
over the current tables could record `telegram_media` only, which leaves the upload
crash window unprotected on the server side. This is C1 decision point 2, now
confirmed.

### Options (decision needed)

**A. Extend `private.ingestion_events` (recommended, smallest).** In migration 9:

- add `origin text not null default 'webhook'` with a check of
  `('webhook','uploader')`;
- make `telegram_update_id` and `update_kind` nullable, with a check that they are
  present exactly when `origin = 'webhook'`. The existing unique
  `(bot_type, telegram_update_id)` is unchanged, since NULLs are distinct;
- add `source_fingerprint text`, checked against `^sf1-[0-9a-f]{64}$`, required for
  `uploader` rows, with a partial unique index `where source_fingerprint is not null`;
- add `upload_state text` (`not_uploaded|uploading|uploaded|upload_failed`, uploader
  rows only), `upload_attempt_count`, `upload_started_at`, `source_size_bytes`;
- add a partial unique index on `telegram_media_id` for uploader rows (one file, one
  item).

Candidates, statuses and every existing webhook row keep working unchanged. No code
path writes `ingestion_events` yet, and every role's privileges are revoked, so no
backfill is expected. Confirm the hosted row count read-only before deploying. Optional: add
`private.telegram_channels (bot_type primary key, chat_id)`, so the database itself
rejects media recorded for a channel that is not the bot's (forged channel id).

**B. New `private.ingestion_sources` table**, keyed by fingerprint, holding the
upload track, with candidates re-pointed to it. This is cleaner in isolation, but it
adds a second lifecycle root and touches the candidate FK. Not recommended.

## Worker boundary threat model (design for migration 9)

| Question | Answer |
| --- | --- |
| Who calls | The uploader CLI on the operator machine only, through PostgREST `rpc/` with the service-role key. The key is never in Vercel or a browser |
| Executing role | Functions owned by `postgres`, `SECURITY DEFINER`, `search_path = ''`, schema-qualified. `service_role` still has **no** privilege on the private tables, and definer rights are the only bridge. EXECUTE is revoked from `PUBLIC`, `anon` and `authenticated`, and granted to `service_role` only, per function |
| Trusted input | None. Every argument is validated: fingerprint pattern, `bot_type` enum, positive ids, bounded text, error code `^[a-z0-9_]{1,100}$`, caption token equal to the fingerprint, size equal to the registered size |
| Tables touched | `private.ingestion_events`, `private.telegram_media` and, for evaluation, `private.metadata_match_candidates`. Never `public.*` |
| Another record's id | Commands take no internal ids. They are keyed by `(fingerprint, bot_type)`; a `bot_type` mismatch with the registered row is refused |
| Arbitrary transitions | Each command is exactly one transition, guarded by `where upload_state = …` under a row lock: start (`not_uploaded`/`upload_failed` → `uploading`), record (`uploading` → `uploaded`), fail (`uploading` → `upload_failed`) |
| Replay / idempotency | Start: the unique fingerprint makes re-registration a no-op, and a start while `uploading` is refused (reconcile first). Record: the same message again returns `already_recorded`; a different message for the same fingerprint, or a message already linked to another fingerprint, returns `conflict` and sets `needs_review`. `telegram_media_delivery_key` stays the uniqueness authority. A duplicate `file_unique_id` is flagged for review (D3), never merged |
| Forged channel ids | Without `telegram_channels`, the database accepts any `chat_id`; the adapter and webhook allow-lists are then the only check. With it, the check is declarative |
| Error disclosure | Generic codes only (`ingest_illegal_transition`, `ingest_conflict`, `ingest_invalid_input`). No row data or SQL detail |
| Publication | Impossible through these commands: none writes `public.*`, sets `status = 'published'` or sets a candidate `approved`. Evaluation writes `pending` candidates only. Approval and publication stay behind the C3/C4 reviewer contract, so a compromised uploader cannot publish |

Proposed commands, mirroring `lib/uploader/store.ts`:
`ingest_upload_status`, `ingest_upload_start`, `ingest_upload_record`,
`ingest_upload_fail` and, if C2B needs it, `ingest_record_evaluation`. That is five
functions and no CRUD. A dedicated `ingest_worker` Postgres role with a minted JWT
would narrow the key's blast radius further. It needs custom JWT issuance, so it is
deferred to G4 hardening.

## Local Bot API adapter (`lib/telegram/local-bot-api.ts`)

- **Fails closed.** `TELEGRAM_BOT_API_URL` has no default. Any `*.telegram.org` host
  is refused, as are credentials, paths or queries in the URL, and plain HTTP off
  loopback (the token is in the request path). Missing or invalid configuration
  refuses to run. Errors name variables, never values.
- **Routing.** `transport` (bot plus channel) must equal the ingestion `kind`, and the
  configured channel must equal the journal's `intendedChannelId`, recorded at scan
  time. A movie through the series transport, or the reverse, fails before the
  network. A file name never selects a channel.
- **No whole-file reads.** `--local` mode: the request body is a `file://` URI
  (optionally translated by `TELEGRAM_BOT_API_PATH_MAP`), and the server reads the
  file from its own disk. The module imports no file-reading API; only an injected
  `stat` is used.
- **Preflight (no network):** regular file; supported extension; size > 0 and
  ≤ ceiling; size on disk equals size at scan time; valid fingerprint; the caption
  carries exactly that fingerprint; caption ≤ 1024 characters.
- **Reply handling.** `ok:true` is validated with the C1 message schema. The chat must
  equal the target channel, media must be present, the caption token must match,
  and `file_size`, when present, must match. Any failed check is `uncertain`, never a
  partial identity. Optional fields map to `null`.
- **Outcome classes.** `failed` (definite): a 4xx refusal, 429 with `retry_after`, or
  connection refused. `uncertain`: a timeout, dropped connection, 5xx, or an
  unreadable or malformed reply. Fetch errors are reduced to codes, so no URL or token
  can reach a log, error or journal.

### Maximum file size

`TELEGRAM_MAX_FILE_BYTES = 2000 * 1024 * 1024 = 2,097,152,000 bytes` (2000 MiB),
unchanged from C1. This is Telegram's upload ceiling: 4000 parts of 512 KiB, the
limit behind the documented "2000 MB". Exactly the ceiling passes; one byte more is
`file_too_large` (permanent) at scan, inspect and preflight. C2B must confirm it with
one real file just under the ceiling. A refusal would be a definite 4xx, so it cannot
cause a duplicate. `scan` prints the largest file and its headroom. No disk was
scanned in C2A.

### Caption and fingerprint

```text
John Wick (2014)
VJ Junior
Movie                      (or: Series S01E02)
velora-src:sf1-<64 hex>
```

The caption is deterministic plain text (no `parse_mode`). Control characters are
removed and each human line is limited to 200 characters, so the whole caption
always fits in 1024. The token is always the last line and always intact. It never
contains a path, file name, token or secret. `fingerprintFromCaption` (C1) parses it
back; zero or conflicting tokens give `null`.

## Crash window and reconciliation (`lib/ingestion/recovery.ts`, `lib/uploader/upload.ts`)

The order of evidence for one upload:

1. journal `uploading`, with a new attempt (`startedAt`, `channelHighWater`);
2. server `ingest_upload_start`. If it refuses, nothing is sent;
3. `sendDocument`;
4. journal stores the validated reply;
5. server `ingest_upload_record`;
6. journal `dbAcknowledgedAt`.

| Crash or outcome | Recovery |
| --- | --- |
| Before 3 | Reconcile, then abandon after the grace period. Nothing was posted |
| After 3, before 4 (the crash window) | Journal `uploading` → `reconcile`: probe the channel for the caption token → `record_confirmed` → server → journal. **No re-upload** |
| After 4, before 5/6 | `record_in_db`: replay the journal's reply. No Telegram call |
| After 6 | `none` |
| `uncertain` (timeout, 5xx) | Stays `uploading`. `upload` refuses and routes to `resume`, which reconciles first |
| Definite failure | `upload_failed`; an explicit retry is allowed (≤ 5 attempts) |
| Server `uploaded`, journal behind | `adopt_server` |
| Journal and server identity differ | `review`; never overwritten |

**Reconciliation contract.** Superseded in C2B.1A: the "20 consecutive missing ids
means end of channel" rule is removed. See "C2B.1A — Recovery hardening" below for
the bounded marker protocol that replaced it.

## Local journal (`lib/uploader/journal.ts`)

- One JSON file per fingerprint in `~/.velora-ingest/journal`, or
  `VELORA_INGEST_JOURNAL_DIR`. The repository is refused except for the Git-ignored
  `/.velora-ingest/`.
- Atomic replace: write a temp file with `flush`, then `rename`. A torn temp file from
  a crash is ignored, and a corrupt entry is refused rather than guessed. A `.lock`
  file allows one writer.
- It holds the paths, kind, `intendedChannelId`, C1 `IngestionState`, the last plan,
  attempts, the validated Telegram record and the DB acknowledgement. It holds no
  tokens or keys.
- It is operational only. Once Supabase acknowledges an upload, the server record is
  authoritative (`decideResume`).

## TMDB ingestion adapter (`lib/tmdb/ingestion-search.ts`)

`searchTmdbForIngestion` goes through the existing `tmdbFetch` transport to
`/search/movie` or `/search/tv` and maps results to C1 `TmdbCandidate`. The year is
deliberately not used as a filter, because the matcher needs namesakes and ±1 years.
It is allowlisted in `lib/catalogue-boundary.test.ts`, and a new assertion checks
that no app, component or library module imports it. Normal browsing still makes
zero TMDB requests.

## CLI (`npm run ingest -- <command>`)

The CLI runs on plain Node 24 through native type stripping plus a 30-line resolve
hook (`scripts/ingest/register.mjs`, for the `@/` alias and a `server-only` stub). It
adds no dependency. `.env.local` is loaded with `--env-file-if-exists`.

| Command | C2A behaviour |
| --- | --- |
| `scan <root> --kind movie\|series [--vjs f] [--match]` | Walk, fingerprint (discovery-key cache), parse, plan, journal. Prints the largest file's headroom |
| `inspect <file> --kind … [--full-hash]` | One plan, with the caption and optional full SHA-256. Writes nothing |
| `upload [--limit n]` | Dry run: lists files and captions |
| `upload --execute` | **Refused.** It needs the Bot API configuration **and** the worker boundary; `unavailableStore` makes execution impossible in C2A |
| `resume [--execute]` | Dry run: prints each recovery decision. `--execute` is refused like `upload` |
| `status` | Counts per plan, upload state, DB acknowledgement and stop reason |

## Environment contract

| Runtime | Variables |
| --- | --- |
| Next.js server | Unchanged. No Telegram variable is read by the app |
| Uploader CLI | `TELEGRAM_BOT_API_URL`, `TELEGRAM_MOVIES_BOT_TOKEN`, `TELEGRAM_MOVIES_CHANNEL_ID`, `TELEGRAM_SERIES_BOT_TOKEN`, `TELEGRAM_SERIES_CHANNEL_ID`, `TELEGRAM_RECONCILE_CHAT_ID`, optional `TELEGRAM_BOT_API_PATH_MAP`, `VELORA_INGEST_JOURNAL_DIR`; C2B adds the Supabase URL and service-role key for the worker RPCs |
| Bot API server | Its own `--api-id` / `--api-hash` (or `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` in its environment), `--local`, `--dir`, `--http-ip-address=127.0.0.1` |

The names follow the operator's existing `.env.local` (`TELEGRAM_MOVIES_*`,
`TELEGRAM_SERIES_*`).

## C2B prerequisites

1. **Schema decision for migration 9** (option A or B above), then migration 9 with
   pgTAP tests: permissions, commands, idempotency, conflicts, illegal transitions,
   no publication, and a definer audit (owner, `prosecdef`, `search_path`, exact
   ACLs). After that, a `SupabaseIngestionStore` implementing `IngestionStore` and a
   separately authorized hosted deploy.
2. **Telegram credentials:** `api_id`/`api_hash` from my.telegram.org, for the server
   only.
3. **Local Bot API server:** build `telegram-bot-api` (natively on Windows via vcpkg,
   or under WSL2/Docker). Run it with `--local --dir=<persistent dir>
   --http-ip-address=127.0.0.1`. With Docker or WSL, mount the library read-only and
   set `TELEGRAM_BOT_API_PATH_MAP`. The `--dir` directory holds the bots' sessions
   and must survive restarts. A restart drops in-flight uploads, which then surface as
   `uncertain` and are reconciled.
4. **Move both bots off the cloud Bot API:** call `logOut` once per bot against
   `api.telegram.org`, then use them only through the local server. After `logOut`, a
   bot cannot log back into the cloud server for 10 minutes. Cloud webhooks and
   `getUpdates` stop, and any other service using those tokens breaks. **Not executed
   in C2A.**
5. **Channels:** both bots are admins of their own channel only.
   `TELEGRAM_SERIES_CHANNEL_ID` in the current `.env.local` is **not** in numeric
   `-100…` form and must be corrected (the movies value is). Channel content
   protection must be off for reconciliation, or another probe must be approved.
6. **Reconciliation chat:** a private chat or group where both bots can post and
   delete.
7. **Trial:** `scan` a small, non-production sample to measure parser and VJ
   coverage. Then one explicit `upload --execute` of one small file, a crash drill
   (kill mid-upload, then `resume`), and one file near the 2000 MiB ceiling.

## C2A tests

| File | Tests | Covers |
| --- | --- | --- |
| `lib/telegram/local-bot-api.test.ts` | 42 | Fail-closed configuration and no cloud fallback; routing and cross-channel refusal; every preflight rejection before the network (ceiling ±1, zero bytes, extension, changed file); file-URI upload and no file reads; reply mapping, optional fields and malformed replies; 4xx/5xx/429/timeout/connection classes; no token in errors or logs; forward probe (found, missing, protected, wrong origin); deterministic caption |
| `lib/uploader/uploader.test.ts` | 31 | Bounded reconciliation (confirmed, gaps, not found, multiple, size mismatch, incomplete, unavailable); resume decisions; journal (round trip, atomic replace, torn temp file, corruption, no secrets, lock, location); the §26 crash scenarios end to end; no publication; C2A refusal without the worker boundary |
| Boundary tests | +1 | Ingestion TMDB adapter unreachable from app code. The C1 client-import test now also covers `lib/telegram` and `lib/uploader` |

Mutation checks, each caught by at least one test:

- removing the reconcile-before-retry guard (3 failures);
- trusting absence without the grace period (2);
- adopting multiple matches (2);
- removing the transport/kind check (1).

---

# C2A.1 — Migration 9: uploader-origin ingestion and the worker boundary

Date: 2026-09-25. Base: remote `091622c` plus C2A (`7fb5c78`, `cb73ee6`, `1df0a2b`).
Status: **implemented and validated locally. No real upload. Not pushed.**
(Deployed to hosted later, in C2A.2, below.)

Approved decisions:

- Option A: `private.ingestion_events` stays the single ingestion lifecycle root.
- A private Telegram channel allow-list.
- `service_role` as the only caller of the worker commands.

## Migration `20260925004059_ingestion_uploader_worker_boundary.sql`

### Schema

| Object | Change |
| --- | --- |
| `private.telegram_channels` (**new**) | `bot_type text primary key` (`movie`/`series`), `chat_id bigint not null unique`, checked `< -1000000000000` (a `-100…` channel id), `created_at`, `updated_at` with the shared trigger. It ships **empty** |
| `private.ingestion_events` (altered) | Adds `origin` (`webhook` default / `uploader`), `source_fingerprint`, `source_size_bytes`, `upload_state`, `upload_attempt_count` (default 0), `upload_started_at`, `upload_failure_code`, `upload_failed_at`. `telegram_update_id` and `update_kind` drop `NOT NULL`; the shape checks below keep them mandatory for webhook rows |

Constraints added to `ingestion_events`:

- `origin_check`: `origin in ('webhook','uploader')`.
- `source_fingerprint_check`: matches `^sf1-[0-9a-f]{64}$`.
- `source_size_check`: 1 to 2,097,152,000 bytes.
- `upload_state_check`: `uploading | uncertain | uploaded | upload_failed | blocked`.
- `upload_attempt_count_check`: 0 to 5.
- `upload_failure_code_check`: matches `^[a-z0-9_]{1,100}$`.
- **`webhook_shape_check`**: a webhook row must have `telegram_update_id` and
  `update_kind`, and every uploader column null or 0. That is exactly the B-1 shape.
- **`uploader_shape_check`**: an uploader row must have no update id or kind; must
  have a fingerprint, size, state, at least 1 attempt and a start time; must link
  media **exactly when** `uploaded`; and must have a failure code exactly when it
  has a failure time.

Indexes added:

- `ingestion_events_source_fingerprint_key`: **unique** `(source_fingerprint) where origin = 'uploader'`. This is the idempotency identity.
- `ingestion_events_uploader_media_key`: **unique** `(telegram_media_id) where origin = 'uploader' and telegram_media_id is not null`. One delivery backs one uploader ingestion.

`private.telegram_media` is unchanged. Every `sendDocument` field maps onto an existing
column, optional Telegram fields stay `NULL`, and no update id is fabricated.

### Upload state (independent of the review `status`)

`status` stays the review track (`received`, `needs_review`, …); `upload_state` is
the upload track. No worker command sets `matched`, `published` or an `approved`
candidate. "Not started" is represented by the absence of a row, which
`ingest_upload_status` reports as `new`.

```text
(no row)      -start->  uploading            (attempt 1)
upload_failed -start->  uploading            (attempt + 1, at most 5)
uploading     -record-> uploaded
uncertain     -record-> uploaded             (reconciliation found it)
upload_failed -record-> uploaded             (found after abandonment)
uploading     -fail->   upload_failed (retryable | abandoned) | uncertain | blocked (permanent)
uncertain     -fail->   upload_failed (abandoned) | uncertain | blocked (permanent)
```

- There is no `uploading`/`uncertain` → `start`: an interrupted attempt must be
  reconciled first.
- There is no automatic stale-attempt transition.
- `uploaded` is final: a later `fail` is `ingest_illegal_transition`, and a different
  message is a `conflict`.

### Worker commands (all in `public`, for PostgREST `rpc/`)

| Function | Returns | Purpose |
| --- | --- | --- |
| `ingest_upload_status(p_source_fingerprint text, p_bot_type text)` | one row: `upload_state` (`new` when absent), `upload_attempt_count`, `upload_failure_code`, `needs_review`, then the linked `telegram_media` identity (null unless uploaded) | Resume decisions and adoption of a server-recorded upload |
| `ingest_upload_start(p_source_fingerprint text, p_bot_type text, p_chat_id bigint, p_source_size_bytes bigint)` | `(upload_state, upload_attempt_count)` | Register (idempotent, reusing the existing row) and start one attempt towards the allow-listed channel |
| `ingest_upload_record(p_source_fingerprint, p_bot_type, p_chat_id, p_message_id, p_file_id, p_file_unique_id, p_media_kind, p_file_name, p_mime_type, p_caption, p_file_size_bytes, p_duration_seconds, p_width, p_height, p_telegram_date timestamptz)` | `recorded` \| `already_recorded` \| `conflict` | Record the `sendDocument` (or reconciled) message as `telegram_media` and link it |
| `ingest_upload_fail(p_source_fingerprint text, p_bot_type text, p_outcome text, p_failure_code text)` | new `upload_state` | `retryable`, `uncertain`, `abandoned` or `permanent` |

`ingest_record_evaluation` is **omitted**. Uploading does not need persisted match
evidence, so the privileged surface stays smaller. It belongs with the C3/C4 review
contract.

What `record` checks:

- the chat is the allow-listed channel **for that bot type**;
- the caption carries **exactly** this fingerprint's `velora-src:` token;
- the size equals the registered size;
- the kind matches the registration.

How `record` handles evidence:

- An existing delivery is adopted only if it is the same `file_unique_id` and
  unclaimed. Otherwise it returns `conflict` and sets `needs_review`.
- A second message for an uploaded source returns `conflict` plus `needs_review`
  (`duplicate_upload_evidence`), and nothing is overwritten.
- The same `file_unique_id` already delivered elsewhere is recorded but flagged
  `duplicate_telegram_file` (D3).

Errors are fixed codes with no row data: `ingest_invalid_input` (22023),
`ingest_channel_not_allowed`, `ingest_not_registered`, `ingest_identity_mismatch`,
`ingest_already_uploaded`, `ingest_attempts_exhausted` and
`ingest_illegal_transition` (P0001).

### Privilege audit

| Item | State |
| --- | --- |
| Function owner | `postgres` for all four |
| `SECURITY DEFINER` | all four. This is required, not convenient: `service_role` has no privilege on the private tables, and definer rights are the only bridge |
| `search_path` | `''` on all four; every object is schema-qualified; no dynamic SQL (tested) |
| EXECUTE | Revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`, then granted to **`service_role` only**. Exact ACL tested: `{postgres=X/postgres, service_role=X/postgres}` |
| Direct table grants | **None added.** `telegram_channels`, `ingestion_events` and `telegram_media` are revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`, and service_role direct read/write is tested to fail with 42501 |
| RLS | Enabled on `telegram_channels` with no policies; unchanged (enabled, no policies) on the B-1 tables |
| Public catalogue | Untouched. No worker function references a `public` table or the value `'approved'` (tested structurally), and a draft title with a version stays draft, unready and unlinked after an upload (tested behaviourally) |

### Webhook compatibility

A valid `channel_post` row inserts exactly as before and defaults to
`origin = 'webhook'`. These are all still refused:

- a replayed `(bot_type, telegram_update_id)` (23505);
- a missing update id or update kind (23514);
- an invalid kind (23514);
- any uploader column on a webhook row (23514).

Match candidates still attach to webhook events. **Result: no regression.**

## Channel allow-list configuration (per deployment)

The migration is deterministic and commits no real channel id. After migration 9 is
deployed, the operator runs this **as the database owner** (SQL editor, or `psql` with
the pooler URL). The worker cannot run it: `service_role` has no privilege on the
table.

```sql
insert into private.telegram_channels (bot_type, chat_id) values
  ('movie',  <Movies channel id, -100…>),
  ('series', <Series channel id, -100…>)
on conflict (bot_type) do update set chat_id = excluded.chat_id;
```

Until both rows exist, `ingest_upload_start` and `ingest_upload_record` fail with
`ingest_channel_not_allowed`: it fails closed. The ids must equal
`TELEGRAM_MOVIES_CHANNEL_ID` / `TELEGRAM_SERIES_CHANNEL_ID`. The adapter checks the
same routing again before any network call.

## Worker store (`lib/uploader/store.ts`)

- `createRpcIngestionStore(rpc)` implements `IngestionStore` over the four RPCs. It
  has no `.from()`, schema or SQL access (tested).
- Payloads carry the fingerprint, kind, size, channel and the Telegram identity.
  They never carry a local path, token or journal data.
- Replies are validated with Zod. A wrong shape is `store_bad_reply`, never a guess.
- Errors are reduced to `IngestStoreError.code`: the database's `ingest_*` code,
  or `store_error` / `store_unavailable`. Raw server text is never surfaced.
- `supabaseRpcTransport(env)` reads `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` (CLI only). It refuses publishable keys and plain
  HTTP off localhost, and names variables, never values.
- `offlineStore` is used when nothing is configured: status `unknown`, and every
  write refuses.

Orchestrator changes (`lib/uploader/upload.ts`):

- An `uncertain` send is recorded on the server (`uncertain`). Even with a lost
  journal, the database then refuses a blind start (tested).
- A journal failure the server never heard is synced first (`sync_failure`).
- An ambiguous reconciliation is persisted as `blocked` (review).
- Abandonment is recorded as `abandoned`.
- `decideResume` treats server `unknown` as stop, `uncertain` as reconcile and
  `blocked` as review.

**Safety gate.** `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false` in `upload.ts`:

- `uploadEntry` and `resumeEntry` refuse unless the caller enables Telegram
  (only tests do, against fakes).
- The CLI refuses `upload --execute` and `resume --execute` before reading any
  configuration.
- A test asserts that the constant is `false`, and a plain-Node CLI test asserts
  the refusal.
- C2B flips the constant only with the first authorized upload.

`resume --server` (dry run) calls only the read-only status RPC.

Database types: the worker RPCs are deliberately absent from
`lib/supabase/database.types.ts`, because clients cannot execute them. This is
recorded in its header.

## C2A.1 tests

| Suite | Count | Covers |
| --- | --- | --- |
| `supabase/tests/database/005_ingestion_worker_boundary.test.sql` | 92 | Schema and shape checks; webhook regression; allow-list constraints and privacy; exact ACLs, owner, definer, `search_path`, no dynamic SQL; anon/authenticated denied (catalog and live); service_role has no direct table access; every state transition, idempotency, channel routing, caption token, replay, conflict, uncertain blocking, retry, the attempt cap, permanent block, D3; publication boundary |
| `003_security_boundaries` (updated) | 30 | 18 tables; the reviewed definer set now includes the four `ingest_upload_*`; the allow-list is closed to clients and service_role |
| `lib/uploader/store.test.ts` | 13 | RPC selection, exact payloads, state mapping, record round trip, error normalization, configuration |
| `lib/uploader/uploader.test.ts` | 35 | C2A scenarios plus: the gate, uncertain persisted and blind start blocked with a lost journal, failure sync, server channel refusal, persisted review block |
| `lib/uploader/cli.test.ts` | 2 | The real CLI loads on plain Node and refuses `--execute` |
| `tests/integration/ingestion-store.test.ts` | 4 | The real store against **local** PostgREST: status, fail-closed allow-list, error codes, anon JWT denied |

Adversarial mutations were applied to the local database only and are now restored.
Each was caught:

| Mutation | Failing assertions |
| --- | --- |
| Grant a worker RPC to `authenticated` | 2 |
| Drop fingerprint uniqueness | 44 |
| Allow a movie upload to the Series channel | 46 |
| Allow an uncertain upload to restart | 3 |
| Upload success publishes | 2 |

A one-off local round trip through real PostgREST (not committed) returned
`recorded`, then `already_recorded`, then an exact record equality, then
`conflict`, then `ingest_illegal_transition`, then anon `42501`.

## Remaining for C2B

1. ~~A separately authorized hosted deploy of migration 9. Before it, confirm
   read-only that hosted `ingestion_events` has no rows.~~ Done in C2A.2.
2. Configure `private.telegram_channels` (above) with numeric ids. The current
   `TELEGRAM_SERIES_CHANNEL_ID` in `.env.local` must be corrected first.
3. Set up the local Bot API server, `api_id`/`api_hash`, `logOut` for both bots and
   the reconciliation chat (see "C2B prerequisites" in C2A).
4. Flip `REAL_TELEGRAM_UPLOADS_AUTHORIZED` with the first authorized upload. Then
   do a crash drill and a near-ceiling file.

# C2A.2 — Hosted deployment of migration 9

Date: 2026-09-25. Branch: `phase-a-foundation`, local at `f98da5a` (remote
`091622c` plus C2A and C2A.1, not pushed). Status: **C2A.2 HOSTED DEPLOYMENT:
PASS.** Migration 9 only. No channel row, no Telegram call, no upload, no C2B.

## Preflight (read-only MCP)

| Check | Observed | Status |
| --- | --- | --- |
| Migrations 1–8 | Byte-identical in the working tree, `HEAD` and remote `091622c` | PASS |
| Hosted history | Exactly 8, ending `20260924195306`; migration 9 absent | PASS |
| Hosted data (aggregate counts) | `ingestion_events` 0, `metadata_match_candidates` 0, `telegram_media` 0 | PASS |
| Starting schema | B-1 shape as assumed: `telegram_update_id`/`update_kind` NOT NULL, no uploader columns, `ingestion_events_update_key`, status CHECK includes `needs_review`/`published`/`rejected`/`ignored`; `private.set_updated_at()` present; no `telegram_channels`, `ingest_upload_*` or conflicting index names; all three tables owner-only ACL, RLS on, no policies | PASS |

## Deployment

- Mechanism as B-1/B-2 and B4: Supabase CLI `2.117.0`, `db push --db-url` over the
  session pooler (port 5432; the CLI token lacks `database_write`). The URL comes
  from the local environment and was never printed.
- Migration SHA-256 `d46b013a…c6320d76a`, equal to the `HEAD` blob, checked
  immediately before the push.
- Dry-run proposed exactly `20260925004059_ingestion_uploader_worker_boundary.sql`,
  no seeds, no roles. The push applied that one migration and exited 0.
- Not used: `migration repair`, ad-hoc DDL, the service-role key, any other migration.

## Verification (read-only MCP)

| Check | Observed | Status |
| --- | --- | --- |
| History | 9 migrations, ending `20260925004059_ingestion_uploader_worker_boundary` | PASS |
| `private.telegram_channels` | PK `bot_type` (CHECK movie/series), `chat_id` bigint UNIQUE with CHECK `< -1000000000000`, `created_at`/`updated_at`, `set_updated_at` trigger; owner `postgres`; RLS on, no policies; ACL `{postgres=arwdDxtm/postgres}` | PASS |
| `ingestion_events` additions | 8 columns with the migration's types, nullability and defaults; `telegram_update_id`/`update_kind` now nullable; the 8 new CHECKs (origin, fingerprint, size, upload state, attempts, failure code, webhook shape, uploader shape) match the migration text | PASS |
| Partial unique indexes | `ingestion_events_source_fingerprint_key` `WHERE origin = 'uploader'`; `ingestion_events_uploader_media_key` `WHERE origin = 'uploader' AND telegram_media_id IS NOT NULL` | PASS |
| Existing keys/FKs | `ingestion_events_update_key` and `telegram_media_id` FK unchanged | PASS |
| RPCs | All four: owner `postgres`, `SECURITY DEFINER`, `search_path=""`, identity arguments and return shapes as in the migration (`status` STABLE, others VOLATILE). `prosrc` MD5 equals the repository body for each | PASS |
| RPC ACL | `{postgres=X/postgres,service_role=X/postgres}` on all four; EXECUTE false for `anon` and `authenticated`; no `PUBLIC` entry | PASS |
| Private-table privileges | `ingestion_events`, `telegram_channels`, `telegram_media`, `metadata_match_candidates`: no table or column privilege for `anon`, `authenticated`, `service_role` or `PUBLIC`; none of them has `USAGE` on `private` | PASS |
| Publication boundary | RPC write targets are only `private.ingestion_events` and `private.telegram_media`; no body references `public.*`, `catalogue_access.*` or `auth.*`; the only triggers on the touched tables are `set_updated_at` | PASS |
| Channel allow-list | `private.telegram_channels`: **0 rows**, intentionally. Hosted start/record fail closed with `ingest_channel_not_allowed` until the operator configures it ("Channel allow-list configuration" above). No write call was made to demonstrate this | PASS |
| Data | `ingestion_events`, `telegram_media`, `metadata_match_candidates`: 0 rows | PASS |

## Advisors (compared with the pre-deploy baseline of the same day)

- Security: one new finding, INFO `rls_enabled_no_policy` on
  `private.telegram_channels`. Reviewed and accepted. It is the intended deny-all
  posture (RLS on, no policies, no grants; only the definer reads it) and the same
  class as the accepted findings on the other `private` tables. No finding for any
  `ingest_upload_*` function. The two accepted `record_search`/`trending_searches`
  WARN pairs are unchanged.
- Performance: unchanged (2 composite-FK INFO, 12 unused-index INFO).
- Blocking findings: none.

## Still not done

Channel configuration, the local Bot API server, `logOut`, and
`REAL_TELEGRAM_UPLOADS_AUTHORIZED` all remain as listed in "Remaining for C2B".
C2B has not started.

# C2B.1A — Recovery hardening before the bot migration

Date: 2026-09-25. Branch: `phase-a-foundation` at `6dc9141` plus this checkpoint
(local, not pushed). The C2B.1 preflight was **BLOCKED** because crash recovery
treated 20 consecutive missing message ids as the end of the channel, and a deleted
gap could then authorize a duplicate upload. That rule is removed. No migration,
no Telegram call and no hosted change in this checkpoint.
`REAL_TELEGRAM_UPLOADS_AUTHORIZED` is still `false`.

## Bounded marker protocol (`reconcileUpload`, `lib/ingestion/recovery.ts`)

The Bot API cannot read channel history. Deleted messages leave gaps of any length,
so a run of missing ids proves nothing. Recovery bounds the search on both sides
instead:

1. **Floor (lower bound).** The attempt's `channelHighWater`: the highest message id
   the journal knew in that channel when the attempt started. Every such message was
   posted before the attempt, so the file, if posted, has a larger id. A floor of 0
   or no attempt record is **unknown**. The result is then `incomplete/floor_unknown`
   with **no Telegram call**, and the scan never starts at id 1.
2. **Access check (read-only).** `getChat` on the kind's channel and on the recovery
   group, with the kind's bot. `has_protected_content: true` (a stable API field)
   stops here, before any marker.
3. **Upper bound.** Post a recovery marker (`sendMessage`, text only) to the same
   channel with the same bot. Channel message ids increase, so everything posted
   before the marker has a smaller id. A marker at or below the floor means the floor
   is wrong (`incomplete`).
4. **Scan** every id strictly between floor and marker, upward. Each probe forwards
   the id into the recovery group, reads the copy and deletes the copy (best effort).
   The id advances only after it was inspected.
5. **Classify** the result (next section).

The marker is never deleted, and correctness does not depend on deleting it: it is
text, never media, and it cannot match a fingerprint. No additional bot permission
is needed.

### Marker

```
velora-recovery:v1 src=sf1-<64 hex> attempt=<n|unknown> at=<ISO-8601 UTC>
```

It is one line of about 120 characters, with no path, token or credential. It never
contains `velora-src:`, so `fingerprintFromCaption` returns `null` for it.
`postRecoveryMarker` posts only text that passes `isRecoveryMarker`, and posts it with
the kind's own bot to the kind's own channel (Movies → Movies, Series → Series). Its
body is exactly `chat_id`, `text`, `disable_notification` and
`link_preview_options`. There is no document, file or path parameter. The reply must
come from the same chat and carry the same text before its `message_id` is used as
the bound. A timed-out marker may exist, and that is harmless; the next run posts a
new one.

### Probe classification (`probeChannelMessage`)

| Telegram reply | Probe result | Scan treats it as |
| --- | --- | --- |
| Forwarded copy with the target token and equal size | `found` | match |
| Forwarded copy: other file, or text (earlier markers included) | `found` / `not_media` | inspected, not the target |
| 400 with exactly `Bad Request: message to forward not found` | `missing` | inspected, empty |
| Any other 400: service message, protected message, unknown wording | `uninspectable` | **incomplete** |
| Other 4xx except 401/403/429; unexpected forward origin; malformed copy | `uninspectable` | **incomplete** |
| 429 (with `retry_after` when given) | `rate_limited` | wait, or stop as **rate_limited** |
| 5xx, timeout, network error, unreachable server | `transient` | back off, or stop as **transient** |
| 401 / 403, recovery group not configured | `blocked` | **permission_blocked** |

Only status codes and `retry_after` are used, with one exception: the not-found
text. The Bot API has no code that separates "no such message" from other 400s, and
it cannot tell a service message from a protected or forbidden one. So text is used
only to reach `missing`. If Telegram rewords it, scans become `incomplete`, never
falsely empty.

### Outcomes, decisions and database state

| Scan result | Decision (`decideAfterReconcile`) | Server (`ingest_upload_fail`) | Upload allowed? |
| --- | --- | --- | --- |
| `found`: exactly one match, full interval inspected | `record_confirmed` | `ingest_upload_record` | never needed |
| `not_found_confirmed`: full interval, no match, marker ≥ 3 h after attempt start | `abandon` | `abandoned` → `upload_failed` | only now, explicitly |
| `not_found_confirmed`: marker within the grace period | `wait` | unchanged (`uploading`/`uncertain`) | no |
| `ambiguous`: two matches, or same token and different size | `review` | `permanent` → `blocked` | no |
| `incomplete`: floor unknown, marker ≤ floor, interval > 2000 ids, uninspectable id | `hold` | `uncertain` (+ reason code) | no |
| `permission_blocked` | `hold` | `uncertain` (+ reason code) | no |
| `rate_limited` / `transient` | `retry_later` | unchanged | no |

The 3-hour grace period is unchanged. It is now measured from the attempt's start to
the marker's post time, both on the uploader's clock. A scan inside the grace period
can establish `found`. Absence inside it only means `wait`, because the local server
may still post the file after the marker. `uploading` and `uncertain` both make the
database refuse a new `ingest_upload_start`, so a hold or a retry cannot turn into a
blind restart.

### Pacing and rate limits (`DEFAULT_RECOVERY_PACING`)

- 3 s between probes (about 20 forwards per minute into the recovery group).
- A 429 whose `retry_after` is at most 120 s is waited out (`retry_after` + 1 s)
  on the same id, at most 5 times per scan. A longer or missing `retry_after`, or a
  sixth 429, ends the scan as `rate_limited`.
- A transient failure is retried on the same id after 5 s, 10 s and 20 s, then the
  scan ends as `transient`.
- The largest interval is 2000 ids (about 1 h 40 min at this pace). A larger one is
  `incomplete/interval_too_large` and needs an operator.

Recovery is slow on purpose. A rate limit is never read as "not found".

## Lower bound on a fresh machine: migration 10 required (proposed, not created)

> Superseded by C2B.1B (below), which implemented migration 10. Its design differs
> from this proposal where noted there.

Migration 9 state is **not** enough for a safe floor without the journal.
`ingest_upload_status` returns neither the attempt's start time nor any channel
position. Uploaded rows from other sources cannot be ordered against the uncertain
attempt either: the local server can post an uncertain file after later uploads
finished. Without the journal, recovery therefore holds (`floor_unknown`): safe, but
unresolvable until the journal is restored or migration 10 lands. A first-ever upload
into a channel has the same problem (journal floor 0).

Proposed migration 10 (awaiting authorization; nothing written):

```sql
-- 1. Operator-verified per-channel checkpoint (for example, the id of a marker
--    posted while configuring the channel). Advance-only.
alter table private.telegram_channels
  add column recovery_floor_message_id bigint not null default 0
    check (recovery_floor_message_id >= 0);

-- 2. Per-attempt floor, captured by ingest_upload_start in the same transaction:
--    greatest(channel checkpoint, max(message_id) of private.telegram_media in that
--    bot/channel). Every such message existed before the attempt, so the file's id
--    is larger. Captured per attempt, it never moves.
alter table private.ingestion_events
  add column upload_floor_message_id bigint
    check (upload_floor_message_id is null or upload_floor_message_id >= 0);
-- (uploader shape check: not null for uploader rows; hosted has 0 uploader rows.)

-- 3. ingest_upload_start sets upload_floor_message_id (create or replace, same signature).
-- 4. ingest_upload_status also returns upload_started_at and upload_floor_message_id
--    (return type changes: drop + create, then re-revoke and re-grant service_role).
-- 5. New public.ingest_channel_checkpoint(p_bot_type text, p_chat_id bigint,
--    p_message_id bigint) returns bigint: advance-only; refuses
--    (ingest_illegal_transition) while any uploader row for that bot is
--    uploading or uncertain, so the checkpoint never passes an unresolved upload.
--    SECURITY DEFINER, search_path '', EXECUTE service_role only.
```

With it, the floor is `max(journal floor, server floor)`: both are safe, so their
maximum is safe. The server attempt start replaces the journal's, so a fresh machine
can reconcile from the server alone. The code keeps the floor in one function
(`attemptFloor`, `lib/uploader/upload.ts`), where the server value would be added.

## Docker topology for the local Bot API server (implemented in C2B.2A)

```
Windows Node uploader (npm run ingest)
  -> http://127.0.0.1:8081            TELEGRAM_BOT_API_URL (loopback only)
  -> Docker: telegram-bot-api --local  port published as 127.0.0.1:8081:8081
  -> Telegram
```

- Publish the port on loopback only (`127.0.0.1:8081:8081`), never `0.0.0.0`. The
  adapter already refuses plain HTTP to any non-loopback host.
- Persistent server state (`--dir`, the bot sessions) goes in the Docker named volume
  `velora-telegram-bot-api-state`, mounted at `/var/lib/telegram-bot-api`. It survives
  container restarts and recreation and is never committed. It must not be a Windows
  bind mount, where TDLib aborts on the first bot login (see "C2B.2B").
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` go to the container only, not to the Next.js
  app.
- Future media mapping, not yet in use: `G:\Movies` mounted read-only at
  `/media/movies`, with `TELEGRAM_BOT_API_PATH_MAP=G:\Movies=>/media/movies`. Do not
  assume `G:` is shared with Docker Desktop until it is checked. No media validation
  against it yet.
- Image: no official image exists. C2B.2A builds Telegram's own source instead of
  using a community image (see "C2B.2A").
- A container restart drops in-flight uploads. They surface as `uncertain` and go
  through the marker protocol above.

## Operational status

| Item | Status |
| --- | --- |
| `TELEGRAM_MOVIES_CHANNEL_ID` / `TELEGRAM_SERIES_CHANNEL_ID` in `.env.local` | Corrected locally (leading `-` added); both valid `-100…` and distinct. Not committed |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | **Absent**: manual prerequisite (my.telegram.org, API development tools) |
| `TELEGRAM_RECONCILE_CHAT_ID` | **Absent**: the operator creates "Velora Ingestion Recovery" with both bots and the operator; its numeric id and the bots' post/forward permissions must be verified. Operational preflight stays blocked until then |
| `TELEGRAM_BOT_API_URL` | Absent until the Docker server exists |
| Recovery markers posted to real channels | None |
| `logOut`, `sendDocument`, any Telegram write | None |

## Tests

- `lib/ingestion/recovery.test.ts` (new, 27): target just below the marker and far
  below it; gaps of more than 20, more than 100 and about 390 deleted ids; other
  files and text ignored; full-interval confirmation; duplicate and size-mismatch
  ambiguity; service or non-forwardable ids; a rate limit and a transient failure
  halfway through (recovered and persistent); permission failures at the access,
  marker and probe stages; marker failures; unknown floors; marker at or below the
  floor; oversized interval; pacing. An exhaustive check puts every failure kind at
  every position of an interval and never gets `not_found_confirmed` or `found`.
  Also marker content and the decision table, including grace.
- `lib/telegram/local-bot-api.test.ts`: probe classification by status code (only
  the exact not-found text is `missing`); the access check (read-only, per-kind bot,
  protected channel); marker posting (Movies bot → Movies channel, Series bot → Series
  channel, text-only body, non-marker text refused offline, reply validation); and
  the whole protocol over the real client against a fake server that refuses every
  delete (150-id gap found; nothing deleted from the channel; no media sent).
- `lib/uploader/uploader.test.ts`: end to end over the journal and the fake worker
  store. Covers a gap longer than 20; a fresh machine with a lost journal (hold, no
  marker, no probe, no upload); a journal floor of 0; an uninspectable hold that stays
  `uncertain`; rate-limit and permission holds; no delete capability; per-kind bot
  routing; and `REAL_TELEGRAM_UPLOADS_AUTHORIZED === false` with no recovery call
  when disabled.

Mutation check (each mutant applied alone, recovery, uploader and transport tests
run, file restored): 16 of 16 killed. The mutants: the 20-id and 100-id gap
heuristics; uninspectable, rate-limited, persistently transient and permission
results counted as inspected; the interval ending one id early; an unknown floor
scanning from id 1; an incomplete scan abandoning; the grace period ignored; a
marker below the floor accepted; "can't be forwarded", 429 and 5xx read as missing;
the marker sent to the other kind's channel; protected content not detected.

# C2B.1B — Migration 10: durable Telegram recovery bounds

Date: 2026-09-25. Branch: `phase-a-foundation`, remote at `6dc9141`, with C2B.1A
(`102c6cf`, `d9cbe35`) and this checkpoint local and not pushed. Migration 10,
`20260925194322_ingestion_recovery_bounds.sql`, is **local only, not deployed**.
No Telegram call, no hosted change, no channel configured.
`REAL_TELEGRAM_UPLOADS_AUTHORIZED` is still `false`.

This supersedes the "migration 10 required (proposed)" section of C2B.1A. Crash
recovery no longer depends on the local journal: a fresh machine resumes from
Supabase state alone.

## Schema change

| Object | Change |
| --- | --- |
| `private.telegram_channels.checkpoint_message_id` | `bigint not null default 0`, CHECK `between 0 and 2147483647` |
| `private.ingestion_events.upload_floor_message_id` | `bigint`, CHECK null, or (`origin = 'uploader'` and `between 1 and 2147483647`) |
| `private.guard_upload_floor()` + trigger | The floor may change only when the attempt count increases (`ingest_recovery_floor_immutable`) |
| `private.guard_channel_checkpoint()` + trigger | The checkpoint never decreases (`ingest_checkpoint_regression`). Changing a bot's `chat_id` resets it to 0, and is refused while that bot has an unresolved upload |

Existing rows get no floor: nothing is fabricated. Hosted had 0 ingestion rows.
An unresolved uploader row without a floor fails closed: status reports
`null`, the worker holds, and the checkpoint cannot advance past it.
`private.ingestion_events` stays the single lifecycle root. There is no new table
and no second lifecycle.

## Worker commands (all `public`, SECURITY DEFINER, owner `postgres`, `search_path = ''`)

| Command | Change |
| --- | --- |
| `ingest_upload_start(p_source_fingerprint text, p_bot_type text, p_chat_id bigint, p_source_size_bytes bigint) returns table (upload_state text, upload_attempt_count integer, upload_floor_message_id bigint)` | Same arguments. Computes, persists and returns the floor. Dropped and recreated (the return type changed) |
| `ingest_upload_status(p_source_fingerprint text, p_bot_type text)` | Also returns `upload_started_at timestamptz`, `upload_age_seconds bigint` and `upload_floor_message_id bigint`. Dropped and recreated |
| `ingest_upload_record(…15 arguments…) returns text` | Same signature. A message at or below the attempt's floor returns `conflict` (review, `recovery_floor_not_below_message`) and is never recorded |
| `ingest_upload_fail(text, text, text, text)` | Unchanged; it never touches the floor |
| **New** `ingest_channel_checkpoint(p_bot_type text, p_chat_id bigint, p_message_id bigint) returns bigint` | Advance-only checkpoint (below) |

New error codes: `ingest_recovery_floor_unknown` (start with no checkpoint and no
recorded message in the channel), `ingest_recovery_unresolved` (a checkpoint advance
while an upload in that channel is unresolved).

## Floor semantics

When a new attempt starts, the server computes, in the same transaction:

```
floor = greatest(channel checkpoint,
                 max(message_id) of private.telegram_media for that bot and channel)
```

- Every message counted was posted before this transaction. A recorded message was
  posted before it was recorded; a checkpoint was observed before it was reported.
  The file is sent only after `ingest_upload_start` returns, so its id is larger than
  the floor.
- A floor of 0 (a new channel with no checkpoint) refuses the start. The operator
  seeds the checkpoint once with an id seen in the channel
  (`npm run ingest -- checkpoint --kind movie --message-id <n> --execute`). A new
  channel's first message, the service message "channel created", is id 1.
- The caller never supplies a floor: `ingest_upload_start` has no such argument,
  service_role has no table privilege, and the trigger blocks any in-attempt change.
- **Attempts.** A new floor is assigned exactly when a new attempt starts: the first
  start, or a retry from `upload_failed` (a definite failure, or a verified-absent
  abandonment). `uploading` and `uncertain` cannot restart (migration 9), so an
  unresolved attempt keeps its floor through holds, retries of recovery and newer
  uploads. `ingest_upload_fail` and `ingest_upload_record` never change it.

## Checkpoint invariant

> Every Telegram message id at or below a channel's checkpoint was posted before
> every upload attempt that is still unresolved (`uploading` or `uncertain`) in that
> channel, and before every attempt started after the checkpoint was set.

The checkpoint does not prove that those messages still exist; deleted messages do
not affect it. It is only a safe scan floor.

`ingest_channel_checkpoint`:

1. validates the arguments (bot type, a channel, an id in `1..2^31-1`);
2. takes the channel's lock exclusively;
3. resolves the allow-listed channel for that bot and `chat_id`
   (`ingest_channel_not_allowed` otherwise), and locks its row;
4. treats an id at or below the current checkpoint as a no-op: it returns the
   current value, never regresses, and is safe to replay;
5. refuses (`ingest_recovery_unresolved`) while any uploader row for that bot is
   `uploading` or `uncertain`. `blocked` rows belong to a reviewer and need no scan;
6. otherwise advances, and returns the new checkpoint.

**Trust boundary.** The worker (service_role) reports ids it observed; the database
cannot check them against Telegram. It decides only whether advancing is safe:
monotonic, the right channel, and no unresolved upload. So a buggy or malicious
worker can never move the checkpoint past an existing unresolved upload. An id
reported too high affects only later attempts, and it fails closed:
- a marker at or below the floor makes the scan `incomplete`;
- a successful `sendDocument` at or below the floor goes to review in
  `ingest_upload_record`.

The uploader reports a marker only after the resolution it closed was recorded
on the server. The report is best effort: a refusal or an outage only keeps later
floors lower, which means a longer scan, never a skipped id.

## Concurrency model

`ingest_upload_start` takes `pg_advisory_xact_lock_shared(1001, k)`, and
`ingest_channel_checkpoint` takes `pg_advisory_xact_lock(1001, k)`, where k is 1 for
movie and 2 for series. Both take the lock before reading any checkpoint, media or
upload state, and hold it to the end of the transaction. Plpgsql under READ
COMMITTED takes a new snapshot per statement, so every read after the lock sees what
committed before it.

| Interleaving | Outcome |
| --- | --- |
| Start A holds the lock; checkpoint B arrives | B waits. Then it sees A's `uploading` row and refuses |
| Checkpoint B holds the lock; start C arrives | C waits. Then it reads B's committed checkpoint. Safe: B's id was observed before C began |
| Start A and start C together | Shared locks: both proceed. Each floor is computed from committed state only; a smaller floor is always safe |
| A becomes `uncertain` (fail) | No lock needed. `uncertain` still blocks any advance, and A's persisted floor is untouched |
| A's record commits during C's start | C may miss it; its floor is only lower (safe). A's own floor is fixed |

pgTAP proves the lock contention with a second, independent session (dblink with a
300 ms `lock_timeout`). With this transaction holding the start and checkpoint
locks, the other session's checkpoint advance and its start both fail with `55P03`.
A different lock key is free, which rules out a broken session. The orderings above
are also run sequentially.

## Fresh-machine recovery (`resolveRecoveryFloor`, `lib/ingestion/recovery.ts`)

1. The uploader starts an attempt. The server persists the floor, and the journal
   stores a copy (`recoveryFloorMessageId`).
2. The process crashes, and the whole journal is lost.
3. On another machine, `scan` recreates the entry, and `resume --server` or
   `--execute` checks every entry against the server. That matters because only the
   server still knows the upload is unresolved.
4. `ingest_upload_status` returns the state, the floor, `upload_started_at` and
   `upload_age_seconds`.
5. The worker posts a recovery marker, scans only `(floor, marker)`, and finds the
   file or rules it out (C2B.1A protocol).

Floor priority:
- The server floor is authoritative.
- The journal copy only corroborates: equal means proceed; lower or higher means a
  `reconcile_floor_conflict` hold with no Telegram call. The larger value is never
  chosen silently.
- No server floor (a pre-migration row) is a `reconcile_floor_unknown` hold.
- The journal's own `channelHighWater` is informational and never a floor.

The grace period uses the server's attempt age, read before the marker is posted and
placed on the uploader's clock, so clock skew between the machines cannot shorten
the 3 hours.

**The journal's reduced role.** It holds local paths, plans, the sendDocument reply
(replayed if the server missed it) and a copy of the floor. None of it is required
for safety. Losing it costs a rescan, and nothing else.

## Tests

- pgTAP `006_ingestion_recovery_bounds.test.sql` (81). It covers:
  - schema and checks;
  - start refused without a floor;
  - checkpoint validation, wrong or unconfigured channel, advance, lower and equal
    no-ops, and owner regression refused;
  - the floor persisted, returned, not forgeable and immutable, from the checkpoint
    or the highest recorded message, channel-scoped;
  - an unresolved attempt keeps its floor; a legitimate retry gets a new one;
  - `uploading`, `uncertain` and legacy floorless rows block the checkpoint;
    resolved and blocked rows do not;
  - evidence at the floor goes to review; a channel change resets the checkpoint;
  - fresh-machine status; lock modes and two-session contention;
  - the exact ACL of all five commands; trigger functions; private-table and column
    privileges; and the publication boundary.
- `005` is updated for migration 10: five worker commands, fixture checkpoints, and
  the start's third column. `003` adds `ingest_channel_checkpoint` to the reviewed
  SECURITY DEFINER set.
- `tests/integration/ingestion-recovery.test.ts` runs against local PostgREST with
  the real store and uploader and a fake Telegram. Machine A crashes uncertain and
  loses its journal. Machine B recovers from status alone: probes stay in
  `(500, 520)`, it records 512, and the checkpoint becomes 520.
- Unit tests cover `resolveRecoveryFloor`: agreement, lower and higher journal,
  missing server floor, and clock skew. End to end they cover journal present,
  absent, corrupt, lower, higher and empty; a new machine; a missing DB floor; a
  retry with a new floor; and checkpoint offers. The store maps the new rows and
  calls only the five commands. The CLI `checkpoint` command validates its input
  and fails closed without configuration.

## Deployment status

Migration 10 was first applied to the local stack only (clean bootstrap 1–10).
It was deployed to hosted in C2B.1C (below).
Afterwards, each channel's checkpoint must be seeded once before its first upload.

# C2B.1C — Hosted deployment of migration 10

Date: 2026-09-25. Branch: `phase-a-foundation`, 5 commits ahead of remote `6dc9141`
(not pushed). Status: **C2B.1C HOSTED DURABLE RECOVERY: PASS.** Migration 10 only.
No channel row, no checkpoint seeded, no Telegram call, no upload.

## Preflight (read-only MCP)

| Check | Observed | Status |
| --- | --- | --- |
| Repository | 5 ahead / 0 behind; the ahead set is exactly C2B.1A and C2B.1B. The only migration difference from the remote is the new migration 10; migrations 1–9 are unchanged | PASS |
| Hosted history | Exactly 9, ending `20260925004059`; migration 10 absent | PASS |
| Hosted data (aggregate counts) | `ingestion_events` 0, `telegram_media` 0, `metadata_match_candidates` 0, `telegram_channels` 0 | PASS |
| Migration 10 objects | None present before the push | PASS |
| Local gate | Clean bootstrap 1–10 and `npm run test:db`: 339 pgTAP tests pass | PASS |

## Pre-deployment source audit

- **Scope.** Two `alter table` changes add one column and one CHECK each. There are
  two invoker trigger functions with their triggers. `ingest_upload_status` and
  `ingest_upload_start` are dropped and recreated, `ingest_upload_record` is
  replaced, and `ingest_channel_checkpoint` is new. The rest is revokes and grants.
  `ingest_upload_fail` is untouched. No reference to any catalogue, VJ, watchlist,
  auth or `catalogue_access` object.
- **Channel-ID reset.** On an UPDATE that changes `chat_id`, the trigger sets
  `checkpoint_message_id` to 0, overriding any value set in the same statement.
  With an unresolved upload for that bot it refuses. So a checkpoint cannot follow a
  bot to another channel. The worker cannot trigger this:
  - it has no privilege on `private.telegram_channels`;
  - the only command that writes the table (`ingest_channel_checkpoint`) sets
    `checkpoint_message_id` alone, on the row it resolved by bot type and `chat_id`,
    and never touches `chat_id`.
  A newly inserted channel row starts at the default 0. Only the owner can insert,
  as part of operator configuration.
- **Record vs floor.** `ingest_upload_record` rejects `p_message_id <=
  upload_floor_message_id` for any source not yet uploaded. It marks the ingestion
  `needs_review` (`recovery_floor_not_below_message`), records nothing, and returns
  `conflict`. `upload_state` stays `uploading`/`uncertain`, so no restart is
  possible. The equality boundary (message id = floor) is a pgTAP case
  (`006`, "a message at the floor").
- **Zero floor.** `ingest_upload_start` raises `ingest_recovery_floor_unknown` when
  the computed floor is below 1, before any insert or update. With no channel
  configured it already fails earlier, with `ingest_channel_not_allowed`.
- **Locking.** Start takes `pg_advisory_xact_lock_shared(1001, k)` and checkpoint
  takes `pg_advisory_xact_lock(1001, k)`. Both compute k as 1 for movie and 2 for
  series, from the already-validated bot type, so a caller's string never becomes a
  lock key. Both take the lock after argument validation and before any read.
  `_xact_` locks are released at transaction end. The only other advisory locks in
  the schema (watchlist, search history) use the single-`bigint` form, which
  PostgreSQL keeps in a separate key space from the two-`int4` form, so they cannot
  collide. The SQL matches "Concurrency model" in C2B.1B.

## Deployment

- Supabase CLI `2.117.0` (`dist/supabase.js`, spawned without a shell),
  `db push --db-url` over the session pooler (port 5432), as for migration 9. The URL
  came from the local environment. It was never printed, and the output was
  redacted.
- Migration SHA-256 `2768e96f…a4b9dcf4`, equal to the `HEAD` blob immediately before
  the push.
- The dry run proposed exactly `20260925194322_ingestion_recovery_bounds.sql`, with
  no seeds and no roles. The push applied that one migration and exited 0.
- No configuration write went with it.

## Verification (read-only MCP)

| Check | Observed | Status |
| --- | --- | --- |
| History | 10 migrations, ending `20260925194322_ingestion_recovery_bounds` | PASS |
| `telegram_channels.checkpoint_message_id` | `bigint`, NOT NULL, default 0; CHECK `0 … 2147483647` | PASS |
| `ingestion_events.upload_floor_message_id` | `bigint`, nullable, no default; CHECK null, or (`origin = 'uploader'` and `1 … 2147483647`) | PASS |
| Migration 9 constraints and indexes | Origin, fingerprint, size, upload state, attempts, failure code, webhook/uploader shape CHECKs; both partial unique indexes; FK; update key: unchanged | PASS |
| Triggers | `ingestion_events_guard_upload_floor` → `private.guard_upload_floor()` and `telegram_channels_guard_checkpoint` → `private.guard_channel_checkpoint()`, both BEFORE UPDATE FOR EACH ROW. The functions are invoker, `search_path=""`, ACL `postgres=X/postgres` only | PASS |
| Five RPCs | Owner `postgres`, SECURITY DEFINER, `search_path=""`; signatures and return shapes as in the migration (`status` STABLE, others VOLATILE) | PASS |
| Function bodies | `md5(prosrc)` of all five RPCs and both trigger functions equals the local stack built from the repository | PASS |
| RPC ACL | `{postgres=X/postgres,service_role=X/postgres}` on all five; EXECUTE false for `anon`, `authenticated` and `PUBLIC` | PASS |
| Private privileges | `telegram_channels`, `ingestion_events`, `telegram_media`, `metadata_match_candidates`: no table or column privilege for `anon`, `authenticated`, `service_role` or `PUBLIC`; none has `USAGE` on `private`. RLS on, 0 policies | PASS |
| Publication boundary | No RPC or trigger body references `public.*`, `auth.*`, `catalogue_access`, publication, availability, rights, approval, VJs, watchlists or versions. No dynamic SQL. The new triggers are on private tables only | PASS |
| Inert state | `telegram_channels` 0, `ingestion_events` 0, `telegram_media` 0, `metadata_match_candidates` 0 | PASS |

## Advisors (compared with the pre-deploy baseline of the same session)

- Security: unchanged. There are 5 INFO `rls_enabled_no_policy` findings (the
  accepted deny-all `private` tables) and the accepted `record_search` /
  `trending_searches` WARN pairs. No finding mentions a migration-10 function or
  table.
- Performance: unchanged (2 composite-FK INFO, 12 unused-index INFO).
- New findings: none. Blocking findings: none.

## Hosted state now

- Fresh-machine durable recovery is available: an unresolved upload can be
  reconciled from `ingest_upload_status` alone.
- `private.telegram_channels` is intentionally **empty**, and every start and record
  fails closed with `ingest_channel_not_allowed`. Once a channel is configured, its
  checkpoint is 0, so starts still fail with `ingest_recovery_floor_unknown`
  until a checkpoint is seeded.
- **Checkpoints are intentionally unseeded.** Seeding is an operational
  prerequisite of Telegram setup. It needs a message id actually observed in that
  configured channel after the channel is verified. The id must never be guessed,
  derived from a URL, copied between Movies and Series, or taken from another
  channel.
- The Telegram bot migration (`logOut`, the local Bot API server) has **not**
  begun. `REAL_TELEGRAM_UPLOADS_AUTHORIZED` is still `false`.

# C2B.2A — Local Telegram Bot API infrastructure

Date: 2026-09-26. Branch: `phase-a-foundation` (from `49e9121`, not pushed). Status:
**C2B.2A LOCAL BOT API INFRASTRUCTURE: PASS.** The server is built, running and
restart-tested. Both bots are **still on the cloud Bot API**: no `logOut`, no Telegram
write, no upload, no marker, no hosted configuration.

## Source provenance

| Item | Value |
| --- | --- |
| Upstream | `https://github.com/tdlib/telegram-bot-api` (owner `tdlib`, not a fork, BSL-1.0). No third-party image |
| Release | Bot API **10.3**. Upstream publishes no tags or GitHub releases; each release is its "Update version to X." commit, and `CMakeLists.txt` at that commit declares `VERSION 10.3` |
| Pinned commit | `2efabc722e9493b9cac450233198d09e5cea0573` (levlam, 2026-08-24, "Update version to 10.3."). `master` was one commit ahead (`e3e9dd8`, "Fix RichBlockDocument."), which is not a release and is not used |
| td submodule | `bc9c263e2bfee06aaab41e82db51a103376030bc`, from `https://github.com/tdlib/td.git`, the gitlink recorded by the pinned commit |
| Base image | `debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a` (multi-arch index), for both stages |
| Build date | 2026-09-26 (image created 2026-09-25T21:56:49Z) |
| Local image | `velora/telegram-bot-api:10.3-2efabc722e94`, id `sha256:1c55f8266c6dd50c46926bed438be6a08818433ebb22929f6a6c752179179c1d`, 44.7 MB; `--version` prints `Bot API 10.3` |

Supply-chain checks:

- Repository metadata, the commit list and `CMakeLists.txt` were read before building.
  The command-line options were confirmed in the pinned `telegram-bot-api.cpp`, not
  taken from memory. The server reads `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` from its
  environment, so no secret goes into argv.
- The Dockerfile fetches exactly the two pinned commits (`fetch --depth 1 <sha>`). It
  fails the build unless `HEAD` equals the pin, and unless the superproject's td
  gitlink equals the td pin. No script is downloaded or piped into a shell.
- Build dependencies are the official Debian list from the upstream `build.html`
  (`make git zlib1g-dev libssl-dev gperf cmake g++`) plus `ca-certificates`. Apt
  packages come from Debian's signed repositories and are not version-pinned.
  Rebuilding later can pick up Debian security updates, but never a different Bot
  API source.
- The pins change only by a reviewed edit to `infra/telegram-bot-api/Dockerfile`.
  Update them deliberately, never silently.

## Files

| File | Purpose |
| --- | --- |
| `infra/telegram-bot-api/Dockerfile` | Two stages. The build stage has only the official build dependencies; the runtime stage has `ca-certificates`, `libssl3t64`, `zlib1g` and the stripped binary. Non-root user 10001; TCP health check; no credential, token, channel id or path baked in |
| `infra/telegram-bot-api/compose.yaml` | `--local --dir=/var/lib/telegram-bot-api --temp-dir=/tmp/telegram-bot-api --http-port=8081`. Publishes `127.0.0.1:8081` only. Also sets a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, a 256 MB tmpfs temp dir, bounded local logs and `restart: unless-stopped` |
| `infra/telegram-bot-api/compose.media.yaml` | Optional override: `G:\Movies` → `/media/movies`, read-only, `create_host_path: false` |

## Runbook

From the repository root:

```
docker compose --env-file .env.local -f infra/telegram-bot-api/compose.yaml up -d --build
docker compose --env-file .env.local -f infra/telegram-bot-api/compose.yaml ps
docker compose --env-file .env.local -f infra/telegram-bot-api/compose.yaml restart
docker compose --env-file .env.local -f infra/telegram-bot-api/compose.yaml down
```

- `--env-file .env.local` only supplies interpolation. The container receives
  exactly `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`, never tokens, Supabase keys or
  channel ids. Without it, compose refuses to start (`TELEGRAM_API_ID is required`).
- State lives in the named volume `velora-telegram-bot-api-state` (C2B.2B replaced
  the original `C:\velora-ops\telegram-bot-api` bind mount). It holds the bots'
  sessions, and the server names each bot's directory **after its full token**. So
  treat the volume as a secret: never list its directories into a log or chat,
  copy it or share it. Never run `down -v`, which deletes it and every session.
- Once `G:\Movies` is mounted, add `-f infra/telegram-bot-api/compose.media.yaml`
  (`VELORA_MEDIA_MOVIES_DIR` overrides the source). While the drive is absent, leave
  the override out: the base server runs without it, and Docker cannot invent an
  empty library.
- **Secret exposure rules:** `docker inspect velora-telegram-bot-api` shows the
  container's environment (API id and hash), because they are supplied at runtime,
  and `docker compose config` prints them after interpolation. Use
  `docker compose config --quiet` or `--no-interpolate`, and never paste `inspect`
  output. The server log, `compose ps`, the image history and the image metadata
  contain no secret (verified below).

## Uploader configuration (`.env.local`, not committed)

| Variable | State |
| --- | --- |
| `TELEGRAM_BOT_API_URL` | `http://127.0.0.1:8081` (loopback, accepted by `parseBotApiBaseUrl`) |
| `TELEGRAM_RECONCILE_CHAT_ID` | Set to the verified recovery supergroup (value kept out of Git) |
| `TELEGRAM_BOT_API_PATH_MAP` | `G:\Movies=>/media/movies` (single-quoted, so the backslash is literal) |
| `TELEGRAM_MOVIES_CHANNEL_ID` / `TELEGRAM_SERIES_CHANNEL_ID` | The leading `-` was missing again and is restored. The signed `-100…` form was confirmed with `getChat` for each bot before the edit |

`loadLocalBotApiConfig` accepts the whole configuration from `.env.local`. The
recovery chat differs from both catalogue channels.

## Path translation

- The uploader sends `file://<server path>`. In the pinned source,
  `Client::get_local_file_path` strips `file:/` and one more `/`, then URL-decodes.
  So `G:\Movies\Sample (2020)\x.mkv` becomes `/media/movies/Sample (2020)/x.mkv`
  inside the container, which is the mounted path.
- **Defect found and fixed.** `toServerFileUri` checked the prefix before
  normalizing. `G:\Movies\..\..\var\lib\telegram-bot-api\x.mkv` passed and became
  `file:///var/lib/telegram-bot-api/x.mkv`: the server's own `--dir`, where the bot
  sessions will live. Any path containing a `.` or `..` segment is now refused,
  mapped or not (`path_outside_server_map` at preflight). Names such as `A..B.mkv`
  are unaffected.
- Only the configured root is translated; `G:\MoviesX\…`, another drive or the root
  itself return null. Matching on a drive-letter map is case-insensitive.
- A new test in `lib/telegram/local-bot-api.test.ts` covers this. Mutation check:
  disabling the guard fails the new test, and restoring it passes (52 of 52).
- **Second defect found and fixed (closeout).** The map's roots were never
  validated. A server root of `/` or empty turned
  `G:\Movies\var\lib\telegram-bot-api\x` into `file:///var/lib/telegram-bot-api/x`,
  and a local root of `G:` or empty widened the map to a whole drive. Both roots are
  now structural checks, and unsafe roots are refused, never repaired.
  `loadLocalBotApiConfig` fails on either one, and `toServerFileUri` refuses every
  path under one:
  - local (`isSafeLocalRoot`): a drive-letter absolute path with at least one
    directory; no UNC, `\\?\` or `\\.\` path, bare drive, relative path, empty,
    `.` or `..` segment, or `:` after the drive;
  - server (`isSafeServerRoot`): an absolute POSIX path with at least one directory;
    no `/`, relative path, empty, `.` or `..` segment, or backslash. It must not
    equal, contain or sit inside the server's `--dir` (`/var/lib/telegram-bot-api`)
    or `--temp-dir` (`/tmp/telegram-bot-api`).

  Even without a map, a translated path never lands in either directory. One
  trailing separator on a root is still accepted. Five new tests cover this; each
  guard, and the earlier dot-segment guard, was mutation-checked (disabled: the
  tests fail; restored: 57 of 57).

## Recovery group

- **Discovery.** Read-only `getUpdates` with no offset, so nothing was acknowledged.
  Both bots observed "Velora Ingestion Recovery". It was created as a basic group
  and migrated to a **supergroup** (`migrate_to_chat_id`/`migrate_from_chat_id`); the
  supergroup id is the one stored. The basic-group id is dead and must not be used.
- **Commands observed.** The two operator messages each contained
  `/start@velora_movies_bot /start@velora_series_bot`. The movies username in them
  is misspelled (the bot is `@veloramovies_bot`). The movies bot saw the messages
  anyway because it is an administrator. Identity rests on `getChat` and
  `getChatMember` below, not on the command text. The two `/start` messages were not
  deleted.
- **Verification** (`getChat`, `getChatMember`, `getChatAdministrators`,
  `getChatMemberCount`, all read-only):
  - both bots resolve the same id: type `supergroup`, the expected title, private, no
    content protection;
  - 3 members: the operator (creator) and the two bots, so no third bot is present;
  - both catalogue channels have content protection off, so forwarding works.
- **Permissions the protocol needs.** In the group: send messages including
  forwarded media, and delete the bot's own forwarded copy (best effort; not needed
  for correctness). The group's default member permissions already allow sending
  messages, documents and videos, and a bot can delete its own messages without
  admin rights. In each catalogue channel: post (the text marker), which each bot
  has as that channel's administrator; `forwardMessage` from it also works.
- **Least privilege (operator action, not a blocker).** Both bots are currently
  **administrators** of the recovery group with broad rights (manage chat, restrict
  members, invite, change info). The protocol does not need any of them. Demote both
  to ordinary members before the bot migration.

## Runtime verification

| Check | Result |
| --- | --- |
| Engine | Docker 28.4.0, Linux containers (linux/amd64), 6 CPUs, 16 GB; 91.7 GB free on C: |
| Container | `Up (healthy)`; user 10001; `ReadonlyRootfs=true`; `CapDrop=[ALL]`; `no-new-privileges` |
| Binding | Port binding `127.0.0.1:8081` only. The Windows listener is `127.0.0.1:8081` (`com.docker.backend`). Loopback connects and `GET /` returns 404 from the server. Every non-loopback IPv4 (Ethernet LAN, WSL vEthernet, link-local) refuses |
| Local mode | `--local` in the container command; the source confirms 2000 MB uploads and `file:` input under it |
| State | The server created `tqueue.binlog` and `webhooks_db.binlog` in the host state directory |
| Restart | A sentinel written by the container survived `compose restart` (same container) and `down` + `up` (new container), with the server binlogs; removed afterwards |
| Read-only | Writes to the image filesystem and to `/media/movies` fail (`Read-only file system`) |
| Media | `G:` is not mounted. No fake `G:\Movies` was created; the override is prepared, not used |
| Secret scan | The values of the API hash, both bot tokens, the service-role key, database URLs and the TMDB/Resend/Supabase tokens, plus the API id and the three chat ids, were searched for in the server log, image history, image metadata, `compose ps`, the build log and every repository change: none found. As expected, only `docker inspect` of the container shows the API id and hash (see the exposure rules) |

## Cloud/local boundary

Both bots are still logged in to `api.telegram.org`, and the local server has no bot
session. Using a bot through the local server needs `logOut` against the cloud first.
That is the bot migration, which needs its own authorization. After it, a bot
cannot return to the cloud for 10 minutes, and its session lives in the state
directory. Nothing in this checkpoint used a bot token against the local server.

## Unchanged

- Hosted: 10 migrations (ending `20260925194322`); `private.telegram_channels` 0 rows,
  `ingestion_events` 0, `telegram_media` 0 (read-only query). No checkpoint is seeded.
- `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false` (`lib/uploader/upload.ts`), so
  `upload --execute` and `resume --execute` remain impossible.
- Telegram calls made: read-only only (`getMe`, `getWebhookInfo`, `getChat`,
  `getChatMember`, `getChatAdministrators`, `getChatMemberCount`, and `getUpdates`
  without an offset). No `logOut`, `sendMessage`, `sendDocument`, `forwardMessage` or
  `deleteMessage`.

## Tests

`npm test` 264, `npm run test:db` 339 pgTAP, `npm run test:catalogue` 30, `lint`,
`typecheck` and `build`: all pass.

## Next (not authorized here)

1. Demote both bots to ordinary members of the recovery group.
2. Bot migration: `logOut` each bot once against the cloud, then `getMe` through
   `127.0.0.1:8081`.
3. Configure the hosted `private.telegram_channels` rows and seed each checkpoint
   from a message actually observed in that channel.
4. Mount `G:\Movies`, then run the trial in "C2B prerequisites" step 7.

# C2B.2B — Movies bot migration (BLOCKED, then recovery preparation)

Status: **the Movies bot is logged out of the cloud and not yet running locally.**
Series is untouched on the cloud. No upload, marker, forward or checkpoint.

## Identities

The numeric id is the primary assertion and the exact username the secondary one.

| Bot | Telegram username | Note |
| --- | --- | --- |
| Movies | `@veloramovies_bot` | Its BotFather display name is `velora_movies_bot`; that is not its username |
| Series | `@velora_series_bot` | |

## Attempt (2026-09-26)

- Preflight passed:
  - cloud `getMe` returned the expected id and username;
  - the bot is Movies-channel administrator with `can_post_messages`, and the
    channel is unprotected;
  - it is an ordinary member of the recovery group, which is private;
  - no webhook on either bot;
  - hosted is empty, and the flag is `false`.
- Cloud `logOut` for Movies only: `{"ok":true,"result":true}` at
  **2026-09-26T07:49:08Z**. It abandoned the 13 unacknowledged cloud updates, which
  nothing consumes.
- The first local `getMe` failed. TDLib aborted (SIGABRT) with `Failed to rename
  binlog … Stat for file ".../td.binlog" failed`, and Docker restarted the server.
- Stopped as required: no retry, no cloud fallback, Series untouched.

## Cause and fix

- The state directory was a Windows bind mount, and TDLib renames its binlog while
  the file is still open. On Docker Desktop's Windows file sharing, a `stat` after
  such a rename returns ENOENT, although the rename did happen on disk.
- A probe in the same image, with no network and a synthetic token-shaped directory,
  reproduced it: rename-then-stat with the file held open failed 5/5 on a bind mount
  and succeeded 5/5 on a named volume. C2B.2A's restart test had covered only the
  server's own empty binlogs, never a bot session, so it could not catch this.
- Fix: `infra/telegram-bot-api/compose.yaml` now uses the named volume
  `velora-telegram-bot-api-state`. After recreation:
  - the server user owns the state directory;
  - the probe passes 5/5 on the live volume;
  - a sentinel survived `up --force-recreate` and was then removed;
  - the container is healthy, loopback-only, `--local`, Bot API 10.3.
- The old bind directory is no longer mounted. It still holds the failed session
  (one 128-byte `td.binlog`, in a directory named after the old token). Delete it
  only after the token is revoked.

## Token exposure

The Movies token was printed into an operator session: a listing of the state
directory showed the token-named session directory. It is not in Git, a log file or
any external service.

**Rotated** in @BotFather, and `.env.local` was updated.
- The old token is confirmed revoked: cloud `getMe` returns `401 Unauthorized`.
- The new token returns the same numeric id and `veloramovies_bot`.
- The failed session directory (named after the old token) was then deleted from the
  old bind directory.
- On Windows, Docker Desktop stores the `:` in such names as U+F03A (the Cygwin
  convention). Node's `rmSync` reported success but did not remove it; Git Bash did.

## Per-bot local gate

Before this change, `TELEGRAM_BOT_API_URL` applied to both bots and the gate was only
`REAL_TELEGRAM_UPLOADS_AUTHORIZED`. Once uploads were enabled, a Series command would
have logged the Series bot in on the local server while it was still live on the
cloud. Now:

- `TELEGRAM_BOT_API_LOCAL_BOTS` lists the migrated kinds (`movie`, `series`). Unset
  means none.
- An unlisted bot is refused with `bot_not_on_local_server` before any request. This
  covers preflight, `sendDocument`, access checks, markers and probes.
- A listed bot needs `TELEGRAM_{MOVIES,SERIES}_BOT_ID` and
  `TELEGRAM_{MOVIES,SERIES}_BOT_USERNAME`. The config refuses an id that is not the
  one its token carries.
- Before a bot's first call, the client runs `getMe` and requires the exact id,
  `is_bot` and the exact username. Otherwise the result is `bot_identity_mismatch`,
  and nothing is sent. Only a success is cached, once per client; a failed check is
  retried on the next call.
- The split state is therefore
  `TELEGRAM_BOT_API_LOCAL_BOTS=movie`: Movies goes to the local server, and Series
  is refused locally and stays on the cloud.
- `.env.local` currently lists no bot, so both are refused.

Five tests cover the gate. Each gate element was mutation-checked: disabled, the
tests fail; restored, they pass.

## Resuming the migration (needs authorization)

1. ~~Rotate the Movies token, update `.env.local` and delete the old failed session
   directory.~~ Done.
2. With the new token, which is live on the cloud: cloud `getMe`, then `logOut`.
3. Only after the `logOut`, set `TELEGRAM_BOT_API_LOCAL_BOTS=movie`. The list
   records completed migrations, never intended ones. Then verify the bot through the
   local server:
   - local `getMe`;
   - Movies channel and recovery group, read-only;
   - session survival across a restart and an `up --force-recreate`.
