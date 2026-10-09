import "server-only";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { isSafeServerRoot, toServerFileUri, type LocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { mediaAllowsUpload, type Journal, type JournalEntry, type JournalStaging } from "@/lib/uploader/journal";
import { freeBytes, remuxSpaceNeeded, runProcess, type Runner } from "@/lib/uploader/media-tools";
import { fingerprintFile, hashFile } from "@/lib/uploader/scan";

export const STAGING_RESERVE_BYTES = 2 * 1024 ** 3;
// The already locally available, reviewed E3.7B Node image. Never pulled.
export const STAGING_PROBE_IMAGE = "sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f";
export interface StagingOptions { root: string; serverRoot: string; sha256: string; signal?: AbortSignal }
export type StagingResult = { result: "staged" | "removed" } | { result: "refused"; code: string };
export interface StagingIO {
  assertInternalVolume(root: string): Promise<boolean>;
  freeBytes(root: string): Promise<number>;
  copy(source: string, partial: string, size: number, signal?: AbortSignal): Promise<void>;
  verifyMount(entry: JournalEntry, staging: JournalStaging): Promise<boolean>;
  now(): Date;
}

const unresolved = (entry: JournalEntry) => entry.state.upload === "uploading" || entry.attempts.some((a) => a.outcome === "pending" || a.outcome === "uncertain");
const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`)); };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Deterministic owned paths, never caller-supplied filenames for deletion. */
export function stagingPaths(entry: JournalEntry, root: string) {
  if (!isFingerprint(entry.fingerprint) || !isAbsolute(root) || resolve(root) === dirname(resolve(root)) || root.split(/[\\/]/).some((s) => s === "." || s === "..")) throw new Error("staging_path_unsafe");
  if (basename(entry.fileName) !== entry.fileName || !/\.mp4$/i.test(entry.fileName) || /[\\/:\p{Cc}]/u.test(entry.fileName)) throw new Error("staging_name_unsafe");
  const canonicalRoot = resolve(root);
  // Staging is outside the origin directory; a bad root can never own the origin.
  if (inside(dirname(resolve(entry.absolutePath)), canonicalRoot) || inside(canonicalRoot, resolve(entry.absolutePath))) throw new Error("staging_overlaps_origin");
  const dir = join(canonicalRoot, entry.fingerprint);
  const path = join(dir, entry.fileName);
  return { dir, path, partial: `${path}.partial` };
}

async function facts(path: string) {
  try { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink()) throw new Error("staging_not_regular"); return s; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function safeDirectory(dir: string) {
  await mkdir(dir, { recursive: true });
  if (!samePath(await realpath(dir), resolve(dir))) throw new Error("staging_symlink_directory");
}
async function validBytes(path: string, entry: JournalEntry, sha256: string) {
  const before = await facts(path);
  if (!before || before.size !== entry.sizeBytes) return false;
  if (await hashFile(path, entry.sizeBytes) !== sha256 || await fingerprintFile(path, entry.sizeBytes) !== entry.fingerprint) return false;
  const after = await facts(path);
  return after !== null && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino;
}

async function validOrigin(entry: JournalEntry, sha256: string) {
  const before = await facts(entry.absolutePath);
  return before !== null && before.mtimeMs === entry.modifiedAtMs
    && await validBytes(entry.absolutePath, entry, sha256)
    && (await facts(entry.absolutePath))?.mtimeMs === entry.modifiedAtMs;
}

/** Bounded, exclusive copy; interruption leaves an untrusted .partial, never a ready file. */
export async function copyStage(source: string, partial: string, size: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const input = await open(source, "r");
  try {
    const output = await open(partial, "wx");
    try {
      const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
      while (offset < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new Error("staging_short_read");
        let written = 0;
        while (written < bytesRead) {
          signal?.throwIfAborted();
          const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written);
          if (!bytesWritten) throw new Error("staging_short_write");
          written += bytesWritten;
        }
        offset += bytesRead;
      }
      signal?.throwIfAborted();
      await output.sync();
    } finally { await output.close(); }
  } finally { await input.close(); }
}

/** Called under the existing journal lock; no server/Telegram dependency exists here. */
export async function stageEntry(entry: JournalEntry, options: StagingOptions, journal: Journal, io: StagingIO): Promise<StagingResult> {
  if (unresolved(entry)) return { result: "refused", code: "upload_unresolved" };
  if (entry.kind !== "movie" || !mediaAllowsUpload(entry.media) || entry.sizeBytes <= 0 || entry.sizeBytes > TELEGRAM_MAX_FILE_BYTES) return { result: "refused", code: "media_not_stageable" };
  if (!/^[0-9a-f]{64}$/.test(options.sha256) || !isSafeServerRoot(options.serverRoot)) return { result: "refused", code: "staging_configuration_invalid" };
  try {
    const target = stagingPaths(entry, options.root);
    if (!await io.assertInternalVolume(options.root)) return { result: "refused", code: "internal_volume_unverified" };
    const old = entry.staging;
    if (old && old.phase !== "removed" && (!samePath(resolve(old.root), resolve(options.root)) || old.serverRoot !== options.serverRoot || old.sha256 !== options.sha256 || old.fileName !== entry.fileName)) return { result: "refused", code: "staging_configuration_changed" };
    options.signal?.throwIfAborted();
    if (!await validOrigin(entry, options.sha256)) return { result: "refused", code: "origin_integrity_mismatch" };
    await safeDirectory(resolve(options.root));
    await safeDirectory(target.dir);
    const staging: JournalStaging = { root: resolve(options.root), serverRoot: options.serverRoot, fileName: entry.fileName, sha256: options.sha256, phase: "copying", verifiedAt: null };
    // An orphan is adoptable only with a persisted copying/verified checkpoint.
    const final = await facts(target.path);
    if (final && (!old || old.phase === "removed")) return { result: "refused", code: "unrecorded_stage_exists" };
    if (!final) {
      const partial = await facts(target.partial);
      if (partial && (!old || old.phase === "removed")) return { result: "refused", code: "unrecorded_partial_exists" };
      if (!partial) {
        if (await io.freeBytes(options.root) < remuxSpaceNeeded(entry.sizeBytes) + STAGING_RESERVE_BYTES) return { result: "refused", code: "insufficient_disk_space" };
        await journal.put({ ...entry, staging, updatedAt: io.now().toISOString() });
        await io.copy(entry.absolutePath, target.partial, entry.sizeBytes, options.signal);
      }
      if (!await validBytes(target.partial, entry, options.sha256)) return { result: "refused", code: "partial_integrity_mismatch" };
      if (!await validOrigin(entry, options.sha256)) return { result: "refused", code: "origin_changed_during_staging" };
      options.signal?.throwIfAborted();
      // Atomic publication with EEXIST refusal: link never overwrites an existing target.
      await link(target.partial, target.path);
      await unlink(target.partial);
    }
    if (!await validBytes(target.path, entry, options.sha256)) return { result: "refused", code: "stage_integrity_mismatch" };
    if (!await io.verifyMount(entry, staging)) return { result: "refused", code: "staging_mount_unverified" };
    if (!await validOrigin(entry, options.sha256)) return { result: "refused", code: "origin_changed_during_staging" };
    options.signal?.throwIfAborted();
    await journal.put({ ...entry, staging: { ...staging, phase: "verified", verifiedAt: io.now().toISOString() }, updatedAt: io.now().toISOString() });
    return { result: "staged" };
  } catch (e) {
    const name = (e as Error).name;
    return { result: "refused", code: name === "AbortError" || name === "TimeoutError" ? "staging_interrupted" : "staging_io_failed" };
  }
}

/** Revalidate, never fall back to the origin when staging is damaged or unfinished. */
export async function verifyStagedEntry(entry: JournalEntry, map: LocalBotApiConfig["pathMap"], io: StagingIO): Promise<{ ok: true; absolutePath: string } | { ok: false; code: string }> {
  try {
    const s = entry.staging;
    if (!s || s.phase !== "verified" || !s.verifiedAt) return { ok: false, code: "stage_not_verified" };
    const target = stagingPaths({ ...entry, fileName: s.fileName }, s.root);
    if (!map || !samePath(resolve(map.local), s.root) || map.server !== s.serverRoot || !toServerFileUri(target.path, map)) return { ok: false, code: "stage_path_map_changed" };
    if (!samePath(await realpath(target.dir), target.dir) || !await validBytes(target.path, entry, s.sha256)) return { ok: false, code: "stage_integrity_mismatch" };
    if (!await io.verifyMount(entry, s)) return { ok: false, code: "staging_mount_unverified" };
    return { ok: true, absolutePath: target.path };
  } catch { return { ok: false, code: "stage_unreadable" }; }
}

/** Deletes only owned copy paths, retaining origin, media and every upload/recovery field. */
export async function cleanupStage(entry: JournalEntry, journal: Journal, now: Date): Promise<StagingResult> {
  if (!entry.staging || entry.staging.phase === "removed") return { result: "refused", code: "stage_not_present" };
  if (unresolved(entry) || !(entry.state.upload === "uploaded" && entry.telegram && entry.dbAcknowledgedAt)
    || entry.telegram.sourceFingerprint !== entry.fingerprint
    || entry.telegram.fileSizeBytes !== entry.sizeBytes
    || entry.telegram.botType !== entry.kind
    || entry.telegram.chatId !== entry.intendedChannelId) return { result: "refused", code: "upload_unsettled" };
  try {
    const t = stagingPaths({ ...entry, fileName: entry.staging.fileName }, entry.staging.root);
    if (!samePath(await realpath(t.dir), t.dir)) return { result: "refused", code: "staging_path_unsafe" };
    for (const path of [t.partial, t.path]) {
      if (await facts(path)) await unlink(path);
    }
    await journal.put({ ...entry, staging: { ...entry.staging, phase: "removed", verifiedAt: null }, updatedAt: now.toISOString() });
    return { result: "removed" };
  } catch { return { result: "refused", code: "staging_cleanup_failed" }; }
}

const PROBE = `const fs=require('node:fs'),crypto=require('node:crypto');
if(fs.readdirSync('/sys/class/net').some(x=>x!=='lo')||fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length!==1)process.exit(2);
const [file,size,expected]=process.argv.slice(1);const h=crypto.createHash('sha256');let bytes=0;
try{fs.openSync(file,'r+');process.exit(3);}catch(e){if(e.code!=='EROFS')process.exit(4);}
fs.createReadStream(file).on('data',b=>{bytes+=b.length;h.update(b)}).on('error',()=>process.exit(5)).on('end',()=>{const sha=h.digest('hex');if(bytes!==Number(size)||sha!==expected)process.exit(6);else console.log('verified');});`;

export async function probeStageMount(entry: JournalEntry, s: JournalStaging, run: Runner = runProcess): Promise<boolean> {
  const t = stagingPaths({ ...entry, fileName: s.fileName }, s.root);
  const name = `velora-stage-probe-${randomUUID()}`;
  const context = process.platform === "win32" ? ["--context", "desktop-linux"] : [];
  const result = await run("docker", [...context, "run", "--rm", "--name", name, "--pull", "never", "--network", "none", "--restart", "no", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "1000:1000", "--memory", "128m", "--cpus", "0.5", "--pids-limit", "32", "--no-healthcheck", "--entrypoint", "node", "--mount", `type=bind,source=${s.root},target=${s.serverRoot},readonly`, STAGING_PROBE_IMAGE, "-e", PROBE, posix.join(s.serverRoot, entry.fingerprint, basename(t.path)), String(entry.sizeBytes), s.sha256], { timeoutMs: 240_000, maxStdoutBytes: 4096 });
  if (result.timedOut || result.code === null) await run("docker", [...context, "rm", "-f", name], { timeoutMs: 10_000, maxStdoutBytes: 4096 });
  return result.code === 0 && result.stdout.trim() === "verified";
}

export function stagingIO(): StagingIO {
  return {
    async assertInternalVolume(root) {
      if (process.platform !== "win32" || !/^[A-Za-z]:[\\/]/.test(root)) return false;
      const drive = root[0].toUpperCase();
      const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$d=Get-Partition -DriveLetter '${drive}' -ErrorAction Stop | Get-Disk -ErrorAction Stop; if($d.BusType -in @('SATA','NVMe','ATA') -and $d.OperationalStatus -contains 'Online' -and -not $d.IsOffline){'internal'}`], { timeoutMs: 20_000, maxStdoutBytes: 4096 });
      return r.code === 0 && r.stdout.trim() === "internal";
    },
    freeBytes, copy: copyStage, verifyMount: probeStageMount, now: () => new Date(),
  };
}
