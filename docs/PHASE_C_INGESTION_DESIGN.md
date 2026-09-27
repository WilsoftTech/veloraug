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

# C2B.2B — Movies bot migration (PASS)

Status: **PASS (2026-09-26).** The Movies bot runs on the local Bot API server and
its session survives restart and recreation. Series stays on the cloud on purpose.
The first attempt was blocked, as recorded below. The retry passed after the state
volume, token and gate were fixed ("Retry").

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
- The old bind directory is no longer mounted. The failed session left in it was
  deleted once the token was revoked (see "Token exposure").

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
- The list records completed migrations, never intended ones. `.env.local` listed no
  bot until the retry's cloud `logOut` succeeded. It now lists `movie` only.

Five tests cover the gate. Each gate element was mutation-checked: disabled, the
tests fail; restored, they pass.

## Retry (PASS, 2026-09-26)

Recovery preparation was committed first. The gate listed no bot, so config was
fail-closed.

1. **Fresh preflight passed.**
   - Cloud `getMe` with the rotated token returned the configured id,
     `is_bot: true` and `veloramovies_bot`.
   - Movies-channel administrator with `can_post_messages`; channel unprotected.
   - Ordinary member of the private recovery supergroup; no webhook on either bot.
   - Series healthy on the cloud.
   - Local server healthy: 10.3, `--local`, loopback only, named volume, hardening
     unchanged, no bot session.
   - Hosted empty; flag `false`.
2. **Cloud `logOut`, Movies only:** `{"ok":true,"result":true}` at
   **2026-09-26T08:23:06Z**. It was called once and was the only Telegram write.
3. **Gate:** only then was `TELEGRAM_BOT_API_LOCAL_BOTS=movie` set. On reload,
   Movies is local and Series is refused.
4. **Local identity:** the adapter's `checkIdentity`, through `127.0.0.1:8081`,
   passed: exact configured id, `is_bot`, exactly `veloramovies_bot`. The server did
   not restart.
5. **Movies channel, read-only through the local server:**
   - configured channel, bot is administrator with `can_post_messages`, not
     content-protected;
   - `checkRecoveryAccess` returned `ok`.
6. **Recovery group, read-only through the local server:**
   - configured private supergroup, no public username;
   - bot is an ordinary member with no admin rights;
   - members may send messages and documents, which is what forwarding and markers
     need.
7. **Session persistence, the test C2B.2A could not run:**
   - One bot session was created at the first local login.
   - After `compose restart`, and again after `up --force-recreate`, identity,
     channel and recovery-group checks passed.
   - Both times the same session was reused, not re-created: it is older than both
     container starts, and its binlog kept growing.
8. **Split routing:** Series calls through the adapter returned
   `bot_not_on_local_server` with no request made. Every recorded request was a
   Movies call to `127.0.0.1:8081`. The adapter has no cloud fallback.
9. **Safety:**
   - Series was never logged out and still answers on the cloud.
   - No `sendDocument`, upload, marker, forward or delete.
   - `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`.
   - Hosted: 10 migrations, `private.telegram_channels` 0 rows, no checkpoints,
     ingestion rows 0.

## Current state

| Item | State |
| --- | --- |
| Movies bot (`@veloramovies_bot`) | Local Bot API (`TELEGRAM_BOT_API_LOCAL_BOTS=movie`) |
| Series bot (`@velora_series_bot`) | Cloud Bot API, on purpose; refused locally (`bot_not_on_local_server`) |
| Real uploads | Disabled in code (`REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`) |
| Hosted channel allow-list (`private.telegram_channels`) | Empty; hosted uploads fail closed |
| Channel checkpoints | None seeded |
| Library mount (`G:\Movies`) | Not mounted |

## Next boundary (each step needs its own authorization)

The Movies path should be proven end to end before anything else changes. Series
migration is **not** automatically next: it is a separate decision, best taken once
the Movies path has passed its trial.

1. Register the Movies channel in hosted `private.telegram_channels`, and seed its
   checkpoint from a message id actually observed in that channel.
2. Mount `G:\Movies`, then run the Movies trial in "C2B prerequisites" step 7:
   - a scan;
   - one explicit small upload, which needs `REAL_TELEGRAM_UPLOADS_AUTHORIZED`
     enabled by a reviewed change;
   - a crash drill with `resume`;
   - a file near the ceiling.
3. Only then migrate Series. Repeat the same sequence (preflight, `logOut`, gate,
   identity, persistence), then register its channel.

# C2B.2C — Movies channel registration and checkpoint bootstrap (PASS)

Status: **PASS (2026-09-26).** The Movies channel is in the hosted allow-list, and
its first checkpoint comes from a marker the Movies bot deliberately posted, using
the id Telegram returned for it. Series is untouched. Real uploads stay disabled.
Production channel, group and message ids are deliberately not recorded here.

## Preflight

- **Git:** `phase-a-foundation` at `ed7bef2`, 0 ahead / 0 behind.
- **Local Bot API:**
  - Docker Desktop had stopped and was started; the container came back healthy on
    its own (`restart: unless-stopped`).
  - Image 10.3, revision `2efabc72`; `--local`; published on `127.0.0.1:8081` only.
  - Non-root, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`.
  - The named volume `velora-telegram-bot-api-state` is the one from C2B.2B.
- **Movies (read-only, through the local server):**
  - the adapter's `checkIdentity` and a raw `getMe` agree: the configured id,
    `is_bot`, exactly `veloramovies_bot`;
  - `getChat` returns the configured channel, type `channel`, not
    content-protected;
  - `getChatMember` shows the bot is an `administrator` with `can_post_messages`.
- **Recovery group:**
  - the configured private supergroup, with no public username;
  - the bot is an ordinary `member`;
  - `checkRecoveryAccess` returned `ok`.
- **Series:**
  - not listed in `TELEGRAM_BOT_API_LOCAL_BOTS`;
  - the adapter refuses it with `bot_not_on_local_server`, with no request made;
  - cloud `getMe` still answers as `velora_series_bot`.
- **Hosted (read-only):**
  - 10 migrations; every ingestion table has 0 rows; no unresolved upload.
  - `telegram_channels` has 0 rows. Its ACL is owner-only, RLS is on with no
    policies, and no client role has a grant or `USAGE` on `private`.
  - `ingest_channel_checkpoint` is owned by `postgres`, SECURITY DEFINER,
    `search_path=""`, and EXECUTE is `postgres`/`service_role` only.
  - The bodies of `ingest_channel_checkpoint` and `guard_channel_checkpoint` are
    MD5-identical to migration 10 in the repository.

## Registration (owner boundary)

- One `insert into private.telegram_channels (bot_type, chat_id)` for `movie`:
  - run as `postgres` through `psql` over the pooler, as "Channel allow-list
    configuration" prescribes;
  - the channel id was read from `.env.local` and never printed;
  - the transaction refused to run unless the table and `ingestion_events` were
    empty.
- Readback, both in the transaction and after commit: exactly one row, `movie`,
  channel equal to `TELEGRAM_MOVIES_CHANNEL_ID`, checkpoint `0`, no Series row.
- Nothing else is stored: no token, username, group id or path.

## Bootstrap marker

- **Re-verified first.** Identity, channel and posting rights were checked again,
  after registration and before the send.
- **Sent once.** One `sendMessage` from the Movies bot through the local server,
  with notifications off. The text is:

  ```
  velora-checkpoint:v1 bootstrap movies at=<ISO time> nonce=<8 hex>
  ```

  - It is distinct from `velora-recovery:v1`: `isRecoveryMarker` is false.
  - It is distinct from media captions: no `velora-src:` token, and
    `fingerprintFromCaption` returns null.
  - It carries no id, path or credential.
  - A local record was reserved before the call, so a rerun cannot send a second
    marker.
- **Reply validated before the id was used:**
  - `ok`, and a positive `message_id` in the checkpoint's range;
  - `chat.id` equals the registered channel, and `chat.type` is `channel`;
  - the text is exactly what was sent;
  - `sender_chat` is that channel, and `from`, if present, is the bot;
  - the date is within minutes of the send;
  - no media, not a forward.
- **Retained.** The marker stays in the channel and is not pinned. It is the
  external evidence for the first checkpoint.

## Checkpoint

- Seeded with `npm run ingest -- checkpoint --kind movie --message-id <id> --execute`,
  which is the service_role worker calling `ingest_channel_checkpoint`.
- The id was the marker's own returned id, not `+ 1`. The RPC returned that id.
- Readback (MCP and `psql`): one row, `movie`, the configured channel, and
  `checkpoint_message_id` equal to the marker id (> 0).
- Monotonicity was not exercised in production. pgTAP `006` covers a lower id
  (no-op), an equal id (no-op) and a direct regression (refused), and the
  hosted body is identical to the tested one.

## Writes

| Where | Writes |
| --- | --- |
| Telegram | Exactly one `sendMessage` (the bootstrap marker). No `sendDocument`, recovery marker, forward or delete |
| Hosted | Exactly two: the Movies channel insert (owner) and one checkpoint advance (RPC) |
| Repository | This record and the roadmap status line |

## State now

| Item | State |
| --- | --- |
| Movies bot | Local Bot API; channel registered; checkpoint seeded (> 0) |
| Series bot | Cloud Bot API; not registered; not logged out; no checkpoint |
| Ingestion rows | `ingestion_events` 0, `telegram_media` 0, `metadata_match_candidates` 0 |
| Real uploads | Disabled (`REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`) |
| Library mount (`G:\Movies`) | Not mounted |

A Movies `ingest_upload_start` would no longer fail with `ingest_channel_not_allowed`
or `ingest_recovery_floor_unknown`. Its floor would be the seeded checkpoint. No
start was made.

## Next boundary (needs its own authorization)

The controlled Movies trial ("C2B.2B", "Next boundary", step 2):
1. mount `G:\Movies`;
2. scan;
3. enable `REAL_TELEGRAM_UPLOADS_AUTHORIZED` through a reviewed change;
4. one small upload;
5. a crash drill;
6. a file near the ceiling.

Series comes after that.

# C2B.2C.1 — Ice P VJ catalogue bootstrap (PASS)

Status: **PASS (2026-09-27).** Hosted `public.vjs` now holds one active VJ, Ice P.
No upload, no Telegram call, no ingestion write.

## Why it was needed

C2B.2D stopped before any upload. Its trial movie parsed the VJ text `ICE P`, but
hosted `public.vjs` was empty. The resolver never creates a VJ, so it returned
`unresolved`. The planner therefore chose `upload_then_review` (`vj_unresolved`)
instead of `upload`.

## Representation

| Column | Value | Basis |
| --- | --- | --- |
| `name` | `VJ Ice P` | Repository convention: the dev seed uses `VJ Junior`/`VJ Emmy`, and the ingestion fixture uses `VJ Ice P` |
| `slug` | `vj-ice-p` | Same convention; satisfies the slug CHECK |
| `is_active` | `true` | |
| `badge_variant`, `sort_order` | Defaults (`blue`, `0`) | |
| `description`, `avatar_url` | Null | Nothing is known, so nothing was invented |

- **No aliases.** The schema has no alias column. None is needed, because the
  resolver's key covers every spelling in the library (below).
- **The dev seed is unchanged.** Its VJs are synthetic, and hosted ids are never
  copied into fixtures.

## Write boundary

- No client role can write `public.vjs`:
  - `anon` and `authenticated` may read the public columns only, filtered by
    `vjs: read active`;
  - `service_role` has no privilege on it.
- No admin write path exists yet; that is Phase G1.
- So the row was inserted by the owner through `psql` over the pooler, the same
  boundary C2B.2C used. The transaction refused to run unless `public.vjs` was
  empty.

## Normalization (proven against repository code, not assumed)

`vjKey` = `normalizeTitle` (lowercase; every run of non-alphanumerics becomes one
space), then drop a leading `vj` word, then remove spaces.

- The name and the slug both give `icep`.
- The five spellings `ICE P`, `Ice P`, `ICEP`, `ICE_P` and `VJ_ICEP` all give
  `icep`. `resolveVj` resolves each of them to the hosted row, with no ambiguity.
- All 14 files in the Movies library were checked too. `parseFilename` extracts
  `Ice P`, `ICE P` or `ICEP`, and every one resolves to the same row.

## Readback

- **Owner (MCP):** exactly 1 VJ, with the values above.
- **Anon REST (`/rest/v1/vjs`):** returns the row, so the public catalogue can
  read it.
- **Nothing else changed:**
  - movies, series, versions and genres: 0;
  - ingestion events, media and match candidates: 0;
  - one channel row (`movie`), with its checkpoint unchanged.

## Planner (dry run: `inspect`, no journal write)

The C2B.2D trial file was re-inspected, with the `--vjs` input built from the
hosted row.

| Check | Result |
| --- | --- |
| Kind | Movie, confirmed |
| Title | "On The Hunt" (2026) |
| VJ | `resolved` to `vj-ice-p` |
| TMDB match | Unchanged (score 1) |
| Duplicate | `none` |
| Action | **`upload`**, with no stop reasons |

## Safety

- Telegram writes: 0. Uploads and upload attempts: 0. Ingestion writes: 0.
- The Movies checkpoint is unchanged, and Series is untouched.
- `REAL_TELEGRAM_UPLOADS_AUTHORIZED = false`.
- The media mount was not needed for the dry run and was not added.

## Next

C2B.2D, the first controlled Movies upload, needs re-authorization. The
single-file selection gap it reported is still open:
- `scan` only walks directories;
- `upload --limit 1` takes journal entries in fingerprint order.

# C2B.2C.2 — Deterministic single-fingerprint upload selection (PASS)

Status: **PASS (2026-09-27).** This checkpoint changed code, tests and docs only.
No Telegram call, no hosted write, no upload. `REAL_TELEGRAM_UPLOADS_AUTHORIZED`
is still `false`.

## Why

C2B.2D could not choose its one authorized file.
- `scan` walks a whole directory, and every Movies file sits in one folder.
- `upload --limit 1` then takes the first *planned* entry in fingerprint order.
- The real scan confirmed the risk. Fourteen entries were journaled, 11 of them
  uploadable. The one that sorts first is a different movie whose match is
  ambiguous (`upload_then_review`), so `--limit 1` would have uploaded it instead
  of the authorized file.

## Operator contract

```
npm run ingest -- upload --fingerprint <sf1-…> [--kind movie|series] [--limit 1] [--execute]
```

It selects exactly one **already-scanned** journal entry.

- **The value** must be `sf1-` plus exactly 64 lowercase hex characters
  (`isFingerprint`). Nothing is normalized: uppercase, whitespace, short or long
  hashes, other prefixes and paths are all `fingerprint_invalid`.
- **It never reads a path** and never creates or edits journal state.
  Unscanned files must be scanned first.
- **Exactly one entry must match** by full string equality:
  - none is `fingerprint_not_found`;
  - more than one is `fingerprint_ambiguous` (a damaged journal, since the journal
    keys files by fingerprint). It never picks one.
- **Repeating the option** is `fingerprint_repeated`. It is parsed as a list,
  so "last one wins" cannot happen.
- **`--limit`** may be omitted, or given as the redundant `1`. Any other value is
  `limit_conflicts_with_fingerprint`, so `--limit` can never change the selection.
  Without `--fingerprint`, `--limit` is unchanged.
- **`--kind`**, if given, must equal the entry's kind (`fingerprint_kind_mismatch`).
  The fingerprint never changes routing: the entry's own kind picks the bot and
  channel, as before.
- **Errors** give a code and a fixed message. They never echo the value, so a
  mistyped path or token is not printed. A missing value is a clean usage error,
  not a stack trace.

## Nothing is bypassed

- **Selection is the only difference.** `selectUploadEntries`
  (`lib/uploader/upload.ts`) replaces the CLI's inline filter.
- **The rest is the one existing path:** the same `uploadEntry` loop, lock and
  deps, in this order:
  1. the real-upload gate;
  2. the plan gate;
  3. `planResume` against the server;
  4. `preflight`;
  5. `ingest_upload_start` and its floor;
  6. `sendDocument`;
  7. reply validation;
  8. `ingest_upload_record`.
- **Selection is not permission.** A fingerprint selects its entry whatever the
  plan. A non-upload plan (`hold`, `reject`, `skip`, `verify_upload`) then reaches
  `uploadEntry`, which refuses it explicitly (`plan_…`) instead of dropping it
  silently.
- **Lifecycle state still decides:**
  - an entry already uploaded ends in `none`/`adopt_server`, never a second send;
  - an unresolved one goes to `reconcile`.
- **The code-level gate still dominates.** `upload --fingerprint <valid>
  --execute` is refused before configuration, server or Telegram, as before.

## Dry run

Without `--execute`, `upload --fingerprint` prints what would happen:
- the selected fingerprint ("exact match, 1 of N journal entries") and its
  kind, relative file name, size, plan and journal state;
- the destination: the kind's bot, whether the channel is the configured one,
  and whether the bot is local. No ids are printed;
- the caption;
- the adapter's **offline** preflight: stat and path mapping only, with a fetch
  that refuses.

It does not write the journal. It does not ask the server; `uploadEntry` does
that at execution.

## `resume`: unchanged (decision)

Resume already chooses deterministically from state:
- it settles every journal entry that is locally pending, or, with `--server`,
  every entry the server reports as unresolved;
- `resumeEntry` never sends a file;
- `upload` stops at the first uncertain result, so a run leaves at most one
  unresolved attempt.

A selector would add no safety. It would also invite the question of whether a
planned entry can be "resumed", which it cannot.

## Source revalidation (finding; not changed here)

Before sending, `preflight` rechecks that the path is a regular file and that its
size equals the scanned size (`source_changed_since_scan`). It does **not**
recheck mtime or the sampled content.
- **The risk:** a different file of exactly the same size, swapped in after the
  scan, would be sent with the old fingerprint in its caption.
- **Scope:** this predates the selector and applies to every upload. It needs
  deliberate replacement, not ordinary drift.
- **Mitigation for C2B.2D:** run `inspect <file> --kind movie` immediately
  before `--execute`, and require its freshly computed fingerprint to equal the
  selected one.
- **Proposed follow-up (separate checkpoint):** recompute the sampled `sf1`
  fingerprint at upload time (about 12 MiB read) and refuse on mismatch.

## Tests

- `lib/uploader/uploader.test.ts` covers:
  - selection among several entries, and independence from journal order;
  - neighbours that differ only in the last hex digit;
  - normal selection unchanged;
  - 13 malformed values;
  - not found, repeated and duplicate entries;
  - `--limit` rules and `--kind` mismatch;
  - through the real `uploadEntry`:
    - non-upload plans refused;
    - an uploaded entry, and a lost journal, never re-sent;
    - uncertain and interrupted entries go to reconcile;
    - the gate refuses first;
    - a selected episode keeps series routing through the real adapter
      (`bot_not_on_local_server` while Series is on the cloud, and
      `channel_changed_since_plan` for an episode planned for Movies), with no
      request and no server start.
- `lib/uploader/cli.test.ts`, on plain Node with fake credentials, covers:
  - the dry run selects one of three entries, finds the configured local
    channel, passes preflight, and writes nothing;
  - selection is independent of order;
  - selection with no configuration;
  - `--execute` is refused by the gate;
  - seven error codes, with and without `--execute`, and no path or token
    echoed;
  - a missing value.
- **Mutation check.** Each of these was disabled in turn, and each change
  failed tests:
  - exact equality;
  - zero-match, multi-match, format, repeated-option, limit and kind guards;
  - the CLI gate;
  - `uploadEntry`'s gate and plan gate.
  All were restored.
- **Suites:** `npm test` 292, `npm run test:db` 339, `npm run test:catalogue` 30.
  Lint, typecheck and build pass.

## Real trial dry run

1. `scan G:\Movies --kind movie --match` ran with the hosted VJ list into a
   scratch journal. It used local reads and read-only TMDB searches only.
2. `upload --fingerprint sf1-a9a1b20b…` (the full value) selected exactly
   `On The Hunt.VJ ICE P.2026.mkv`, 1 of 14 entries:
   - "On The Hunt" (2026), VJ ICE P;
   - plan `upload`; journal `not_uploaded`;
   - destination: the configured movie channel through the local Bot API;
   - preflight ok.
3. The journal was byte-identical afterwards.
4. With the real configuration, `--execute` was refused by the gate.
5. Hosted was unchanged:
   - ingestion events, media and candidates: 0;
   - the Movies checkpoint is unchanged;
   - 1 VJ.

# C2B.2C.3 — Upload-time source fingerprint revalidation (PASS)

Status: **PASS (2026-09-27).** This checkpoint changed code, tests and docs only.
No Telegram call, no hosted write, no upload. `REAL_TELEGRAM_UPLOADS_AUTHORIZED`
is still `false`. It closes the C2B.2C.2 finding.

## Rule

Immediately before a **new** upload attempt starts, the journal's fingerprint is
recomputed from the file's current bytes and must equal the journal's value
exactly.

- **One algorithm.** `fingerprintFile` (`lib/uploader/scan.ts`, over
  `computeFingerprint`) is the same code `scan` and `inspect` use. The uploader
  receives it as the `fingerprintSource` dependency, and the CLI passes the real
  function. There is no upload-specific implementation, and the `sf1` format and
  sampling are unchanged.
- **Exact equality.** `current === entry.fingerprint`. No prefix, partial,
  case-insensitive, name, size or mtime fallback.
- **Codes.** Neither code carries a path or a fingerprint.

| Case | Refused by | Code |
| --- | --- | --- |
| File missing | Preflight stat | `source_unreadable` |
| Size changed | Preflight size check | `source_changed_since_scan` |
| Same size, sampled bytes changed | Revalidation | `source_fingerprint_changed` |
| Read fails (locked, deleted, or shrank after preflight: a short read) | Revalidation | `source_fingerprint_unreadable` |

- **Nothing is repaired.** A mismatch returns `refused`. The journal is not
  touched: no attempt is recorded, and its fingerprint is not replaced. A
  changed file needs an explicit rescan and a new operator decision.

## Position in `uploadEntry` (the one shared upload path)

1. Code gate (`telegramEnabled`).
2. Plan gate, planned channel, server boundary available.
3. `planResume` against the server. An uploaded, uncertain or interrupted
   source leaves here (`none`, `adopt_server`, `reconcile`, …) **before** any
   source read, so revalidation can never turn an unresolved attempt into a
   resend.
4. `preflight`: routing, caption, extension, ceiling, stat, size, path map.
5. **`verifySourceFingerprint`**, the new step.
6. Journal `upload_started`, then `ingest_upload_start` (the floor), then
   `sendDocument`, then validation, then `ingest_upload_record`.

- **Every caller is covered.** `upload`, `upload --limit` and
  `upload --fingerprint` differ only in selection, and all of them call
  `uploadEntry`. `fingerprintSource` is a required dependency, so no caller can
  omit it.
- **Resume is unaffected.** `resumeEntry` never sends a file and never reads the
  source.
- **The dry run uses the same function.** `upload --fingerprint` without
  `--execute` calls `verifySourceFingerprint` and prints the result on its
  `source` line.
- **Gate ordering.** In the CLI, `--execute` is refused by
  `REAL_TELEGRAM_UPLOADS_AUTHORIZED` before any configuration or file read. In
  `uploadEntry`, the code gate is step 1. So no upload can start without both the
  authorization and a passing revalidation.

## Remaining boundary (TOCTOU; documented, not closed)

The local Bot API server opens the file itself: `file://` through the read-only
`/media/movies` mount, when `sendDocument` arrives. Between revalidation and that
open, two things still happen:
- the `ingest_upload_start` round trip;
- a second adapter preflight inside `sendDocument`, which re-stats the size just
  before the request.

