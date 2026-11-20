# Media checks — 5 November 2026

This is a progress report, not a blanket verification. The supervised media-only worker remains running. Publisher containment is still active.

The initial request covered 122 recorded movie files: 94 had both whole-file integrity and streaming passes, and 28 remained. New uploads arrived during the run. At the latest saved read-only audit (2026-11-04T22:05:41.670Z), 94 of 124 had both passes; 30 remained.

All 21 previously failed files received fresh reinspection requests through the existing revision-fenced command. The plan refused approved/published candidates and active leases and checked that film/VJ identity, source bindings and rights records were preserved. Unchecked uploads are covered by the existing independent media-only queue, including unconfirmed titles. All currently remaining files meet the queue size and format limits. No duplicate reader was started and no live lease was cleared.

The worker and owner database identities passed read-only connection checks, and sufficient local storage is available. A generic worker store error was observed; the worker continued processing, with lease expiry preserving the failed attempt's fence. No evidence write was forced or approval barrier bypassed.

Six complete, digest-bound local originals are also undergoing strict full-file decoding and seek checks. Completed local results so far:

| File | Integrity | Streaming |
| --- | --- | --- |
| Yuva Part 1 | failed | not_attempted |
| Yuva Part 2 | verified | verified |
| THE PUNISHER ONE LAST KILL | verified | verified |
| RESIDENT EVIL RACOON | verified | verified |

These local results do not rewrite hosted evidence. A fresh whole-file check confirms corruption in Yuva Part 1: the HEVC decoder cannot reconstruct frame references near the end and exits with invalid-data errors. The known library folders contain the same source copy; a clean replacement is needed to pass. Gaslight's digest-bound original also failed a tail timestamp diagnostic; that sample is not a whole-file pass or a replacement for its existing failure finding.

No rights decision, film/VJ confirmation, publication approval, publication, media transfer, listener restart or schema change was performed. Clean full decoding remains required; no damaged tail was trimmed and no decoder error was ignored.
