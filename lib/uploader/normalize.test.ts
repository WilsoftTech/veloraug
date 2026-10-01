import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_POLICY_VERSION, type PacketDigest } from "@/lib/ingestion/media";
import { newJournalEntry, openJournal, type Journal, type JournalEntry } from "@/lib/uploader/journal";
import { cleanupRendition, normalizeEntry, renditionTarget, type NormalizeDeps } from "@/lib/uploader/normalize";
import { canonicalInspection, COVER_ART, H264_HIGH_1080P, matroskaInspection, MP3_STEREO, sourceMedia } from "@/lib/uploader/test-media";
import type { SourceFingerprint } from "@/types/ingestion";

/**
 * normalizeEntry and cleanupRendition with a real journal and fake tools
 * (E3.5). Real FFmpeg runs in media-ffmpeg.test.ts; here every failure can be
 * forced. Nothing here can reach Telegram or a database: neither is a dependency.
 */

const SRC = `sf1-${"1".repeat(64)}` as SourceFingerprint;
const OUT = `sf1-${"2".repeat(64)}` as SourceFingerprint;
const SOURCE_PATH = "G:\\Movies\\On The Hunt.VJ ICE P.2026.mkv";
const SOURCE_SIZE = 1_004_462_878;
const OUT_SIZE = 1_007_441_962;
const ROOT = "G:\\Movies\\.velora-renditions";
const T0 = new Date("2026-10-01T12:00:00Z");
const DIGEST: PacketDigest = { video: { packets: 124_997, bytes: 990_000_000, sha256: "a".repeat(64) }, audio: { packets: 199_380, bytes: 83_000_000, sha256: "b".repeat(64) } };

