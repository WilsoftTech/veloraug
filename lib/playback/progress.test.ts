import { describe, expect, it, vi } from "vitest";
import {
  CONTINUE_WATCHING_ENDPOINT,
  PROGRESS_ENDPOINT,
  fetchContinueWatching,
  fetchVersionProgress,
  formatPlaybackTime,
  isCompletedPosition,
  isResumable,
  progressFraction,
  progressFromMedia,
  resumeVersion,
  saveVersionProgress,
  shouldSaveProgress,
  type VersionProgress,
} from "@/lib/playback/progress";

const entry = (movieVersionId: number, positionSeconds: number, updatedAt: string, completed = false): VersionProgress =>
  ({ movieVersionId, positionSeconds, durationSeconds: 6000, completed, updatedAt });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("progress rules", () => {
  it("completion matches the database rule: at most 5% left", () => {
    expect(isCompletedPosition(5699, 6000)).toBe(false);
    expect(isCompletedPosition(5700, 6000)).toBe(true);
    expect(isCompletedPosition(5700, null)).toBe(false);
  });

  it("resumes only unfinished positions of at least 30 s", () => {
    expect(isResumable({ completed: false, positionSeconds: 29 })).toBe(false);
    expect(isResumable({ completed: false, positionSeconds: 30 })).toBe(true);
    expect(isResumable({ completed: true, positionSeconds: 3000 })).toBe(false);
  });

  it("picks the most recently watched unfinished version among the page's versions", () => {
    const progress = [entry(1, 400, "2026-11-17T10:00:00Z"), entry(4, 300, "2026-11-17T12:00:00Z"), entry(9, 500, "2026-11-17T13:00:00Z"),
      entry(5, 10, "2026-11-17T14:00:00Z"), entry(6, 5900, "2026-11-17T15:00:00Z", true)];
    expect(resumeVersion([1, 4, 5, 6], progress)?.movieVersionId).toBe(4);
    expect(resumeVersion([5, 6], progress)).toBeNull();
    expect(resumeVersion([], progress)).toBeNull();
  });

  it("formats positions and fractions", () => {
    expect(formatPlaybackTime(31)).toBe("0:31");
    expect(formatPlaybackTime(754.9)).toBe("12:34");
    expect(formatPlaybackTime(3723)).toBe("1:02:03");
    expect(formatPlaybackTime(-5)).toBe("0:00");
    expect(progressFraction(1500, 6000)).toBe(0.25);
    expect(progressFraction(7000, 6000)).toBe(1);
    expect(progressFraction(10, null)).toBeNull();
  });

  it("turns what the video element reports into a bounded save request", () => {
    expect(progressFromMedia(3, 61.8, 5400.4)).toEqual({ movieVersionId: 3, positionSeconds: 61, durationSeconds: 5400 });
    expect(progressFromMedia(3, 5399, 5400.4, true)).toEqual({ movieVersionId: 3, positionSeconds: 5400, durationSeconds: 5400 });
    // Live or unknown durations are not sent; nonsense positions are not saved.
    expect(progressFromMedia(3, 61, Number.POSITIVE_INFINITY)).toEqual({ movieVersionId: 3, positionSeconds: 61, durationSeconds: null });
    expect(progressFromMedia(3, 61, Number.NaN)).toEqual({ movieVersionId: 3, positionSeconds: 61, durationSeconds: null });
    expect(progressFromMedia(3, Number.NaN, 100)).toBeNull();
    expect(progressFromMedia(3, 200_000, 200_000)).toEqual({ movieVersionId: 3, positionSeconds: 86_400, durationSeconds: 86_400 });
  });

  it("saves periodically only after a real move", () => {
    expect(shouldSaveProgress(null, 0)).toBe(true);
    expect(shouldSaveProgress(100, 104)).toBe(false);
    expect(shouldSaveProgress(100, 105)).toBe(true);
    expect(shouldSaveProgress(100, 20)).toBe(true);
  });
});

