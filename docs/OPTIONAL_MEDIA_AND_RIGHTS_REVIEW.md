# Optional media verification and the rights review

2026-10-18. **Local only, uncommitted.** Nothing was pushed, deployed or published,
no hosted migration was applied, and no listener was rebuilt or restarted. The
emergency containment (AGENTS.md section 40) is unchanged: the pause marker and
the five quarantine guards remain, and nothing here records rights, approves or
publishes on its own.

## 1. Owner decisions (2026-10-18)

| Question | Decision |
| --- | --- |
| Is verified media still required to publish when inspection is `optional` or `disabled`? | **No.** Unchecked or inconclusive media does not block publication in those modes. A definite media failure still blocks (the brief: known corruption must never pass). `required`, the default, keeps the Checkpoint 10 gate unchanged. |
| What is "preparing a catalogue entry"? | Reaching the catalogue-ready review state. No draft `movies` rows. |
| Rights documentation | Optional: a reference is enough, and a document's SHA-256 can be recorded. Publication still needs a verified rights decision by an account with the rights permission (the brief and section 40). |
| Rights expiry | None. Statuses are `not_provided`, `pending_review`, `verified`, `rejected`. |

## 2. Audit: where each check is enforced

```
Telegram post
  → listener (services/media-gateway/discovery.mts, VELORA_DISCOVERY_INSPECTION = disabled | metadata | bounded)
  → discovery_receive / discovery_claim / discovery_complete       media evidence written here (worker roles only)
  → private.channel_review_blockers                                the single gate evaluator
      identity, metadata, VJ, media (mode-dependent from now on), content conflict,
      rights clearance (revision + document bound), conflicts, relationship, linkage
  → lib/discovery/database.ts reviewStatus → guidance.ts / media-report.ts / discovery-review.tsx (presentation only)
  → discovery_review_approve → catalogue_review.approve_channel_candidate     gates again, review permission
  → discovery_review_publish → catalogue_review.publish_channel_candidate
      → private.catalogue_publish_channel_movie                               gates again, publish permission
      → private.catalogue_materialize_movie_version                           sets rights_status = 'cleared'
  → public read policies, media_gateway.resolve_movie_version, resolve_movie_download
      all require published + ready + rights_status = 'cleared' (unchanged)
  → /api/media/stream-token and /api/media/download-token (lib/playback, unchanged)
```

Already in place before this change:

- **Trusted source and provenance.** The registered Movies channel (`private.telegram_channels`), with the channel and message in `private.telegram_media`. The `tg1-` identity is a SHA-256 of chat, message, file unique id and size.
- **Duplicates.** Each delivery is recorded once in `discovery_deliveries`. A unique index lets a document have only one provenance, and a repost becomes `ignored` / `duplicate_media`.
- **Matching.** Catalogue first, then TMDB suggestions, then existing active VJs.
- **Media inspection.** Full-file verification never ran automatically: only an operator runs `discovery.mts --verify <key>`.

## 3. What changed

### Database: `20261018090000_optional_media_and_rights_review.sql` (migration 29, local only)

- **`private.catalogue_policy`**: one row holding `media_inspection_mode`, default `required`.
  - It has no grants for any API role. The owner changes it with SQL, and it cannot be deleted.
  - Every value is recorded with the database role that set it in the append-only `private.catalogue_policy_audit`.
  - `private.media_inspection_mode()` falls back to `required` if the row is missing.
- **`private.media_evidence_known_failure(ev)`**: true only for a Policy 3 finding against the file itself, which the reviewer screen shows as "Failed". These are not failures:
  - reader outages;
  - decodes that do not show damage (`decode_failed`, `decode_error_at_end`, `decode_codec_unsupported`);
  - earlier policies' refusals, which are history under Policy 3.
- **`private.channel_review_blockers`** is replaced. In `required` mode the media gate is identical to before. In `optional` and `disabled` modes only `media_known_failure` blocks. Every other gate is unchanged, including `rights_clearance_required`.
- **`private.rights_submissions`** holds submitted references, with an optional document SHA-256.
  - At most one is open per revision.
  - Each is decided once (`verified` or `rejected`), and a trigger forbids any other change and any deletion.
  - A submission grants nothing.
