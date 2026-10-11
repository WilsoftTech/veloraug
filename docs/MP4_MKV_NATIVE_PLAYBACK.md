# MP4 and MKV native playback and download

Working record for the change that accepts original MP4 and MKV movie files
without conversion, plays them natively where a browser can, reports
compatibility accurately, and offers a secure download of the original file
where it cannot. It is implemented in approved checkpoints; this file records
each one.

Fixed requirements, from the approved brief: MP4 and MKV are the only new movie
upload formats; the original file, extension, codecs, audio streams and Telegram
document identity are preserved; no transcoding, no MKV-to-MP4 conversion, no
fast-start remuxing, no browser-side repackaging; no automatic replacement of
existing Telegram media; one movie version per VJ; rights clearance and
publication approval stay as they are; no production migration, deployment,
Telegram upload or push without separate authorization.

| Checkpoint | State |
| --- | --- |
| 0. Read-only verification and impact map | Done. Gate A approved conditionally (2026-10-11) |
| 1. Browser test infrastructure and baseline | Closed with four transient headed failures and successful reruns; evidence preserved |
| 2. MP4/MKV ingestion | Implemented locally; see [close-out](MP4_MKV_CHECKPOINTS_2_3.md) |
| 3. Media verification | Implemented locally; bounded evidence remains unverified |
| 4. Schema and RPC preparation | Prepared and tested in disposable databases; persistent application not approved; see [report](MP4_MKV_CHECKPOINT_4.md) |
| 5. Original-file gateway downloads | Implemented and tested locally; resolver migration remains unapplied; see [report](MP4_MKV_CHECKPOINT_5.md) |
| 6. Frontend playback and downloads | Local implementation; see [report](MP4_MKV_CHECKPOINT_6.md) for final validation and limitations |
| 7. Activation safety and release preparation | Local review, one player fix, readiness checklist and device test plan; nothing activated; see [report](MP4_MKV_CHECKPOINT_7.md) |
| 8 to 9 | Not implemented; separate approval required |

## Checkpoint 0: verification against the audit (2026-10-11)

Read-only. Branch `phase-a-foundation` at `f838c93`, clean tree. The audit
document is not in the repository; its findings were checked as summarised in
the brief.

| Audit finding | Result |
| --- | --- |
| ffprobe in the ingestion and uploader inspection code | Confirmed (`lib/ingestion/media.ts`, `lib/uploader/media-tools.ts`). Local build 9.0.2 |
| FFmpeg 5.1.9 in the worker images | Confirmed for the discovery image (`5.1.9-0+deb12u1`). The upload worker installs the same Debian package; not run |
| The parser recognises thirteen extensions | Confirmed. A second copy is a SQL pattern in `public.admin_upload_create` |
| Policy: fast-start MP4, H.264, AAC or MP3 | Confirmed, in three places: `classifyMedia`, the generated `verified` column of `private.media_evidence`, and the admin-upload SQL gates |
| MKV rejected | Partly. Discovery rejects it after 16 bytes (`container_not_mp4`). Local ingestion classifies it `remux` and repackages it, so the original is never uploaded |
| Several audio tracks and subtitles go to manual review | Confirmed |
| Publication depends on the verified-media classification | Partly: three separate gates. The CLI uploader path has no database media gate; its gate is `mediaAllowsUpload` in the uploader |
| Gateway: signed streaming, bounded reads, ranges, backpressure | Confirmed |
| Download operation and route reserved and refused | Confirmed: the token is verified, then `not_implemented` |
| Native `<video>` and token renewal | Confirmed |
| No capability detection, no durable browser automation | Confirmed |

Differences that shape the design:

- The admin upload path names every staged file `.verified.mp4`, and Telegram
  names the document after that path. An MKV would be stored under an MP4 name,
  and no admin upload keeps its original file name today.
- The gateway requires a Range header and caps a response at 8 MiB and 120
  seconds. A whole-file download needs its own bounded profile.
- The gateway's catalogue resolver returns exactly five fields and no file name.
- The public catalogue carries no media details, so a player cannot predict
  compatibility before Play.
- Hosted has 17 migrations and the repository 23: six admin-upload migrations
  are not deployed. New migrations must not depend on them.
- The developer's `next dev` hot-reloads the working tree against hosted data,
  so UI that reads new columns must tolerate their absence until deployment.

