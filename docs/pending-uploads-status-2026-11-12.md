# Pending uploads - 12 November 2026

Latest hosted read-only snapshot: 2026-11-11T21:14:46.020Z.

Of the initial 40 open files, 10 were individually rights-cleared, approved and published following the owner's explicit named authorization. Two additional files were rejected as byte-identical copies of already-published versions. No media was deleted or reuploaded. 28 remain open: 10 with passing media needing film identity, and 18 with media failures or incomplete checks.

## Published and publicly verified

- [28 Years Later: The Bone Temple](http://localhost:3000/movies/28-years-later-the-bone-temple-2026) - published, media 148, revision 4.
- [A Nightmare on Elm Street Part 2: Freddy's Revenge](http://localhost:3000/movies/a-nightmare-on-elm-street-part-2-freddy-s-revenge-1985) - published, media 160, revision 4.
- [Knightfall](http://localhost:3000/movies/knightfall-2025) - published, media 149, revision 4.
- [Redbad](http://localhost:3000/movies/redbad-2018) - published, media 157, revision 4.
- [Runner](http://localhost:3000/movies/runner-2026) - published, media 150, revision 4.
- [The Forever Purge](http://localhost:3000/movies/the-forever-purge-2021) - published, media 153, revision 4.
- [The Gentleman](http://localhost:3000/movies/the-gentleman-2025) - published, media 152, revision 4.
- [The Purge](http://localhost:3000/movies/the-purge-2013) - published, media 154, revision 4.
- [The Purge: Anarchy](http://localhost:3000/movies/the-purge-anarchy-2014) - published, media 155, revision 4.
- [The Purge: Election Year](http://localhost:3000/movies/the-purge-election-year-2016) - published, media 156, revision 4.

The Purge retains its source filename's existing Part 1 classification; no part/identity rules were changed.

## Duplicate copies closed

- Saving General Yang: pending media 151 is byte-identical by full SHA-256 to the existing published version 14. The existing version and all media files were preserved.
- Ultimate Hero: pending media 158 is byte-identical by full SHA-256 to the existing published version 58. The existing version and all media files were preserved.

## Verified media awaiting identity confirmation

The owner's additional statement "ALL RIGHTS ARE APPROVED" has been recorded for these exact ten source-bound files. It does not confirm their film identities. Metadata remains unconfirmed; no film or VJ identity is guessed. Fuze's earlier TMDB candidate was Fuze (2025), TMDB 1242265, while its filename says 2026. Further TMDB API searches encountered connection timeouts, so no new identity suggestions were recorded as decisions.

| Media | File | Status |
| --- | --- | --- |
| 129 | Anti Drugs Association .Vj Ice P.mp4 | Identity/year confirmation needed; rights statement saved |
| 133 | Devil 2.Vj Ice P.mp4 | Identity/year confirmation needed; rights statement saved |
| 127 | Fong Sai-Yuk, Return of Heroes.VJ Ice P.mp4 | Identity/year confirmation needed; rights statement saved |
| 2 | Fuze 2026.VJ Ice P.mkv | Identity/year confirmation needed; rights statement saved |
| 118 | Go For Broke.Vj Ice P.mp4 | Identity/year confirmation needed; rights statement saved |
| 102 | THE SUPRIME CHIEF ADVENTURE TO THE UNKNOWN.VJ ICE P.2026.mkv | Identity/year confirmation needed; rights statement saved |
| 113 | Vedaa part 1.VJ ICE P.mp4 | Identity/year confirmation needed; rights statement saved |
| 112 | Vedaa part 2.VJ ICE P.mp4 | Identity/year confirmation needed; rights statement saved |
| 159 | Venganza.2026. AKA, REVEGE.VJ ICE P.mp4 | Identity/year confirmation needed; rights statement saved |
| 109 | Yuva Part 2.Vj Ice P.mp4 | Identity/year confirmation needed; rights statement saved |

## Media issues

| Media | File | Recorded failure |
| --- | --- | --- |
| 5 | ALL THE DEVIL S MEN _VJ ICE P.mkv | decode_error_at_end |
| 95 | Baby John 2.Vj Ice P.mp4 | decode_error_at_end |
| 134 | Devil.1.Vj Ice P.mp4 | decode_error_at_end |
| 137 | Fighter(Chinese) 2024.Vj Junior.mkv | decode_error_at_end |
| 123 | Gandhi 3 Part 1.Vj Ice P.mp4 | media_read_document_resolution_failed |
| 124 | Gandhi 3 Part 2.Vj Ice P.mp4 | media_read_document_resolution_failed |
| 121 | Garudan 1.Vj Ice P.mp4 | decode_corrupt_data |
| 9 | GASLIGHT 1.VJ ICE.P.mp4 | decode_error_at_end |
| 35 | Jana Nayagan 2.Vj Ice P.mp4 | decode_error_at_end |
| 62 | KILL CODE.VJ ICE P.mp4 | decode_error_at_end |
| 40 | Motor City. Vj Ice P.mp4 | decode_error_at_end |
| 61 | NEGLECT.VJ ICEP.mp4 | decode_error_at_end |
| 43 | Precious Cargo.VJ Ice P.mp4 | decode_error_at_end |
| 33 | Special ID.VJ Ice P.mp4 | decode_corrupt_data |
| 88 | SPECIAL PROTECTION 02.VJ ICE P.2026.mp4 | seek_decode_failed |
| 46 | The Land of Warriors.VJ Ice P.mp4 | mp4_layout_incomplete |
| 19 | WILD CAT.VJ ICEP.mp4 | decode_corrupt_data |
| 108 | Yuva Part 1.Vj Ice P.mp4 | decode_corrupt_data |

Gandhi 3 Parts 1 and 2 (media 123 and 124) were requeued through the existing revision-fenced command; the existing verifier attempted both and again recorded document-resolution failures. These are inaccessible/unverified sources, not successful full-file reads. No leases or failed evidence were cleared.

The nine newly hashed available local copies across six failed media records are all byte-identical to their failed hosted originals. Prior digest-bound local failures for Yuva Part 1 and Special ID also remain valid. No clean replacement was found in those checked copies; a different source must pass full hashing, strict decoding and seek checks before any replacement workflow. Source media was never modified, trimmed or remuxed.

## Safeguards and evidence

The standing-approval pause and quarantined guards remain intact. No contained publisher, batch or discovery listener was restarted. Existing queued inspections reused current source-bound evidence without writing any fresh verification claim; confirmed identities were preserved. Rights and publication affected only the ten expressly authorized titles. The other ten files have a saved rights statement pending identity review. No hosted migration or remote web deployment was part of this processing pass.

Private audit, exact authorizations, inspection receipts, publication readbacks, public API verification, duplicate SHA-256 comparisons, retrieval retry results and local hash comparisons are under `.velora-ingest/pending-uploads-20261111/`. The historical published uploader record for On The Hunt without a linked version remains a separate recorded anomaly; no binding was changed.