- **`rights_clearances`** gains a nullable `document_sha256` and `submission_id`. Existing rows are unchanged.
- **`public.discovery_review_submit_rights`** (any reviewer permission) and **`public.discovery_review_decide_rights`** (rights permission):
  - Both are SECURITY DEFINER, with `search_path=''`, an owner of `postgres`, and EXECUTE for `authenticated` only.
  - Verifying writes the same revision-bound clearance as `discovery_review_clear_rights`: a new revision, and any approval cleared.
- **`private.channel_view`** adds `media_inspection_mode`, `rights_status`, the rights submissions (detail view) and the evidence's `known_failure`.

The migration depends only on migrations present on hosted. It applies to the hosted-equivalent 19-migration chain (no admin-upload chain) as well as to the full chain.

### Application

| File | Change |
| --- | --- |
| `lib/discovery/model.ts` | Optional `mediaInspection` and `rightsReview` on the review model; the offline inbox format is unchanged |
| `lib/discovery/database.ts` | Parses the new view fields (absent or unknown values are dropped, never trusted); `media_known_failure` maps to `awaiting_media`; `submitRights` and `decideRights` |
| `lib/discovery/guidance.ts` | `catalogueStage` (Discovered, Identified, Catalogue-ready, Awaiting publication authorization, Published, Rejected or blocked); next-step text for each rights status; the media step includes `media_known_failure` |
| `lib/discovery/media-report.ts` | The five independent indicators; under optional mode the media requirements read "verification optional" and are satisfied unless the file failed |
| `components/discovery-review.tsx` | "Where this movie stands" overview, a "Distribution rights" panel (submit, verify or reject, history) and a stage line on queue cards. The panel appears only when the database reports the rights review |
| `app/admin/discovery/actions.ts` | `submit_rights` and `decide_rights` commands; each is authorized again by the database |

No new route, permission, environment variable or dependency. Approve and Publish are the same controls, offered to the same permissions.

**On a database without migration 29** (hosted today), the overview and stage lines render from the existing fields. The rights panel and its commands do not appear. Note that the developer's `next dev` hot-reloads this UI onto hosted data.

## 4. Configuration

| Setting | Where | Effect |
| --- | --- | --- |
| `private.catalogue_policy.media_inspection_mode` | Database, owner SQL only | `required` (default): publication needs verified media. `optional` / `disabled`: only a known media failure blocks |
| `VELORA_DISCOVERY_INSPECTION` (existing) | Listener host | Whether the listener inspects automatically: `bounded` (bounded reads), `metadata` (no media reader), `disabled` (records only). It does not decide any gate. Recommended pairing: `required` ↔ `bounded`; `optional` ↔ `metadata` or `bounded`; `disabled` ↔ `metadata` |

Changing the mode (owner, after migration 29 is deployed):

```sql
update private.catalogue_policy set media_inspection_mode = 'optional';  -- or 'required' / 'disabled'
select * from private.catalogue_policy_audit order by id;                 -- every change is recorded
```

A candidate approved under `optional` is checked again at publication. If the mode
has changed back to `required` in between, publication is refused.

## 5. Workflow

```
Telegram Movies channel (registered, trusted source)
  → detected once (duplicates ignored)                                   Discovered
  → film and VJ suggested, then confirmed by a reviewer                  Identified
  → media check (mode decides whether it gates publication)              Catalogue-ready
      required: verified integrity and streaming needed
      optional / disabled: not needed; a known failure still blocks
  → rights: not provided → pending review → verified | rejected          Awaiting publication authorization
      (submit: any reviewer; decide: rights permission; reference only, document optional)
  → approve (review permission) → publish (publish permission)          Published
  → public catalogue, stream and download: published + ready + rights cleared (unchanged)
```

## 6. Validation (2026-10-18, local, disposable containers only)

