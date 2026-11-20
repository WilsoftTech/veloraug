# Multipart movie publication

Filename convention clarified by the owner on 10 November 2026: `WRONG TURN 01. VJ ICE` and `WRONG TURN 1. VJ ICE` mean Wrong Turn, Part 1, with the VJ ICE credit. `Movie name.S01E01` means season 1, episode 1 of that title. A bare part number does not imply a season or episode. Keep the number in the parsed title for review; the existing multipart recognizer maps `01` and `1` to the same part after the base film identity is confirmed. Filename text alone does not confirm film or VJ identity.

Initially prepared locally on 4 November 2026 (Africa/Nairobi). The approved rollout described below is now complete for the local app and hosted database.

The read-only Tehran audit found both files confirmed as TMDB 942058 / VJ Ice P. Tehran 2 had verified integrity and streaming; its only blocker was `existing_version_replacement_requires_separate_workflow`. The catalogue keyed a version by movie and VJ alone. Poster paths were never a uniqueness key.

The new migration keys movie versions by movie, VJ and file part (0 denotes a whole film). It recognizes a trailing number, Part N, PartN or PTN only when the filename base agrees with confirmed film metadata. An exact metadata title remains intact, including sequels. Each part retains a separate Telegram binding, evidence, rights and revision-bound approval. Different files of the same part still require replacement review. All films may share artwork.

Existing published part versions are backfilled without changing their IDs, source files or movie URLs. Empty version titles receive a part label; curated titles are preserved. The live review gates, approval guard, shared materializer and admin upload preflight all use the part key. The player displays each part and VJ, sorts numbered labels naturally and constrains long labels on small screens.

Validation completed:

- All 25 disposable database suites passed: 1,483 assertions, including 39 multipart checks.
- A pre-migration published Part 1 fixture retained its version ID, media binding, URL and curated title after migration.
- 121 focused UI/discovery tests passed, including Approve then Publish button rendering for a multipart candidate.
- TypeScript, relevant ESLint, diff checks and the offline production build passed. The build retained an existing unrelated uploader filesystem-tracing warning.

Rollout requires separate owner authorization under AGENTS.md section 40. Back up the hosted database and deploy the compatible web changes before applying `20261104201951_multipart_movie_versions.sql`: the updated reviewer model accepts the new `new_part` relationship. Then inspect the Tehran 2 review again; its existing identity, media and rights decisions are retained, and explicit approval/publication remain separate user actions. Keep the standing-approval pause marker and quarantined guards in place.
## Approved rollout completed

The owner approved the rollout and clarified that the web target is the local app only. The migration committed on 4 November 2026 at 23:50 EAT. No remote web deployment was needed.

Hosted preflight found 20 applied migrations, without the optional-media or admin-upload features present in the full local test chain. The multipart migration now selects fixed definitions compatible with the installed policy and updates admin-upload review only when that feature already exists. It does not install those pending features or make media verification optional.

A fresh encrypted, snapshot-consistent backup was created outside the repository. All 63 inventoried tables restored exactly into a private disposable database, with scheduled work suppressed and no external network access. The migration rehearsal preserved every existing version ID and file binding and all unrelated data. The final migration matched the rehearsed function fingerprints, preserved all movie, review, rights, media, event and metadata-candidate records, and recognized five existing part versions. Only this migration and its history entry were applied.

A fresh hosted audit confirms Tehran 2 still has verified integrity and streaming, no publication blockers, and no publication approval. A local rendering check using its actual hosted review record displays Approve. Publish becomes available after a separate approval at the current revision. Tehran 1 remains published with its original file and URL. Unauthenticated local HTTP requests correctly show sign-in.

The revised migration passed all 25 disposable SQL suites (1,483 assertions). The local unit suite passed 1,241 tests with 42 skipped, the real-record rendering test passed independently, and TypeScript passed. Publisher containment remains active. No rights decision, title approval, publication, Telegram transfer, listener restart or unrelated migration was performed.
## Lettered-part extension prepared

The requested A/B extension is prepared in `20261104205725_lettered_movie_parts.sql`. It recognizes standalone A–Z, Part A/PartA and PT A/PTA, as well as numeric parts, zero-padded numbers and bracketed years. A/1 and B/2 share canonical slots, so renaming a different file cannot bypass replacement review. Exact metadata titles and unrelated films stay separate. The local metadata lookup also offers the base film for lettered filenames; identity still needs confirmation.

Validation: 60 discovery tests, TypeScript and relevant ESLint passed. All 25 disposable SQL suites passed (1,497 assertions), including independently publishing A and B and refusing a numeric 2 replacement for B. A rolled-back legacy migration test preserved curated titles and source bindings and skipped an A/1 collision without merging either file. A fresh encrypted hosted backup restored all 63 inventoried tables exactly; its migration rehearsal recognized two more existing part versions with no alias conflicts. The rehearsal removed Thug Life Part 2's replacement blocker; its rights clearance requirement remains.

The extension has NOT been applied to hosted. Automatic approval review rejected the apply command because AGENTS.md section 40 names only the prior migration in its exception and requires explicit authorization for this second hosted migration. The operator script remains guarded by backup/hash, rehearsal, history, function-fingerprint, privilege and source-binding checks. No rights, title approval, publication, Telegram transfer or listener change occurred.
## Lettered-part rollout completed

On 5 November 2026, the owner explicitly approved the exact migration name after the automatic-review rejection. `20261104205725_lettered_movie_parts.sql` committed at 00:15 EAT after the fresh encrypted backup, exact hosted restore rehearsal and 1,497 passing SQL assertions.

The committed function definitions match the rehearsal. The migration recognized two additional existing versions, preserved every source binding and curated title, and left all movie, review, rights, media, event and metadata-candidate records unchanged. Fresh post-commit checks confirm A=1 and B=2, with numeric 1/2 mapping identically. All future confirmations and publication checks use the same shared recognizer. The local metadata lookup also supports lettered filenames.

Thug Life Part 2 now reports the new-part relationship and no replacement blocker. Rights clearance remains required. The extension did not approve or publish any movie, change media-verification requirements, upload or transfer Telegram media, restart a listener, deploy a remote web app, apply an unrelated migration or reactivate contained batches. The standing-approval pause remains present.