Direction approved at Gate A: originals are preserved without conversion,
transcoding or remuxing; published movie versions are untouched; series
ingestion rules do not change; media integrity and streaming readiness stay
separate from browser compatibility; rights clearance and publication approval
are preserved; one movie version per VJ; original file names are preserved for
download; database migrations stay independent of the six pending admin-upload
migrations.

## Checkpoint 1: browser test infrastructure and baseline (2026-10-11)

**Result: PASS with reruns, not flawless.** Durable browser automation exists, and the baseline is
recorded. No media acceptance rule, product code, database object or published
movie changed.

### What was added

- `@playwright/test` 1.64.0, exact pin, development dependency only. Browser
  builds are downloaded to the user profile, outside the repository.
- `playwright.config.ts`: six projects. `chrome` and `msedge` are the installed
  browsers. `chrome-software-decode` is the installed Chrome with hardware video
  decoding switched off. `chromium`, `firefox` and `webkit` are Playwright's
  builds.
- `tests/browser/harness.ts`: serves the fixtures through the real gateway core
  (`createMediaGateway`). The signed stream URL, the required Range header, the
  bounded 206 responses and the stored media type are production code. Only the
  two ports are doubles: the catalogue is the fixture manifest, and the reader
  reads local files in place of Telegram. Loopback only.
- `tests/browser/probe.html` and `probe.ts`: one native `<video>` element is
  loaded, played from a real click, seeked and resumed.
- `tests/browser/playback.spec.ts`: every fixture in every project. It records
  results and fails only if the harness misbehaves or if a combination already
  proven with real movies stops working (fast-start MP4 with H.264 and AAC or
  MP3, in Chrome, Edge and Firefox).
- `tests/browser/startup.spec.ts`: opt-in measurement with larger files.
- `tests/browser/matrix.mjs`: prints the tables below from the recorded results.
- `tests/browser/fixtures/`: thirteen fixtures, their generator and manifest.

```text
npm run test:browser            # all projects, headless
npm run test:browser:fixtures   # regenerate the fixtures (needs FFmpeg)
node tests/browser/matrix.mjs   # print the matrix from the last run
```

### Fixtures

All thirteen are synthetic: FFmpeg's test pattern and a 440 Hz tone, twelve
seconds, 320 by 180. There is no third-party content. They total 3.6 MB and are
committed, so the suite needs no FFmpeg. The generator is the only place in the
repository where FFmpeg encodes anything; nothing in the product calls it.

| File | Container | Video | Audio | Subtitles | Served as | Bytes |
| --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | MP4, fast start | h264 | aac | none | video/mp4 | 247792 |
| mp4-h264-aac-moov-at-end.mp4 | MP4, index at end | h264 | aac | none | video/mp4 | 247792 |
| mp4-h264-mp3-faststart.mp4 | MP4, fast start | h264 | mp3 | none | video/mp4 | 271643 |
| mkv-h264-aac.mkv | MKV | h264 | aac | none | video/x-matroska | 246981 |
| mkv-h264-mp3.mkv | MKV | h264 | mp3 | none | video/x-matroska | 270338 |
| mkv-hevc-aac.mkv | MKV | hevc | aac | none | video/x-matroska | 261103 |
| mp4-hevc-aac-faststart.mp4 | MP4, fast start | hevc | aac | none | video/mp4 | 262115 |
| mp4-h264-aac-two-audio.mp4 | MP4, fast start | h264 | aac + aac | none | video/mp4 | 326573 |
| mkv-h264-aac-two-audio.mkv | MKV | h264 | aac + aac | none | video/x-matroska | 323363 |
| mp4-h264-aac-subtitles.mp4 | MP4, fast start | h264 | aac | mov_text | video/mp4 | 248493 |
| mkv-h264-aac-subtitles.mkv | MKV | h264 | aac | subrip | video/x-matroska | 247278 |
| mp4-h264-ac3-faststart.mp4 | MP4, fast start | h264 | ac3 | none | video/mp4 | 318119 |
| mkv-h264-ac3.mkv | MKV | h264 | ac3 | none | video/x-matroska | 317384 |

In the two-audio fixtures the first, default track is 440 Hz and the second is
880 Hz, so the measured tone shows which track a browser plays.

### What is measured

Nothing is inferred from an event alone.

