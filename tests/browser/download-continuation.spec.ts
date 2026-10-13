import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Download, type Page } from "@playwright/test";
import { startPlayerHarness } from "./player-harness";

/**
 * Download continuation (E3.9 Checkpoint 8), as a browser's own download manager
 * meets it. The real player, issuer and gateway core run on loopback; the file
 * is synthetic and the interruptions are made by the harness.
 *
 * What is asserted for every browser is the gateway's side: a started transfer
 * outlives its capability, every new or resumed request is authorized on
 * arrival, and a refused request reads no media. What a browser does after an
 * interruption differs by engine and is asserted as observed on 2026-10-13:
 *
 * - Chrome, Edge and Chromium resume by themselves, on the same link, with
 *   Range and If-Range.
 * - Playwright's WebKit and Firefox builds send no resume request. For them the
 *   request a download manager would send is issued by the test (`managerResume`),
 *   which shows the gateway's answer and nothing about those browsers. WebKit
 *   reports the failed download; Firefox reports nothing within the time watched.
 *
 * In no browser does a newly issued link continue a partial file: it starts a
 * new download at byte 0. Safari, iOS and Android are not covered here.
 */

const MIB = 1024 * 1024;
const SIZE = 6 * MIB;
const CUT_AT = 2 * MIB;
const FILE = { id: 201, file: "continuation.mp4", sizeBytes: SIZE, mime: "video/mp4" };
/** How long a browser that never resumes is watched before the test says so. */
const NO_RESUME_WINDOW_MS = 3_000;

type Host = Awaited<ReturnType<typeof startPlayerHarness>>;
const test = base.extend<{ host: Host }, { file: { dir: string; sha256: string } }>({
  file: [async ({}, provide) => {
    // Bytes that differ at every offset, so a range served from the wrong place changes the hash.
    const bytes = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) bytes[i] = (i * 31 + (i >>> 8) * 17 + (i >>> 16) * 7) & 255;
    const dir = await mkdtemp(join(tmpdir(), "velora-continuation-"));
    await writeFile(join(dir, FILE.file), bytes);
    try { await provide({ dir, sha256: createHash("sha256").update(bytes).digest("hex") }); } finally { await rm(dir, { recursive: true, force: true }); }
  }, { scope: "worker" }],
  host: async ({ file }, provide) => {
    // 150 ms per read of 1 MiB: slow enough to act on a transfer while it runs.
    const host = await startPlayerHarness({ fixtures: [FILE], fixtureDir: file.dir, readDelayMs: 150 });
    try { await provide(host); } finally { await host.close(); }
  },
});

test.beforeEach(async ({ page, host }) => {
  await page.context().route("**/*", (route) => route.request().url().startsWith(host.origin + "/") || route.request().url().startsWith(host.gateway.origin + "/") ? route.continue() : route.abort());
  await page.goto(`${host.origin}/fixture?versions=${FILE.id}&legacy`);
});

const sha256Of = async (download: Download) => createHash("sha256").update(await readFile((await download.path())!)).digest("hex");
/** Requests the browser's download manager made: everything but the page's one-byte readiness probe. */
const transfers = (host: Host) => host.gateway.downloads.filter((request) => request.range !== "bytes=0-0");
const issued = (host: Host) => host.requests.filter((request) => request.operation === "download").length;

async function startDownload(page: Page) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Download/ }).click();
  return event;
}

/**
 * The viewer's explicit retry after an interruption. In Playwright's Firefox
 * build a pointer click is no longer delivered to the page once a transfer has
 * been cut, while script and the keyboard still work; the cause was not
 * identified, and it says nothing about Firefox itself. The button is therefore
 * activated from the keyboard there.
 */
async function pressRetry(page: Page, browserName: string) {
  const button = page.getByRole("button", { name: /^Resume\/Retry Download/ });
  if (browserName === "firefox") await button.press("Enter");
  else await button.click();
}

async function retryDownload(page: Page, browserName: string) {
  const event = page.waitForEvent("download");
  await pressRetry(page, browserName);
  return event;
}