The server then reads the whole file while it uploads. So a change timed into
that window (seconds before the send, or during the upload), or a same-size edit
**outside** the three sampled 4 MiB regions, is still not detected here.

- **Out of scope:** closing it would need a snapshot, a lock, or a full-content
  hash compared after the upload, which changes the architecture.
- **Not blind:** the caption token and the recorded `file_size` are still
  checked against the reply, and `--full-hash` in `inspect` can confirm a
  specific file.
- **What this does close** is the practical gap: a stale journal entry whose
  file was replaced at the same size after the scan. That includes a replacement
  that kept the file's mtime, which a rescan's `discoveryKey` cache would reuse.

## Cost

- **Fixed read:** three 4 MiB samples, 12,582,912 bytes, whatever the file size.
- **Trial movie (958 MiB):** about 30 ms to recompute, with the file probably in
  the OS cache after the scan. A cold read on the library drive is a few seeks
  more, still a fixed 12 MiB.

## Tests

- **`lib/uploader/uploader.test.ts`:** 10 new cases on a real 13 MiB file with
  the real `fingerprintFile`.
  - An unchanged source passes, with the check ordered after `preflight` and
    before `sendDocument`.
  - One byte flipped in the start, middle and end samples (same name, same size)
    is refused, with:
    - no server call;
    - no `sendDocument`;
    - no journal attempt, and an existing entry left byte-identical.
  - A byte outside the samples passes: the documented limit.
  - Through the real adapter, a size change and a missing file are refused by
    preflight, before revalidation, with no request.
  - An I/O error, a short read and a deleted file each return
    `source_fingerprint_unreadable`.
  - A value differing only in its last hex digit, or only in case, is a change.
  - Ordinary, `--limit` and `--fingerprint` selections all reach the check.
  - Uncertain and interrupted attempts go to `reconcile`, and resume replays
    without reading the source.
  - With the gate off, nothing runs, revalidation included.
- **`lib/uploader/cli.test.ts`:**
  - fixtures carry their real `sf1` values;
  - the dry run shows the exact match;
  - a same-size edit of the selected file is reported as
    `source_fingerprint_changed`, and the journal is left unchanged.
- **Mutation check.** Each of these made tests fail, and all were restored:
  - skipping the recompute;
  - prefix-only comparison;
  - case-insensitive comparison;
  - not refusing a mismatch;
  - moving the check after `ingest_upload_start`;
  - treating a read failure as a match.
- **Suites:** `npm test` 303, `npm run test:db` 339, `npm run test:catalogue` 30
  (including the recovery integration test). Lint, typecheck and build pass.

## Real trial proof (read only)

1. A fresh `scan G:\Movies --kind movie --match` into a scratch journal
   reproduced the trial fingerprint `sf1-a9a1b20b…` with plan `upload`.
2. `upload --fingerprint <it>` (dry run):
   - selected 1 of 14 entries;
   - preflight ok;
   - `source`: the current bytes fingerprint to the selected value (exact
     match).

   The journal was byte-identical afterwards, and `--execute` was refused by the
   gate.
3. `inspect` showed:
   - "On The Hunt" (2026);
   - VJ resolved to `vj-ice-p`;
   - duplicate `none`;
   - action `upload`, with no stop reasons.
4. A same-size copy in the scratchpad (outside the library), with one byte
   flipped in the middle sample, returned `source_fingerprint_changed`. The
   unmodified copy passed first. The copy was deleted afterwards.
5. The real movie's size, mtime and fingerprint are unchanged. It was only read.

# C2B.2D — First controlled Movies upload: stopped before sending (2026-09-27)

Status: **BLOCKED, confirmed not sent** (a pre-send authorization block). This is
not a PASS, and C2B.2D is still open.

- **Preconditions passed:**
  - Git in sync;
  - the local Bot API healthy, with `G:\Movies` mounted read-only at
    `/media/movies`;
  - the Movies identity, channel and recovery group verified, and Series isolated;
  - hosted empty, with the checkpoint unchanged;
  - a fresh scan reproduced the authorized fingerprint;
  - the `--fingerprint` dry run selected 1 of 14 entries, preflight and source
    revalidation passed.
- **Why it stopped:** "enable" then meant editing the source constant
  `REAL_TELEGRAM_UPLOADS_AUTHORIZED` in `lib/uploader/upload.ts`. The agent's
  permission policy refused that edit, and it was not worked around.
- **Nothing happened:** no upload attempt, no Telegram write, no hosted write.
  The constant stayed `false`.
- **The media mount** was left in place: it is read-only.

C2B.2C.4 (below) replaces the source constant with a runtime gate, so the
retry never edits code.

# C2B.2C.4 — Runtime real-upload authorization gate (PASS)

Status: **PASS (2026-09-27).** This checkpoint changed code, tests and docs only.
No Telegram call, no hosted write, no upload.

## Semantics

Real Telegram traffic is a runtime, fail-closed operational gate:

```ts
isRealTelegramUploadAuthorized() // process.env.REAL_TELEGRAM_UPLOADS_AUTHORIZED === "true"
```

- **Only the exact string `true` enables.** Unset, empty and every other value
  deny: `false`, `FALSE`, `0`, `1`, `yes`, `TRUE`, `True`, `" true "`,
  `"true\n"`, quoted values.
- **Read on every call**, from the process environment, never cached at import.
  So it can be enabled for one command, and a build cannot bake it in.
- **Server and CLI only.** No `NEXT_PUBLIC_` variant; no reference in `app/`,
  `components/` or the client bundle; never logged. The CLI prints only
  `Real Telegram uploads: disabled|ENABLED`, in `status` and in `upload` dry
  runs, never the raw value.
