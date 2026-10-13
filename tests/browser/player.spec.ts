import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import { startPlayerHarness } from "./player-harness";
import { FIXTURES } from "./harness";

const test = base.extend<{ host: Awaited<ReturnType<typeof startPlayerHarness>> }>({
  host: async ({}, provide) => { const host = await startPlayerHarness(); try { await provide(host); } finally { await host.close(); } },
});

test.beforeEach(async ({ page, host }) => {
  // Prevent any external requests, including a future accidental hosted auth/catalogue call.
  await page.context().route("**/*", (route) => route.request().url().startsWith(host.origin + "/") || route.request().url().startsWith(host.gateway.origin + "/") ? route.continue() : route.abort());
});

test("authorized download uses selected VJ, gateway filename and exact original bytes without Blob", async ({ page, host }) => {
  await page.addInitScript(() => { window.Blob = class { constructor() { throw new Error("Blob buffering forbidden in player test"); } } as unknown as typeof Blob; });
  await page.goto(`${host.origin}/fixture`);
  await expect(page.getByRole("button", { name: "Download (MP4)", exact: true })).toBeVisible();
  await page.getByLabel("VJ", { exact: true }).selectOption("4");
  await expect(page.getByRole("button", { name: "Download (MKV)", exact: true })).toBeVisible();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download (MKV)", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("handed to your browser");
  const result = await event;
  expect(result.url()).toContain(`${host.gateway.origin}/v1/movie-versions/4/download?`);
  expect(result.suggestedFilename()).toBe("mkv-h264-aac.mkv");
  expect(await result.failure()).toBeNull();
  const bytes = await readFile((await result.path())!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURES.find((file) => file.id === 4)!.sha256);
  expect(host.requests.filter((request) => request.operation === "download")).toEqual([{ operation: "download", versionId: 4 }]);
  await expect(page.getByRole("status")).toContainText("handed to your browser");
  expect(await page.locator('a[href*="token="]').count()).toBe(0);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
});

// Checkpoint 9: the server's download switch (issuer and gateway). The page is only told the result.
const askIssuer = (page: Page) => page.evaluate(async () => {
  const response = await fetch("/api/media/download-token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ movieVersionId: 1 }) });
  return { status: response.status, body: await response.json() as Record<string, string> };
});

test("download switch off: no Download control, both server sides refuse a request made anyway, and playback is unaffected", async ({ page, host }) => {
  host.state.issuerDownloads = false; host.state.gatewayDownloads = false;
  await page.goto(`${host.origin}/fixture?versions=1`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Download/ })).toHaveCount(0);
  await expect(page.getByText(/download manager/i)).toHaveCount(0);
  // The issuer refuses before it reads the session or asks the catalogue.
  expect(await askIssuer(page)).toEqual({ status: 503, body: { error: "downloads_disabled" } });
  expect(host.requests).toEqual([]);
  // A link issued while the issuer's switch was on is refused by the gateway's own switch: no byte of the file is sent.
  host.state.issuerDownloads = true;
  const issued = await askIssuer(page);
  expect(issued.status).toBe(200);
  const refused = await page.evaluate(async (url) => {
    const results = [];
    for (const headers of [{}, { Range: "bytes=0-0" }] as Record<string, string>[]) { const response = await fetch(url, { headers }); results.push({ status: response.status, body: await response.text() }); }
    return results;
  }, issued.body.downloadUrl);
  expect(refused).toEqual([{ status: 503, body: '{"error":"downloads_disabled"}' }, { status: 503, body: '{"error":"downloads_disabled"}' }]);
  expect(host.gateway.downloads.map((request) => request.status)).toEqual([503, 503]);
  // Streaming never reads the switch.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  expect(host.gateway.requests.length).toBeGreaterThan(0);
  expect(host.gateway.requests.every((request) => request.status === 206)).toBe(true);
});

