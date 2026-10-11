import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test as base } from "@playwright/test";
import { startHarness, type Harness, type ServedFile } from "./harness";
import { metadataLoaded, probeResult, startProbe } from "./probe";

/**
 * Startup cost of larger files (opt-in). How much of a file a browser must
 * fetch before it reports metadata decides whether a container can be streamed
 * at all, and the committed fixtures are too small to show it: a browser reads
 * a 300 KB file whole before it needs to choose.
 *
 * The four files are about 55 MB each and are never committed:
 *
 *   node --env-file-if-exists=.env.local tests/browser/fixtures/generate.mjs --large <dir>
 *   VELORA_BROWSER_LARGE_FIXTURES=<dir> npx playwright test startup
 *
 * They are served through production-sized responses (8 MiB) from a slowed
 * origin, so "bytes sent before metadata" is a property of the browser and the
 * file, not of loopback speed. Recorded to tests/browser/.results; nothing here
 * is asserted beyond the harness working.
 */
const DIR = process.env.VELORA_BROWSER_LARGE_FIXTURES ?? "";
const RESULTS_DIR = join(__dirname, ".results");
const PRODUCTION_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Per read of up to 1 MiB; with the gateway's read-ahead of two, about 5 MiB a second. */
const READ_DELAY_MS = 400;

const FILES = [
  { id: 101, file: "large-mp4-faststart.mp4", mime: "video/mp4" },
  { id: 102, file: "large-mp4-index-at-end.mp4", mime: "video/mp4" },
  { id: 103, file: "large-mkv-cues-at-end.mkv", mime: "video/x-matroska" },
  { id: 104, file: "large-mkv-cues-at-front.mkv", mime: "video/x-matroska" },
];
const available = DIR !== "" && FILES.every(({ file }) => existsSync(join(DIR, file)));
const served: ServedFile[] = available ? FILES.map((entry) => ({ ...entry, sizeBytes: statSync(join(DIR, entry.file)).size })) : [];

const test = base.extend<object, { harness: Harness }>({
  harness: [
    async ({}, provide) => {
      const harness = await startHarness({ fixtures: served, fixtureDir: DIR, maxResponseBytes: PRODUCTION_RESPONSE_BYTES, readDelayMs: READ_DELAY_MS });
      await provide(harness);
      await harness.close();
    },
    { scope: "worker" },
  ],
});

test.skip(!available, "set VELORA_BROWSER_LARGE_FIXTURES to a directory made by generate.mjs --large");

for (const file of FILES) {
  test(`startup: ${file.file}`, async ({ page, browser, headless, harness }, testInfo) => {
    const entry = served.find((candidate) => candidate.id === file.id)!;
    const project = headless ? testInfo.project.name : `${testInfo.project.name}-headed`;
    harness.reset();
    const sent = () => ({ requests: harness.requests.length, bytes: harness.requests.reduce((sum, request) => sum + request.bytesSent, 0) });

    await startProbe(page, harness.origin, {
      url: harness.streamUrl(entry, `${project}-${entry.id}`), mime: entry.mime,
      typeWithCodecs: `${entry.mime}; codecs="avc1.64001F, mp4a.40.2"`, videoCodec: "avc1.64001F", audioCodec: "mp4a.40.2", seekTo: 60,
    });
    const atMetadata = (await metadataLoaded(page, 110_000)) ? sent() : null;
    const result = await probeResult(page, 130_000);

    const record = {
      project, browserVersion: browser.version(), headless, file: entry.file, sizeBytes: entry.sizeBytes,
      responseBytes: PRODUCTION_RESPONSE_BYTES, readDelayMs: READ_DELAY_MS,
      atMetadata, atEnd: sent(), result,
      timeline: harness.requests.slice(0, 16).map((request) => ({ range: request.range, startedMs: request.startedMs, status: request.status, bytesSent: request.bytesSent })),
    };
    await mkdir(join(RESULTS_DIR, project), { recursive: true });
    await writeFile(join(RESULTS_DIR, project, `startup-${entry.file}.json`), `${JSON.stringify(record, null, 2)}\n`);

    expect(result.harnessError, "probe page failed").toBeUndefined();
    expect(harness.requests.length, "the browser never asked the gateway for the file").toBeGreaterThan(0);
  });
}
