import type { Page } from "@playwright/test";

/**
 * The contract between the specs and the probe page (probe.html), which drives
 * one native <video> element and reports what the browser actually did.
 */
export interface ProbeConfig { url: string; mime: string; typeWithCodecs: string; videoCodec: string; audioCodec: string; seekTo: number }

export interface ProbeResult {
  /** Set only when the probe page itself failed. */
  harnessError?: string;
  canPlayType: string; canPlayContainer: string; mediaCapabilities: string;
  metadata: boolean; metadataMs: number | null; duration: number | null; width: number; height: number;
  audioTracks: number | null; videoTracks: number | null; textTracks: number;
  playing: boolean; playingMs: number | null; playRejected: string | null; firstFrame: boolean; framesDecoded: number | null;
  /** False in a build without Web Audio: the audio could not be measured, which is not silence. */
  audioMeasured: boolean; audioRms: number; audioHz: number | null; audioDecodedBytes: number | null; hasAudioHint: boolean | null;
  seeked: boolean; seekPosition: number | null; frameAfterSeek: boolean; resumed: boolean; audioRmsAfterSeek: number;
  errorCode: number | null; errorMessage: string | null; events: string[];
}

declare global {
  interface Window { __probeConfig?: ProbeConfig; __probeResult?: ProbeResult }
}

/** The fixtures' tone has an RMS near 0.06; decoded silence measures 0. */
export const AUDIBLE_RMS = 0.01;

/** Opens the probe page and starts playback with a real click (a user gesture, as in the product). */
export async function startProbe(page: Page, origin: string, config: ProbeConfig): Promise<void> {
  await page.goto(`${origin}/`);
  await page.evaluate((value) => { window.__probeConfig = value; }, config);
  await page.click("#run");
}

/** Resolves when the element has loaded metadata; false if it never does within the time. */
export async function metadataLoaded(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(() => document.querySelector("video")!.readyState >= 1, undefined, { timeout: timeoutMs, polling: 20 });
    return true;
  } catch {
    return false;
  }
}

export async function probeResult(page: Page, timeoutMs = 100_000): Promise<ProbeResult> {
  const handle = await page.waitForFunction(() => window.__probeResult, undefined, { timeout: timeoutMs });
  return (await handle.jsonValue()) as ProbeResult;
}
