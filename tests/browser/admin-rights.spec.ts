import { expect, test as base } from "@playwright/test";
import { startPlayerHarness } from "./player-harness";

/**
 * The reviewer screen under optional media verification and the rights review
 * (migration 20261018090000), in real browsers: the five facts, the rights panel,
 * layout from phone to desktop, keyboard and touch targets. Synthetic candidates
 * only (admin-fixture.tsx); the database's decisions are covered by suite 022.
 */
const test = base.extend<{ host: Awaited<ReturnType<typeof startPlayerHarness>> }>({
  host: async ({}, provide) => { const host = await startPlayerHarness(); try { await provide(host); } finally { await host.close(); } },
});
test.beforeEach(async ({ page, host }) => {
  await page.context().route("**/*", (route) => route.request().url().startsWith(host.origin + "/") ? route.continue() : route.abort());
});

test("the overview and the rights panel fit from 360 px to 1440 px, in both themes", async ({ page, host }, info) => {
  for (const theme of ["dark", "light"]) for (const width of [360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${host.origin}/admin-fixture?scenario=rights_pending&theme=${theme}`);
    const overview = page.getByRole("region", { name: "Where this movie stands" });
    await expect(overview).toBeVisible();
    for (const label of ["Telegram source", "Film and VJ", "Media verification", "Distribution authorization", "Publication approval"]) await expect(overview.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Distribution rights" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`).toBe(true);
    if (info.project.name === "chromium" && theme === "dark" && [390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`rights-pending-${width}.png`), fullPage: true });
  }
});

test("an uninspected file reads as not inspected, rights as not provided, and nothing can be approved", async ({ page, host }) => {
  await page.goto(`${host.origin}/admin-fixture?scenario=optional`);
  const overview = page.getByRole("region", { name: "Where this movie stands" });
  await expect(overview.getByText("Awaiting publication authorization")).toBeVisible();
  await expect(overview.getByText("Not inspected", { exact: true })).toBeVisible();
  await expect(overview.getByText("Not provided", { exact: true })).toBeVisible();
  await expect(overview.getByText("Verified", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Approve|Publish to the site)$/ })).toHaveCount(0);
  // The submission form is reachable and usable from the keyboard, with labelled fields.
  const reference = page.getByLabel("Rights reference");
  await reference.focus();
  await expect(reference).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Document SHA-256 (optional)")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Submit for rights review" })).toBeFocused();
});

test("a pending reference offers verify and reject to a rights reviewer, with comfortable touch targets", async ({ page, host }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${host.origin}/admin-fixture?scenario=rights_pending`);
  const rights = page.getByRole("region", { name: "Distribution rights" });
  await expect(rights.getByText("Pending review", { exact: true })).toBeVisible();
  await expect(rights.getByText(/licence 2026-021 · no document · Rejected/)).toBeVisible();
  for (const name of [/^Verify rights: licence 2026-021-B$/, /^Reject$/]) {
    const button = rights.getByRole("button", { name });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(rights.getByRole("button", { name: "Submit for rights review" })).toHaveCount(0);
});