- **Metadata**: the element reaches `readyState` 1 without an error.
- **First frame**: the picture drawn from the element to a canvas has content.
- **Audio**: the RMS of the samples the element produces, through Web Audio.
  The tone measures about 0.06 and silence measures 0. Where a build has no Web
  Audio, the result says "not measured" and falls back to the decoder's own
  byte count; it is never reported as silence.
- **Seek and resume**: a seek to 7 s completes, and playback then advances while
  the element holds decodable data.
- **Range requests**: every request the browser made, its Range header, the
  status and the bytes actually written.
- `canPlayType()` and Media Capabilities are recorded beside the outcome, as a
  prediction to compare with it.

The harness shortens the response window from 8 MiB to 32 KiB, so each small
fixture needs several range requests and an index at the end forces a real seek
to the tail.

### Browsers and platform

| Project | Browser | Version | Headless | Platform |
| --- | --- | --- | --- | --- |
| chrome | chromium | 154.0.8037.99 | yes | Windows_NT 10.0.26300 x64 |
| chrome-headed | chromium | 154.0.8037.99 | no | Windows_NT 10.0.26300 x64 |
| msedge | chromium | 155.0.4283.45 | yes | Windows_NT 10.0.26300 x64 |
| msedge-headed | chromium | 155.0.4283.45 | no | Windows_NT 10.0.26300 x64 |
| chrome-software-decode | chromium | 154.0.8037.99 | yes | Windows_NT 10.0.26300 x64 |
| chromium | chromium | 156.0.8078.4 | yes | Windows_NT 10.0.26300 x64 |
| firefox | firefox | 157.0 | yes | Windows_NT 10.0.26300 x64 |
| firefox-headed | firefox | 157.0 | no | Windows_NT 10.0.26300 x64 |
| webkit | webkit | 27.2 | yes | Windows_NT 10.0.26300 x64 |

Headless runs are the default. Chrome, Edge and Firefox were also run headed,
because hardware video decoding can differ between the two modes.

### Result by fixture and browser

| Fixture | Content | chrome | chrome-headed | msedge | msedge-headed | chrome-software-decode | chromium | firefox | firefox-headed | webkit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | MP4 · h264 · aac | plays | plays | plays | plays | plays | plays | plays | plays | video; audio none decoded |
| mp4-h264-aac-moov-at-end.mp4 | MP4, index at end · h264 · aac | plays | plays | plays | plays | plays | plays | plays | plays | video; audio none decoded |
| mp4-h264-mp3-faststart.mp4 | MP4 · h264 · mp3 | plays | plays | plays | plays | plays | plays | plays | plays | video; audio none decoded |
| mkv-h264-aac.mkv | MKV · h264 · aac | plays | plays | plays | plays | plays | plays | plays | plays | no metadata |
| mkv-h264-mp3.mkv | MKV · h264 · mp3 | plays | plays | plays | plays | plays | plays | video only, no audio | video only, no audio | no metadata |
| mkv-hevc-aac.mkv | MKV · hevc · aac | plays | plays | plays | plays | audio only, no picture | audio only, no picture | does not play | plays | no metadata |
| mp4-hevc-aac-faststart.mp4 | MP4 · hevc · aac | plays | plays | plays | plays | audio only, no picture | audio only, no picture | does not play | plays | video; audio none decoded |
| mp4-h264-aac-two-audio.mp4 | MP4 · h264 · aac + aac | plays | plays | plays | plays | plays | plays | plays | plays | video; audio none decoded |
| mkv-h264-aac-two-audio.mkv | MKV · h264 · aac + aac | plays | plays | plays | plays | plays | plays | plays | plays | no metadata |
| mp4-h264-aac-subtitles.mp4 | MP4 · h264 · aac · subtitles mov_text | plays | plays | plays | plays | plays | plays | plays | plays | video; audio none decoded |
| mkv-h264-aac-subtitles.mkv | MKV · h264 · aac · subtitles subrip | plays | plays | plays | plays | plays | plays | plays | plays | no metadata |
| mp4-h264-ac3-faststart.mp4 | MP4 · h264 · ac3 | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | no metadata |
| mkv-h264-ac3.mkv | MKV · h264 · ac3 | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | video only, no audio | no metadata |

### Startup cost of larger files