/** The request a download manager sends to continue a partial file: the same link, the bytes it lacks, the validator it was given. */
function managerResume(page: Page, download: Download, etag: string) {
  return page.request.get(download.url(), { headers: { Range: `bytes=${CUT_AT}-`, "If-Range": etag } });
}

/**
 * Waits until the interrupted transfer has been dealt with by the browser, and
 * reports whether the browser itself asked to resume it.
 */
async function afterInterruption(page: Page, host: Host, download: Download, browserName: string) {
  await expect.poll(() => transfers(host)[0]?.bytesSent).toBe(CUT_AT);
  if (browserName === "chromium") {
    await expect.poll(() => transfers(host).length).toBeGreaterThanOrEqual(2);
    return true;
  }
  // WebKit reports the failure. Firefox under Playwright reports nothing, so it is watched for a bounded time.
  if (browserName === "webkit") expect(await download.failure()).not.toBeNull();
  else await page.waitForTimeout(NO_RESUME_WINDOW_MS);
  expect(transfers(host)).toHaveLength(1);
  return false;
}

test("an uninterrupted transfer runs past its capability's expiry and completes; the expired link then starts nothing", async ({ page, host, file }) => {
  await expect(page.getByText(/A download that has started keeps running/)).toBeVisible();
  const download = await startDownload(page);
  // The response has begun and is still being sent when the capability's ten minutes run out.
  await expect.poll(() => transfers(host)[0]?.status).toBe(200);
  expect(transfers(host)[0].bytesSent).toBeLessThan(SIZE);
  host.state.clockOffsetMs = 3_600_000;
  expect(await download.failure()).toBeNull();
  expect(await sha256Of(download)).toBe(file.sha256);
  expect(transfers(host)).toMatchObject([{ range: null, status: 200, bytesSent: SIZE }]);
  // The same link can no longer start or resume anything, and the refusal reads no media.
  const etag = transfers(host)[0].etag!;
  expect((await page.request.get(download.url())).status()).toBe(401);
  expect((await managerResume(page, download, etag)).status()).toBe(401);
  expect(transfers(host).slice(1).map((request) => request.bytesSent)).toEqual([0, 0]);
  expect(issued(host)).toBe(1);
});

test("an interruption inside the capability's lifetime: a resume on the same link continues from the cut, byte-identical", async ({ page, host, file, browserName }) => {
  host.state.cutAtOffset = CUT_AT;
  const download = await startDownload(page);
  const resumedByBrowser = await afterInterruption(page, host, download, browserName);
  const [first] = transfers(host);
  expect(first).toMatchObject({ range: null, status: 200, bytesSent: CUT_AT });
  if (resumedByBrowser) {
    // The browser's own download manager, with no action by the viewer or the page.
    expect(await download.failure()).toBeNull();
    expect(await sha256Of(download)).toBe(file.sha256);
    expect(transfers(host)).toHaveLength(2);
    expect(transfers(host)[1]).toMatchObject({ range: `bytes=${CUT_AT}-`, ifRange: first.etag, token: first.token, status: 206, contentRange: `bytes ${CUT_AT}-${SIZE - 1}/${SIZE}`, bytesSent: SIZE - CUT_AT });
  } else {
    // This browser build did not ask. The gateway's answer to a manager that does:
    const resumed = await managerResume(page, download, first.etag!);
    expect(resumed.status()).toBe(206);
    expect(resumed.headers()["content-range"]).toBe(`bytes ${CUT_AT}-${SIZE - 1}/${SIZE}`);
    const whole = Buffer.concat([(await readFile(join(file.dir, FILE.file))).subarray(0, CUT_AT), await resumed.body()]);
    expect(createHash("sha256").update(whole).digest("hex")).toBe(file.sha256);
  }
  // One capability served every request: the viewer was not asked to authorize again.
  expect(issued(host)).toBe(1);
  expect(new Set(host.gateway.downloads.map((request) => request.token)).size).toBe(1);
});

