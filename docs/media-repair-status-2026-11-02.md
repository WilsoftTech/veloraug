# Media repair status

Report prepared on 2 November 2026 (Africa/Nairobi), covering the checks completed on 1 November. Counts refer to recorded media files, not unique films.

## Recorded media audit

The read-only hosted snapshot taken on 1 November at 23:18 EAT covered 110 recorded movie files:

- 80 had recorded whole-file integrity and streaming passes.
- 20 had whole-file findings without both passes.
- 9 had no current inspection evidence.
- 1 had only historical bounded inspection evidence.

These are recorded evidence counts, not a claim that this report freshly decoded every file. The separate automatic media-verification worker remained active.

## Local repair attempts

Gaslight was the only nonpassing entry for which a complete local copy could be matched to its recorded size and content hash in the inspected staging folders.

Two lossless repair candidates were tested: a fast-start MP4 remux and a second remux correcting two reversed presentation timestamps near the end. Both preserved every audio and video packet, with matching ordered payload hashes and unchanged codec parameters. The timestamp candidate passed a 30-second end-segment decode without errors.

Both candidates nevertheless failed the strict whole-file decode. Neither passed integrity verification, and streaming verification was withheld. No repair candidate was cleared for publication. A passing short sample cannot replace a clean complete decode.

Twenty other entries with failed or historical nonpassing findings lacked a complete, digest-bound local source in the inspected folders. Partial downloads were excluded from repair. Complete source copies are needed for further diagnosis; damaged content may require clean replacement sources.

## Publication boundary

Media verification, film/VJ identity, distribution rights and publication approval remain separate requirements. The repair attempts did not alter hosted evidence, originals, rights decisions or publication status, and did not upload any media. Publisher containment remains in place.

Private paths, operational identifiers, content hashes, credentials, raw diagnostics and media files are intentionally excluded from this report.
