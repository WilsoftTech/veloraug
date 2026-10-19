import { expect, test as base } from "@playwright/test";
import { createHash } from "node:crypto";
import { startPlayerHarness } from "./player-harness";

const test = base.extend<{ host: Awaited<ReturnType<typeof startPlayerHarness>> }>({
  host: async ({}, provide) => { const host = await startPlayerHarness(); try { await provide(host); } finally { await host.close(); } },
});

test.beforeEach(async ({ page, host }) => {
  await page.context().route("**/*", (route) => route.request().url().startsWith(host.origin + "/") ? route.continue() : route.abort());
});

const movie = { name: "Example.Movie.mp4", mimeType: "video/mp4", buffer: Buffer.from("film") };

test("selection validates files, clears removed files, and submits only draft facts", async ({ page, host }) => {
  await page.goto(`${host.origin}/admin-fixture?screen=upload`);
  const picker = page.getByLabel("Movie file", { exact: true });
  const create = page.getByRole("button", { name: "Create upload draft" });
  await expect(create).toBeDisabled();
  await picker.setInputFiles({ ...movie, name: "wrong.txt" });
  await expect(picker).toHaveAttribute("aria-invalid", "true");
  await expect(create).toBeDisabled();
  await picker.setInputFiles({ ...movie, buffer: Buffer.alloc(0) });
  await expect(page.getByRole("alert")).toContainText("nonempty");
  await picker.setInputFiles(movie);
  await expect(create).toBeEnabled();
  const requestId = await page.locator('[name="requestId"]').inputValue();
  await expect(page.getByText("Ready to create a draft", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Remove selected file" }).click();
  await expect(create).toBeDisabled();
  await expect(page.locator('[name="fileName"]')).toHaveValue("");
  await picker.setInputFiles(movie);
  expect(await page.locator('[name="requestId"]').inputValue()).not.toBe(requestId);
  await expect(picker).not.toHaveAttribute("name");
  await picker.setInputFiles([]);
  await expect(create).toBeDisabled();
  await picker.setInputFiles(movie);
  await create.click();
  await expect(page.getByRole("alert")).toHaveText("Synthetic draft received: Example.Movie.mp4 (4 bytes).");
  expect(host.requests).toEqual([]);
});

test("a paused transfer enables resume and stops showing a stale speed estimate", async ({ page, host }) => {
  await page.route("**/api/admin/uploads/synthetic-upload/transfer", (route) => route.fulfill({ json: { url: `${host.origin}/synthetic-staging`, token: "synthetic" } }));
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/synthetic-staging", async (route) => {
    if (route.request().method() === "PATCH") {
      await held;
      await route.abort();
    } else await route.fulfill({ json: { offset: 0, size: 4, chunks: [] } });
  });
  await page.goto(`${host.origin}/admin-fixture?screen=transfer`);
  const picker = page.getByLabel("Select the file to upload or resume");
  await picker.setInputFiles(movie);
  await page.getByRole("button", { name: "Start or resume transfer" }).click();
  await expect(page.getByText("Transferring your movie…")).toBeVisible();
  await expect(picker).toBeDisabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused. Completed chunks are retained.")).toBeVisible();
  await expect(picker).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start or resume transfer" })).toBeEnabled();
  await expect(page.getByText(/min remaining/)).toHaveCount(0);
  release!();
});

test("R2 resume checks saved hashes and reconciles completed parts before queuing verification", async ({ page, host }) => {
  const commands: string[] = [];
  await page.route("**/api/admin/uploads/synthetic-upload/transfer", async (route) => {
    const { command } = route.request().postDataJSON() as { command: string };
    commands.push(command);
    await route.fulfill({ json: { size: 4, bytes: 4, complete: command === "complete", parts: [{ number: 1, size: 4, sha256: createHash("sha256").update(movie.buffer).digest("hex"), etag: "synthetic-part" }] } });
  });
  await page.goto(`${host.origin}/admin-fixture?screen=transfer&r2`);
  const picker = page.getByLabel("Select the file to upload or resume");
  await picker.setInputFiles({ ...movie, buffer: Buffer.from("else") });
  await page.getByRole("button", { name: "Start or resume transfer" }).click();
  await expect(page.getByText("This is a different file. Create a new draft.")).toBeVisible();
  expect(commands).toEqual(["status"]);
  await picker.setInputFiles(movie);
  await page.getByRole("button", { name: "Resume transfer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Verification queued" })).toBeDisabled();
  expect(commands).toEqual(["status", "status", "complete"]);
  await expect(page.getByRole("button", { name: "Refresh processing status" })).toBeVisible();
});