| Gate | Result |
| --- | --- |
| New suite 022 (pgTAP) | 133/133. Three gate mutations caught: known failure ignored (3 failures), rights not required (29), mode ignored (4) |
| All database suites, 29 migrations | 21/22 suites, 1,343 assertions. Suite 003 fails 2 inventory assertions (section 7) |
| Hosted-equivalent chain (19 + this migration) | Applies; suites 009, 010, 012, 018, 021, 022 pass. Suite 017 cannot run there because it needs an admin-upload role (as before) |
| `supabase db lint` (disposable database, warning level) | Two warnings, both in existing functions; none in the new migration |
| Unit (`vitest run`, media tool paths set) | 1,244 passed, 3 failed (section 7). 21 new tests pass |
| Integration (isolated) | 66 passed, 1 skipped (existing Auth exclusion), 2 failed (section 7). The new end-to-end test passes 5/5 |
| Typecheck: app and the three service configs | Pass |
| ESLint | Pass |
| Offline production build (isolated, seeded) | Pass. No new command name in browser chunks |
| Private-value scan of the build | 0 matches in 1,306 files. The scan script stops on a link Next creates under `.next/node_modules`, so it was run from a copy that skips links. Admin route traces include only the committed synthetic browser fixtures, through existing filesystem use |
| Browser, admin specs, six projects | 42/42 (24 existing, 18 new) |
| `scripts/checkpoint9-validation.mts` | **Not run**: its first line asserts exactly 28 migrations |

An existing listener `--check` test timed out once under parallel load. It passed 3/3 alone and in the next full run.

## 7. Existing checks changed with approval (2026-10-18)

The owner approved these changes after the failures above were reported. Each was failing only because of the new content; no expectation was weakened:

1. `supabase/tests/database/003_security_boundaries.test.sql`: the table count goes from 33 to 36 (the three new private tables), and the reviewed SECURITY DEFINER set gains `public.discovery_review_decide_rights` and `public.discovery_review_submit_rights`.
2. `components/discovery-review.test.tsx` (three counts) and `tests/integration/original-verification.test.tsx` (two counts): `>Verified<` and `>Failed<` are counted only in the page above the new overview (`mediaPart`), with the same expected numbers.
3. `scripts/checkpoint9-validation.mts`: 28 migrations become 29. **Also changed, beyond the approved wording:** the new migration is added to the script's `NOT_ON_HOSTED` list. Its 17-migration pass already leaves out everything that builds on Policy 3, and this migration does as well.

Results after the changes:

| Gate | Result |
| --- | --- |
| Database suites (29 migrations) | 22/22, 1,345 assertions |
| Unit | 1,247/1,247 |
| Integration (isolated) | 68 passed, 1 skipped (existing Auth exclusion) |
| `scripts/checkpoint9-validation.mts` | Pass |
| Typecheck (app and three service configs), ESLint | Pass |
| Offline build; browser-chunk and private-value scans | Pass; 0 matches in 1,308 files |
| Full browser matrix, six projects | 234 passed, 0 failed, 24 skipped (the existing optional large-file startup measurements), 13.2 min |

## 8. Deployment prerequisites (each needs separate authorization)

1. Review the migration and its grants; commit from an explicit manifest.
2. Hosted: back up first, confirm 19 migrations, and dry-run so it proposes only `20261018090000`. Apply, then verify function bodies and grants against local and run the advisors.
3. Choose the mode (it stays `required` until the owner changes it) and pair the listener's inspection setting at its next authorized restart.
4. The emergency containment still applies: no automatic clearance, approval or publication. Each title needs its own rights decision.

## 9. Risks and rollback

- **Unverified media can be published in `optional`/`disabled` mode.** A file that was never checked can reach viewers and may fail to play or be damaged. The reviewer screen always says "Not inspected" or "Verification inconclusive". Mitigation: `required` is the default, and a later known failure blocks any unpublished candidate.
- **A failure found after publication does not unpublish.** Use the existing withdraw action.
- **The mode is global.** It is not per title.
- **Rollback**: set the mode back to `required` (immediate, recorded). Unpublished candidates are then held at the media gate again, including approved ones. To withdraw a published title, use the existing withdraw action, or set `movie_versions.rights_status` as the owner. Grants change only through a new migration. Rights submissions and the setting history are never deleted.

## 10. Follow-up (2026-10-18): optional reference and automatic media checks