| Project | File | Size MiB | Requests before metadata | MiB sent before metadata | Metadata ms | MiB sent in total | Seek to 60 s | Resume | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chrome | large-mkv-cues-at-end.mkv | 55.5 | 1 | 2.0 | 441 | 15.6 | yes | yes | plays |
| chrome | large-mkv-cues-at-front.mkv | 55.7 | 1 | 2.0 | 449 | 15.4 | yes | yes | plays |
| chrome | large-mp4-faststart.mp4 | 55.5 | 1 | 2.0 | 496 | 15.6 | yes | yes | plays |
| chrome | large-mp4-index-at-end.mp4 | 55.5 | 2 | 2.0 | 864 | 15.7 | yes | yes | plays |
| msedge | large-mkv-cues-at-end.mkv | 55.5 | 1 | 2.0 | 425 | 15.6 | yes | yes | plays |
| msedge | large-mkv-cues-at-front.mkv | 55.7 | 1 | 2.0 | 443 | 15.4 | yes | yes | plays |
| msedge | large-mp4-faststart.mp4 | 55.5 | 1 | 2.0 | 473 | 15.6 | yes | yes | plays |
| msedge | large-mp4-index-at-end.mp4 | 55.5 | 2 | 2.0 | 859 | 15.7 | yes | yes | plays |
| chrome-software-decode | large-mkv-cues-at-end.mkv | 55.5 | 1 | 2.0 | 472 | 15.6 | yes | yes | plays |
| chrome-software-decode | large-mkv-cues-at-front.mkv | 55.7 | 1 | 2.0 | 483 | 16.0 | yes | yes | plays |
| chrome-software-decode | large-mp4-faststart.mp4 | 55.5 | 1 | 2.0 | 431 | 16.0 | yes | yes | plays |
| chrome-software-decode | large-mp4-index-at-end.mp4 | 55.5 | 3 | 4.0 | 1283 | 18.0 | yes | yes | plays |
| chromium | large-mkv-cues-at-end.mkv | 55.5 | 1 | 2.0 | 429 | 15.6 | yes | yes | plays |
| chromium | large-mkv-cues-at-front.mkv | 55.7 | 1 | 2.0 | 432 | 16.0 | yes | yes | plays |
| chromium | large-mp4-faststart.mp4 | 55.5 | 1 | 2.0 | 461 | 16.0 | yes | yes | plays |
| chromium | large-mp4-index-at-end.mp4 | 55.5 | 2 | 2.0 | 865 | 16.0 | yes | yes | plays |
| firefox | large-mkv-cues-at-end.mkv | 55.5 | 7 | 55.5 | 11780 | 55.5 | yes | yes | plays |
| firefox | large-mkv-cues-at-front.mkv | 55.7 | 7 | 55.7 | 11730 | 55.7 | yes | yes | plays |
| firefox | large-mp4-faststart.mp4 | 55.5 | 1 | 4.0 | 1229 | 20.0 | yes | yes | plays |
| firefox | large-mp4-index-at-end.mp4 | 55.5 | 3 | 2.0 | 870 | 17.5 | yes | yes | plays |
| webkit | large-mkv-cues-at-end.mkv | 55.5 | never |  |  | 57.2 | no | no | no metadata |
| webkit | large-mkv-cues-at-front.mkv | 55.7 | never |  |  | 55.7 | no | no | no metadata |
| webkit | large-mp4-faststart.mp4 | 55.5 | 1 | 2.0 | 729 | 15.6 | yes | yes | video; audio none decoded |
| webkit | large-mp4-index-at-end.mp4 | 55.5 | 3 | 2.0 | 1226 | 17.6 | yes | yes | video; audio none decoded |

The startup files are about 55 MB each, generated on demand and never
committed. They are served through production-sized responses of 8 MiB from an
origin slowed to roughly 5 MiB a second, so "sent before metadata" describes the
browser and the file rather than loopback speed.

### Findings

1. **MP4 with H.264 and AAC or MP3 plays everywhere tested**: Chrome 154, Edge
   155, Chromium 156 and Firefox 157, with picture, sound, seek and resume.
2. **An MP4 with its index at the end plays in all of them.** Each browser
   fetched the tail on its second or third request and then restarted near the
   beginning. In Chrome and Edge metadata arrived about 0.4 s later than for the
   fast-start copy on the slowed origin, for the same 2 MiB. This is a startup
   cost, not a failure. Firefox timings were too noisy to compare.
3. **MKV with H.264 and AAC plays in Chrome, Edge and Chromium** when served as
   `video/x-matroska`. Metadata needed the first 2 MiB only. With the Cues at the
   end, a seek cost one small request to the tail.
