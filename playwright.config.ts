import { defineConfig } from "@playwright/test";

/**
 * Browser playback tests (tests/browser): fixtures served through the real
 * media gateway core on loopback. `npm run test:browser`.
 *
 * `chrome` and `msedge` are the browsers installed on this machine. `chromium`,
 * `firefox` and `webkit` are Playwright's own builds. Playwright WebKit is an
 * approximation only: Safari on macOS and iOS, and Android browsers, need real
 * devices and are not covered here.
 */
export default defineConfig({
  testDir: "tests/browser",
  tsconfig: "./tests/browser/tsconfig.json",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: false,
  // Media decoding is timing-sensitive; two browsers at a time keeps the measurements steady.
  workers: 2,
  retries: 0,
  timeout: 150_000,
  reporter: [["list"]],
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "msedge", use: { browserName: "chromium", channel: "msedge" } },
    // Chrome decodes HEVC only with the device's hardware decoder. This project shows what a device without one gets.
    { name: "chrome-software-decode", use: { browserName: "chromium", channel: "chrome", launchOptions: { args: ["--disable-accelerated-video-decode"] } } },
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