- **Committed default: deny.** The source constant is gone. `.env.example`
  documents `REAL_TELEGRAM_UPLOADS_AUTHORIZED=false` as the kill switch. No
  committed file enables it.

## Enforcement (the shared path)

- **`uploadEntry`** checks the gate as its first statement, before:
  - the plan gate;
  - server status;
  - preflight and source revalidation;
  - the journal attempt;
  - `ingest_upload_start`;
  - `sendDocument`.
- **`resumeEntry`** checks it first too: recovery posts markers and forwards
  messages.
- **No caller can pass authorization in.** The injectable `telegramEnabled`
  boolean was removed from `UploaderDeps`, so a future caller of the uploader is
  still blocked unless the process environment says exactly `true`.
- **The CLI refuses early too** (`executionDeps`), before any configuration or
  store is loaded, with a stable message: "real Telegram uploads are not
  authorized for this process … Nothing was sent."

## Authorization is not selection

- The gate enables the uploader. It does not choose a file.
- A controlled production upload needs **both**:
  - `REAL_TELEGRAM_UPLOADS_AUTHORIZED=true`, in that command's environment only;
  - `upload --fingerprint <exact authorized sf1>`.
- Nothing else is relaxed:
  - plan, VJ and match gates;
  - duplicate and state rules;
  - routing and the registered channel;
  - source revalidation;
  - the recovery floor;
  - reply validation.

## Operator procedure (process-scoped)

Never put `true` in `.env.local`, in source code, or in a commit. Node's
`--env-file` does not override a variable already in the environment, so the
command's own environment decides.

PowerShell:

```powershell
$env:REAL_TELEGRAM_UPLOADS_AUTHORIZED = "true"
try {
    npm run ingest -- upload --fingerprint <AUTHORIZED_FINGERPRINT> --kind movie --execute
}
finally {
    Remove-Item Env:REAL_TELEGRAM_UPLOADS_AUTHORIZED -ErrorAction SilentlyContinue
}
```

- The value lives in that PowerShell session only for the `try` block.
- A child-only variant (for example `cmd /c "set …&& npm …"`) was considered and
  not adopted. It adds quoting pitfalls for no real gain, and `finally` already
  removes the value even when the command fails.
- In a POSIX shell, `REAL_TELEGRAM_UPLOADS_AUTHORIZED=true npm run ingest -- …`
  scopes it to the one child.

## Tests

- `lib/uploader/uploader.test.ts` runs against the real environment gate:
  - every test sets it with `vi.stubEnv`;
  - after each test, `vi.unstubAllEnvs()` runs and the original process value is
    asserted to be back.

  It covers:
  - the matrix: 17 denied values (including unset, empty, `false`, `FALSE`,
    `0`, `1`, `yes`, `TRUE`, and padded and quoted forms) and the exact `true`;
  - every denied value refuses `uploadEntry` and `resumeEntry` with no server
    call, no journal write, no source read and no Telegram call;
  - exact `true` reaches the fake `markUploadStarted`, then the fake
    `sendDocument`;
  - the value is read per call: the same deps are refused, then allowed, then
    refused again.
- `lib/uploader/cli.test.ts`, as real child processes with an explicit
  environment:
  - nine denied values refuse `upload` and `resume --execute` without echoing
    the value;
  - exact `true` passes the gate and stops at the missing configuration (no
    network);
  - `status` and the dry run show only the sanitized state.
- The recovery integration test enables the gate for its suite and restores it
  afterwards.
- **Mutation check.** Each of these made tests fail, and all were restored:
  - unset authorizes;
  - any truthy string authorizes;
  - case-insensitive comparison;
  - trimmed comparison;
  - the gate moved after `ingest_upload_start`;
  - the gate removed from `uploadEntry`;
  - the gate removed from `resumeEntry`;
  - the value read once at import.
- **Suites:** `npm test` 310, `npm run test:db` 339, `npm run test:catalogue` 30.
  Lint, typecheck and build pass.

## State after this checkpoint

- The operator shell has the variable unset, and `.env.local` does not set it.
- `npm run ingest -- status` reports `Real Telegram uploads: disabled`.
- Hosted is unchanged: ingestion rows 0, and the Movies checkpoint is unchanged.
- C2B.2D is **not** complete. Its retry uses the procedure above with the
  authorized fingerprint.

# C2B.2D — First controlled Movies upload, retry: BLOCKED — UNCERTAIN (2026-09-27)

One authorized attempt, for the trial movie only. Its outcome is **uncertain**. It
is preserved for a separately authorized reconciliation, and it has **not** been
retried.

## Preflight (all passed, immediately before execution)

- **Git:** `b25e6e9`, level with the remote. The gate was unset in the shell and
  absent from `.env.local`.
- **Local Bot API:** healthy, `--local`, `127.0.0.1:8081` only. `G:\Movies` is
  mounted read-only at `/media/movies`, and the file is visible at 1,004,462,878
  bytes.
- **Movies:** identity, channel, administrator with `can_post_messages`,
  unprotected, and the recovery group all verified.
- **Series:** on the cloud, refused locally with no request.
- **Hosted:**
  - 10 migrations;
  - one `movie` channel row, equal to the configuration, at checkpoint 22;
  - one active VJ;
  - ingestion events, media and candidates 0.
- **Dry run:** `upload --fingerprint <authorized> --kind movie` selected 1 of 14
  entries. Preflight ok, and the current bytes equal the authorized fingerprint.

## Execution

- **Command:** run once, in PowerShell:

  ```
  npm run ingest -- upload --fingerprint <authorized> --kind movie --execute
  ```

  - `REAL_TELEGRAM_UPLOADS_AUTHORIZED=true` was set only inside the `try` block.
  - `finally` removed it (confirmed).
  - Duration: 23:00:58Z to 23:06:09Z.
- **Result:** `{"result":"uncertain","code":"network_error"}`.
- **Hosted after:**
  - one uploader row: `movie`, upload state `uncertain`, attempt 1, floor 22,
    failure code `network_error`, source size 1,004,462,878;
  - `status = received`;
  - `telegram_media` 0 and match candidates 0;
  - the checkpoint is still 22 (not advanced).
- **Journal after:** the entry is `uploading`, attempt 1 is `uncertain`
  (`network_error`), with recovery floor 22. No Telegram record.
- **Nothing else:** no Telegram read-back was attempted, because forward probes
  belong to reconciliation. No retry, no marker, no delete.

## Cause (defect found; not fixed here)

The client aborted after exactly **300 s** without response headers.
- The adapter's `sendDocument` passes an `AbortSignal.timeout(4 h)`.
- But Node 24's built-in `fetch` (undici) also applies its default dispatcher
  `headersTimeout` of 300 s, and the uploader never overrides it.
- The local Bot API server replies only after Telegram has accepted the whole
  file. So any upload that takes more than 300 s is cut off on the client side
  and mapped to `uncertain` / `network_error`, while the server keeps uploading.

**Evidence:**
- The container did not restart.
- Its network output kept growing after the client error: 622 MB at 23:06:1x,
  671 MB at 23:06:51, 707 MB at 23:07:07.
- It levelled off at **1.01 GB** at 23:10:02Z, which matches the file size
  (1,004,462,878 bytes) plus overhead, with no restart. So the server very
  probably finished the upload, and the movie is probably in the Movies channel
  under the attempt's caption token. This is not confirmed: reading it back
  needs the reconciliation probe, which was not authorized here.

**Safety held:**
- The attempt was already durable: `ingest_upload_start` fixed the floor at 22.
- The server now refuses any new start for this fingerprint while it is
  `uncertain`.
- Crash reconciliation (marker plus bounded scan of `(22, marker)`) will find
  the message by its `velora-src` caption token, or rule it out.

**Fix (separate checkpoint):** give the Bot API transport a dispatcher whose
`headersTimeout`/`bodyTimeout` cover the upload window (at least the 4 h upload
timeout), with a test that a slow reply past 300 s is not `uncertain`.
Reconciliation must stay the recovery path for this attempt.

## State now

| Item | State |
| --- | --- |
| Trial source | Hosted `uncertain` (floor 22); journal `uploading`; retry refused by the server |
| Movies checkpoint | 22 (unchanged) |
| Real uploads | Disabled: shell unset, not in `.env.local` |
| Series | Cloud, unregistered, untouched |
| Upload attempts | 1 (uncertain); 0 confirmed |

## Next (each needs its own authorization)

1. Fix the transport timeout (above).
2. Reconcile this attempt, with `resume --server` first as a dry run:
   - post a recovery marker;
   - scan `(22, marker)`;
   - record the message if it is found;
   - otherwise the source stays held until the grace period ends.
3. Only then continue C2B.2D.

# C2B.2E — Reconciliation of the uncertain C2B.2D upload (PASS)

Status: **PASS (2026-09-27).** The uncertain attempt from C2B.2D was resolved by
the existing bounded marker protocol. Nothing was re-sent: there was no second
`sendDocument` and no new attempt. So C2B.2D's one authorized upload is now a
**confirmed, durably recorded** upload. The operator also saw the movie in the
channel; that was treated only as supporting evidence.

## Baseline (verified before recovery)

- Hosted: one uploader row:
  - `movie`, `uncertain`;
  - attempt 1, floor 22, `network_error`;
  - media 0, candidates 0;
  - checkpoint 22;
  - catalogue 0.
- Journal: the entry is `uploading`, attempt 1 `uncertain`, floor 22, with no
  Telegram record.
- Movies local and verified; Series on the cloud, refused locally. The gate was
  unset.

## Recovery

1. `resume --server` (dry run, read-only status RPC): exactly one entry to
   settle, `{"action":"reconcile"}`. The other 13 were settled and skipped.
2. One `resume --execute`, with `REAL_TELEGRAM_UPLOADS_AUTHORIZED=true` set only
   inside a PowerShell `try` and removed in `finally`. It ran 23:16:03–23:16:24Z
   and returned `{"result":"uploaded","acknowledged":true}`.
3. Protocol path (existing code, unchanged):
   1. the floor came from the server (22), and the journal copy agreed;
   2. access checks;
   3. one recovery marker (`velora-recovery:v1`) posted to the Movies channel by
      the Movies bot, message **24**;
   4. the bounded interval `(22, 24)` = {23} was inspected with a forward probe
      into the recovery group;
   5. the forwarded copy was deleted, best effort;
   6. the match was on the exact `velora-src:<authorized sf1>` token and size;
   7. it was recorded through `ingest_upload_record`;
   8. the marker was offered as the channel checkpoint.
4. `sendDocument` calls: **0**. `resumeEntry` has no send path.

## Result (read back independently)

| Check | Result |
| --- | --- |
| Ingestion row | The same single row (no new one): `upload_state = uploaded`, `upload_attempt_count = 1`, floor 22, `status = received` |
| Media | Exactly 1 row, linked from the row (`telegram_media_id`): message **23** in the configured Movies channel, `document`, `On The Hunt.VJ ICE P.2026.mkv`, `video/x-matroska`, 1,004,462,878 bytes (= source), `telegram_date` 23:09:23Z |
| Caption | `On The Hunt (2026) / VJ ICE P / Movie / velora-src:<authorized sf1>`: exact token |
| Duplicates | 1 row for its `file_unique_id` |
| Invariant | bootstrap checkpoint 22 ≤ floor 22 < message 23 < marker 24 |
| Channel checkpoint | **24**, advanced by the protocol's own offer after the recorded resolution (not manually) |
| Journal | `uploaded`, attempt 1 `confirmed`, floor 22, Telegram record message 23 with a matching fingerprint, DB acknowledged |
| Candidates / review | 0 match candidates; review `discovered`; not approved |
| Catalogue | 0 movies and versions: nothing published |

**Stale failure code.** `upload_failure_code` still reads `network_error` on the
now-`uploaded` row. `ingest_upload_record` does not clear it, so it stands as a
historical code. Worth tidying in a later migration; it does not affect behavior.

**Timing.** Telegram dated the message 23:09:23Z, about 3 min after the client's
300 s cutoff. This matches the outbound traffic levelling off, and the upload
finishing server-side.

## Duplicate safety (the gate unset)

- **Existing journal:**
  - a rescan plans `skip` (`already_uploaded`);
  - `upload --fingerprint` (dry run) says "would not upload (plan_skip,
    journal_uploaded)";
  - a plain `upload` dry run does not list it;
  - `resume --server` finds 0 entries to settle.
- **Lost journal** (a fresh scratch journal):
  - the offline planner plans `upload`, since it sees only local state;
  - `resume --server` returns `adopt_server` with message 23, and `uploadEntry`
    runs that status check before any start. So the server's record prevents a
    second send.
  - The scratch journal was deleted afterwards.

## Telegram read-back

The Bot API cannot read channel history read-only. The protocol's forward probe
(recovery group) was the independent read-back of message 23: document, caption
token and size, all validated. No further forward was made.

## Telegram writes by recovery (Movies bot, local server)

| Kind | Count |
| --- | --- |
| Recovery marker (`sendMessage`, Movies channel) | 1 (message 24, retained) |
| Forward probe (Movies channel → recovery group) | 1 (message 23) |
| Deletion of the forwarded copy (recovery group, best effort) | 1 |
| `sendDocument` | 0 |

Series: cloud, unregistered, untouched.

## State and next

- **Real uploads:** disabled (shell unset, not in `.env.local`).
- **C2B.2D:** its first controlled upload is now confirmed. It was completed
  through reconciliation, not the direct reply, because of the transport
  timeout.
- **Next defect to fix:** Node's `fetch` default `headersTimeout` of 300 s cuts
  off local Bot API replies for uploads longer than 300 s ("C2B.2D … retry",
  Cause). The fix needs its own checkpoint. Until it lands, every upload over
  about 5 min will end `uncertain` and need reconciliation.
- **Still outstanding:**
  - the crash/reconciliation drill;
  - the near-ceiling test;
  - bulk ingestion;
  - the Series migration.

# C2B.2F — Long-running local Bot API transport (PASS)

Status: **PASS (2026-09-27).** This checkpoint changed code, tests and docs only.
No Telegram media, marker or probe; no hosted write. It fixes the transport
defect that made the C2B.2D upload `uncertain`. C2B.2E then recovered that upload
correctly.

## Cause (reproduced, not inferred)

- **Reproduction:** a loopback server held back its response headers for 330 s.
  Node 24.13.0 (bundled undici 7.18.2) was called with `fetch` and
  `AbortSignal.timeout(4 h)`, the adapter's exact call shape.
- **Failure:** at **306 s**, with this chain:

  ```
  TypeError: fetch failed
    cause: HeadersTimeoutError (UND_ERR_HEADERS_TIMEOUT)
  ```