4. **Firefox does not stream MKV.** It plays the small fixtures, but for the
   55 MB files it reported metadata only after the whole file had been sent:
   55.5 of 55.5 MiB, about 11.7 s, whether the Cues were at the front or the end.
   The same streams in MP4 started after 2 to 4 MiB. For a feature-length movie
   this means fetching the entire file before the first frame. Whether Firefox
   completes at all for a file larger than its media cache is not tested.
5. **MKV with MP3 audio is silent in Firefox**, with a correct picture and no
   error. This matches the E3 finding with a real movie.
6. **HEVC depends on the device's hardware decoder.** Chrome and Edge played it
   in both containers on this machine. With hardware decoding off, and in
   bundled Chromium, the audio played with no picture, no error event, a video
   width of 0 and no decoded frames. Firefox played it headed and raised
   `MediaError` 3 headless.
7. **AC-3 audio is silent in every browser tested**, with a correct picture and
   no error event.
8. **Two audio tracks**: every browser played the first, default track. Neither
   Chrome nor Firefox exposes `audioTracks`, so there is no native way to switch.
9. **Embedded subtitles are ignored.** No text track is exposed and playback is
   unaffected.
10. **`canPlayType()` is not proof in either direction.** Firefox answered
    "probably" for HEVC and then failed headless, and answered "" for MP3 in MP4
    with the codec string `mp4a.6B` and then played it. Chrome answered
    truthfully for HEVC and AC-3 in every case observed.
11. **The gateway contract held throughout.** Every media response was a 206 of
    at most one window with the stored content type, no request arrived without
    a Range header, and every seek produced range requests past byte 0.

What a player can observe when playback is partial, since no error is raised:

| Case | Chromium family | Firefox |
| --- | --- | --- |
| Picture but no sound (AC-3, or MP3 in MKV) | `webkitAudioDecodedByteCount` stays 0 | `mozHasAudio` is false |
| Sound but no picture (HEVC without a decoder) | `videoWidth` is 0 and no frames are decoded | Raises `MediaError` 3 instead |

### Not covered

- **Safari on macOS, Safari on iOS and every Android browser are NOT TESTED.**
  They need real devices.
- **Playwright WebKit is an approximation and is not Safari.** On Windows it
  decoded the MP4 picture, decoded no audio, has no Web Audio, loaded no MKV and
  failed the AC-3 MP4 with `MediaError` 4. None of this is evidence about
  Safari.
- Firefox here is Playwright's build of Firefox 157, not the stock release.
- One machine and one GPU. HEVC results belong to this hardware.
- Synthetic files only: no real movie, no feature-length file, no real network,
  no Telegram read.
- Download, token renewal and network recovery are later checkpoints.

### Notes on the runs

- Final headless run: 78 passed, 24 skipped (the opt-in startup tests). Startup
  run: 24 passed. Unit suite: 966 passed, 28 skipped. `tsc --noEmit` and
  `npm run lint` pass.
- Headed runs open real windows on the desktop. Four headed tests failed across
  the session: one page was closed from outside the test, one probe was started
  twice, and two failures were not captured. The probe now runs once per page
  load. All four passed when repeated, and headed results equal the headless
  ones except for HEVC in Firefox.
- The baseline unit run before any change had one failure, a file-lock race in
  `lib/discovery/discovery.test.ts` that passes alone. It did not recur.

### What this means for later checkpoints

Design input, not decisions:

- A compatibility profile has to be per container, video codec, audio codec and
  browser family, and has to say whether each entry was tested or predicted.
- MKV plays natively in the Chromium family only, on this evidence. Firefox
  needs the download path offered up front for MKV.
- The player has to detect silent audio and a missing picture by observation,
  because the browser raises no error for either.
- A non-fast-start MP4 can pass with a startup warning.
- HEVC and AC-3 cannot be promised to any viewer: HEVC depends on the device,
  and AC-3 was silent everywhere tested.

### Measurements by browser

