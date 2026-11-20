import { expect, test as base } from "@playwright/test";
import { startPlayerHarness } from "./player-harness";

/**
 * The reviewer screen's media panel in real browsers (Checkpoint 9): layout at
 * phone to desktop widths, keyboard access and what each state says. Synthetic
 * candidates only (admin-fixture.tsx). What the screen reads from a database is
 * covered by scripts/checkpoint9-validation.mts and the unit tests.
 */
const test = base.extend<{ host: Awaited<ReturnType<typeof startPlayerHarness>> }>({
  host: async ({}, provide) => { const host = await startPlayerHarness(); try { await provide(host); } finally { await host.close(); } },
});
test.beforeEach(async ({ page, host }) => {
  await page.context().route("**/*", (route) => route.request().url().startsWith(host.origin + "/") ? route.continue() : route.abort());
});
const REQUIREMENTS = ["Media integrity verified", "Streaming readiness verified", "Film identity confirmed", "VJ identity confirmed", "Rights clearance approved", "Final publication approval granted"];

test("the media panel and the six requirements fit from 360 px to 1440 px, in both themes, with nothing cut off", async ({ page, host }, info) => {
  for (const theme of ["dark", "light"]) for (const width of [360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${host.origin}/admin-fixture?scenario=pending&theme=${theme}`);
    const panel = page.getByRole("region", { name: "Media inspection" });
    await expect(panel).toBeVisible();
    for (const label of ["Media integrity", "Streaming readiness", "Browser compatibility", "Download availability"]) await expect(panel.getByText(label, { exact: true })).toBeVisible();
    await expect(panel.getByText("Metadata consistent, not verified")).toBeVisible();
    // The long release name wraps inside the panel.
    const name = panel.getByText(/Example\.Movie\.2024.*\.mkv/);
    await expect(name).toBeVisible();
    const [nameBox, panelBox] = [await name.boundingBox(), await panel.boundingBox()];
    expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`).toBe(true);
    const gates = page.getByRole("region", { name: "Publication gates" });
    for (const label of REQUIREMENTS) await expect(gates.getByText(label, { exact: true })).toBeVisible();
    if (info.project.name === "chromium" && theme === "dark" && [390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`dashboard-pending-${width}.png`), fullPage: true });
  }
});

