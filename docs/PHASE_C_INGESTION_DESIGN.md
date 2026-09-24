# Phase C — Telegram Ingestion: Contract and Pipeline Foundation (C1)

Date: 2026-09-25
Baseline: `phase-a-foundation` at `0b70ac1` (Phases A and B complete). Hosted: 8 migrations.
Status: **C1 contract checkpoint implemented locally. No migration. Not pushed.**

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
