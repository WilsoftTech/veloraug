import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newJournalEntry, openJournal, type Journal, type JournalEntry } from "@/lib/uploader/journal";
import { fingerprintFile, hashFile } from "@/lib/uploader/scan";
import { canonicalInspection, sourceMedia } from "@/lib/uploader/test-media";
import type { Runner } from "@/lib/uploader/media-tools";
import { cleanupStage, copyStage, probeStageMount, stageEntry, stagingPaths, verifyStagedEntry, type StagingIO, type StagingOptions } from "@/lib/uploader/staging";

let dir: string;
let entry: JournalEntry;
let journal: Journal;
let options: StagingOptions;
let io: StagingIO;
const now = new Date("2026-10-09T19:30:00Z");
const payload = Buffer.alloc(64 * 1024, 7);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "velora-staging-"));
  const origin = join(dir, "origin", "Synthetic.VJ.Test.mp4");
  await mkdir(join(dir, "origin"));
  await writeFile(origin, payload);
  const facts = await stat(origin);
  entry = { ...newJournalEntry({ fingerprint: await fingerprintFile(origin, payload.length), kind: "movie", intendedChannelId: -1001111111111, fileName: "Synthetic.VJ.Test.mp4", relativePath: "Synthetic.VJ.Test.mp4", absolutePath: origin, sizeBytes: payload.length, modifiedAtMs: facts.mtimeMs, discoveryKey: "e".repeat(64) }, now), media: sourceMedia(canonicalInspection(payload.length)), plan: { action: "upload", stopReasons: [] } };
  journal = await openJournal(join(dir, "journal"));
  await journal.put(entry);
  options = { root: join(dir, "stage"), serverRoot: "/media/staging", sha256: await hashFile(origin, payload.length) };
  io = { assertInternalVolume: vi.fn(async () => true), freeBytes: vi.fn(async () => 10 * 1024 ** 3), copy: vi.fn(copyStage), verifyMount: vi.fn(async () => true), now: () => now };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("local staging with synthetic bytes only", () => {
  it("preserves origin, identity, attempts and media; persists and revalidates verified bytes", async () => {
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "staged" });
    const saved = (await journal.get(entry.fingerprint))!;
    expect(saved).toEqual({ ...entry, staging: { root: options.root, serverRoot: options.serverRoot, fileName: entry.fileName, sha256: options.sha256, phase: "verified", verifiedAt: now.toISOString() } });
    const target = stagingPaths(saved, options.root);
    expect(await readFile(target.path)).toEqual(payload);
    expect(await readFile(entry.absolutePath)).toEqual(payload);
    expect(await verifyStagedEntry(saved, { local: options.root, server: options.serverRoot }, io)).toEqual({ ok: true, absolutePath: target.path });
    expect(await verifyStagedEntry({ ...saved, fileName: "Renamed.mp4" }, { local: options.root, server: options.serverRoot }, io)).toEqual({ ok: true, absolutePath: target.path });
    expect(await stageEntry(saved, options, journal, io)).toEqual({ result: "staged" });
    expect(io.copy).toHaveBeenCalledTimes(1);
  });

  it.each(["space", "volume", "hash", "mtime", "unresolved", "media"])("refuses %s before copying", async (reason) => {
    if (reason === "space") io.freeBytes = async () => 0;
    if (reason === "volume") io.assertInternalVolume = async () => false;
    if (reason === "hash") options.sha256 = "0".repeat(64);
    if (reason === "mtime") await utimes(entry.absolutePath, now, now);
    if (reason === "unresolved") entry.state.upload = "uploading";
    if (reason === "media") entry.media = null;
    expect((await stageEntry(entry, options, journal, io)).result).toBe("refused");
    expect(io.copy).not.toHaveBeenCalled();
  });

  it("records interruption, refuses a truncated partial and never publishes it", async () => {
    io.copy = async (_source, partial) => { await writeFile(partial, payload.subarray(0, 8)); throw new DOMException("aborted", "AbortError"); };
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "refused", code: "staging_interrupted" });
    const saved = (await journal.get(entry.fingerprint))!;
    expect(saved.staging?.phase).toBe("copying");
    expect(await stageEntry(saved, options, journal, io)).toEqual({ result: "refused", code: "partial_integrity_mismatch" });
    await expect(stat(stagingPaths(entry, options.root).path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts a complete partial after a crash only with its recorded checkpoint", async () => {
    io.copy = async (source, partial, size) => { await copyStage(source, partial, size); throw new Error("crash after flush"); };
    await stageEntry(entry, options, journal, io);
    const saved = (await journal.get(entry.fingerprint))!;
    expect(await stageEntry(saved, options, journal, io)).toEqual({ result: "staged" });
    expect((await journal.get(entry.fingerprint))?.staging?.phase).toBe("verified");
  });

  it("recovers a promoted orphan after its verified journal write fails", async () => {
    const put = journal.put;
    journal.put = async (next) => { if (next.staging?.phase === "verified") throw new Error("checkpoint failure"); await put(next); };
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "refused", code: "staging_io_failed" });
    const saved = (await journal.get(entry.fingerprint))!;
    expect(saved.staging?.phase).toBe("copying");
    journal.put = put;
    expect(await stageEntry(saved, options, journal, io)).toEqual({ result: "staged" });
    expect(io.copy).toHaveBeenCalledTimes(1);
  });

  it("refuses a staging directory redirected through a junction or symlink", async () => {
    const other = join(dir, "elsewhere");
    await mkdir(other);
    await symlink(other, options.root, process.platform === "win32" ? "junction" : "dir");
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "refused", code: "staging_io_failed" });
    expect(io.copy).not.toHaveBeenCalled();
  });

  it("never overwrites or adopts an unrecorded target", async () => {
    const target = stagingPaths(entry, options.root);
    await mkdir(target.dir, { recursive: true });
    await writeFile(target.path, payload);
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "refused", code: "unrecorded_stage_exists" });
    expect(await readFile(target.path)).toEqual(payload);
    expect(io.copy).not.toHaveBeenCalled();
  });

  it("refuses a changed origin after copy, leaving only a partial", async () => {
    io.copy = async (source, partial, size) => { await copyStage(source, partial, size); await utimes(source, now, now); };
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "refused", code: "origin_changed_during_staging" });
    await expect(stat(stagingPaths(entry, options.root).path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the isolated mount check, then rechecks tampering and mapping without falling back", async () => {
    io.verifyMount = async () => false;
    expect(await stageEntry(entry, options, journal, io)).toEqual({ result: "refused", code: "staging_mount_unverified" });
    let saved = (await journal.get(entry.fingerprint))!;
    expect(await verifyStagedEntry(saved, { local: options.root, server: options.serverRoot }, io)).toEqual({ ok: false, code: "stage_not_verified" });
    io.verifyMount = async () => true;
    await stageEntry(saved, options, journal, io);
    saved = (await journal.get(entry.fingerprint))!;
    expect(await verifyStagedEntry(saved, { local: options.root, server: "/different" }, io)).toEqual({ ok: false, code: "stage_path_map_changed" });
    await writeFile(stagingPaths(saved, options.root).path, Buffer.alloc(payload.length, 9));
    expect(await verifyStagedEntry(saved, { local: options.root, server: options.serverRoot }, io)).toEqual({ ok: false, code: "stage_integrity_mismatch" });
  });

  it("refuses overlapping roots, path traversal and changed staging configuration", async () => {
    expect(() => stagingPaths(entry, join(dir, "origin", "stage"))).toThrow("staging_overlaps_origin");
    expect(() => stagingPaths({ ...entry, fileName: "../bad.mp4" }, options.root)).toThrow("staging_name_unsafe");
    await stageEntry(entry, options, journal, io);
    const saved = (await journal.get(entry.fingerprint))!;
    expect(await stageEntry(saved, { ...options, serverRoot: "/elsewhere" }, journal, io)).toEqual({ result: "refused", code: "staging_configuration_changed" });
  });

  it("requires acknowledgement before cleanup and deletes only the owned copy", async () => {
    await stageEntry(entry, options, journal, io);
    const saved = (await journal.get(entry.fingerprint))!;
    expect(await cleanupStage(saved, journal, now)).toEqual({ result: "refused", code: "upload_unsettled" });
    const telegram = { botType: "movie" as const, chatId: -1001111111111, messageId: 2, fileId: "fake", fileUniqueId: "fake-unique", mediaKind: "document" as const, fileName: entry.fileName, mimeType: "video/mp4", caption: null, fileSizeBytes: payload.length, durationSeconds: null, width: null, height: null, telegramDate: now.toISOString(), sourceFingerprint: entry.fingerprint };
    const uploaded = { ...saved, state: { ...saved.state, upload: "uploaded" as const }, telegram, dbAcknowledgedAt: now.toISOString() };
    expect(await cleanupStage(uploaded, journal, now)).toEqual({ result: "removed" });
    expect(await readFile(entry.absolutePath)).toEqual(payload);
    expect((await journal.get(entry.fingerprint))?.staging?.phase).toBe("removed");
  });

  it("uses an isolated, read-only, never-pulled probe and removes a timed-out container", async () => {
    const run = vi.fn<Runner>(async () => ({ code: null, stdout: "", stderrTail: "", timedOut: true }));
    expect(await probeStageMount(entry, { ...options, fileName: entry.fileName, phase: "verified", verifiedAt: now.toISOString() }, run)).toBe(false);
    const args = run.mock.calls[0][1] as unknown as string[];
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--pull", "never", "--read-only", "ALL", "no-new-privileges:true"]));
    expect(args.join(" ")).not.toMatch(/token|socket|state-volume/);
    expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining(["rm", "-f"]));
  });
});