- **Why:** built-in `fetch` runs on undici's global dispatcher. Its
  `headersTimeout` (300 s, checked on a coarse timer) fires however long the
  caller's signal is. It also has a 300 s `bodyTimeout`. The adapter's
  `uploadTimeoutMs` of 4 h was therefore never the effective limit for
  `sendDocument`.
- **Why an upload hits it:** the local Bot API server sends no headers until
  Telegram has taken the whole file, so a large upload waits longer than 300 s
  for headers.
- **What went wrong in C2B.2D:** the adapter mapped the `TypeError` to
  `uncertain` / `network_error`, while the server finished the upload (message 23
  at 23:09:23Z).

## Timeouts, before and after

| Layer | Before | After |
| --- | --- | --- |
| Connect | undici default (10 s) | `sendDocument`: OS connect (loopback); others unchanged |
| Response headers | undici `headersTimeout` 300 s, **the effective limit** | `sendDocument`: none of its own; others unchanged |
| Response body | undici `bodyTimeout` 300 s | `sendDocument`: none of its own; others unchanged |
| Application | `AbortSignal.timeout`: 4 h upload (ineffective past 300 s), 60 s for other calls | Same values, now **effective** for `sendDocument` |
| TDLib/Telegram | Server-side; not bounded by the client | Unchanged |

## Implementation

- **`lib/telegram/long-running-fetch.ts`:** `longRunningFetch`, a
  fetch-compatible POST built on `node:http`/`node:https`.
  - Those client modules have no header or body timeout of their own, so the
    caller's AbortSignal is the only limit.
  - It opens a fresh connection per call (`agent: false`).
  - It keeps no global state and does not touch `fetch`, the undici dispatcher
    or TLS settings.
  - It adds no dependency. The `undici` package is not installed, and reaching
    Node's bundled copy would mean using internals.
- **Adapter (`lib/telegram/local-bot-api.ts`):**
  - `TransportDeps` gains a **required** `mediaFetch`, so production cannot
    silently fall back to built-in fetch.
  - `call()` takes a `via` selector, and **only `sendDocument`** passes
    `"media"`.
  - `getMe`, `getChat`, markers, forward probes and deletes keep built-in
    `fetch` with their 60 s signal. TMDB, Supabase and the app are untouched.
- **CLI:** the execution client passes `mediaFetch: longRunningFetch`, with
  `UPLOAD_TIMEOUT_MS` still **4 h**. The dry-run client passes its offline stub
  for both transports.
- **Error shape is kept, and so is the classification:**
  - an abort at the 4 h limit rejects with the signal's `TimeoutError`, which is
    still `uncertain` / `timeout`, never "not sent";
  - a refused connection is `TypeError` with an `ECONNREFUSED` cause, which is
    `unreachable`, definitely not sent;
  - a drop mid-reply is `TypeError`, which is `uncertain` / `network_error`;
  - nothing retries on its own.

**Recovery is unchanged and still required.** Floors, markers, forward probes,
the `uncertain` state, server adoption and duplicate protection all remain. A
network or process failure can still leave an upload unresolved.

## Proof beyond 300 s (real adapter, loopback, no Telegram)

- **Setup:** `createLocalBotApiClient`, wired exactly as the CLI wires it
  (`fetch` plus `mediaFetch: longRunningFetch`, 4 h upload timeout, 60 s
  requests). It ran against a loopback fake Bot API that answers `getMe` at once
  and holds `sendDocument`'s headers for 330 s.
- **Result:** the request was still open at 60, 120, 180, 240 and **300 s**, past the
  306 s where built-in fetch failed. The server sent headers at 330.1 s, and
  `sendDocument` returned `succeeded`: the reply was validated (message 99, size
  1,004,462,878, caption token). The 4 h limit was not reached.
- **Control:** the same hold with plain `fetch` failed at 306 s
  (`UND_ERR_HEADERS_TIMEOUT`).

## Automated tests (no 300 s waits in the suite)

- **`lib/telegram/long-running-fetch.test.ts`** (8), on real loopback servers:
  - a late reply succeeds, with the exact POST, headers and body;
  - it never calls global fetch;
  - the caller's signal aborts it at its deadline as a `TimeoutError` and tears
    down the connection;
  - an already-aborted signal sends nothing;
  - `ECONNREFUSED` keeps fetch's shape;
  - a mid-reply drop is a failure, not partial success;
  - non-2xx replies are returned;
  - non-http schemes are refused.
- **`lib/telegram/local-bot-api.test.ts`** (+5):
  - only `sendDocument` uses `mediaFetch`; `getMe`, `sendMessage` and
    `forwardMessage` use `fetch`;
  - the real adapter over `longRunningFetch` and a loopback Bot API:
    - a late reply within the limit succeeds;
    - at a small upload limit the result is `uncertain` / `timeout`, with no
      second request;
    - a slow `getMe` still times out at the short request limit when the upload
      limit is 4 h;
    - a stopped server is `bot_api_unreachable`.
- **Mutation check.** Each of these made tests fail, and all were restored:
  1. `sendDocument` on `fetch`;
  2. `mediaFetch` used for every call;
  3. a header timeout re-added (scaled to 300 ms);
  4. delegating to global fetch;
  5. no application timeout;
  6. an ignored abort;
  7. a timeout classified as "not sent";
  8. an abort reshaped as `ECONNREFUSED`.
- **Suites:** `npm test` 323, `npm run test:db` 339, `npm run test:catalogue` 30.
  Lint, typecheck and build pass.

## Recovered movie (regression, read-only)

The C2B.2E result is unchanged:
- `uploaded`, attempt 1;
- media linked, 1 row;
- 0 unresolved;
- checkpoint 24.

With the gate unset, `resume --server` has 0 entries to settle. The fingerprint
dry run says it would not upload (`plan_skip, journal_uploaded`), and the plain
upload dry run does not list it.

## `upload_failure_code` (conclusion)

It holds the **last recorded failure** (historical), not the current state:
- only `ingest_upload_fail` writes it, together with `upload_failed_at`, and the
  CHECK pairs the two;
- neither a new start nor `ingest_upload_record` clears it;
- the store reads it only for `blocked` rows.

So `uploaded` with `network_error` is consistent with the schema: the attempt
did hit a network error before recovery confirmed it. No cleanup migration is
needed. If a "current failure" field is ever wanted, that is a separate schema
decision.

## State and next

- **Nothing external:** no Telegram media upload, marker, probe or delete; no
  hosted write.
- **Gate:** `REAL_TELEGRAM_UPLOADS_AUTHORIZED` unset.
- **Next:**
  - a large upload now waits up to the real 4 h limit for its reply;
  - reconciliation stays the path for any `uncertain` result;
  - the crash drill, the near-ceiling test, bulk ingestion and the Series
    migration each still need authorization.

---

# C2B.2H — Uploaded movie → catalogue: publication foundation

Date: 2026-09-27. **C2B.2H FIRST MOVIE CATALOGUE PUBLICATION: PASS.**
Migration 11, `20260927090650_ingestion_movie_publication.sql`, is deployed.
On The Hunt (VJ Ice P) was evaluated, approved and published through the
owner-only lifecycle after the operator's explicit rights confirmation. It
appears on the real UI from the hosted catalogue. Telegram writes: 0.

## Why On The Hunt is not visible (hosted, read-only audit)

- Event 1: `origin = uploader`, `upload_state = uploaded`, attempt count 1,
  floor 22, media 1 (message 23, `On The Hunt.VJ ICE P.2026.mkv`, 1,004,462,878
  bytes, one row for its `file_unique_id`). **`status = received`, `parsed` null.**
- Candidates 0, movies 0, versions 0, genres 0. VJ 1 `vj-ice-p` is active.
- Fuze (event 2, media 2, message 25) is in the same state. Series is unregistered.

The missing lifecycle states are evaluation, approval and publication. None of
them had a database write path: the worker commands stop at `uploaded` (by
design, C2A threat model). So the public policies correctly return nothing.

## Match (re-run through the existing matcher, read-only TMDB search)

`On The Hunt` (2026), movie (confirmed), VJ `ICE P` resolved to 1. TMDB
**1428857** "On the Hunt" (2026): `exact_title_year`, score 1, high
confidence, unique. The other exact title, 440478 (2017), is a year conflict,
and 18 more results do not match the title.

## Design: two privilege tiers

| Command | Who | Writes |
| --- | --- | --- |
| `public.ingest_record_evaluation(fp, bot, parsed, candidates)` | `service_role` (worker), SECURITY DEFINER | `parsed` with `review_reasons`, **pending** candidates, and `status` = `matched` or `needs_review` |
| `private.catalogue_approve_movie_match(fp, tmdb_id)` | owner only, SECURITY INVOKER, no grant | the candidate becomes `approved`, the others `superseded` |
| `private.catalogue_publish_movie(fp, metadata, rights_cleared)` | owner only, SECURITY INVOKER, no grant | the movie (reused by `tmdb_id`), genres, a version that is `ready` + `cleared` and linked to the uploaded media, the movie `published`, the event `published` |

- **The C2A threat model is kept.** The worker key can record evidence but can never approve or
  publish: no API role, including `service_role`, holds EXECUTE on the owner
  commands, and they live in `private`, which the Data API does not expose. The evaluation
  command references no `public.` table, no `'approved'` and no publication
  column, and the existing structural tests (005/006) cover it.
- **The decision is re-derived in the database.** Every candidate's score must
  equal the tier of its own reasons (the caller cannot inflate confidence).
  `matched` requires a declared kind, a resolved VJ and exactly one score-1
  candidate. Approval re-checks the stored evidence (unique score 1, named id)
  and that the VJ is active.
- **Publication** is one transaction, as the C1 boundary requires. Slug:
  `slug(title)-year`. A slug collision, an archived title, or an existing
  version for the same title and VJ with other media (`same_title_same_vj`)
  is refused, never merged. Artwork must be a TMDB path. Rights need the
  operator's explicit attestation.
- **Idempotency.** An identical evaluation returns `already_recorded`, and
  different evidence is refused (`ingest_evaluation_conflict`). Approval
  returns `already_approved` and publication `already_published`, with no row
  changes.
- **Public read is unchanged.** No grant, policy or predicate was touched.

## Operator path (CLI + owner)

1. `npm run ingest -- evaluate --fingerprint <sf1> --kind movie --vjs <vjs.json> [--execute]`
   reads the server's own record of the upload (Telegram file name and caption
   token; no local file or journal), then parses, resolves the VJ, runs the
   matcher and records the result through the worker RPC.
2. `npm run ingest -- publication-sql --fingerprint <sf1> --tmdb-id <n> --out <file.sql> [--rights-cleared]`
   fetches the TMDB snapshot of the approved id and writes the owner script
   (approve, publish and a readback in one transaction). It never overwrites a
   file and touches no database. The snapshot is embedded as a random-tag
   dollar-quoted literal; TMDB text in the header comment is JSON-escaped.
3. The operator reviews the script, then runs it as `postgres` through `psql`
   over the pooler (the channel-registration boundary).

## UI

`MovieCard` (the one card) now shows a top-left VJ badge derived from
`TitleSummary.vjs`: the first VJ and `+N` for the rest, with the full list for
screen readers. It comes after the title in reading order and uses the
`DESIGN.md` pill tokens. Per-VJ `badge_variant` colours are still unused (D5,
Phase D). No other component changed. Caching is unchanged: `/` and `/vjs`
revalidate every 300 s, and `/movies`, details and search are dynamic.

## Local verification

- `db reset` applies all 11 migrations, and `db lint`: no errors. The linter caught a
  `text[] || 'literal'` bug before any test.
- `npm run test:db`: **416/416** across 7 files. The new
  `007_ingestion_movie_publication` has 77 assertions: privileges, every
  refusal, materialize-once, replay counts, the anon read surface, and an
  approved-but-unpublished movie staying hidden. 003/005/006 were updated
  deliberately for the sixth worker command.
- Mutation checks: **11 of 11 killed**:
  - approval: unique match, active VJ;
  - publication: rights, version conflict, approved candidate, artwork path;
  - evaluation: two exact matches, caller score, replacing evidence,
    non-uploaded source.
  Two initially survived, and both were fixed:
  - M1: a test was added that corrupts the stored evidence as the owner;
  - M6: the mutant itself was wrong.
- `npm test` 336/336 (including `MovieCard` markup, the evaluation payload,
  the snapshot and the script), `npm run test:catalogue` 30/30, lint and
  typecheck pass.
- **Rehearsal on the local stack** with the real file name, fingerprint and
  TMDB data (fake channel id):
  - evaluation `matched`, and its replay `already_recorded`;
  - the owner script gave `approved` and `published` as `on-the-hunt-2026`, with
    20 candidates, 1 approved, the version ready/cleared/linked and attempts 1;
  - the second run: `already_approved` / `already_published`;
  - anonymous PostgREST: title, poster, date, VJ and genres are readable;
    `telegram_media_id`, `availability_status` and `publication_status` are
    refused.
- **Production build against the local catalogue**: `/`, `/movies`, the
  detail page, `/search?q=On The Hunt` and `/vjs/vj-ice-p` all render the
  movie with its badge. No Telegram, fingerprint or channel text appears in the
  HTML.
- Screenshots at 520 px and 1280 px show no overflow. Headless Edge cannot lay
  out narrower than about 500 px, so 360–430 px is not verified here.

## Known limits

- A replayed `evaluate` searches TMDB again. If TMDB's results changed, the
  replay is refused as `ingest_evaluation_conflict`; nothing is overwritten.
- Evaluation and publication are movie-only. Series needs its own checkpoint.

## Hosted: migration 11 deployment (PASS)

- Starting HEAD `ee459f1`, equal to `veloraug/phase-a-foundation`. The code was committed first
  (`ba06039`, `e463dc2`, `dfb12d9`), and the migration SHA-256 `52d506c8…a305` equals the
  committed blob.
- The gate was a re-read of the whole migration: four `CREATE FUNCTION` statements, then `REVOKE`/`GRANT`
  only. There is no `DROP`, `ALTER`, table, policy or default-privilege change. Hosted had
  exactly the 10 expected migrations.
- Supabase CLI 2.117.0 `db push --db-url` over the **session** pooler (5432). The URL came from the local
  environment and was never printed. The dry run proposed only
  `20260927090650_ingestion_movie_publication.sql`, with no seeds and no roles. The push applied it and
  exited 0. `.env.local`'s `DATABASE_URL` points at the transaction pooler (6543); the
  port was overridden for this command only, and the file is unchanged.

### Verification (read-only)