test("a page opened before the switch went off cannot download, and says why", async ({ page, host }) => {
  await page.goto(`${host.origin}/fixture?versions=1`);
  const button = page.getByRole("button", { name: "Download (MP4)", exact: true });
  await expect(button).toBeVisible();
  host.state.issuerDownloads = false;
  await button.click();
  await expect(page.getByRole("alert")).toContainText("Downloads are switched off at the moment.");
  expect(host.gateway.downloads).toEqual([]);
  // The issuer on and only the gateway off: the one-byte probe is refused, so nothing is handed to the browser.
  host.state.issuerDownloads = true; host.state.gatewayDownloads = false;
  let handedOff = false; page.on("download", () => { handedOff = true; });
  await page.getByRole("button", { name: "Resume/Retry Download (MP4)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  expect(host.gateway.downloads.map((request) => request.status)).toEqual([503]);
  expect(handedOff).toBe(false);
  // Both on again: the same control works, after a fresh authorization.
  host.state.gatewayDownloads = true;
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Resume/Retry Download (MP4)", exact: true }).click();
  expect(await (await event).failure()).toBeNull();
});

test("signed-out action is hidden and stale signed-in UI cannot obtain a download", async ({ page, host }) => {
  host.state.signedIn = false;
  await page.goto(`${host.origin}/fixture`);
  await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);
  host.state.signedIn = true; await page.reload();
  host.state.signedIn = false;
  await page.getByRole("button", { name: "Download (MP4)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sign in again");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", /sign-in/);
});

test("expiry reissues through fresh auth; explicit retry denies revoked access and recovers only when authorized", async ({ page, host }) => {
  host.state.expiredOnce = true;
  await page.goto(`${host.origin}/fixture?versions=1`);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download (MP4)", exact: true }).click();
  expect(await (await event).failure()).toBeNull();
  expect(host.requests.filter((request) => request.operation === "download")).toHaveLength(2);
  await expect(page.getByText(/may restart instead of resuming/)).toBeVisible();
  host.state.entitled = false;
  await page.getByRole("button", { name: "Resume/Retry Download (MP4)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("revoked");
  expect(host.requests.filter((request) => request.operation === "download")).toHaveLength(3);
  host.state.entitled = true; host.state.published = false;
  await page.getByRole("button", { name: "Resume/Retry Download (MP4)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("no longer available");
  host.state.published = true;
  const retry = page.waitForEvent("download");
  await page.getByRole("button", { name: "Resume/Retry Download (MP4)", exact: true }).click();
  expect(await (await retry).failure()).toBeNull();
});

test("network and unavailable gateway fail safely, without fetching a full file or infinite loading", async ({ page, host }) => {
  await page.goto(`${host.origin}/fixture?legacy`);
  await expect(page.getByText("Compatibility is untested for this file and browser.")).toBeVisible();
  await page.route("**/api/media/download-token", (route) => route.abort());
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection");
  await page.unroute("**/api/media/download-token");
  host.state.gatewayUnavailable = true;
  await page.getByRole("button", { name: "Resume/Retry Download", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Resume/Retry Download", exact: true })).toBeEnabled();
});

test("interrupted browser handoff needs explicit retry, which obtains a fresh capability", async ({ page, host }) => {
  await page.goto(`${host.origin}/fixture?versions=1`);
  // Abort the full browser-managed request while allowing the one-byte readiness probe.
  await page.context().route("**/v1/movie-versions/1/download?*", (route) => route.request().headers().range === "bytes=0-0" ? route.continue() : route.abort());
  await page.getByRole("button", { name: "Download (MP4)", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check its download manager");
  expect(host.requests.filter((request) => request.operation === "download")).toHaveLength(1);
  await page.context().unroute("**/v1/movie-versions/1/download?*");
  const retry = page.waitForEvent("download");
  await page.getByRole("button", { name: "Resume/Retry Download (MP4)", exact: true }).click();
  expect(await (await retry).failure()).toBeNull();
  expect(host.requests.filter((request) => request.operation === "download")).toHaveLength(2);
});

test("unsupported container keeps Download accessible; warnings preserve HEVC, AC-3 and tail-MP4 distinctions", async ({ page, host }) => {
  await page.goto(`${host.origin}/fixture?versions=1&unsupported`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
  for (const [version, text] of [[2, "Startup may take longer"], [7, "HEVC"], [12, "silently"]] as const) {
    await page.goto(`${host.origin}/fixture?versions=${version}`);
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  }
});

test("missing picture, missing audio and slow metadata have distinct bounded fallback messages", async ({ page, host }) => {
  await page.clock.install();
  // This test injects native events to exercise UI decisions, not the decoder.
  // A real pending WebKit source raises its own error before the watchdog; suppress transport here.
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get: () => "", set: () => {} });
    HTMLMediaElement.prototype.play = function () { this.setAttribute("data-source-attached", ""); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = () => {};
    HTMLMediaElement.prototype.load = () => {};
  });
  // A real element raises media events only after its source is attached. The play() stand-in
  // above marks that moment, so each injection waits for it instead of racing the attach effect.
  const sourceAttached = () => expect(page.locator("video")).toHaveAttribute("data-source-attached", "");
  await page.goto(`${host.origin}/fixture?versions=1`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await sourceAttached();
  // Synthetic native event regression: the real matrix separately measures actual decoded output.
  await page.locator("video").evaluate((video) => { Object.defineProperty(video, "videoWidth", { value: 0 }); Object.defineProperty(video, "videoHeight", { value: 0 }); video.dispatchEvent(new Event("loadeddata")); });
  await expect(page.getByRole("alert")).toContainText("without a decoded picture");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await sourceAttached();
  await page.locator("video").evaluate((video) => { Object.defineProperty(video, "videoWidth", { value: 320 }); Object.defineProperty(video, "mozHasAudio", { value: false }); video.dispatchEvent(new Event("loadeddata")); });
  await expect(page.getByRole("status").filter({ hasText: "no decoded audio" })).toBeVisible();
  await page.getByRole("button", { name: "Close player" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Loading");
  await page.clock.runFor(30_100);
  await expect(page.getByRole("alert")).toContainText("metadata is taking too long");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await sourceAttached();
  await page.locator("video").evaluate((video) => {
    Object.defineProperty(video, "videoWidth", { value: 320 });
    video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("loadeddata")); video.dispatchEvent(new Event("waiting"));
  });
  await expect(page.getByRole("status").filter({ hasText: "Buffering" })).toBeVisible();
  await page.clock.runFor(30_100);
  await expect(page.getByRole("alert")).toContainText("Check your connection");
});

/**
 * Models a browser that refuses the automatic start (the play() promise rejects
 * with NotAllowedError and the element stays paused) and holds back the first
 * frame until playback begins (no loadeddata or canplay), as iOS Safari is
 * documented to do. Transport and decoding stay real. Not a Safari test.
 */
async function refuseAutomaticStart(page: Page) {
  await page.clock.install();
  await page.addInitScript(() => {
    const nativePlay = HTMLMediaElement.prototype.play;
    (window as unknown as { viewerPlay(video: HTMLMediaElement): Promise<void> }).viewerPlay = (video) => nativePlay.call(video);
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException("The request is not allowed by the user agent.", "NotAllowedError"));
    for (const name of ["loadeddata", "canplay", "canplaythrough"]) document.addEventListener(name, (event) => event.stopImmediatePropagation(), true);
  });
}

test("a refused automatic start waits for the viewer: it is not shown as loading or closed by the loading deadline", async ({ page, host }) => {
  await refuseAutomaticStart(page);
  await page.goto(`${host.origin}/fixture?versions=1`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  // Waiting for the viewer is not loading.
  await expect.soft(page.getByText("Loading…")).toHaveCount(0);
  await page.clock.runFor(30_100);
  await expect.soft(page.getByRole("alert")).toHaveCount(0);
  await expect(video).toHaveCount(1);
  // The viewer starts playback from the native controls.
  await video.evaluate((element: HTMLVideoElement) => (window as unknown as { viewerPlay(video: HTMLMediaElement): Promise<void> }).viewerPlay(element));
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("after a refused automatic start, the loading deadline still applies once the viewer has pressed play", async ({ page, host }) => {
  await refuseAutomaticStart(page);
  await page.goto(`${host.origin}/fixture?versions=1`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await page.clock.runFor(30_100);
  await expect(video).toHaveCount(1);
  // What an element raises when the viewer presses play and the next frame is not available.
  await video.evaluate((element) => element.dispatchEvent(new Event("waiting")));
  await expect(page.getByRole("status").filter({ hasText: "Buffering" })).toBeVisible();
  await page.clock.runFor(30_100);
  await expect(page.getByRole("alert")).toContainText("Check your connection");
});

test("native MP4 playback, VJ change and capability renewal preserve the existing player", async ({ page, host }, info) => {
  // This is native video/control regression, not an audio assertion or a Safari support claim.
  await page.clock.install();
  await page.goto(`${host.origin}/fixture?versions=1,2`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  await page.getByLabel("VJ", { exact: true }).selectOption("2");
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  // Paused -> resume after expiry triggers fresh authorization for selected VJ.
  await page.locator("video").evaluate((video: HTMLVideoElement) => video.pause());
  await page.clock.runFor(600_000);
  await page.locator("video").evaluate((video) => video.dispatchEvent(new Event("play")));
  await expect.poll(() => host.requests.filter((request) => request.operation === "stream").length).toBe(3);
  expect(host.requests.filter((request) => request.operation === "stream").map((request) => request.versionId)).toEqual([1, 2, 2]);
  expect(info.project.name).toBeTruthy();
});

test("desktop/tablet/phone controls fit and support keyboard focus and download activation", async ({ page, browser, host }, info) => {
  for (const width of [1440, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${host.origin}/fixture`);
    const button = page.getByRole("button", { name: "Download (MP4)", exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await expect(button).toBeFocused();
    const outline = await button.evaluate((element) => getComputedStyle(element).outlineStyle); expect(outline).not.toBe("none");
    if (info.project.name === "chromium" && [390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`player-${width}.png`), fullPage: true });
  }
  const event = page.waitForEvent("download"); await page.keyboard.press("Enter"); expect(await (await event).failure()).toBeNull();
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    await touch.route("**/*", (route) => route.request().url().startsWith(host.origin + "/") || route.request().url().startsWith(host.gateway.origin + "/") ? route.continue() : route.abort());
    const phone = await touch.newPage(); await phone.goto(`${host.origin}/fixture?versions=1`);
    const tapped = phone.waitForEvent("download"); await phone.getByRole("button", { name: "Download (MP4)", exact: true }).tap();
    expect(await (await tapped).failure()).toBeNull();
  } finally { await touch.close(); }
});
