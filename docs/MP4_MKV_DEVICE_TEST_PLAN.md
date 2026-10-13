# MP4/MKV real-device test plan

Prepared at Checkpoint 7, 2026-10-12; sections 1 and 8 updated at Checkpoint 8,
2026-10-13. **No test in sections 4 to 8 has been run.**
This plan says what to test on physical devices, how, and what counts as a pass.
It keeps the tests already executed apart from the ones that need a device.

## 1. What has been executed, and what it does not show

All of it ran on one Windows 11 machine, against synthetic 12-second fixtures
served on loopback through the real gateway core. Evidence:
`MP4_MKV_NATIVE_PLAYBACK.md`, `MP4_MKV_CHECKPOINT_6.md`, `MP4_MKV_CHECKPOINT_7.md`.

| Browser | Build | Executed |
| --- | --- | --- |
| Chrome 154 | Installed build | 13 fixtures: metadata, first frame, measured audio, seek, resume (headless and headed). Player UI, download, renewal and loading deadline (headless) |
| Edge 155 | Installed build | The same |
| Chrome 154, hardware decoding off | Installed build | The same, headless only |
| Chromium 156 | Playwright build | The same, headless only |
| Firefox 157 | Playwright build | The same as Chrome |
| WebKit 27.2 | Playwright build on Windows | Headless only, as an approximation only |

Real movies, earlier checkpoints: On The Hunt and Call of Heroes (fast-start MP4,
H.264 and MP3) play in desktop Chrome and Firefox with picture, sound and seeks
(E3.3, E3.7D).

What none of this shows:

- **Safari on macOS and Safari on iPhone: not tested.** Playwright WebKit is not
  Safari. It decoded no audio and loaded no MKV on Windows, which says nothing
  about Safari.
- **Chrome and Firefox on Android: not tested.**
- **Edge on Windows** is covered by automation for playback. Its download
  manager was exercised with small files that complete at once and, at
  Checkpoint 8, with one 6 MiB synthetic file whose transfer the test harness
  cut on loopback. Its pause and resume buttons were never pressed.
- **Interrupted downloads (Checkpoint 8, automated, loopback).** Chrome, Edge
  and Chromium resumed by themselves on the same link and saved a byte-identical
  file. Playwright's WebKit and Firefox builds sent no resume request. Those are
  results for these builds under automation, with a harness-made cut. They are
  not results for a lost mobile connection, for Safari or for real Firefox.