| Check | Result |
| --- | --- |
| History | 11 migrations, last `20260927090650` |
| Bodies | MD5 of all 9 `ingest_*`/`catalogue_*` functions identical to the clean local chain |
| Worker commands (6) | Owner `postgres`, SECURITY DEFINER, `search_path=""`, ACL `postgres=X/postgres,service_role=X/postgres` |
| Owner commands (approve, publish, slug) | Owner `postgres`, SECURITY INVOKER, `search_path=""`, ACL `postgres=X/postgres`. EXECUTE false for `anon`, `authenticated` and `service_role` |
| Service-role probe (the uploader's key, PostgREST) | `rpc/catalogue_approve_movie_match` 404 via `public`; approve and publish 406 via `private` (not exposed). Nothing changed |
| Private tables | RLS on, 0 policies, no table or column grant for `anon`, `authenticated`, `service_role` or `PUBLIC`; no `USAGE` on `private` |
| Public columns | Unchanged. `telegram_media_id`, `telegram_media_bot_type`, availability, rights, publication and metadata status are not selectable by client roles |
| Default privileges | None on `private` or `catalogue_access` |
| Anonymous PostgREST | `movies` `[]`, `movie_versions` `[]`; private columns 401; worker RPCs 404; `private` and `catalogue_access` 406 |
| Advisors | **No delta.** Security: the same 5 INFO `rls_enabled_no_policy` and the same accepted WARNs (`record_search`, `trending_searches` for `anon`/`authenticated`). Performance: the same 2 unindexed-FK and 11 unused-index INFOs |

## Hosted: On The Hunt evaluation (PASS)

- The command was `evaluate --fingerprint sf1-a9a1…b982 --kind movie --vjs … --execute`. It was keyed to the
  existing recovered ingestion (event 1) and read from the server's own
  Telegram record (`On The Hunt.VJ ICE P.2026.mkv`). No new event was created.
- **Result: `matched`.** The server re-derived it: kind confirmed, VJ resolved to 1
  (`vj-ice-p`, active), and exactly one score-1 candidate, **TMDB 1428857** "On the
  Hunt" (2026), with `review_reasons: []`.
- Candidates: 20 rows (every same-kind TMDB result), all `pending`, 0 decided.
  Exactly one has score 1. The only other exact title, 440478 (2017), scores 0.3 as
  a year conflict.
- **Idempotency.** A second `evaluate --execute` returned `already_recorded`; the
  counts were unchanged.
- **State now.**
  - Event 1: `status = matched`, `upload_state = uploaded`, attempt count **1**, media 1
    (message 23).
  - Totals: events 2, media 2, approved candidates **0**, movies **0**, versions **0**,
    genres 0, series 0.
  - Movies checkpoint **26**. Series is unregistered.
  - Fuze (event 2): unchanged, `received`, 0 candidates.
  - The anonymous catalogue does not show On The Hunt.

## Rights gate (stopped here)

- Owner script generated **without** `--rights-cleared`:
  `.velora-ingest/c2b2h-on-the-hunt-publish-RIGHTS-NOT-ASSERTED.sql` (Git-ignored,
  SHA-256 `8D5D209A…C351C`). It passes `false`. If it were run, the publish step would raise
  `catalogue_rights_not_cleared`, and `ON_ERROR_STOP` would roll back the approval in the
  same transaction. **It was not run.**
- After explicit rights confirmation, the next step is:
  1. `publication-sql --rights-cleared` to a new file;
  2. review it;
  3. run it once as `postgres` over the pooler;
  4. readback, anonymous checks and the rendered production pages.

Telegram writes: 0. `REAL_TELEGRAM_UPLOADS_AUTHORIZED` is unset in the shell and absent from
`.env.local`.

## Publication (PASS)

### Authorization and baseline

- **Operator confirmation.** Rights are cleared for the VJ Ice P version of
  "On The Hunt (2026)", **this title only**. It was not extended to Fuze, Series
  or future ingestion.
- **Baseline re-verified read-only before any write.**
  - Migration 11: installed, 11 migrations, function MD5s unchanged.
  - On The Hunt: event 1 `matched/uploaded/attempt 1`, media 1 (message 23).
  - Candidates: 20, all pending; the only score-1 is 1428857. VJ 1 is active.
  - Catalogue: 0 movies, 0 versions, 0 genres.
  - Unchanged elsewhere: Fuze `received` with 0 candidates; checkpoint 26;
    Series unregistered.
  - The runtime upload gate was unset. HEAD `b2e82a6` was synced.

### Owner script

- **New script.** Generated with `publication-sql … --tmdb-id 1428857
  --rights-cleared` as `.velora-ingest/c2b2h-on-the-hunt-publish-RIGHTS-CLEARED.sql`
  (Git-ignored). **SHA-256 `F4D978A65E856AEA312B8F0A86B69DF61CAD90F393CC52F1AC530E7252093733`**.
  The earlier `…RIGHTS-NOT-ASSERTED.sql` was neither edited nor run; its hash is
  unchanged.
- **Review.**
  - It contains exactly two calls, both keyed by On The Hunt's fingerprint:
    `private.catalogue_approve_movie_match(…, 1428857)` and
    `private.catalogue_publish_movie(…, <snapshot>, true)`. `true` appears only in
    that call.
  - It runs in one transaction with `ON_ERROR_STOP`, followed by a readback.
  - It has no table writes, no Fuze or Series reference, no Telegram
    operation and no secret.
  - The snapshot is TMDB 1428857: "On the Hunt", 2026-02-27, poster and backdrop
    TMDB paths, genres Action (28) and Thriller (53). TMDB has no runtime, so
    it is null.
- **Preflight, read-only.** The MCP role is `supabase_read_only_user`, which is
  itself denied the owner-only slug helper. Every predicate held:
  - uploaded, with media from the movie bot;
  - `matched`, with a unique pending 1428857 and none approved;
  - VJ resolved and active;
  - computed slug `on-the-hunt-2026`, with no slug, title, media or version
    conflict.

  A write-then-rollback rehearsal on hosted was deliberately not run, because it
  would consume identity-sequence values.

### Execution (once, as `postgres`, over the session pooler; URL never printed)

- The hash was re-checked immediately before the run.
- `psql -X -v ON_ERROR_STOP=1 -f` exited 0 with: `BEGIN`, approval `approved`,
  publication `published`, **movie 1 `on-the-hunt-2026`, version 1**, the readback,
  then `COMMIT`.

### Hosted lifecycle (read-only after commit)

| Area | State |
| --- | --- |
| Ingestion | 2 events (no new one). Event 1 `published/uploaded/attempt 1`, media 1 = message 23. 2 media rows |
| Candidates | `approved: 1` (TMDB 1428857), `superseded: 19`. No other approval anywhere |
| Movie | Exactly 1: id 1, `on-the-hunt-2026`, "On the Hunt", release 2026-02-27, overview set, poster `/gkscq…jpg`, backdrop `/9gBWv…jpg`, TMDB 1428857, rating 4.7 (17 votes), `metadata_status = reviewed`, `published`, `published_at` set, not featured |
| Version | Exactly 1: id 1, VJ 1 `vj-ice-p`, `ready`, `cleared` (rights recorded), `available_at` set, `telegram_media_id = 1` (bot `movie`), private link |
| Genres | Action, Thriller (2 genres, 2 links) |
| Unchanged | Fuze `received/uploaded/attempt 1`, 0 candidates. Movies checkpoint 26. Series: 0 channel rows, 0 series |

### Public read (real PostgREST path, publishable key)

- **Readable.** Exactly the display fields: id, slug, title, original title,
  overview, release date, runtime, poster/backdrop, TMDB id and rating,
  `published_at`. Also the version (`id`, `title_override`, `available_at`), VJ
  (id, slug, name, badge variant) and genres. The list returns 1 row, and a
  title search finds it. The payload has no Telegram, fingerprint, path or
  floor text.
- **Denied.**
  - Columns (401): `telegram_media_id`, `telegram_media_bot_type`,
    `availability_status`, `rights_status`, `publication_status`,
    `metadata_status`, `vjs.is_active`, and `select=*`.
  - Private tables (406): `telegram_media`, `ingestion_events`,
    `metadata_match_candidates`, `telegram_channels`.
  - RPCs (404): `ingest_upload_status`, `ingest_record_evaluation`,
    `catalogue_publish_movie`.

### Real UI (`npm run build`, then `next start` against the hosted catalogue; no fixtures)

| Route | Result |
| --- | --- |
| `/` | 200. Hero (newest title with a backdrop) and the Latest Movies card with badge |
| `/movies` | 200. Newest-first grid card with badge; genre and VJ filters present |
| `/movies/on-the-hunt-2026` | 200. Title, 2026, Movie, rating, Action/Thriller, "Available from VJ Ice P", overview, backdrop |
| `/search?q=On%20The%20Hunt` | 200. Found through the Supabase search, as a `MovieListItem` row |
| `/vjs/vj-ice-p` | 200. VJ page, Movies row card with badge |

- **Badge.** It renders from `TitleSummary.vjs` on every `MovieCard`: visible
  `VJ Ice P` (uppercase, top-left, inside the poster) and the screen-reader text
  "Available from VJ Ice P". A grep of `app`, `components` and the catalogue
  layer finds no title-specific code.
- **Search rows.** The search row (`MovieListItem`) shows no VJ. It never did,
  and it was left unchanged as out of scope; this is noted for Phase D.
- **Rendered-page leak scan.** No `sf1-`, `velora-src`, file ids, chat or
  message ids, `-100…` ids, floor/recovery text, `.mkv` source names or local
  paths appear in the HTML or RSC payloads of any tested route.

### Cache

- `/` and `/vjs` use ISR: an `x-nextjs-cache: HIT`, with `s-maxage=300`.
- `/movies`, details and search are dynamic (`no-store`).
- The build ran after publication, so visibility was **immediate**.
- A server that was already running would show it on dynamic routes at once,
  and on `/` and `/vjs` within one 300 s revalidation. Caching was not changed.
- There is no deployed site to observe: `NEXT_PUBLIC_SITE_URL` is localhost.

### Responsive

- Chrome DevTools device emulation (Edge over CDP; no new dependency) at 360,
  390 and 430 px (mobile, DPR 2) and at 1280 px, on `/`, `/movies`, the detail
  page and the VJ page.
- **No horizontal overflow** at any width (`scrollWidth` = viewport).
- The badge sits inside the poster everywhere, and card titles are not
  truncated. Cards measured 128–187 px wide on phones.
- At 360 px the detail hero wraps cleanly: title, genres, VJ line, overview
  and button. This replaces the earlier ~500 px `--window-size` limitation.

### Idempotency

- **Replay.** As `postgres`, inside a transaction that was always rolled back:
  approval → `already_approved`; publication → `already_published` (movie 1,
  version 1). Every count was identical: movies 1, versions 1, media 2, events
  2, approved 1, genres 2, links 2, attempts 1, max movie id 1.
- **Evaluation replay** (service role): `already_recorded`.
- The reviewed owner script was not run a second time.

### Regression

- **Fuze:** uploaded, `received`, 0 candidates, unpublished.
- **Telegram writes: 0** (`sendDocument` 0, marker 0, forward 0, delete 0).
- **Movies checkpoint:** 26.
- **Series:** unregistered and untouched.
- **Runtime upload authorization:** unset.
- Normal browsing reads only the Supabase catalogue.
  `lib/catalogue-boundary.test.ts` passes, and TMDB serves only as the image CDN.

### Tests

- `npm test`: 336/336.
- `npm run test:db`: 416/416 (7 files).
- `npm run test:catalogue`: 30/30.
- Lint, typecheck and the production build pass.
- Mutation checks: **11/11 killed**:
  - approval: unique match, active VJ;
  - publication: rights, version conflict, approved candidate, artwork path,
    slug conflict;
  - evaluation: ambiguity, caller score, evidence replacement, non-uploaded
    source.

---

# C2B.2I — First browser media delivery: BLOCKED — DELIVERY ARCHITECTURE

Date: 2026-09-27. **C2B.2I FIRST BROWSER MEDIA DELIVERY: BLOCKED — DELIVERY
ARCHITECTURE.** It stopped at the audit, before any implementation. Repository code
was unchanged. Telegram writes: 0. Hosted writes: 0.

## Media (read-only header probe of the source; no ffprobe installed)

| Property | On The Hunt (VJ Ice P) |
| --- | --- |
| Container | Matroska (`doctype matroska`, not WebM), muxed by Lavf 57.71 |
| Video | H.264 High profile, level 4.0, 1920×1080, 24 fps |
| Audio | MP3 (`A_MPEG/L3`), 2 channels, 44.1 kHz, 1 track, language `und` |
| Subtitles | None |
| Duration, bitrate | 1:26:48 (5,208.3 s), about 1.54 Mbps overall |
| Seek index | Cues present, but at the end of the file (the last ~29 KB), so a browser needs a tail range request before it can seek |

Browser compatibility was not tested, because delivery stopped first. H.264 with
MP3 in Matroska is plausible in Chromium browsers and unsupported in Safari. It
must be tested before any format decision.

## Delivery findings

- **`getFile` needs a complete download before it returns.** In `--local` mode, the
  first `getFile` for the movie made the Bot API download the whole file from
  Telegram (about 1 GB) into its own state storage. No byte was available before
  that completed, so Telegram → Bot API is not progressive.
- **The first retrieval exceeded the 300 s fetch header limit.** The client hit
  undici's `headersTimeout`, as in C2B.2F. The server finished the download about
  5 minutes after the request.
- **Later retrievals came from the Bot API cache.** The second `getFile` returned
  at once, with the exact size (1,004,462,878 bytes).
- **No usable HTTP file-serving path.** The Bot API's HTTP file endpoint returned
  404 in this deployment, for both path forms tried. No Range-capable path exists.
- **The bytes are out of the application's reach.** The cached file sits inside
  the Bot API's state storage, a Docker named volume, not on a filesystem the
  Next.js application can read. In production that application is Vercel-hosted
  and cannot reach the loopback Bot API at all.
- **Conclusion.** The current architecture cannot provide production HTTP Range
  delivery to a Vercel-hosted Next.js application. No streaming endpoint was
  built: faking one would breach the checkpoint's own rule.

## Options for the next delivery checkpoint (decision needed; the roadmap's E1 spike)

1. **A read-only media gateway next to the Bot API.** It mounts the state volume
   read-only on loopback, with a Velora-authorized range proxy in front.
   - Every title needs a full `getFile` cache before its first play.
   - It works only where the Bot API runs.
2. **An MTProto-based gateway.** `upload.getFile` supports offset reads, so ranges
   come from Telegram without a full pre-download. It needs a new dependency and a
   long-running (non-serverless) host.
3. **Browser-ready copies made at ingestion** (MP4 or HLS) in object storage. This
   is a larger product and cost decision.

## Security incident during the probe

A diagnostic line printed the Bot API's absolute path for the cached file. In
`--local` mode that path contains the Movies bot token. It reached the operator
session transcript only: not Git, a file, a log or an external service. The value
is not reproduced here. The operator is rotating the token in @BotFather ("Movies
bot credential rotation" below).

- **Lesson.** In `--local` mode, `getFile.file_path` is itself a secret. Diagnostics
  must never print it, or any part of it, in any form: redact the whole path, not
  just token-equal substrings.
- **Afterwards.** A later read-only, name-hashed inventory of the state volume found
  that the token-named per-bot directory, with the cached copy, was already gone.
  It is recorded in the rotation section.

## Writes

Telegram: `sendDocument` 0, markers 0, forward probes 0, deletes 0. Two `getFile`
calls were made (reads). Hosted: 0. Repository code: unchanged.

## Movies bot credential rotation (PASS)

Date: 2026-09-27. **MOVIES BOT CREDENTIAL ROTATION: PASS.** No credential values
or credential-bearing paths are recorded anywhere.

1. **Rotation.** The operator revoked the exposed token and generated a new one in
   @BotFather, then updated `.env.local` (13:26 local). The agent never saw, read
   or printed either token. At the operator's instruction the old token was **not
   used or tested in any form**, including hashing.
2. **The old token is out of use.** A revoked token cannot authenticate, so the
   local identity check passing proves the configured token is valid. The state
   volume holds **exactly one** per-bot directory, and a name-blind check (hashes
   compared in-process, only a boolean printed) matches it to the configured
   token.
3. **Stale state.** No stale state remained. Before any post-rotation call, a
   name-hashed inventory found **no** per-bot directory at all: the Bot API had
   already discarded the revoked token's state, including the ~1 GB cached copy
   from C2B.2I. **No cleanup, stop or deletion was needed or performed.**
4. **Local login only.** The cloud Bot API was never called, since calling it
   could log the bot back in there. The first post-rotation request, the
   adapter's `checkIdentity` (local `getMe`), created the new session on
   `127.0.0.1:8081`. It returned the exact configured numeric id, `is_bot` and
   exactly `veloramovies_bot`.
5. **Access, read-only, through the local server.**
   - `checkRecoveryAccess`: `ok`. That is `getChat` on the registered Movies
     channel (not content-protected) and on the recovery group.
   - `getChatMember`: channel `administrator` with `can_post_messages`, and an
     ordinary `member` of the recovery group.
6. **Persistence.**
   - `docker restart`, then healthy, still loopback-only (`127.0.0.1:8081`), 0
     crash restarts.
   - The same session directory (same inode) was reused, and its binlog grew with
     the later calls.
   - Every check passed again after the restart.
7. **Series.** Unchanged: still cloud-only and not listed as local. The adapter
   refused it with `bot_not_on_local_server` and made no request.
8. **Hosted (read-only).** Unchanged:
   - 11 migrations;
   - the Movies channel registration and checkpoint **26**, last updated before
     the rotation;
   - media 1 (On The Hunt, message 23) and media 2 (Fuze, message 25), with
     identical file-id fingerprints and last updated before the rotation;
   - On The Hunt `published`, Fuze `received`, both attempt 1;
   - Series 0.

   Stored `file_id`s were not exercised: that would need `getFile`, which is
   outside this checkpoint.
9. **Writes.**
   - Telegram: 0 (no upload, marker, forward, delete, recovery or publication).
   - Reads: `getMe`, `getChat`, `getChatMember`.
   - Hosted: 0.
   - `REAL_TELEGRAM_UPLOADS_AUTHORIZED`: unset.

---

# E1 — MTProto media delivery feasibility spike: BLOCKED — SESSION ARCHITECTURE

Date: 2026-09-27. **E1 MTProto feasibility: BLOCKED — SESSION ARCHITECTURE.** It
stopped after research, **before any MTProto login**. There was no dependency
install, code change or Telegram call (not even a read), and no hosted write. The
ingestion bot session was not touched.

## 1. The protocol primitive can serve HTTP ranges (official documentation)

- `upload.getFile(location, offset, limit, precise?, cdn_supported?)` is usable
  by **both users and bots**
  ([method](https://core.telegram.org/method/upload.getFile)).
- **Rules** ([files](https://core.telegram.org/api/files)):
  - Without `precise`, offset and limit must be divisible by 4 KiB, and 1 MiB must
    be divisible by the limit.
  - With `precise` ("useful for example to stream videos by keyframes"), offset
    and limit must be divisible by 1 KiB, and the limit must be ≤ 1 MiB.
  - Always, each request must lie within one 1 MiB-aligned window:
    `offset / 2^20 == (offset + limit − 1) / 2^20`.
- **Errors and redirects.**
  - `FILE_MIGRATE_X`: the file lives on DC X. It needs an exported/imported
    authorization for that DC.
  - `FILE_REFERENCE_EXPIRED`/`INVALID`: refetch the message for a fresh
    `file_reference`.
  - `FLOOD_WAIT`/`FLOOD_PREMIUM_WAIT` (420): wait.
  - CDN: `upload.fileCdnRedirect` is returned only when the client passes
    `cdn_supported`. A spike can omit it; a production gateway that opts in must
    implement `upload.getCdnFile` and hash checks.
- **Range mapping (to be proven).** An arbitrary HTTP range `[a, b]` maps to
  aligned reads:
  1. start at `floor(a / 1024) * 1024`;
  2. never cross a 1 MiB boundary, with each `limit` rounded up to a 1 KiB
     multiple and ≤ 1 MiB;
  3. trim the prefix `a − start` and cut at `b`.

  No protocol blocker exists, so the documentation does not force a stop.
- **Resolving the document** needs `InputDocumentFileLocation` (id, access_hash,
  file_reference). A bot resolves it read-only with `channels.getMessages`
  ("Both users and bots can use this method";
  [method](https://core.telegram.org/method/channels.getMessages)) on the Movies
  channel, message 23. It uses `inputChannel(id, access_hash = 0)`, which bots
  must use when no full hash is known locally
  ([peers](https://core.telegram.org/api/peers)).
- **Login** is `auth.importBotAuthorization(api_id, api_hash, bot_auth_token)`
  ([method](https://core.telegram.org/method/auth.importBotAuthorization)). That
  page says nothing about coexisting sessions.

## 2. Session safety: credible risk, so no login with the ingestion bot

- The official Local Bot API README
  ([tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api)) says: *"If
  the bot is logged in on more than one server simultaneously, there is no
  guarantee that it will receive all updates."* It prescribes `logOut`/`close`
  before a bot changes servers.
- An MTProto `importBotAuthorization` with the Movies token is such a second
  login.
- No official source (the Bot API reference, the method pages, or the Telethon
  and Pyrogram docs consulted) states that a second MTProto authorization is
  harmless to a bot already on a Local Bot API server.
- **Risk.** Update delivery to the ingestion bot is explicitly unguaranteed, and
  roadmap C1/C2 webhook ingestion depends on updates. Any other interaction is
  undocumented. The ingestion session was proven only hours ago and has already
  needed a rotation.
- Per the brief, that is credible risk, so **no login was attempted.**

## Recommended architecture: a dedicated media-reader identity

- **A separate bot used only by the media service over MTProto**, never on any
  Bot API server:
  - it is added to the Movies channel as an administrator with **all rights
    off** (bots join channels only as administrators);
  - it resolves message 23 read-only with `channels.getMessages`;
  - it reads with `upload.getFile` using its own `file_reference`.
- **Why it is safe.** The ingestion bot (uploads, markers, recovery) never gets a
  second login, and the reader bot's own updates are irrelevant. It can be
  revoked without touching ingestion, and it can never post (no rights).
- **Credential types needed.** The operator configures them; values must never
  be pasted into chat:
  1. **A new bot token** from @BotFather for the reader bot. Its numeric id and
     exact username are also needed, for an identity assertion like
     `TELEGRAM_BOT_API_LOCAL_BOTS`'s.
  2. **`api_id` / `api_hash`.** The existing `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`
     (the app credentials the local Bot API server uses) can be reused: they
     identify the developer app, not a session. The operator may prefer a
     dedicated app entry at my.telegram.org.
  3. **Channel membership.** The operator adds the reader bot to the Movies
     channel with no admin rights enabled. This is a Telegram action that only
     the operator performs.
- **Proposed server-only variable names** (never `NEXT_PUBLIC_`):
  - `TELEGRAM_MEDIA_BOT_TOKEN`
  - `TELEGRAM_MEDIA_BOT_ID`
  - `TELEGRAM_MEDIA_BOT_USERNAME`
  - optionally `TELEGRAM_MEDIA_API_ID`/`_HASH`

## Dependency evaluation (npm registry metadata only; nothing installed)

| | GramJS (`telegram`) | mtcute (`@mtcute/node`) |
| --- | --- | --- |
| Latest | 2.26.22 (2026-07-14) | 0.32.3 (2026-09-25) |
| Unpacked size | about 2.0 MB | about 64 KB, plus `@mtcute/core`/`wasm` |
| Dependencies | 14, pure JS (includes browser shims: `buffer`, `path-browserify`, `websocket`, `node-localstorage`) | includes **`better-sqlite3` (native build)** |
| Bot login, raw `upload.getFile` with `precise`/offset/limit | Yes (`client.invoke(new Api.upload.GetFile(...))`) | Yes (raw `tl` calls) |

- **Recommendation for the spike: GramJS.** It has no native build on this
  Windows machine and gives direct raw-method control.
- **Isolation.** Keep it isolated: a spike script under `.velora-ingest/`, plus
  the dependency in a separate throwaway package or `--no-save`. Never in the
  Next.js bundle.
- **Revisit** the choice (mtcute, or TDLib) for a persistent production gateway.
  Neither choice changes the hosting fact from C2B.2I: MTProto needs a
  long-running server, not Vercel functions.

## Writes

Telegram 0 (not even reads), hosted 0, catalogue 0, repository code unchanged.
No MTProto session was created. On The Hunt stays published and unchanged, and Fuze
unpublished; the Movies checkpoint is 26; Series is untouched.

---

# E1.1 — Dedicated MTProto media-reader range proof: CLOSED — LEAST PRIVILEGE VERIFIED

Date: 2026-09-27. **E1.1 DEDICATED MTProto RANGE PROOF: CLOSED — LEAST
PRIVILEGE VERIFIED.** The proof passed all 14 criteria. After the operator
removed the reader's default channel rights, a live read-only re-check found
the admin-state marker `other` and no write or manage capability ("Reader
rights"). No production gateway, route, player or dependency was added to the
application.

## Isolation (configuration only, before any login)

- The reader `@media_reader_bot` differs from the Movies ingestion bot
  (`@veloramovies_bot`) and from Series:
  - by id and by username;
  - by token, compared by hash in-process and never printed.
- Its token's id prefix matches `TELEGRAM_MEDIA_BOT_ID`.
- The Local Bot API adapter reads no `TELEGRAM_MEDIA_*` variable, and
  `TELEGRAM_BOT_API_LOCAL_BOTS` is `movie` only.
- API credentials: the existing app credentials, `TELEGRAM_API_ID`/`HASH`.
- **Afterwards:** the Local Bot API still holds exactly one per-bot session (the
  Movies token's).

## Library and session

- **GramJS `telegram` 2.26.22** (it reports itself as 2.26.21).
  - It was installed **only** in the Git-ignored `.velora-ingest/mtproto-spike/`,
    with `--ignore-scripts` and an exact version. The application's
    `package.json` and lockfile are unchanged, and nothing in
    `app`/`components`/`lib`/`scripts` imports it.
- **npm marks it archived and unmaintained**, with development moved to the fork
  `teleproto`. That is fine for the spike, but it **disqualifies GramJS for a
  production gateway**. Re-evaluate teleproto, mtcute or TDLib there.
- **Session.** A GramJS `StringSession` holding the reader's MTProto auth key,
  stored only in Git-ignored `.velora-ingest/mtproto/reader.session`. It is never
  printed. Deleting it just forces a fresh bot login.

## Authentication and resolution

- `auth.importBotAuthorization`: `getMe` returns the configured id and username,
  `bot: true`, and it is not the ingestion bot. Home DC 4.
- **Channel.** `channels.getParticipant` with a zero access hash returned
  `CHANNEL_INVALID`. The documented bot pattern works:
  1. `channels.getChannels` with `access_hash = 0` returns the full (non-min)
     channel;
  2. the reader is a member of the broadcast channel;
  3. that hash is used for later calls and kept in memory only.
- **Message 23** via `channels.getMessages`:
  - document, `video/x-matroska`, **1,004,462,878 bytes**, with a filename
    attribute;
  - the caption's source token matches On The Hunt's fingerprint (compared
    in-process);
  - the document lives on DC 4 (the home DC), so there was no `FILE_MIGRATE`.
  - `InputDocumentFileLocation` is built in memory only.

## Reader rights (least privilege verified)

- The reader is `ChannelParticipantAdmin` with **`postMessages`,
  `editMessages`, `deleteMessages` and `other`**. These are Telegram's defaults
  when a bot is added to a channel as an administrator.
- It holds no invite, change-info, ban, pin or add-admin rights.
- Read access does not depend on these rights: `getChannels`, `getMessages` and
  `upload.getFile` are reads. So this is not a READER PERMISSION MODEL block.
- They were **not changed** by the agent.

### Close-out (read-only; the operator removed the rights in Telegram)

- **First re-check.** Telegram still reported post, edit, delete and `other`,
  both from the live `channels.getParticipant` and from the `channels.getChannels`
  channel object. The change had not taken effect, so nothing was recorded then.
- **Second re-check, after the operator saved the change.** Both sources report
  `ChannelParticipantAdmin`, not creator, with **only `other`**:
  - no `post_messages`, `edit_messages`, `delete_messages`, `invite_users`,
    `change_info`, `ban_users`, `pin_messages` or `add_admins`;
  - no `manage_call`, `manage_topics`, stories, direct-message or rank rights;
  - not `anonymous`.
- **What `other` means.** Per the official schema
  ([chatAdminRights](https://core.telegram.org/constructor/chatAdminRights)),
  `other` is set "if none of the other flags are set, but you still want the
  user to be an admin".
  - By itself it allows only admin-level **visibility**: the admin log, chat and
    message statistics, the member list, and seeing anonymous admins. It also
    allows ignoring slow mode, which is irrelevant without posting rights.
  - It grants **no write or manage capability.** A bot can join a channel only
    as an administrator, so `other` alone is the least privilege possible.
- **Still readable.** The channel resolves (broadcast, member, full access hash).
  Message 23 reads as a `video/x-matroska` document, 1,004,462,878 bytes,
  caption fingerprint matching, on DC 4.
- **One bounded read**, `bytes=777777777-777843312`: one `upload.getFile`
  call, 65,536 bytes, **SHA-256 byte-equal** to the local source.
  - It took about 16–18 s on both re-checks, against about 0.3–0.5 s for
    similar reads in the main run. That is probably a fresh connection to the
    file's DC on a short-lived script. A gateway must keep its connection warm;
    this was not investigated further.
- **The ingestion bot is unaffected.**
  - Local `getMe` gives the exact identity.
  - Channel `administrator` with can-post (it needs that) and recovery-group
    `member`.
  - The Local Bot API still holds only the Movies session, is healthy, and has
    not restarted.
- **Writes and state.** Telegram content writes 0, hosted writes 0. On The Hunt
  published at attempt 1 with media 1, Fuze `received`, media references
  unchanged, checkpoint 26, Series untouched.

## Range primitive (`lib/telegram/mtproto-range.ts`, pure, 12 unit tests, 8/8 mutants killed)

- **HTTP semantics.** The range is inclusive, an end past EOF is clamped
  (RFC 9110), and a start at or past EOF is unsatisfiable. A per-caller maximum
  length applies; the spike used 4 MiB.
- **Algorithm.** For each 1 MiB window the range touches, the mapper issues one
  read:
  - `offset = floor(position / 1 KiB) × 1 KiB`;
  - `limit = ceil((min(last, windowEnd) + 1 − offset) / 1 KiB) × 1 KiB`, which is
    ≤ 1 MiB and never crosses the window, because window ends are 1 KiB-aligned;
  - it keeps `[position − offset, …)` of the reply.

  That is the minimum possible number of reads. `assembleRange` refuses a short
  reply (`range_reply_truncated`) rather than returning short output.
- **The spike used `upload.getFile`** with `precise: true`, `cdnSupported: false`
  (no CDN redirect is possible), one read per planned request, and
  `FILE_MIGRATE_X` handling (never triggered).

## Results (every range compared with the local source: length, first and last byte, SHA-256)

| Test | Range | Length | `getFile` calls | Telegram payload | First byte | Equal |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Beginning | 0–1048575 | 1,048,576 | 1 | 1,048,576 | 2,142 ms (includes sender warm-up) | yes |
| Middle, unaligned (~500 MiB) | 524288333–524812620 | 524,288 | 1 | 525,312 | 519 ms | yes |
| Tail (last 64 KiB, cues region) | 1004397342–1004462877 | 65,536 | 1 | 66,334 | 337 ms | yes |
| EOF clamp (end past EOF) | 1004461878–(EOF+4096) → 1004462877 | 1,000 | 1 | 1,822 | 300 ms | yes |
| **Arbitrary HTTP range** | **123456789–124505364** | **1,048,576** | **2** (window split) | 1,049,600 | 446 ms | **yes** |
| Seek pattern, 256 KiB each | beginning, tail/index (the exact cues range), 400 MiB, 800 MiB, 100 MiB | 5 reads | 5 | about 1.08 MiB | 346–436 ms | yes, all |
| After abandonment | 300 MiB | 131,072 | 1 | 132,096 | 447 ms | yes |
| After a forced-reference run | 50 MiB | 65,536 | 1 | 66,560 | 375 ms | yes |

- **Arbitrary-range proof.** The first byte, last byte, exact length
  (1,048,576) and SHA-256 all equal the local source.
- **Concurrency.** Three 256 KiB reads ran at once: all fulfilled and
  byte-equal, in 633 ms wall time against 1,510 ms summed. GramJS pipelined
  them over one sender; it did not serialize them. There was no flood wait and
  no migration.
- **Abandonment.** GramJS has **no per-RPC cancellation** (no AbortSignal). One
  1 MiB read was abandoned after 30 ms. It settled in the background, bounded
  to exactly its 1 MiB, and the next read succeeded. A gateway must therefore
  bound in-flight reads per client (each is ≤ 1 MiB), not rely on cancellation.
- **File-reference refresh.**
  - **Implemented but not exercised live.** On `FILE_REFERENCE_EXPIRED`/`INVALID`
    the reader refetches message 23 once and retries once, with no loop.
  - Telegram **accepted every reference** for this reader and document: the
    fresh 33-byte one, an XOR-corrupted one, a random 20-byte one and an empty
    one. So the error could not be provoked. Keep the bounded path; it cannot
    be proven here.
- **Volume.**
  - The whole experiment: 15 ranges, **17 `upload.getFile` calls**, 5.54 MiB of
    Telegram payload, and **5.55 MiB received by all sockets in the process**
    (0.01 MiB sent). The file is 957.9 MiB.
  - Each range's socket bytes tracked its aligned request (for example, the
    tail read received 66 KiB).
  - Peak RSS was 126 MiB. **No full-file retrieval.**

## Ingestion and application invariants (after the spike)

- The ingestion bot on the Local Bot API is healthy:
  - local `getMe` gives the exact id and username;
  - channel `administrator` with can-post, and recovery-group `member`;
  - `getChat` succeeds; the server is healthy with no restart.
  - Series is refused locally.
- Hosted, read-only, unchanged:
  - On The Hunt `published`, attempt 1, media 1;
  - Fuze `received`, media 2;
  - media rows last updated before the spike;
  - checkpoint 26, Series 0.
- **Writes.** Telegram content 0 (no post, edit, forward, delete or upload), and
  the Bot API was not used for the reader. Hosted 0.

## Security audit

- **Spike artifacts and the new module:** 0 secret values (every token, the API
  hash and the service key checked) and 0 token-shaped strings.
- **Output:** all printed output was filtered, and none contained a token, hash,
  access hash, file reference, channel id, fingerprint or path.
- **Session material** is Git-ignored and outside every committed path.

## Next (not started)

The source primitive works. A production gateway still needs:
- a long-running host (not Vercel functions);
- a maintained MTProto library;
- publication-checked, Range-serving HTTP;
- per-client in-flight bounds;
- the reader's rights removed.

---

# E1.2 — Media gateway foundation: PASS

Date: 2026-09-27. **E1.2 MEDIA GATEWAY FOUNDATION: PASS.** A long-running,
published-only HTTP byte-range gateway serves On The Hunt (VJ Ice P) from the
Movies channel over MTProto through the dedicated media reader. It holds one
warm connection and bounded upstream work. No player, download, HLS, transcoding
or Series work. Starting HEAD `c66cb2c`.

## 1. MTProto client selection: mtcute 0.32.3

Criteria: maintenance, persistent sessions, per-request cancellation,
reconnect and DC migration, native dependencies, Docker/Linux cost, and fit for
a long-running gateway. Registry metadata and source were read on 2026-09-27.

| | mtcute (`@mtcute/node`) | teleproto | tdl + TDLib | GramJS (`telegram`) |
| --- | --- | --- | --- | --- |
| Latest | 0.32.3 (2026-09-25) | 1.229.0 (2026-08-25) | tdl 8.1.0 (2026-03-10); prebuilt-tdlib 2026-08-26 | 2.26.22 (2026-07-14) |
| Releases | 117 since 2023-11; 12 in the last 6 months | 55 since 2025-05; 21 in the last 6 months | tdl: 1 in the last year | npm marks it **archived, unmaintained** |
| Maintainers (npm) | 1 | 1 | 1 (binding); TDLib itself is Telegram's | 2 |
| Per-RPC cancellation | **Yes**: `abortSignal` on every call; local reject plus `rpc_drop_answer` to Telegram | **No**: `invoke(request, dcId)`; the only `abortSignal` is for QR login | `cancelDownloadFile` (TDLib's own file manager) | No (E1.1) |
| File reads | Raw `upload.getFile` with `precise` on the document's DC | Raw invoke (GramJS model) | `downloadFile`/`readFilePart` into TDLib's **disk cache** only; no raw ranged `getFile` | Raw invoke |
| Session | `exportSession`/`importSession` string, any storage | StringSession/StoreSession | TDLib database directory (binlog and files) | StringSession |
| Reconnect, DC | Built in: reconnect strategy, per-DC pools, `FILE_MIGRATE` surfaced as a typed error | GramJS model | Fully internal | GramJS model |
| Native code | None when storage is in memory (`better-sqlite3` installs, but its addon is never built or loaded: `--ignore-scripts`) | None | **~60 MB native TDLib per platform** (glibc/musl builds) | None |

**Decision: mtcute 0.32.3**, pinned exactly with `@mtcute/file-id` 0.32.0.
- It is the only maintained candidate with real per-RPC cancellation, which a
  gateway needs when a browser goes away.
- teleproto inherits GramJS's call model: no cancellation, and a young fork (since
  2025-05) with high churn.
- TDLib is the most battle-tested MTProto client but the wrong model here. It
  streams through its own on-disk file cache, and C2B.2I already showed that
  model forces the full-file problem. It adds a large native binary and a full
  client database.
- **Risks accepted:** mtcute is pre-1.0 with a single maintainer. Mitigations:
  an exact pin; one small adapter (`services/media-gateway/mtcute-reader.mts`)
  behind a port the HTTP core owns; the range planner stays ours.

**Why GramJS is rejected for production.** npm marks it archived and
unmaintained (development moved to teleproto), and it has no per-RPC
cancellation (E1.1). It remains only as the E1.1 spike record.

**`downloadChunk` source finding, verified in the installed 0.32.3:**
- it aligns the offset down to 1 KiB and the limit up to 1 KiB;
- it refuses an aligned limit above 1 MiB (`MtArgumentError`);
- it calls `upload.getFile` with `precise: true`;
- it trims the aligned reply;
- it passes `abortSignal` through.

Two defects follow from that code, both reproduced offline against the real
function with a stub that answers like Telegram (short replies at EOF):
1. **It does not keep a read inside one 1 MiB window.** For offset 1,048,000,
   limit 2,000 it requested `offset 1047552, limit 3072`, which crosses a window
   and is illegal per the files documentation.
2. **It trims by the requested length, not the reply length.** For the last
   1,000 bytes it returned **774 bytes**, silently truncated at EOF.

So the gateway does not use `downloadChunk`. It calls `upload.getFile` directly
with the E1.1 planner's legal, window-local reads (`lib/telegram/mtproto-range.ts`),
does its own trimming, and refuses a short reply (`document_resolution_failed`).

## 2. Runtime and container architecture

- **Core (`lib/media-gateway/`).** Node built-ins plus the E1.1 planner only;
  a boundary test enforces this:
  - `range.ts`: Range parsing;
  - `token.ts`: authorization tokens;
  - `pump.ts`: bounded streaming;
  - `limits.ts`;
  - `errors.ts`;
  - `log.ts`;
  - `config.ts`;
  - `resolver-sql.ts`;
  - `server.ts`: `node:http`.
- **Service (`services/media-gateway/`).** A separate npm package, excluded from
  the root tsconfig and never imported by the application (boundary test). It
  holds `mtcute-reader.mts`, `pg-resolver.mts`, `main.mts`, its own lockfile,
  tsconfig (`erasableSyntaxOnly`), `Dockerfile` and an allow-list
  `Dockerfile.dockerignore`.
- **It runs on plain Node 24** with native type stripping and the existing
  `scripts/ingest/register.mjs` hooks, so there is no build step.
- **Not in the app.** The Next.js production build contains no gateway code (a
  scan of `.next` finds 0 matches), and the application's `package.json` is
  unchanged.
- **Image:** `node:24.13.0-bookworm-slim@sha256:4660b1ca…`, `npm ci --omit=dev
  --ignore-scripts`.
  - Only 17 application files; no session, `.env` or journal file (verified
    inside the image).
  - Runs as `node` (uid 1000); 375 MB, mostly the Node base image.
  - Health check on `/healthz`; `STOPSIGNAL SIGTERM`.
- **Proof container:** `--read-only`, tmpfs `/tmp`, `--cap-drop ALL`,
  `no-new-privileges`, `--memory 256m`, `--cpus 1`, `--pids-limit 64`, bound to
  `127.0.0.1` only. The session directory is a mounted volume.
- **Host.** It needs a long-running host (a container or VM), not Vercel
  functions, as C2B.2I established.

## 3. Persistent session

- **One mtcute client for the life of the process.** Updates are disabled and
  library logs are off.
- **Storage.** `MemoryStorage`, plus an exported session string in
  `MEDIA_GATEWAY_SESSION_FILE`:
  - written atomically (temporary file, then rename), mode 0600;
  - re-persisted after startup and on shutdown.
- **No new authorization.** The E1.1 reader's GramJS session was converted
  offline (`@mtcute/convert`, in a throwaway directory since removed): the same
  256-byte auth key on home DC 4. A bot login (`MEDIA_GATEWAY_ALLOW_BOT_LOGIN=true`
  plus `TELEGRAM_MEDIA_BOT_TOKEN`) is possible only when explicitly enabled and
  no session exists; the token must belong to the reader id.
- **Startup, fail closed:**
  1. connect;
  2. `getMe` equals the configured reader id and username, is a bot, and is not
     an ingestion bot;
  3. the Movies channel resolves (access hash 0 → full channel), the reader is a
     member, and its admin rights are exactly `other`. Any write right fails
     readiness (`rights_too_broad`).
  - The rights check repeats every 5 minutes.
- **Reconnect.** mtcute's strategy (immediate, then up to 5 s apart). Readiness
  requires `connected`.
- **Shutdown (SIGTERM/SIGINT):**
  1. readiness drops and new streams are refused;
  2. running streams get 15 s;
  3. the session is persisted and connections close.
- **Transient startup failures retry** with backoff. Identity, rights and
  missing-session failures stay not ready.

## 4. Authorization tokens

- **Format.** `v1.<base64url claims>.<HMAC-SHA256>`. Claims:
  `{aud: "velora-media-gateway", op: "stream" | "download", mv, sub, iat, exp, jti}`,
  where `mv` is the internal movie-version id.
- **No Telegram identifier** can be expressed. Any extra claim is refused.
- **Verification order.** The MAC is compared in constant time before parsing.
  Then:
  1. strict claims;
  2. a lifetime cap (`exp − iat` ≤ 3,600 s by default);
  3. `iat` skew ≤ 30 s;
  4. expiry;
  5. operation;
  6. version.
- **Stream and download are separate.** A `stream` token never authorizes
  `/download`, and the reverse. `/download` recognizes a download token and still
  serves no bytes (501).
- **Transport.** `?token=` for media elements, or `Authorization: Bearer`; both
  together are refused. Responses carry `Cache-Control: private, no-store` and
  `Referrer-Policy: no-referrer`. The token is never logged.
- **Issuer.** `signMediaToken` is server-only. In E1.2 only the proof harness
  issues tokens; the entitled issuer is roadmap E2.

## 5. Catalogue and private-media resolution

- **One fixed statement** (`RESOLVE_MOVIE_VERSION_SQL`). It returns the private
  media of a movie version only when all of these hold:
  - the movie is `published` with `published_at`;
  - the version is `ready` and rights `cleared`;
  - the VJ is active;
  - the media belongs to the movie bot, sits in the **registered** Movies
    channel, and has a recorded size.
- **Fail closed.** Anything else, including Fuze-style media with no version and
  unknown ids, returns no row → 404, identical for every cause.
- **Read-only, one round trip.** It runs as `set transaction read only; set local
  statement_timeout = 3000; <statement>`, one simple-protocol batch, which
  PostgreSQL runs as one implicit transaction. On the hosted pooler:
  - **~233 ms warm** (four round trips took ~1,150 ms);
  - a write inside such a batch is refused (SQLSTATE 25006, nothing created);
  - nothing carries over to the next query.
- **Why not the alternatives.** Startup parameters cannot carry the read-only
  default through the Supabase pooler (measured: dropped). postgres.js refuses a
  textual `BEGIN` on a pool. Readiness verifies `transaction_read_only = on`. The
  version id is interpolated only as a validated positive safe integer.
- **Credential (debt).** `MEDIA_GATEWAY_DATABASE_URL` is the owner connection
  the ingestion tooling already uses. `private.telegram_media` grants nothing to
  any API role, and this checkpoint changes nothing hosted. A dedicated
  least-privilege role or a narrow SECURITY DEFINER function is the follow-up.
- **Document integrity.** The reader fetches the message read-only
  (`channels.getMessages`) and checks the document against the catalogue before
  any byte is served:
  - the Bot API `file_unique_id` parsed to the same document id;
  - the exact size;
  - the MIME type.
- **Caching and retries.** The resolved location is cached for 10 minutes per
  media id. `FILE_REFERENCE_*` gets one refresh and one retry, `FILE_MIGRATE_X`
  one retry on DC X.

## 6. Endpoint and Range semantics

`GET /v1/movie-versions/{id}/stream?token=…`, `GET /v1/movie-versions/{id}/download`
(reserved), `GET /healthz`, `GET /readyz`, and a CORS preflight (`OPTIONS`) on
the media routes.

- **Order, each step failing closed:**
  1. route;
  2. only the `token` parameter (anything else, for example `message_id` or
     `chat_id`, gets 400);
  3. token;
  4. rate and stream limits;
  5. reader readiness;
  6. catalogue;
  7. Range;
  8. bytes.
- **Range.** One `bytes` range: `a-b`, `a-` or `-n`.
  - An end past EOF is clamped.
  - A range longer than `maxResponseBytes` (8 MiB) or open-ended is shortened
    to it: a valid 206 with a smaller `Content-Range`, and the client asks again.
  - A missing Range gets 400 `range_required`, so **the whole movie is never one
    response**.
  - Malformed, multi-range or repeated headers get 400.
  - A start ≥ size, or `-0`, gets 416 with `Content-Range: bytes */size`.
- **Headers go out only after the first upstream read succeeds.** An early
  Telegram failure is therefore still a clean status. A mid-body failure cuts
  the connection.
- **CORS** is allow-listed per origin. A suffix range is not CORS-safelisted, so
  Chrome preflights it (found in the browser proof, then implemented). The
  preflight never touches the catalogue or Telegram.

## 7. Streaming, backpressure and limits

- **Bounded pump.**
  - At most `readAheadPerStream` (2) reads in flight per stream, each ≤ 1 MiB,
    plus a gateway-wide semaphore of `maxReadsInFlight` (8).
  - Every reply is trimmed and written at once; no response is assembled.
  - When `write()` returns false, nothing new is scheduled until `drain`.
- **On disconnect or timeout:**
  - scheduling stops immediately (including an abort observed during a write);
  - in-flight reads are aborted through mtcute's signal;
  - their semaphore slots are awaited and returned.
  - With a non-cancellable client, only already-issued reads would finish
    (tested with a fake).
- **Limits (defaults; configurable only within hard bounds, and fail closed on
  bad values):**

| Limit | Default |
| --- | --- |
| Active streams, global / per subject / per IP | 32 / 3 / 6 |
| Reads in flight | 8 gateway-wide, 2 per stream |
| Response size | 8 MiB |
| Timeouts | request 120 s, idle 30 s, per read 30 s |
| Token lifetime cap | 3,600 s |
| Range requests per 60 s window | 120 per subject, 240 per IP (bounded key table) |

- Pooler connections are pre-opened at startup, because a pooler connect costs
  about 2 s.

## 8. Errors, logging, health

- **Internal codes** (closed set). Among them:
  - authorization missing, invalid, expired, wrong operation, wrong version;
  - version unavailable; invalid request; range required, invalid,
    unsatisfiable;
  - rate limited; too many streams; not ready; catalogue unavailable;
  - Telegram unavailable; flood wait (with `Retry-After`, capped); MTProto
    disconnected;
  - document resolution failed; upstream timeout; internal.
- **Public output.** Each code maps to a fixed status and a one-field JSON body.
  Raw Telegram, MTProto and driver errors never leave their adapter; anything
  unclassified is `internal_error`.
- **Logs are JSON lines by allow-list:** request id, internal version id, route,
  requested and served bytes, reads planned and issued, RPC count, status,
  latency, first byte, safe code, outcome and state. Any other field, and any
  non-identifier-like string, is dropped.
- **Health.**
  - `/healthz` answers `{"status":"ok"}` and calls nothing.
  - `/readyz` answers 200 only when the reader is `ready`, MTProto is connected,
    the read-only catalogue probe passes and the gateway is not shutting down.
    Otherwise it answers 503 with a safe state label only.

## 9. On The Hunt HTTP proof (through the gateway's HTTP boundary)

Every range was compared with the local source `G:\Movies` (length, first and
last byte, SHA-256). The table is the final **local-process** run, the same code
as the image. The container run executed the same steps, but its per-range lines
were filtered out of the saved console log and its summary file was never
written (the harness stopped at the reconnect step), so the table claims nothing
for the container. In the container, byte-equality is proven by the browser
proof (§10: beginning, tail, middle and unaligned ranges) plus the 416 and 400
cases.

| Proof | Request | Result |
| --- | --- | --- |
| A beginning | `bytes=0-1048575` | 206, `bytes 0-1048575/1004462878`, length 1,048,576, **byte-equal** |
| B middle | `bytes=524288333-524812620` | 206, 524,288 bytes, **byte-equal** |
| C final 64 KiB | `bytes=-65536` | 206, `bytes 1004397342-1004462877/1004462878`, **byte-equal** |
| D arbitrary unaligned | `bytes=123456789-124505364` | 206, 1,048,576 bytes, 2 reads (window split), **byte-equal** |
| Open-ended | `bytes=0-` | 206, `bytes 0-8388607/…` (bounded, not the movie), byte-equal |
| EOF clamp | end past EOF | 206, 1,000 bytes, byte-equal |
| E unsatisfiable | `bytes=1004462878-`, `bytes=-0` | **416**, `Content-Range: bytes */1004462878` |
| No Range | none | 400 `range_required` |
| F missing, tampered, foreign-key, expired | | 401 (expired: `authorization_expired`) |
| G wrong operation | download token on stream; stream token on download; version 1 token on version 2 | 403 |
| G download endpoint | download token | 501, no bytes |
| H Fuze | version 2 (Fuze has no version row); unknown id | 404 |
| H Telegram ids from the client | `message_id=25`, `chat_id=…`, a Telegram-shaped path | 400 / 400 / 404 |

- Every 206 carried `Accept-Ranges: bytes`, an exact `Content-Range` and
  `Content-Length`, and `Content-Type: video/x-matroska`.
- **Every denial made 0 MTProto RPCs and served 0 bytes** (gateway logs).
  Authorization failures also never reached the catalogue (unit-tested with call
  counters).

## 10. Browser-level proof (headless Chrome 153; no player)

- A page on another origin (allow-listed) made six independent `fetch` range
  requests to the live gateway. The four 206 responses (beginning, suffix tail,
  middle 256 KiB, unaligned 1 MiB) had correct headers and were **SHA-256-equal
  in-browser** (`crypto.subtle`) to the source.
- `bytes=1004462878-` got 416 with `bytes */1004462878`; no Range got 400.
- It passed in both local and container mode.

## 11. Latency, throughput, memory

- **Cold starts.**
  - E1.1 cold script: ~16–18 s for a 64 KiB read.
  - Gateway startup to ready: 4.2–6.6 s (connect, identity, channel and rights,
    pool warm-up).
- **Warm: 10 × 64 KiB spread across the file, sequential, end to end over
  HTTP.**
  - Container: median TTFB **579 ms** (545–625).
  - Local: median **567 ms** (516–631).
  - That is ~230 ms catalogue plus ~350–450 ms MTProto, against the E1.1
    established session's 0.3–0.5 s for the MTProto read alone.
- **Before the resolver fix:** median 1,524 ms (four database round trips).
- **Throughput:**
  - 8 MiB response: 4.9 s locally (~1.7 MiB/s); 10.6 s in an earlier run.
  - Concurrency: 3 × 256 KiB in 1.0–1.3 s.
- **Connection pool.** mtcute's `main` connection read 1 MiB in ~0.6 s against
  ~1.3 s on its `download` pool (4 concurrent: 2.16 against 1.16 MiB/s), so
  `main` is the default.
- **Container memory under `--memory 256m`:** 70.9 MiB idle; **76.5 MiB** with
  three paused 8 MiB streams.

## 12. Backpressure, disconnect, reconnect, shutdown (live)

- **Disconnect** after the first chunk of an 8 MiB range:
  - `client_closed`, **3 of 9** planned reads issued, 1 completed, 0.94 MB
    served;
  - no later activity for that request (both modes).
- **Backpressure.** A client paused for 6 s mid-response: the gateway did not
  finish or read ahead while paused. On resume it served all 8 MiB,
  byte-equal (9 of 9 reads).
- **Per-subject limit:** 3 open streams, and the 4th got 429 `too_many_streams`.
- **Reconnect, container.** A real network cut (`docker network disconnect`) for
  ~10.5 minutes:
  - the drop was seen at once and followed by 131 bounded reconnect attempts;
  - there was no crash or restart;
  - after reconnection it was `connected` within ~5 s and `/readyz` was `ready`.
- **Reconnect, in-process.** A hard socket drop:
  - readiness 503 (`mtproto_connecting`) immediately;
  - reconnected in **282 ms**;
  - the next range was byte-equal.
- **Graceful shutdown.**
  - `docker stop` (SIGTERM) logged `shutdown` → `reader_state: stopped` →
    `stopped`, and the container exited in 5.6 s with the session re-persisted.
  - In-process, a 4 MiB stream in flight at shutdown completed byte-equal first.

## 13. Tests and gates

- **Gateway unit suites: 138 tests.** They cover:
  - Range: aligned, unaligned, suffix, open-ended, invalid, 416;
  - tokens: signature, tamper, expiry, lifetime, operation, version, extra or
    Telegram claims;
  - limits; pump (backpressure, disconnect, bounded read-ahead, cancel on error,
    truncated reply);
  - HTTP (denial ordering with call counters, 206/416 headers, download split,
    CORS, readiness, shutdown);
  - log redaction; safe errors; config; the bundle boundary.
- **Resolver against the local database: 15 tests.** Published, and ten hidden
  cases:
  - draft, archived, not ready, unavailable, archived version;
  - rights blocked, rights unknown;
  - inactive VJ, unregistered channel, no size;
  - also unknown id and Fuze-style media with no version.
  - It rolls back and leaves no rows.
- **Mutation testing: 24 of 24 critical mutants killed.**
  - 6 token, 3 range, 4 server, 5 pump, 1 log, 5 SQL.
  - The first round let 5 survive: 1 equivalent (its redundant line removed), 1
    real pump defect (fixed and tested), and 3 weak tests or fixtures
    (strengthened).
- **Full suites:**
  - `npm test`: 486 across 25 files;
  - `npm run test:db`: 416 pgTAP, PASS;
  - `npm run test:catalogue`: 45 across 4 files;
  - `db lint --local`: no schema errors.
- **Lint:** 0 errors (1 pre-existing warning in a Git-ignored E1.1 spike file).
- **Typecheck:** root and service.
- **`next build`:** passes, with 0 gateway strings in `.next`.
- **Defects found and fixed during the checkpoint:**
  - Node strip-only TypeScript rejected parameter properties; they were removed,
    and `erasableSyntaxOnly` now enforces it;
  - `bytes=<size>-` was misclassified as 400 (now 416);
  - an abort observed during a write could schedule reads;
  - the 4-round-trip resolver;
  - the missing CORS preflight.

## 14. Security and external state

- **Secret scan.** All 33 changed or new files were checked against 25
  configured secret values and against token, session, database-URL and
  channel-id shapes: **no secret**. The only matches were public bot usernames
  already in this record (the test sample was replaced) and the committed
  `-1000000000000` constant.
- **Log audit** in both modes: 0 matches for the token secret, API hash, bot
  tokens, database URL, channel id (both forms), reader id or session; no
  token-shaped strings; every line JSON.
- **Session material** lives only in Git-ignored `.velora-ingest/`. The image
  build context is an allow-list.
- **Temporary packages removed:** `eval-mtcute`, the GramJS spike's
  `node_modules`, the intermediate converted-session copy and the scratch
  teleproto install.
- **External writes:**
  - Telegram content writes **0**. MTProto reads only: `getMe`, `getChannels`,
    `getParticipant`, `getMessages`, `upload.getFile`, all bounded ranges. No
    upload, send, edit, delete, forward or permission change.
  - Hosted writes **0**. Reads: catalogue resolution, and one deliberate write
    probe inside a read-only transaction (refused with 25006, nothing created).
- **After the checkpoint, hosted is unchanged:**
  - 11 migrations;
  - On The Hunt published, version 1 ready/cleared, attempt 1, media 1;
  - Fuze `received` with no version;
  - checkpoint **26**;
  - Series 0, episodes 0;
  - every `updated_at` predates the checkpoint.
- **Local infrastructure.** Docker Desktop was started for the gates and was
  restarted when its engine hung. The Local Bot API container was not used.

## 15. Debt and next

- **Database credential.** A least-privilege database credential or a narrow
  SECURITY DEFINER resolver (a migration) replaces the owner connection.
- **Token issuer.** The entitled issuer, short-lived playback sessions, is E2.
- **Playback.**
  - Media-element playback was not tested (not MKV decoding).
  - Safari cannot play Matroska/MP3 (C2B.2I).
- **Latency options:** a short positive resolution cache (bounded unpublish
  delay), and co-locating the gateway with the database region.
- **`FILE_REFERENCE_*` refresh** is implemented but still unprovoked (as in E1.1).
- **Production host, TLS, the public hostname and ingress rate limiting** are
  G-phase work.
