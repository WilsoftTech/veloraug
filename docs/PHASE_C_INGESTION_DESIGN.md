# Phase C — Telegram Ingestion: Contract and Pipeline Foundation (C1)

Date: 2026-09-25
Baseline: `phase-a-foundation` at `0b70ac1` (Phases A and B complete). Hosted: 8 migrations.
Status: **C1 on the remote. C2A (transport, recovery, tooling) and C2A.1
(migration 9 worker boundary and RPC store) implemented and validated locally.
Migration 9 is not deployed; nothing is pushed; no real upload has happened.**

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

**Reconciliation contract.** The Bot API has no channel-history method. The probe
forwards message id *n* from the channel into the private `TELEGRAM_RECONCILE_CHAT_ID`
chat, where caption and file identity survive a forward. It reads the copy and
deletes it. It scans upward from the attempt's `channelHighWater`. Uploads are
serial, so the file, if posted, has a higher id. The end of the channel is 20
consecutive missing ids; the hard bound is 500 probes. Results:

- **confirmed**: exactly one match with equal size;
- **not_found**;
- **ambiguous**: more than one match, a size mismatch, or the bound reached (review,
  never upload);
- **unavailable**: a Telegram error (retry later).

The local server keeps uploading after the HTTP call times out, so `not_found` inside
the 3-hour grace period means **wait**, and after it, **abandon**. Abandoning only
permits a later explicit upload.

Limits: forwarding fails on channels with **protected content**. That is reported as
`channel_content_protected`, never as missing. Confirm the channel setting in C2B.
Probes are rate-limited like any bot call, and the bound keeps them few.

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
Status: **implemented and validated locally. Migration 9 NOT deployed. No real
upload. Not pushed.**

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

1. A separately authorized hosted deploy of migration 9. Before it, confirm
   read-only that hosted `ingestion_events` has no rows.
2. Configure `private.telegram_channels` (above) with numeric ids. The current
   `TELEGRAM_SERIES_CHANNEL_ID` in `.env.local` must be corrected first.
3. Set up the local Bot API server, `api_id`/`api_hash`, `logOut` for both bots and
   the reconciliation chat (see "C2B prerequisites" in C2A).
4. Flip `REAL_TELEGRAM_UPLOADS_AUTHORIZED` with the first authorized upload. Then
   do a crash drill and a near-ceiling file.