let dir: string;
let journal: Journal;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "velora-normalize-"));
  journal = await openJournal(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function source(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const fresh = newJournalEntry({ fingerprint: SRC, kind: "movie", intendedChannelId: -1001111111111, fileName: "On The Hunt.VJ ICE P.2026.mkv", relativePath: "On The Hunt.VJ ICE P.2026.mkv", absolutePath: SOURCE_PATH, sizeBytes: SOURCE_SIZE, modifiedAtMs: 1_000, discoveryKey: "e".repeat(64) }, T0);
  return { ...fresh, plan: { action: "normalize", stopReasons: ["media_remux_required"] }, media: sourceMedia(matroskaInspection(SOURCE_SIZE)), ...overrides };
}

/** A small fake file system plus fake tools. `files` maps a path to its size, mtime and sf1. */
function world() {
  const target = renditionTarget(source(), ROOT)!;
  const files = new Map<string, { sizeBytes: number; modifiedAtMs: number; fingerprint: SourceFingerprint }>([[SOURCE_PATH, { sizeBytes: SOURCE_SIZE, modifiedAtMs: 1_000, fingerprint: SRC }]]);
  const calls: string[] = [];
  const deps: NormalizeDeps = {
    journal,
    tools: { ffprobe: { path: "ffprobe", version: "9.0.2-test", source: "env" }, ffmpeg: { path: "ffmpeg", version: "9.0.2-test", source: "env" } },
    renditionsRoot: ROOT,
    probe: vi.fn(async (path: string) => {
      calls.push(`probe ${path === target.partialPath ? "partial" : path}`);
      return { ok: true as const, inspection: canonicalInspection(OUT_SIZE, { durationSeconds: 5208.29 }) };
    }),
    digest: vi.fn(async (path: string) => {
      calls.push(`digest ${path === SOURCE_PATH ? "source" : "partial"}`);
      return structuredClone(DIGEST);
    }),
    remux: vi.fn(async (from: string, to: string) => {
      calls.push("remux");
      expect(from).toBe(SOURCE_PATH);
      expect(to).toBe(target.partialPath);
      files.set(to, { sizeBytes: OUT_SIZE, modifiedAtMs: 2_000, fingerprint: OUT });
      return { ok: true as const };
    }),
    freeBytes: vi.fn(async () => 100 * 1024 ** 3),
    fingerprint: vi.fn(async (path: string) => {
      const file = files.get(path);
      if (!file) throw new Error("ENOENT");
      return file.fingerprint;
    }),
    fileFacts: vi.fn(async (path: string) => {
      const file = files.get(path);
      return file ? { sizeBytes: file.sizeBytes, modifiedAtMs: file.modifiedAtMs } : null;
    }),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async (from: string, to: string) => {
      calls.push("rename");
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    remove: vi.fn(async (path: string) => {
      calls.push(`remove ${path === target.partialPath ? "partial" : path === target.path ? "rendition" : path}`);
      files.delete(path);
    }),
    plan: vi.fn(async (entry: JournalEntry) => (entry.media?.role === "rendition" ? { action: "upload_then_review" as const, stopReasons: ["match_match_not_requested"] } : { action: "normalize" as const, stopReasons: ["media_rendition_recorded"] })),
    now: () => T0,
  };
  return { deps, files, calls, target };
}

describe("renditionTarget", () => {
  it("keeps the source's name (title, year, VJ survive for evaluation) in a fingerprint-named directory", () => {
    const target = renditionTarget(source(), ROOT)!;
    expect(target.dir).toBe(join(ROOT, SRC.slice(0, 20)));
    expect(target.fileName).toBe("On The Hunt.VJ ICE P.2026.mp4");
    expect(target.partialPath).toBe(`${target.path}.partial`);
  });

  it("handles difficult names as plain names, and refuses ones that could leave the directory", () => {
    const odd = "Tom Clancy's [Jack_Ryan] (Ghost war) — Ünïcode & spaces.VJ ICE P.mkv";
    expect(renditionTarget({ fingerprint: SRC, fileName: odd }, ROOT)?.fileName).toBe("Tom Clancy's [Jack_Ryan] (Ghost war) — Ünïcode & spaces.VJ ICE P.mp4");
    for (const bad of ["..", ".", "..\\..\\evil.mkv", "../evil.mkv", "sub/evil.mkv", "sub\\evil.mkv"]) {
      expect(renditionTarget({ fingerprint: SRC, fileName: bad }, ROOT), bad).toBeNull();
    }
  });
});

describe("normalizeEntry (Class 2)", () => {
  it("repackages, verifies and journals the rendition as its own entry; the source only gets a link", async () => {
    const { deps, calls, files, target } = world();
    await journal.put(source());
    const result = await normalizeEntry(source(), deps);
    expect(result).toMatchObject({ result: "normalized", verification: { passed: true } });
    expect(calls).toEqual(["remove partial", "remux", "probe partial", "digest source", "digest partial", "rename"]);
    expect(files.has(target.path)).toBe(true);
    expect(files.has(target.partialPath)).toBe(false);

    const rendition = (await journal.get(OUT))!;
    expect(rendition).toMatchObject({
      fingerprint: OUT, kind: "movie", fileName: "On The Hunt.VJ ICE P.2026.mp4", absolutePath: target.path, sizeBytes: OUT_SIZE,
      relativePath: `.velora-renditions/${SRC.slice(0, 20)}/On The Hunt.VJ ICE P.2026.mp4`,
      state: { upload: "not_uploaded", review: "discovered" }, attempts: [], plan: { action: "upload_then_review" },
      media: { role: "rendition", classification: { class: "canonical", reasons: [], policyVersion: MEDIA_POLICY_VERSION }, derivedFrom: { fingerprint: SRC, sizeBytes: SOURCE_SIZE, verification: { passed: true } } },
    });
    const linked = (await journal.get(SRC))!;
    expect(linked.media?.rendition).toEqual({ fingerprint: OUT, absolutePath: target.path, sizeBytes: OUT_SIZE, createdAt: T0.toISOString(), removedAt: null });
    expect(linked.state).toEqual(source().state);
    expect(linked.plan).toEqual({ action: "normalize", stopReasons: ["media_rendition_recorded"] });
  });

  it("is idempotent: a second run on the unchanged source makes no new derivative", async () => {
    const { deps } = world();
    await normalizeEntry(source(), deps);
    const again = await normalizeEntry((await journal.get(SRC))!, deps);
    expect(again).toMatchObject({ result: "already_normalized", reason: "rendition_intact" });
    expect(deps.remux).toHaveBeenCalledTimes(1);
  });

  it("never re-creates a rendition with upload history, even uncertain, and even if its file is gone", async () => {
    const { deps, files, target } = world();
    await normalizeEntry(source(), deps);
    const rendition = (await journal.get(OUT))!;
    await journal.put({ ...rendition, state: { ...rendition.state, upload: "uploading", uploadAttempts: 1 }, attempts: [{ number: 1, startedAt: T0.toISOString(), channelHighWater: 26, recoveryFloorMessageId: 26, outcome: "uncertain", code: "network_error", finishedAt: null }] });
    files.delete(target.path);
    expect(await normalizeEntry((await journal.get(SRC))!, deps)).toMatchObject({ result: "already_normalized", reason: "rendition_has_upload_history" });
    expect(deps.remux).toHaveBeenCalledTimes(1);
  });

  it("re-creates a rendition that was never uploaded and whose file is missing", async () => {
    const { deps, files, target } = world();
    await normalizeEntry(source(), deps);
    files.delete(target.path);
    expect(await normalizeEntry((await journal.get(SRC))!, deps)).toMatchObject({ result: "normalized" });
    expect(deps.remux).toHaveBeenCalledTimes(2);
  });

  it("refuses every class but remux, uninspected media, an older policy and a source with upload history", async () => {
    const { deps } = world();
    const remuxMedia = sourceMedia(matroskaInspection(SOURCE_SIZE));
    const cases: Array<[Partial<JournalEntry>, string]> = [
      [{ media: null }, "media_not_inspected"],
      [{ media: { ...remuxMedia, inspection: null } }, "media_not_inspected"],
      [{ media: sourceMedia(canonicalInspection(SOURCE_SIZE)) }, "media_canonical"],
      [{ media: { ...remuxMedia, classification: { class: "audio_normalization", reasons: ["audio_codec_ac3"], policyVersion: MEDIA_POLICY_VERSION } } }, "media_audio_normalization"],
      [{ media: { ...remuxMedia, classification: { class: "video_transcode_required", reasons: ["video_codec_hevc"], policyVersion: MEDIA_POLICY_VERSION } } }, "media_video_transcode_required"],
      [{ media: { ...remuxMedia, classification: { class: "manual_review", reasons: ["multiple_audio_streams"], policyVersion: MEDIA_POLICY_VERSION } } }, "media_manual_review"],
      [{ media: { ...remuxMedia, classification: { ...remuxMedia.classification, policyVersion: 0 } } }, "media_policy_outdated"],
      [{ state: { ...source().state, upload: "uploaded" } }, "source_has_upload_history"],
      [{ fileName: ".." }, "rendition_name_unsafe"],
    ];
    for (const [overrides, code] of cases) expect(await normalizeEntry(source(overrides), deps), code).toMatchObject({ result: "refused", code });
    expect(deps.remux).not.toHaveBeenCalled();
  });

  it("E3.6: maps the film and audio by their index, whatever the order, and leaves verified cover art out", async () => {
    const { deps } = world();
    // As in the library MP4s, but with the cover first: 0 cover, 1 film, 2 audio; not fast-start.
    const inspection = canonicalInspection(SOURCE_SIZE, { streams: [{ ...COVER_ART, index: 0 }, { ...H264_HIGH_1080P, index: 1 }, { ...MP3_STEREO, index: 2 }], layout: { boxes: ["ftyp", "free", "mdat", "moov"], fastStart: false, fragmented: false, complete: true } });
    const withCover = source({ media: sourceMedia(inspection) });
    expect(withCover.media?.classification).toMatchObject({ class: "remux", reasons: ["mp4_not_fast_start", "attached_picture"] });
    await journal.put(withCover);
    expect(await normalizeEntry(withCover, deps)).toMatchObject({ result: "normalized", verification: { passed: true } });
    expect(deps.remux).toHaveBeenCalledWith(SOURCE_PATH, expect.any(String), { video: 1, audio: 2, artwork: [0] });
    // Each file's digest follows its own selection: the source's film is stream 1, the rendition's stream 0.
    expect(deps.digest).toHaveBeenNthCalledWith(1, SOURCE_PATH, { video: 1, audio: 2, artwork: [0] });
    expect(deps.digest).toHaveBeenNthCalledWith(2, expect.stringMatching(/\.partial$/), { video: 0, audio: 1, artwork: [] });
  });

  it("E3.6: a source whose film cannot be selected is refused even if a stale record calls it remux", async () => {
    const { deps } = world();
    const ambiguous = canonicalInspection(SOURCE_SIZE, { streams: [H264_HIGH_1080P, { ...H264_HIGH_1080P, index: 1 }, { ...MP3_STEREO, index: 2 }] });
    const media = { ...sourceMedia(ambiguous), classification: { class: "remux" as const, reasons: ["container_matroska"], policyVersion: MEDIA_POLICY_VERSION } };
    expect(await normalizeEntry(source({ media }), deps)).toMatchObject({ result: "refused", code: "stream_selection_ambiguous" });
    expect(deps.remux).not.toHaveBeenCalled();
  });

  it("E3.6: an output whose streams cannot be selected is discarded before any digest", async () => {
    await failsWith((w) => vi.mocked(w.deps.probe).mockResolvedValueOnce({ ok: true, inspection: canonicalInspection(OUT_SIZE, { streams: [H264_HIGH_1080P, { ...H264_HIGH_1080P, index: 1 }, { ...MP3_STEREO, index: 2 }] }) }), "output_streams_unselectable");
  });

  it("E3.6: a never-uploaded rendition made under an older policy is regenerated and re-verified, not reused", async () => {
    const { deps } = world();
    await normalizeEntry(source(), deps);
    const rendition = (await journal.get(OUT))!;
    await journal.put({ ...rendition, media: { ...rendition.media!, classification: { ...rendition.media!.classification, policyVersion: MEDIA_POLICY_VERSION - 1 } } });
    expect(await normalizeEntry((await journal.get(SRC))!, deps)).toMatchObject({ result: "normalized" });
    expect(deps.remux).toHaveBeenCalledTimes(2);
    expect((await journal.get(OUT))!.media?.classification.policyVersion).toBe(MEDIA_POLICY_VERSION);
  });

  it("refuses before writing anything when the source bytes changed since the scan, or there is not enough space", async () => {
    const { deps, files } = world();
    files.set(SOURCE_PATH, { sizeBytes: SOURCE_SIZE, modifiedAtMs: 1_000, fingerprint: `sf1-${"9".repeat(64)}` as SourceFingerprint });
    expect(await normalizeEntry(source(), deps)).toMatchObject({ result: "refused", code: "source_fingerprint_changed" });
    files.set(SOURCE_PATH, { sizeBytes: SOURCE_SIZE, modifiedAtMs: 1_000, fingerprint: SRC });
    vi.mocked(deps.freeBytes).mockResolvedValueOnce(SOURCE_SIZE);
    expect(await normalizeEntry(source(), deps)).toMatchObject({ result: "refused", code: "insufficient_disk_space" });
    expect(deps.remux).not.toHaveBeenCalled();
  });

  async function failsWith(setup: (w: ReturnType<typeof world>) => void, code: string, details?: string[]) {
    const w = world();
    await journal.put(source());
    setup(w);
    const result = await normalizeEntry(source(), w.deps);
    expect(result).toMatchObject({ result: "failed", code, ...(details ? { details } : {}) });
    // Nothing usable is left behind or recorded.
    expect(w.files.has(w.target.partialPath)).toBe(false);
    expect(w.files.has(w.target.path)).toBe(false);
    expect(await journal.get(OUT)).toBeNull();
    const saved = (await journal.get(SRC))!;
    expect(saved.media?.rendition).toBeNull();
    expect(saved.media?.normalizationFailure).toMatchObject({ code, at: T0.toISOString() });
    return w;
  }

  it("an FFmpeg failure leaves no derivative and records why", async () => {
    await failsWith((w) => vi.mocked(w.deps.remux).mockImplementationOnce(async (_from, to) => {
      w.files.set(to, { sizeBytes: 5, modifiedAtMs: 2, fingerprint: OUT });
      return { ok: false, code: "ffmpeg_failed", detail: "Invalid data found when processing input" };
    }), "ffmpeg_failed", ["Invalid data found when processing input"]);
  });

  it("an output that cannot be probed, or is not canonical, fails verification", async () => {
    await failsWith((w) => vi.mocked(w.deps.probe).mockResolvedValueOnce({ ok: false, code: "probe_failed" }), "output_probe_failed");
    await failsWith((w) => vi.mocked(w.deps.probe).mockResolvedValueOnce({ ok: true, inspection: canonicalInspection(OUT_SIZE, { layout: { boxes: ["ftyp", "mdat", "moov"], fastStart: false, fragmented: false, complete: true } }) }), "verification_failed", ["output_not_canonical:mp4_not_fast_start"]);
  });

  it("any packet difference (a re-encode) fails verification and nothing is uploaded later", async () => {
    await failsWith((w) => vi.mocked(w.deps.digest).mockImplementation(async (path) => (path === SOURCE_PATH ? structuredClone(DIGEST) : { ...structuredClone(DIGEST), video: { ...DIGEST.video, sha256: "f".repeat(64) } })), "verification_failed", ["video_packets_changed"]);
    await failsWith((w) => vi.mocked(w.deps.digest).mockResolvedValueOnce(null), "packet_digest_failed");
  });

  it("a source that changes during normalization fails it (the source is never written)", async () => {
    await failsWith((w) => vi.mocked(w.deps.digest).mockImplementation(async (path) => {
      if (path !== SOURCE_PATH) w.files.set(SOURCE_PATH, { sizeBytes: SOURCE_SIZE, modifiedAtMs: 5_000, fingerprint: SRC });
      return structuredClone(DIGEST);
    }), "source_changed_during_normalization");
  });

  it("a rendition over the Telegram ceiling is refused", async () => {
    await failsWith((w) => vi.mocked(w.deps.probe).mockResolvedValueOnce({ ok: true, inspection: canonicalInspection(2_100 * 1024 * 1024) }), "rendition_too_large");
  });

  it("bytes that were already uploaded under another link are adopted, never journaled as new", async () => {
    const { deps } = world();
    const uploaded = { ...newJournalEntry({ fingerprint: OUT, kind: "movie", intendedChannelId: -1001111111111, fileName: "x.mp4", relativePath: "x.mp4", absolutePath: "G:\\x.mp4", sizeBytes: OUT_SIZE, modifiedAtMs: 1, discoveryKey: "f".repeat(64) }, T0), state: { ...source().state, upload: "uploaded" as const, uploadAttempts: 1 } };
    await journal.put(uploaded);
    expect(await normalizeEntry(source(), deps)).toMatchObject({ result: "already_normalized", reason: "rendition_has_upload_history" });
    expect((await journal.get(OUT))!.state.upload).toBe("uploaded");
    expect((await journal.get(SRC))!.media?.rendition?.fingerprint).toBe(OUT);
  });
});

describe("cleanupRendition", () => {
  async function normalized() {
    const w = world();
    await journal.put(source());
    await normalizeEntry(source(), w.deps);
    return { ...w, rendition: (await journal.get(OUT))! };
  }

  it("removes a never-uploaded rendition, and the journal stops offering it for upload", async () => {
    const { deps, files, target, rendition } = await normalized();
    expect(await cleanupRendition(rendition, deps)).toEqual({ result: "removed", reason: "never_uploaded" });
    expect(files.has(target.path)).toBe(false);
    expect((await journal.get(OUT))!.plan).toEqual({ action: "hold", stopReasons: ["rendition_removed"] });
    expect((await journal.get(SRC))!.media?.rendition?.removedAt).toBe(T0.toISOString());
  });

  it("removes an uploaded rendition only once the server acknowledged it", async () => {
    const { deps, files, target, rendition } = await normalized();
    const uploaded = { ...rendition, state: { ...rendition.state, upload: "uploaded" as const, uploadAttempts: 1 }, attempts: [{ number: 1, startedAt: T0.toISOString(), channelHighWater: 26, recoveryFloorMessageId: 26, outcome: "succeeded" as const, code: null, finishedAt: T0.toISOString() }] };
    expect(await cleanupRendition({ ...uploaded, dbAcknowledgedAt: null }, deps)).toEqual({ result: "refused", code: "rendition_upload_unsettled" });
    expect(files.has(target.path)).toBe(true);
    expect(await cleanupRendition({ ...uploaded, dbAcknowledgedAt: T0.toISOString() }, deps)).toEqual({ result: "removed", reason: "uploaded" });
  });

  it("never removes a rendition while its upload is uncertain or failed with attempts", async () => {
    const { deps, files, target, rendition } = await normalized();
    const attempt = { number: 1, startedAt: T0.toISOString(), channelHighWater: 26, recoveryFloorMessageId: 26, outcome: "uncertain" as const, code: "network_error", finishedAt: null };
    expect(await cleanupRendition({ ...rendition, state: { ...rendition.state, upload: "uploading", uploadAttempts: 1 }, attempts: [attempt] }, deps)).toEqual({ result: "refused", code: "rendition_upload_unsettled" });
    expect(await cleanupRendition({ ...rendition, state: { ...rendition.state, upload: "upload_failed", uploadAttempts: 1 }, attempts: [{ ...attempt, outcome: "failed" }] }, deps)).toEqual({ result: "refused", code: "rendition_upload_unsettled" });
    expect(await cleanupRendition(source(), deps)).toEqual({ result: "refused", code: "not_a_rendition" });
    expect(files.has(target.path)).toBe(true);
    expect(files.has(SOURCE_PATH)).toBe(true);
  });
});