- No feature-length MKV, no HEVC or AC-3 real movie, no mobile network, no
  transfer that really outlives a ten-minute capability (the automated test
  moves the gateway's clock instead of waiting), no resume started by a person
  in a download manager, no battery-saver or data-saver mode.
- The refused-automatic-start case (Checkpoint 7) is a deterministic model of
  what iOS Safari is documented to do. It is not a Safari result.

## 2. What the devices need to reach

A phone cannot use the loopback test host, and the production issuer refuses a
plain-HTTP gateway origin that is not loopback. So one of these is needed first.
Both need approval; neither exists today.

- **Route A, no deployment (recommended first).** A small change to the browser
  test host so it can listen on the LAN address. Devices on the same Wi-Fi then
  open the real `MoviePlayer` against the real issuer and gateway core, with the
  synthetic fixtures. It covers every codec and container case, the player
  states, and downloads of small files. It cannot cover feature-length files,
  Telegram throughput or real sign-in.
- **Route B, staging.** A hosted gateway on HTTPS with its allowed origins set,
  and a web deployment that points at it. It covers real movies, real sign-in,
  long transfers, the ten-minute link lifetime and the four-hour maximum. It depends on the gateway hosting
  decision and on migration 9 (`MP4_MKV_ACTIVATION_READINESS.md`).

Larger MKV, HEVC and AC-3 files for Route B must be files Velora has the right to
use. The repository's generator (`npm run test:browser:fixtures`) can make
synthetic 55 MB files; nothing else in the product encodes media.

## 3. Devices, and what to record for each

| ID | Device and browser | Minimum |
| --- | --- | --- |
| S-MAC | Safari on macOS | Current macOS release, one Apple-silicon Mac |
| S-IOS | Safari on iPhone | Current iOS and, if available, the previous major version |
| C-AND | Chrome on Android | One mid-range phone, current Chrome |
| F-AND | Firefox on Android | Same phone, current Firefox |
| E-WIN | Edge on Windows | Current Edge, manual pass for downloads |

For every run record: device model, OS version, browser version, network (Wi-Fi
or mobile, measured down and up speed), power and data-saver modes, date, tester.
Record each case as **pass**, **fail**, or **not applicable**, with what was
seen and heard. A case nobody ran stays **not run**. Never copy a result from
another device.

## 4. Playback cases (every device)

Use headphones or a speaker: "audio" means a person heard it.

| ID | File | Expect, and what to note |
| --- | --- | --- |
| P1 | MP4 fast-start, H.264 + AAC | Picture and sound. The reference case |
| P2 | MP4 fast-start, H.264 + MP3 | Picture and sound. This is what both published movies are. Safari and MP3-in-MP4 has never been checked |
| P3 | MP4 with the index at the end, H.264 + AAC | Plays after a longer start. Note the delay. The startup warning is shown |
| P4 | MKV, H.264 + AAC | Chromium family: expected to play. Safari and Firefox: unknown. Note whether anything loads |
| P5 | MKV, H.264 + MP3 | As P4. In desktop Firefox it was silent; listen for sound |
| P6 | HEVC + AAC, in MP4 and in MKV | Depends on the device decoder. Note picture and sound separately |
| P7 | H.264 + AC-3, in MP4 and in MKV | Silent on every desktop browser tested. Note whether there is sound |
| P8 | Two audio tracks, MP4 and MKV | Which track plays (first is a low tone, second a high tone). Whether the browser offers a track menu |
| P9 | Embedded subtitles, MP4 and MKV | Whether the browser offers or shows them |

For each case that loads, do all of these and record each one:

1. Press Play. Does playback start by itself, or does the player wait?
2. Picture visible and moving. Sound audible.
3. Seek forward past what has loaded, then backward. Playback resumes.
4. Pause 30 seconds, then resume.
5. Fullscreen and back. On phones, rotate.
6. On phones: lock the screen for 30 seconds, unlock, resume. Switch apps and
   return.
7. Read the compatibility text and warnings under the player. Do they match what
   happened? Note every mismatch: the text is a prediction, the device is the
   truth.
8. When something does not play: the exact message shown, and whether Download
   is offered.

## 5. Automatic start and the loading deadline (every device, most of all S-IOS)

Checkpoint 7 fixed a defect that could not be reproduced in a desktop browser.
These cases are how it gets confirmed on the platform it was aimed at.

| ID | Steps | Pass |
| --- | --- | --- |
| A1 | Press Play on P1 and do nothing else for 60 seconds | Either it plays, or the player stays open and paused with its native controls and **no** "Loading…" text. It is never closed and no connection error appears |
| A2 | After A1 leaves the player paused, press the native play control | Playback starts |
| A3 | iPhone only: repeat A1 and A2 in Low Power Mode, then with Low Data Mode on | Same as A1 and A2 |
| A4 | Android only: repeat A1 and A2 with Data Saver on | Same |
| A5 | Slow network (throttle to about 1 Mbit/s or use a weak mobile signal), press Play on P3 | Plays, or after about 30 seconds shows the "taking too long" message with Download offered. Never an endless spinner |
| A6 | Turn the network off before pressing the native play control in A2 | "Buffering…", then within about 30 seconds the connection message. Not an endless spinner |

## 6. Buffering, renewal and recovery (every device, Route B for real lengths)

| ID | Steps | Pass |
| --- | --- | --- |
| B1 | Play a feature-length file on a mobile network for 15 minutes | Continuous playback. At about 8.5 minutes the capability renews with no visible break and the position is kept |
| B2 | Pause for 11 minutes, then resume | Resumes. One new capability is requested |
| B3 | While playing, switch the network off for 20 seconds and back on | Playback recovers once by itself, or shows the connection message. No loop of retries |
| B4 | While playing, switch from Wi-Fi to mobile data | As B3 |
| B5 | Seek to 15:00, 30:00 and near the end | Each seek resumes within a few seconds on Wi-Fi |
| B6 | Sign out in another tab, then keep watching past the next renewal | Playback stops with the sign-in message at the renewal, within 10 minutes |
| B7 | Stop the test gateway and press Play | "Temporarily unavailable". Never "can't be played in this browser" |
| B8 | Firefox on Android with a large MKV | Note how much is fetched before the first frame, and whether it starts at all |

## 7. Download cases (every device)

Check the saved file, not the button. On a computer compare size and SHA-256
(`shasum -a 256` on macOS, `certutil -hashfile <file> SHA256` on Windows) with
the fixture manifest. On a phone compare the size and open the file in a media
player that supports the format (VLC).

| ID | Steps | Pass |
| --- | --- | --- |
| D1 | Signed in, press Download on P1 | The browser's download starts. The saved name and extension are the original ones. Size and hash match |
| D2 | The same for P4 (MKV) | Saved as `.mkv`, never renamed to `.mp4`. Note where iPhone Safari puts it (Files) and whether it previews, saves or refuses |
| D3 | The same for P6 and P7 | The file is intact and plays with picture and sound in VLC, whatever the browser could do with it |
| D4 | Signed out | No Download button |
| D5 | Press Download while a download of the same account is still running | A clear message, not a second transfer. Note the wording |
| D6 | Version with two VJs: choose the second VJ, then Download | The second VJ's file is saved |
| D7 | Keyboard on desktop: Tab to Download, Enter | Download starts. Focus ring visible |
| D8 | Phone, portrait and landscape | Button at least 44 px high, no horizontal scrolling |

## 8. Interrupted transfers and the ten-minute link (Route B, large files)

These are the cases the checklist marks as a blocker. They need a file large
enough to take several minutes.

**The expected results below describe a Checkpoint 8 build**
(`MP4_MKV_CHECKPOINT_8.md`): a link can start or resume a download for ten
minutes, a transfer that has started continues past that, up to four hours, and
a new link starts a new download. Record which build was tested. A gateway
image built before Checkpoint 8 still cuts every transfer at ten minutes.

| ID | Steps | Record |
| --- | --- | --- |
| I1 | Start a large download on a link slow enough to need more than ten minutes. Record size, time and average speed | Expected: it runs past ten minutes and completes. Size and hash match |
| I2 | Start it, switch the network off after one minute, switch it on after 30 seconds, then use the **browser's own** resume | Does the browser resume from where it stopped, by itself or when asked, or fail? What does it show? Automated Chrome and Edge resumed by themselves after a server-side cut; a lost network is a different interruption |
| I3 | As I2, but wait until more than ten minutes after the first press before resuming | Expected: the browser's resume fails, because the link has expired. Record the browser's message and whether it keeps the partial file |
| I4 | After I3, press **Resume/Retry Download** on the page | Expected from every automated browser: a second download from zero, not a continuation. Record which the device does. If it is from zero, a connection that drops after ten minutes can only finish by starting again |
| I5 | Let a download run past ten minutes without interruption | Expected: it continues and completes. Record the total time |
| I6 | During a download that is already past ten minutes, have an administrator unpublish the version on the test catalogue | The transfer stops within about 35 seconds |
| I7 | Phone: lock the screen during a download for two minutes | Whether the download continues, pauses or fails |
| I8 | Phone: switch from Wi-Fi to mobile data during a download | As I2. The gateway may refuse a resume with "too many" for up to 30 seconds, until it notices the first connection is dead; record whether the browser tries again |
| I9 | After a download has failed, press **Resume/Retry Download** with a mouse or a finger | The page reacts. Under automation the Firefox build stopped delivering pointer clicks to the page after a cut transfer, while the keyboard still worked; the cause is not known. Check real Firefox on desktop and Android |
| I10 | While a download is running, press Download again in a second tab | A clear message, not a second transfer (one download per account). After the first finishes, it works |

## 9. Pass criteria for the launch gate

- P1 and P2 pass on S-MAC and S-IOS with picture, **audible** sound, seek and
  resume. P2 is what is published today, so a P2 failure on Safari blocks launch
  for Apple devices or forces an audio decision that earlier checkpoints
  deferred.
- A1 and A2 pass on every device.
- D1 passes on every device. D2 is recorded for every device, pass or fail.
- Every case in sections 4 to 8 has a recorded result or an explicit **not run**
  with the reason.
- I1, I3, I4 and I5 have recorded results before downloads are enabled for
  viewers.

A failure is a finding, not a reason to change a test. Record it, with the device
details, in the next checkpoint report.

## 10. Not in this plan

Automated device farms, performance benchmarking, DRM, casting, picture-in-picture
and offline playback. Series playback is out of scope until series continuity
(roadmap E4) exists.