test("each state says what it is: pending, verified, failed, not reported and not inspected are different", async ({ page, host }, info) => {
  const panel = page.getByRole("region", { name: "Media inspection" });
  const gates = page.getByRole("region", { name: "Publication gates" });
  const done = () => gates.locator("li").evaluateAll((items) => items.map((item) => item.querySelector("svg")!.classList.contains("lucide-check")));

  await page.goto(`${host.origin}/admin-fixture?scenario=pending`);
  await expect(page.getByRole("heading", { name: "Verification pending" })).toBeVisible();
  await expect(panel.getByText("Verified", { exact: true })).toHaveCount(0);
  expect(await done()).toEqual([false, false, true, true, false, false]);
  await expect(page.getByRole("button", { name: /Approve|Publish/ })).toHaveCount(0);
  await expect(panel.getByText("Audio tracks").locator("xpath=following-sibling::dd[1]")).toHaveText("2");
  await expect(panel.getByText("Subtitle tracks").locator("xpath=following-sibling::dd[1]")).toHaveText("3");

  await page.goto(`${host.origin}/admin-fixture?scenario=verified`);
  await expect(panel.getByText("Verified", { exact: true })).toHaveCount(2);
  expect(await done()).toEqual([true, true, true, true, true, true]);
  // Approved and verified, but this account cannot publish: an explanation, no button.
  await expect(page.getByText("Publishing needs the publish permission")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish to the site" })).toHaveCount(0);
  await page.goto(`${host.origin}/admin-fixture?scenario=verified&publisher`);
  await expect(page.getByRole("button", { name: "Publish to the site" })).toBeVisible();
  if (info.project.name === "chromium") { await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: info.outputPath("dashboard-verified-1440.png"), fullPage: true }); }

  await page.goto(`${host.origin}/admin-fixture?scenario=failed`);
  await expect(panel.getByText("Failed", { exact: true })).toHaveCount(2);
  await expect(panel.getByRole("heading", { name: "Why the inspection did not pass" })).toBeVisible();
  await expect(panel.getByText("does not match what its container reports")).toBeVisible();
  expect(await done()).toEqual([false, false, true, true, false, false]);
  if (info.project.name === "chromium") await page.screenshot({ path: info.outputPath("dashboard-failed-1440.png"), fullPage: true });

  await page.goto(`${host.origin}/admin-fixture?scenario=earlier`);
  await expect(panel.getByText("Not reported", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Verified by the earlier MP4 policy")).toBeVisible();
  await expect(panel.getByText("Failed", { exact: true })).toHaveCount(0);
  expect(await done()).toEqual([true, true, true, true, false, false]);
  if (info.project.name === "chromium") await page.screenshot({ path: info.outputPath("dashboard-earlier-schema-1440.png"), fullPage: true });

  await page.goto(`${host.origin}/admin-fixture?scenario=none`);
  await expect(panel.getByText("Not inspected", { exact: true })).toHaveCount(3);
  await expect(panel.getByText("Failed", { exact: true })).toHaveCount(0);
  expect(await done()).toEqual([false, false, true, true, false, false]);
});

test("the download setting is shown, not controlled, and the browser detail opens from the keyboard", async ({ page, host }) => {
  await page.goto(`${host.origin}/admin-fixture?scenario=pending`);
  const panel = page.getByRole("region", { name: "Media inspection" });
  await expect(panel.getByText("Switched off", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /download/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.goto(`${host.origin}/admin-fixture?scenario=pending&downloads`);
  await expect(panel.getByText("Not available until published", { exact: true })).toBeVisible();
  // The per-browser detail is a native disclosure: focus it and open it with the keyboard.
  const summary = panel.locator("summary", { hasText: "Browser by browser" });
  await expect(panel.getByText("Not tested on a real device").first()).toBeHidden();
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(panel.getByText("Streaming unreliable")).toBeVisible();
  await expect(panel.getByText("Not tested on a real device")).toHaveCount(3);
  // No Telegram identifier is on the page.
  const text = await page.locator("body").innerText();
  expect(text).toContain("Movies channel, message 46");
  for (const secret of ["1001111111111", "AgADsynthetic46", "d".repeat(64)]) expect(text).not.toContain(secret);
  // The page made no request beyond its own host: nothing to the gateway, no issuer call.
  expect(host.requests).toEqual([]); expect(host.gateway.requests).toEqual([]); expect(host.gateway.downloads).toEqual([]);
});

test("a historical policy 2 refusal and an inconclusive decode are not shown as failed files, and fit from 360 px to 1440 px", async ({ page, host }, info) => {
  const panel = page.getByRole("region", { name: "Media inspection" });
  const gates = page.getByRole("region", { name: "Publication gates" });
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${host.origin}/admin-fixture?scenario=historical`);
    await expect(page.getByRole("heading", { name: "Awaiting Policy 3 inspection" })).toBeVisible();
    await expect(panel.getByText("Awaiting Policy 3 inspection", { exact: true })).toHaveCount(3);
    await expect(panel.getByText("Failed", { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "Historical result (not a current verdict)" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Why the inspection did not pass" })).toHaveCount(0);
    await expect(panel.getByText(/index at the end.*Policy 3 accepts that layout/)).toBeVisible();
    for (const label of REQUIREMENTS) await expect(gates.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve|Publish/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `historical ${width}`).toBe(true);
    if (info.project.name === "chromium" && width === 390) await page.screenshot({ path: info.outputPath("dashboard-historical-390.png"), fullPage: true });

    await page.goto(`${host.origin}/admin-fixture?scenario=inconclusive`);
    await expect(page.getByRole("heading", { name: "Verification inconclusive" })).toBeVisible();
    await expect(panel.getByText("Not verified", { exact: true })).toHaveCount(2);
    await expect(panel.getByText("Failed", { exact: true })).toHaveCount(0);
    await expect(panel.getByText(/not evidence of damage/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve|Publish/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `inconclusive ${width}`).toBe(true);
  }
});


test("catalogue filters fit phones and desktops and support keyboard submission", async ({ page, host }) => {
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${host.origin}/admin-fixture?screen=catalogue`);
    await expect(page.getByRole("heading", { name: "Catalogue", exact: true })).toBeVisible();
    await expect(page.getByText("Showing 1 to 20 of 45.", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of await page.getByRole("form", { name: "Filter catalogue" }).locator("input, select, button").all()) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.goto(`${host.origin}/admin-fixture?screen=catalogue&q=VJ+Test&status=archived&page=2`);
  await expect(page.getByText("Showing 21 to 22 of 22.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "First page" })).toHaveAttribute("href", "/admin/catalogue?q=VJ+Test&status=archived");
  await expect(page.getByRole("link", { name: "Next", exact: true })).toHaveCount(0);
  await page.getByLabel("Search loaded movies", { exact: true }).fill("missing title");
  await page.getByLabel("Publication status").selectOption("draft");
  await page.route("**/admin/catalogue?**", async (route) => {
    const url = new URL(route.request().url());
    url.pathname = "/admin-fixture";
    url.searchParams.set("screen", "catalogue");
    await route.fulfill({ response: await page.request.get(url.toString()) });
  });
  await page.getByRole("button", { name: "Apply filters" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=missing.*status=draft/);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await expect(page.getByRole("heading", { name: "No matching movies" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reset filters" }).first()).toBeVisible();
});


test("full catalogue search and cursor navigation work across phone and desktop layouts", async ({ page, host }) => {
  for (const theme of ["light", "dark"]) for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${host.origin}/admin-fixture?screen=catalogue&paged&theme=${theme}&q=VJ+Test&status=archived`);
    await expect(page.getByLabel("Search movies", { exact: true })).toHaveValue("VJ Test");
    await expect(page.getByText("20 movies on this page. More matches on the next page.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Next", exact: true })).toHaveAttribute("href", "/admin/catalogue?q=VJ+Test&status=archived&cursor=106");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of await page.getByRole("form", { name: "Filter catalogue" }).locator("input, select, button").all()) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.route("**/admin/catalogue?**", async (route) => {
    const url = new URL(route.request().url());
    url.pathname = "/admin-fixture";
    url.searchParams.set("screen", "catalogue");
    await route.fulfill({ response: await page.request.get(url.toString()) });
  });
  await page.getByRole("link", { name: "Next", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/cursor=106/);
  await expect(page.getByRole("heading", { name: "Synthetic movie 104", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic movie 144", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "First page" })).toHaveAttribute("href", "/admin/catalogue?q=VJ+Test&status=archived");
  await page.getByLabel("Search movies", { exact: true }).fill("Older needle");
  await page.getByLabel("Publication status").selectOption("published");
  await page.getByRole("button", { name: "Apply filters" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=Older.*status=published/);
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
  await expect(page.getByRole("heading", { name: "Older needle film", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Next", exact: true })).toHaveCount(0);
  await page.goto(`${host.origin}/admin-fixture?screen=catalogue&paged&cursor=1`);
  await expect(page.getByRole("heading", { name: "No matching movies" })).toBeVisible();
  await expect(page.getByRole("link", { name: "First page" })).toHaveAttribute("href", "/admin/catalogue");
});


test("uploaded movies fit mobile and desktop without exposing unsupported review actions", async ({ page, host }) => {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(host.origin + "/admin-fixture?scenario=uploaded-movies");
    const panel = page.getByRole("region", { name: "Uploaded movies (1)", exact: true });
    await expect(panel.getByRole("heading", { name: "Wrong Turn 5 Bloodlines" })).toBeVisible();
    await expect(panel.getByText("Matched; awaiting review", { exact: true })).toBeVisible();
    await expect(panel.getByText("Awaiting verification", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("manual metadata form supports device poster selection and existing parts on mobile and desktop",async({page,host},info)=>{
 for(const width of [360,1440]){
 await page.setViewportSize({width,height:950});
 await page.goto(host.origin+"/admin-fixture?scenario=manual-metadata");
 await expect(page.getByRole("heading",{name:"Enter movie details manually"})).toBeVisible();
 await page.getByLabel("VJ",{exact:true}).selectOption("1");
 await page.getByLabel("Release date",{exact:true}).fill("2024-05-01");
 await page.getByLabel("Poster from your device (optional)",{exact:true}).setInputFiles({name:"poster.webp",mimeType:"image/webp",buffer:Buffer.from("synthetic fixture upload")});
 await expect(page.getByText("Stored as WebP in Cloudflare R2.",{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole("button",{name:"Save and confirm manual details"}).click();
 await expect(page.getByRole("status")).toContainText("Synthetic metadata saved: Manual Film");
 await page.getByLabel("Use an existing manually entered movie",{exact:true}).selectOption("123");
 await expect(page.getByLabel("Movie title",{exact:true})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"Confirm selected movie and VJ"})).toBeVisible();
 if(info.project.name==="chromium") await page.screenshot({path:info.outputPath("manual-metadata-"+width+".png"),fullPage:true});
 }
});