#### chrome

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 62 | 114 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 52 | 104 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | supported | yes | 60 | 67 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 102 | 155 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | supported | yes | 106 | 160 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | supported | yes | 58 | 119 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | probably | supported | yes | 61 | 123 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 53 | 105 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 160 | 212 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 55 | 117 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 116 | 169 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 52 | 52 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 155 | 156 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### chrome-headed

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 52 | 104 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 59 | 112 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | supported | yes | 52 | 104 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 109 | 161 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | supported | yes | 106 | 163 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | supported | yes | 51 | 54 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | probably | supported | yes | 52 | 104 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 60 | 113 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 161 | 215 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 60 | 122 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 101 | 160 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 55 | 56 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 153 | 154 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### msedge

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 72 | 124 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 53 | 105 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | supported | yes | 51 | 102 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 102 | 153 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | supported | yes | 102 | 157 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | supported | yes | 52 | 138 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | probably | supported | yes | 52 | 53 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 57 | 109 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 154 | 165 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 53 | 57 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 109 | 129 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 64 | 66 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 161 | 216 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### msedge-headed

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 53 | 322 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 58 | 109 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | supported | yes | 50 | 105 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 101 | 157 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | supported | yes | 105 | 159 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | supported | yes | 51 | 136 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | probably | supported | yes | 59 | 61 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 56 | 65 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 156 | 208 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 52 | 104 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 102 | 157 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 55 | 117 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 162 | 164 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### chrome-software-decode

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 53 | 65 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 53 | 104 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | supported | yes | 51 | 109 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 110 | 162 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | supported | yes | 106 | 162 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | "" | unsupported | yes | 51 | 107 | no | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | "" | unsupported | yes | 52 | 104 | no | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 53 | 117 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 153 | 205 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 51 | 106 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 104 | 105 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 52 | 52 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 102 | 165 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### chromium

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 55 | 107 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 51 | 105 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | supported | yes | 56 | 107 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 106 | 165 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | supported | yes | 121 | 172 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | "" | unsupported | yes | 64 | 129 | no | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | "" | unsupported | yes | 52 | 104 | no | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 59 | 120 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 104 | 157 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 54 | 127 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 156 | 207 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 54 | 55 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 163 | 164 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### firefox

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 50 | 102 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 50 | 110 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | "" | unsupported | yes | 52 | 103 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 51 | 103 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | "" | unsupported | yes | 51 | 102 | yes | silent |  | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | supported | yes | 50 |  | no | silent |  | no | no | 8 | 7 | 206 | MediaError 3: Utility MF Media Engine CDM only support for media engine playback |
| mp4-hevc-aac-faststart.mp4 | probably | supported | yes | 51 |  | no | silent |  | no | no | 2 | 1 | 206 | MediaError 3: MediaResult __cdecl mozilla::RemoteVideoDecoderChild::InitIPDL(const VideoInfo &, float, const CreateDecoderParams::OptionSet &, Maybe<layers::TextureFactoryIdentifier>, const Maybe<uint64_t> &, const |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 51 | 193 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 50 | 103 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 61 | 169 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 50 | 103 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 51 | 102 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 57 | 108 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### firefox-headed

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | supported | yes | 50 | 101 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | supported | yes | 50 | 174 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | "" | unsupported | yes | 50 | 104 | yes | yes | 445 | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | supported | yes | 54 | 116 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | "" | unsupported | yes | 50 | 102 | yes | silent |  | yes | yes | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | supported | yes | 51 | 159 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | probably | supported | yes | 51 | 102 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | supported | yes | 61 | 112 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | supported | yes | 49 | 113 | yes | yes | 445 | yes | yes | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | supported | yes | 51 | 102 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | supported | yes | 105 | 248 | yes | yes | 445 | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | "" | unsupported | yes | 51 | 103 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-ac3.mkv | "" | unsupported | yes | 76 | 130 | yes | silent |  | yes | yes | 10 | 9 | 206 |  |

#### webkit

| Fixture | canPlayType | Media Capabilities | Metadata | Metadata ms | Playing ms | First frame | Audio | Tone Hz | Seek | Resume | Range requests | Past byte 0 | Statuses | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mp4-h264-aac-faststart.mp4 | probably | unavailable | yes | 373 | 443 | yes | none decoded |  | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-moov-at-end.mp4 | probably | unavailable | yes | 381 | 530 | yes | none decoded |  | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-mp3-faststart.mp4 | probably | unavailable | yes | 295 | 362 | yes | none decoded |  | yes | yes | 9 | 8 | 206 |  |
| mkv-h264-aac.mkv | probably | unavailable | no |  |  | no | none decoded |  | no | no | 8 | 7 | 206 |  |
| mkv-h264-mp3.mkv | probably | unavailable | no |  |  | no | none decoded |  | no | no | 9 | 8 | 206 |  |
| mkv-hevc-aac.mkv | probably | unavailable | no |  |  | no | none decoded |  | no | no | 8 | 7 | 206 |  |
| mp4-hevc-aac-faststart.mp4 | probably | unavailable | yes | 313 | 331 | yes | none decoded |  | yes | yes | 8 | 7 | 206 |  |
| mp4-h264-aac-two-audio.mp4 | probably | unavailable | yes | 302 | 371 | yes | none decoded |  | yes | yes | 10 | 9 | 206 |  |
| mkv-h264-aac-two-audio.mkv | probably | unavailable | no |  |  | no | none decoded |  | no | no | 10 | 9 | 206 |  |
| mp4-h264-aac-subtitles.mp4 | probably | unavailable | yes | 306 | 322 | yes | none decoded |  | yes | yes | 8 | 7 | 206 |  |
| mkv-h264-aac-subtitles.mkv | probably | unavailable | no |  |  | no | none decoded |  | no | no | 8 | 7 | 206 |  |
| mp4-h264-ac3-faststart.mp4 | probably | unavailable | no |  |  | no | none decoded |  | no | no | 3 | 0 | 206 | MediaError 4 |
| mkv-h264-ac3.mkv | probably | unavailable | no |  |  | no | none decoded |  | no | no | 21 | 18 | 206 | MediaError 4 |

## Discovery listener: SIGTERM does not release the consumer lease

Read-only investigation, 2026-10-11. The running listener was not touched.

**Cause.** `services/media-gateway/discovery.mts` registers its shutdown with
`process.once("SIGTERM", stop)`. In bounded mode the MTProto library also
installs a handler (`@mtcute/node/utils/exit-hook.js`, through its storage
layer). That handler runs the library's cleanup, removes its own listeners and
then sends the process the same signal again. By then the worker's one-shot
listener has already fired and been removed, so no listener is left, the default
action applies and the process is killed. The asynchronous `finally` block that
releases the lease never runs, and the lease lingers until it expires.

In metadata mode no MTProto client is created, so the hook is never installed
and the one-shot listener is enough. The media gateway (`main.mts`) uses
`process.on`, which is why its graceful shutdown works with the same library.

**Reproduction.** A disposable container from `velora-discovery:media-recovery`,
with no network, no credentials and a read-only root, ran a short script that
uses the library's own exit hook and the worker's signal wiring.

| Wiring | Result |
| --- | --- |
| `process.once`, library hook installed | Killed by the signal, exit 143, release never reached |
| `process.on`, library hook installed | Release completed, exit 0 |
| `process.once`, no library hook | Release completed, exit 0 |

**Checkpoint 1 proposal (not applied at that checkpoint).** In `discovery.mts`, register both handlers with
`process.on` in place of `process.once`. The existing `finally` block already
removes them, and `abort()` is safe to call twice. No other change is needed:
`admin-upload.mts` and `admin-upload-r2.mts` use the same one-shot pattern but
never load the MTProto library.

**To verify once approved.** Rebuild the listener image, start it in bounded
mode in an isolated environment, send SIGTERM and confirm the lease row is
released at once. Replacing the running listener is a live operation and needs
its own approval.


## Checkpoint 1 close-out and numbering (2026-10-11)

The complete matrix and measurements above remain preserved. All 141 raw JSON
records (117 small-fixture records in nine headless/headed projects plus 24
startup records) are archived in `docs/evidence/checkpoint1-browser-results.zip`,
with SHA-256 in the adjacent `.sha256` file. Regression runs cannot overwrite
that archive. The archive contains the saved successful baseline records, not
missing failure traces.

Four transient headed-test failures occurred: an externally closed page, a
probe started twice, and two failures whose diagnostic details were not
captured. All four passed on rerun. Their exact missing traces/test identities
cannot be reconstructed; this is a limitation of the original evidence.
Those runs were not flawless. The double-start probe fix remains in place.

**E3.9 is provisional.** Repository numbering was checked against
`IMPLEMENTATION_ROADMAP.md` and the existing E3/E3.8/E3.8B documents. No competing
E3.9 entry was found beyond this work's baseline roadmap entry. The external
numbering/audit reference is not in the repository, so owner confirmation of
the final label remains pending.

The separately approved local Checkpoints 2?3 and listener signal fix are
recorded in [the close-out report](MP4_MKV_CHECKPOINTS_2_3.md). The live listener
was not rebuilt, restarted or replaced.
