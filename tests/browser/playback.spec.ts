import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { expect, test as base } from "@playwright/test";
import { FIXTURES, FIXTURE_GENERATOR, HARNESS_MAX_RESPONSE_BYTES, startHarness, type Fixture, type Harness } from "./harness";
import { AUDIBLE_RMS, probeResult, startProbe, type ProbeConfig } from "./probe";

/**
 * Baseline browser playback matrix (MP4/MKV native playback, Checkpoint 1).
 *
 * Every fixture is played in every browser project through the real gateway
 * core, and what the browser actually did is written to
 * tests/browser/.results/<project>/<fixture>.json (`node tests/browser/matrix.mjs`
 * prints the tables). The suite records; it does not judge the combinations
 * the product has no evidence for yet. It fails only when the harness itself
 * misbehaves, or when a combination the product already relies on stops
 * working (PROVEN below).
 *
 * WebKit here is Playwright's WebKit build on this operating system. It is an
 * approximation: it is not Safari on macOS or iOS, and its results never count
 * as Safari validation.
 */

const RESULTS_DIR = join(__dirname, ".results");
const SEEK_TO_SECONDS = 7;

/**
 * Already proven with real movies (E3.3: fast-start MP4, H.264 with MP3, in
 * Chrome and Firefox) and its AAC twin. These must keep working.
 */
const PROVEN = { projects: ["chrome", "msedge", "firefox"], fixtures: ["mp4-h264-aac-faststart.mp4", "mp4-h264-mp3-faststart.mp4"] };

const test = base.extend<object, { harness: Harness }>({
  harness: [
    // Playwright requires the first argument to be destructured, even when it is empty.
    async ({}, provide) => {
      const harness = await startHarness();
      await provide(harness);
      await harness.close();
    },
    { scope: "worker" },
  ],
});

const codecsOf = (fixture: Fixture) => /codecs="([^,"]+), ([^"]+)"/.exec(fixture.typeWithCodecs)!;

for (const fixture of FIXTURES) {
  test(fixture.file, async ({ page, browser, browserName, headless, harness }, testInfo) => {
    // A headed run is recorded beside the headless one: hardware video decoding can differ between them.
    const project = headless ? testInfo.project.name : `${testInfo.project.name}-headed`;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));
    harness.reset();

    const [, videoCodec, audioCodec] = codecsOf(fixture);
    const config: ProbeConfig = { url: harness.streamUrl(fixture, `${project}-${fixture.id}`), mime: fixture.mime, typeWithCodecs: fixture.typeWithCodecs, videoCodec, audioCodec, seekTo: SEEK_TO_SECONDS };
    await startProbe(page, harness.origin, config);
    const result = await probeResult(page);
    const userAgent = await page.evaluate(() => navigator.userAgent);

    const requests = harness.requests.filter((request) => request.versionId === fixture.id);
    const starts = requests.map((request) => Number(/^bytes=(\d+)-/.exec(request.range ?? "")?.[1] ?? Number.NaN));
    const record = {
      project, browserName, browserVersion: browser.version(), headless, userAgent,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      fixtureGenerator: FIXTURE_GENERATOR,
      fixture: { file: fixture.file, container: fixture.container, video: fixture.video, audio: fixture.audio, subtitles: fixture.subtitles, fastStart: fixture.fastStart, sizeBytes: fixture.sizeBytes, servedAs: fixture.mime },
      result,
      requests: {
        count: requests.length,
        statuses: [...new Set(requests.map((request) => request.status))].sort((a, b) => a - b),
        withoutRange: requests.filter((request) => request.range === null).length,
        largestResponseBytes: Math.max(0, ...requests.map((request) => request.contentLength)),
        startingPastZero: starts.filter((start) => start > 0).length,
        bytesSent: requests.reduce((sum, request) => sum + request.bytesSent, 0),
        firstRanges: requests.slice(0, 6).map((request) => request.range),
      },
      pageErrors,
    };
    await mkdir(join(RESULTS_DIR, project), { recursive: true });
    await writeFile(join(RESULTS_DIR, project, `${fixture.file}.json`), `${JSON.stringify(record, null, 2)}\n`);

    // The harness worked: the browser reached the gateway, and the gateway kept its contract.
    expect(result.harnessError, "probe page failed").toBeUndefined();
    expect(pageErrors, "probe page threw").toEqual([]);
    expect(requests.length, "the browser never asked the gateway for the file").toBeGreaterThan(0);
    for (const request of requests) {
      // 0: closed by the browser before a status. 416: a range at or past the end.
      expect([0, 206, 416], `unexpected status for ${request.range}`).toContain(request.status);
      expect(request.contentLength).toBeLessThanOrEqual(HARNESS_MAX_RESPONSE_BYTES);
      if (request.status === 206) expect(request.contentType).toBe(fixture.mime);
    }

    if (PROVEN.projects.includes(testInfo.project.name) && PROVEN.fixtures.includes(fixture.file)) {
      expect(result, "a combination proven with real movies no longer plays").toMatchObject({ metadata: true, playing: true, firstFrame: true, seeked: true, frameAfterSeek: true, resumed: true, errorCode: null });
      expect(result.audioRms, "audio decoded before the seek").toBeGreaterThan(AUDIBLE_RMS);
      expect(result.audioRmsAfterSeek, "audio decoded after the seek").toBeGreaterThan(AUDIBLE_RMS);
      expect(record.requests.startingPastZero, "seeking used range requests").toBeGreaterThan(0);
    }
  });
}