describe("browser transport", () => {
  it("reads progress for at most 20 distinct versions, and makes no request for none", async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [entry(1, 400, "2026-11-17T10:00:00Z")] }));
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    const result = await fetchVersionProgress([...ids, 1], fetchImpl);
    expect(result).toEqual({ ok: true, progress: [entry(1, 400, "2026-11-17T10:00:00Z")] });
    expect(fetchImpl).toHaveBeenCalledWith(`${PROGRESS_ENDPOINT}?versions=${ids.slice(0, 20).join(",")}`, expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
    const none = vi.fn();
    expect(await fetchVersionProgress([], none)).toEqual({ ok: true, progress: [] });
    expect(none).not.toHaveBeenCalled();
  });

  it("separates 'off' (stop asking) from transient failures", async () => {
    for (const status of [401, 403, 404, 503]) expect(await fetchVersionProgress([1], async () => json(status, { error: "x" }))).toEqual({ ok: false, reason: "unavailable" });
    expect(await fetchVersionProgress([1], async () => json(500, { error: "failed" }))).toEqual({ ok: false, reason: "failed" });
    expect(await fetchVersionProgress([1], async () => json(429, { error: "rate_limited" }))).toEqual({ ok: false, reason: "failed" });
    expect(await fetchVersionProgress([1], async () => { throw new TypeError("offline"); })).toEqual({ ok: false, reason: "failed" });
    expect(await fetchVersionProgress([1], async () => json(200, { items: [{ movieVersionId: "1" }] }))).toEqual({ ok: false, reason: "failed" });
    expect(await fetchVersionProgress([1], async () => new Response("<html>", { status: 200 }))).toEqual({ ok: false, reason: "failed" });
  });

  it("saves as same-origin JSON, with keepalive when the page is leaving", async () => {
    const fetchImpl = vi.fn(async () => json(200, { completed: false }));
    expect(await saveVersionProgress({ movieVersionId: 1, positionSeconds: 61, durationSeconds: 5400 }, fetchImpl, true)).toBe("saved");
    expect(fetchImpl).toHaveBeenCalledWith(PROGRESS_ENDPOINT, expect.objectContaining({
      method: "POST", keepalive: true, credentials: "same-origin", body: JSON.stringify({ movieVersionId: 1, positionSeconds: 61, durationSeconds: 5400 }),
    }));
    expect(await saveVersionProgress({ movieVersionId: 1, positionSeconds: 61, durationSeconds: null }, async () => json(503, {}))).toBe("unavailable");
    expect(await saveVersionProgress({ movieVersionId: 1, positionSeconds: 61, durationSeconds: null }, async () => json(404, {}))).toBe("unavailable");
    expect(await saveVersionProgress({ movieVersionId: 1, positionSeconds: 61, durationSeconds: null }, async () => json(500, {}))).toBe("failed");
    expect(await saveVersionProgress({ movieVersionId: 1, positionSeconds: 61, durationSeconds: null }, async () => { throw new TypeError("offline"); })).toBe("failed");
  });

  it("Continue Watching shows nothing unless the response is well formed", async () => {
    const item = { title: { kind: "movie", id: 7, slug: "a-2024", title: "A", posterPath: null, releaseYear: 2024, rating: null, tmdbId: null, vjs: [] },
      movieVersionId: 3, positionSeconds: 61, durationSeconds: 5400 };
    const fetchImpl = vi.fn(async () => json(200, { items: [item] }));
    expect(await fetchContinueWatching(fetchImpl)).toEqual([item]);
    expect(fetchImpl).toHaveBeenCalledWith(CONTINUE_WATCHING_ENDPOINT, expect.objectContaining({ cache: "no-store" }));
    expect(await fetchContinueWatching(async () => json(503, { error: "progress_unavailable" }))).toBeNull();
    expect(await fetchContinueWatching(async () => json(200, { items: [{ ...item, title: { ...item.title, kind: "series" } }] }))).toBeNull();
    expect(await fetchContinueWatching(async () => { throw new TypeError("offline"); })).toBeNull();
  });
});