test("dropping several movies cannot silently select the first", async ({ page, host }) => {
  await page.goto(`${host.origin}/admin-fixture?screen=upload`);
  const data = await page.evaluateHandle(() => {
    const files = new DataTransfer();
    files.items.add(new File(["film"], "first.mp4"));
    files.items.add(new File(["film"], "second.mkv"));
    return files;
  });
  await page.locator("form > div").first().dispatchEvent("drop", { dataTransfer: data });
  await expect(page.getByRole("alert")).toHaveText("Choose one movie at a time.");
  await expect(page.getByRole("button", { name: "Create upload draft" })).toBeDisabled();
  await data.dispose();
});

test("selection and transfer fit phones and desktop in both themes", async ({ page, host }, info) => {
  const name = `${"Long.Movie.Release.Name.".repeat(8)}mp4`;
  for (const theme of ["dark", "light"]) for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of ["upload", "transfer"]) {
      await page.goto(`${host.origin}/admin-fixture?screen=${screen}&theme=${theme}&name=${name}`);
      const picker = page.getByLabel(screen === "upload" ? "Movie file" : "Select the file to upload or resume", { exact: true });
      await picker.setInputFiles({ ...movie, name });
      await expect(picker).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${screen} ${theme} ${width}`).toBe(true);
      const button = page.getByRole("button", { name: screen === "upload" ? "Create upload draft" : "Start or resume transfer" });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if (info.project.name === "chromium" && theme === "dark" && [390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`${screen}-${width}.png`), fullPage: true });
    }
  }
});

test("disk transfer recovers after completion queue failure without sending the bytes again", async ({ page, host }) => {
  let bytes = 0;
  let chunks = 0;
  let verifies = 0;
  await page.route("**/api/admin/uploads/synthetic-upload/transfer", async (route) => {
    if (route.request().headers()["upload-command"] === "verify") {
      verifies++;
      await route.fulfill({ status: verifies === 1 ? 503 : 200, json: {} });
    } else await route.fulfill({ json: { url: `${host.origin}/synthetic-staging`, token: "synthetic" } });
  });
  await page.route("**/synthetic-staging", async (route) => {
    if (route.request().method() === "PATCH") {
      bytes = 4; chunks++;
      await route.fulfill({ json: { offset: bytes } });
    } else await route.fulfill({ json: { size: 4, offset: bytes, chunks: bytes ? [{ offset: 0, size: 4, sha256: createHash("sha256").update(movie.buffer).digest("hex") }] : [] } });
  });
  await page.goto(`${host.origin}/admin-fixture?screen=transfer`);
  const picker = page.getByLabel("Select the file to upload or resume");
  await picker.setInputFiles({ ...movie, name: "different.mp4" });
  await page.getByRole("button", { name: "Start or resume transfer" }).click();
  await expect(page.getByText("Reselect the same file name and size to continue this upload.")).toBeVisible();
  await picker.setInputFiles(movie);
  await page.getByRole("button", { name: "Start or resume transfer" }).click();
  await expect(page.getByText(/verification could not be queued/)).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "4");
  await page.getByRole("button", { name: "Resume transfer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Verification queued" })).toBeDisabled();
  await expect(page.getByText(/movie is still private/)).toBeVisible();
  await expect(picker).toBeDisabled();
  expect(chunks).toBe(1);
  expect(verifies).toBe(2);
});