test("a resume after expiry is refused; a newly issued link is a new download from byte 0, never a continuation", async ({ page, host, file, browserName }) => {
  host.state.cutAtOffset = CUT_AT;
  host.state.onCut = () => { host.state.clockOffsetMs = 3_600_000; };
  const download = await startDownload(page);
  const resumedByBrowser = await afterInterruption(page, host, download, browserName);
  const [first] = transfers(host);
  if (resumedByBrowser) {
    expect(await download.failure()).not.toBeNull();
    expect(transfers(host)).toHaveLength(2);
    expect(transfers(host)[1]).toMatchObject({ range: `bytes=${CUT_AT}-`, token: first.token, status: 401, bytesSent: 0 });
  } else {
    expect((await managerResume(page, download, first.etag!)).status()).toBe(401);
    expect(transfers(host).at(-1)).toMatchObject({ status: 401, bytesSent: 0 });
  }
  const before = transfers(host).length;
  // The viewer presses Resume/Retry Download: fresh authentication, a new capability, a new link.
  const retry = await retryDownload(page, browserName);
  expect(await retry.failure()).toBeNull();
  expect(await sha256Of(retry)).toBe(file.sha256);
  expect(issued(host)).toBe(2);
  expect(retry.url()).not.toBe(download.url());
  const fresh = transfers(host).slice(before);
  expect(fresh).toHaveLength(1);
  // No Range and no If-Range: the browser did not attach the new link to the partial file.
  expect(fresh[0]).toMatchObject({ range: null, ifRange: null, status: 200, bytesSent: SIZE });
  expect(fresh[0].token).not.toBe(first.token);
});

test("a failed resume leaves an explicit retry: the page reports the outage, does not hang, and recovers when the gateway does", async ({ page, host, file, browserName }) => {
  host.state.cutAtOffset = CUT_AT;
  host.state.onCut = () => { host.state.gatewayUnavailable = true; };
  const download = await startDownload(page);
  const resumedByBrowser = await afterInterruption(page, host, download, browserName);
  const [first] = transfers(host);
  if (resumedByBrowser) expect(await download.failure()).not.toBeNull();
  else expect((await managerResume(page, download, first.etag!)).status()).toBe(503);
  for (const request of transfers(host).slice(1)) expect(request).toMatchObject({ status: 503, bytesSent: 0 });
  await pressRetry(page, browserName);
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: /^Resume\/Retry Download/ })).toBeEnabled();
  host.state.gatewayUnavailable = false;
  const retry = await retryDownload(page, browserName);
  expect(await retry.failure()).toBeNull();
  expect(await sha256Of(retry)).toBe(file.sha256);
  expect(transfers(host).at(-1)).toMatchObject({ range: null, status: 200, bytesSent: SIZE });
});

test("entitlement revoked between requests: the resume and the retry are both refused, and no further byte is served", async ({ page, host, file, browserName }) => {
  host.state.cutAtOffset = CUT_AT;
  host.state.onCut = () => { host.state.entitled = false; };
  const download = await startDownload(page);
  const resumedByBrowser = await afterInterruption(page, host, download, browserName);
  const [first] = transfers(host);
  if (resumedByBrowser) {
    expect(await download.failure()).not.toBeNull();
    expect(transfers(host)[1]).toMatchObject({ range: `bytes=${CUT_AT}-`, token: first.token });
  } else expect((await managerResume(page, download, first.etag!)).status()).toBe(404);
  // The link is still inside its ten minutes; the refusal comes from the per-request entitlement check.
  for (const request of transfers(host).slice(1)) expect(request).toMatchObject({ status: 404, bytesSent: 0 });
  const gatewayRequests = host.gateway.downloads.length;
  await pressRetry(page, browserName);
  await expect(page.getByRole("alert")).toContainText("revoked");
  expect(host.gateway.downloads).toHaveLength(gatewayRequests);
  host.state.entitled = true;
  const retry = await retryDownload(page, browserName);
  expect(await retry.failure()).toBeNull();
  expect(await sha256Of(retry)).toBe(file.sha256);
});