Owner request: "make reference optional too. Implement auto check all movies for
Media integrity and streaming readiness." Local only, like the rest; nothing ran
against Telegram or hosted.

**Optional reference** (in `20261018090000`, which has never been applied anywhere but disposable databases):

- `rights_clearances.reference` and `rights_submissions.reference` are nullable. A given reference still follows the old rule (a short label, never a URL).
- `discovery_review_clear_rights` keeps its signature, grants and rights capability. A null or empty reference is recorded as none and audited as `rights_cleared` / `no_reference`.
- The rights decision itself is unchanged and still required to publish. It is made per title, per revision and per document by an account with the rights permission.
- The screen marks the reference as optional only when the database reports the rights review; the hosted schema still requires a reference.

**Automatic whole-file verification** (`20261018100000_automatic_media_verification.sql`, migration 30, local only):

- **`public.discovery_verification_due(limit, retry_seconds)`** returns the keys of the candidates due a check, oldest first. It is SECURITY DEFINER with `search_path=''`, EXECUTE for `service_role` and `velora_discovery_worker` only, and it writes nothing. A candidate is due when all of these hold:
  - it awaits review with its film and VJ confirmed, the same rule as the keyed claim;
  - it is not a duplicate, is in the registered channel, and is within the 2,097,152,000-byte contract limit;
  - it has no whole-file evidence since the last reviewer request for a new check.

  A failed attempt waits `retry_seconds`. Five failed attempts at one revision wait for a reviewer. A finished verification, passing or not, is never repeated by itself.
- **`lib/discovery/auto-verify.ts`** runs the loop. It verifies one candidate at a time through the unchanged keyed claim, tries each key once per pass, and logs fixed codes only.
- **`services/media-gateway/discovery.mts --verify-due [--once]`** shares one verifier setup with `--verify`.
  - It needs `VELORA_DISCOVERY_LIVE_AUTHORIZED=true` **and** `VELORA_DISCOVERY_AUTO_VERIFY=true`, the dedicated reader session and `VELORA_DISCOVERY_SPOOL_DIR`.
  - It waits `VELORA_DISCOVERY_VERIFY_INTERVAL_SECONDS` between passes (default 900 seconds) and `VELORA_DISCOVERY_VERIFY_RETRY_SECONDS` after a failure (default 21600).
  - It reads whole documents from Telegram through the read-only reader, so it runs as its own process beside the listener.
  - It has no command that records rights, approves or publishes, and a test scans its source for any.
- A failed attempt leaves the candidate `failed` until the listener (in `metadata` or `bounded` mode) picks it up again. With the listener stopped or `disabled`, it stays there.
- Published titles are not re-checked.

| Gate | Result |
| --- | --- |
| Suite 022 (now with the optional reference) | 144/144 |
| New suite 023 (due) | 27/27. Four of five mutations caught; the fifth (duplicates) is equivalent, because a duplicate never awaits review |
| Database suites, 30 migrations | 21/23 suites, 1,380 assertions. 003 and 011 fail on their reviewed inventories (below) |
| Hosted-equivalent chain (19 plus both new migrations) | Applies. Suites 009, 010, 012, 018, 021, 022 and 023 pass |
| Unit | 1,255/1,255, including the loop and the two-switch gate on the real host |
| Integration (isolated) | 69 passed, 1 skipped. The real loop verified a synthetic MP4 whole (integrity and streaming verified), recorded a reader outage as a failed attempt without evidence, repeated nothing on a second run, and recorded no rights, approval or publication |
| Typecheck (app and three service configs), ESLint, offline build, private-value scan, admin browser specs (42/42) | Pass |

Existing checks that need approval to change (not changed):

1. `supabase/tests/database/011_discovery_worker_role.test.sql`: "exactly ten worker RPCs" becomes eleven, and `discovery_verification_due` joins the reviewed list of worker commands.
2. `supabase/tests/database/003_security_boundaries.test.sql`: `public.discovery_verification_due` joins the reviewed SECURITY DEFINER set.
3. `scripts/checkpoint9-validation.mts`: 29 migrations become 30, and the new migration joins its `NOT_ON_HOSTED` list (it builds on Checkpoint 10).
