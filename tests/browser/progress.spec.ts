import { expect, test as base, type Page } from "@playwright/test";
import { startPlayerHarness } from "./player-harness";

/**
 * Movie viewing progress through the real player and the real progress route
 * handlers (in-memory store with the database's clamp and completion rule).
 * The committed fixtures are 12 s long, shorter than the 30 s resume threshold,
 * so a forward seek to a saved point is not exercised here: a resume beyond the
 * end of the file starts from the beginning, which these tests do cover.
 */
const test = base.extend<{ host: Awaited<ReturnType<typeof startPlayerHarness>> }>({
  host: async ({}, provide) => { const host = await startPlayerHarness(); try { await provide(host); } finally { await host.close(); } },
});

test.beforeEach(async ({ page, host }) => {
  await page.context().route("**/*", (route) => route.request().url().startsWith(host.origin + "/") || route.request().url().startsWith(host.gateway.origin + "/") ? route.continue() : route.abort());
});

const saves = (host: { progressRequests: { method: string; body: unknown }[] }) =>
  host.progressRequests.filter((request) => request.method === "POST").map((request) => request.body as { movieVersionId: number; positionSeconds: number; durationSeconds: number | null });
const playing = (page: Page) => expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => !video.paused && video.readyState >= 3)).toBe(true);

test("the most recently watched unfinished VJ is preselected and offered from its saved point", async ({ page, host }) => {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  host.progress.set(1, { movieVersionId: 1, positionSeconds: 40, durationSeconds: 3000, completed: false, updatedAt: hourAgo });
  host.progress.set(4, { movieVersionId: 4, positionSeconds: 31, durationSeconds: 3000, completed: false, updatedAt: new Date().toISOString() });
  await page.goto(`${host.origin}/fixture?versions=1,4`);
  await expect(page.getByRole("button", { name: "Resume from 0:31", exact: true })).toBeVisible();
  await expect(page.getByLabel("VJ", { exact: true })).toHaveValue("4");
  await expect(page.getByRole("button", { name: "Start over", exact: true })).toBeVisible();
  expect(host.progressRequests).toEqual([{ method: "GET", body: "1,4" }]);

  // A manual choice wins, and shows that version's own saved point.
  await page.getByLabel("VJ", { exact: true }).selectOption("1");
  await expect(page.getByRole("button", { name: "Resume from 0:40", exact: true })).toBeVisible();

  // The saved point is beyond this 12 s file's end, so it plays from the start instead of seeking past the end.
  await page.getByRole("button", { name: "Resume from 0:40", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("readyState", 4);
  expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeLessThan(7);
  expect(host.requests.filter((request) => request.operation === "stream").map((request) => request.versionId)).toEqual([1]);
});

test("pause, the end and closing save the playing version; the end counts as watched", async ({ page, host }) => {
  await page.goto(`${host.origin}/fixture?versions=1,4`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => host.progressRequests.length).toBe(1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);

  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.pause(); });
  await expect.poll(() => saves(host).length).toBe(1);
  expect(saves(host)[0]).toMatchObject({ movieVersionId: 1, durationSeconds: 12 });
  expect(host.progress.get(1)?.completed).toBe(false);

  // Play out the last second: the end is saved as the full duration and counts as watched.
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 11; void video.play(); });
  await expect.poll(() => host.progress.get(1)?.completed, { timeout: 20_000 }).toBe(true);
  expect(host.progress.get(1)).toMatchObject({ positionSeconds: 12, durationSeconds: 12 });
  const atEnd = saves(host).length;

  // Watched: closing does not save again, and the page offers a fresh Play rather than a resume.
  await page.getByRole("button", { name: "Close player", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start over", exact: true })).toHaveCount(0);
  expect(saves(host).length).toBe(atEnd);

  // Changing VJ while playing saves the version that was playing, not the newly selected one.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 3; });
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime >= 3)).toBe(true);
  const beforeChange = saves(host).length;
  await page.getByLabel("VJ", { exact: true }).selectOption("4");
  await expect.poll(() => saves(host).length).toBeGreaterThan(beforeChange);
  expect(saves(host).at(-1)).toMatchObject({ movieVersionId: 1, durationSeconds: 12 });
  expect(saves(host).at(-1)!.positionSeconds).toBeGreaterThanOrEqual(3);
  expect(saves(host).every((save) => save.movieVersionId === 1)).toBe(true);
  expect(host.progress.get(1)?.completed).toBe(false);
  expect(host.progress.has(4)).toBe(false);
});

test("progress off (migration not applied): one read, no saves, playback unaffected", async ({ page, host }) => {
  host.state.progressDeployed = false;
  await page.goto(`${host.origin}/fixture?versions=1`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => host.progressRequests.length).toBe(1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await playing(page);
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.pause(); });
  await page.getByRole("button", { name: "Close player", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  expect(host.progressRequests).toEqual([{ method: "GET", body: "1" }]);
  expect(host.requests.filter((request) => request.operation === "stream")).toHaveLength(1);
});

test("signed out: the page makes no progress request", async ({ page, host }) => {
  host.state.signedIn = false;
  await page.goto(`${host.origin}/fixture?versions=1,4`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(host.progressRequests).toEqual([]);
});
