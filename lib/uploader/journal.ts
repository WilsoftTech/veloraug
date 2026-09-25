import "server-only";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { initialState } from "@/lib/ingestion/state";
import type { CatalogueKind } from "@/types/catalogue";
import type { IngestionState, PlannedAction, SourceFingerprint, TelegramMediaRecord } from "@/types/ingestion";

/**
 * The uploader's local operational journal (C2). One JSON file per source
 * fingerprint, replaced atomically (write temp file, flush, rename), so a crash
 * leaves either the previous entry or the new one, never a torn file.
 *
 * It holds operational state: local paths, the intended channel, attempts, the
 * sendDocument result and whether Supabase acknowledged it. It holds no tokens
 * or keys. It is not catalogue authority: once Supabase acknowledges an upload,
 * the server record wins (see decideResume).
 *
 * It lives outside the repository by default (~/.velora-ingest/journal). The
 * only in-repo location it accepts is the Git-ignored `.velora-ingest/`.
 */

export const JOURNAL_VERSION = 1;
export const JOURNAL_DIR_ENV = "VELORA_INGEST_JOURNAL_DIR";
export const IN_REPO_JOURNAL_DIR = ".velora-ingest";

export interface UploadAttempt {
  number: number;
  startedAt: string;
  /** Highest message id the journal knew in the target channel when the attempt started. Informational. */
  channelHighWater: number;
  /**
   * The recovery floor the server fixed for this attempt (migration 10), once
   * ingest_upload_start returned it. It only corroborates the server's floor;
   * null when the start never succeeded, or for entries older than C2B.1B.
   */
  recoveryFloorMessageId: number | null;
  outcome: "pending" | "succeeded" | "failed" | "uncertain" | "confirmed" | "abandoned";
  code: string | null;
  finishedAt: string | null;
}

export interface JournalEntry {
  version: typeof JOURNAL_VERSION;
  fingerprint: SourceFingerprint;
  kind: CatalogueKind;
  /** The channel this entry was planned for. A config change blocks the upload. */
  intendedChannelId: number | null;
  fileName: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  discoveryKey: string;
  state: IngestionState;
  plan: { action: PlannedAction; stopReasons: string[] } | null;
  attempts: UploadAttempt[];
  /** The validated sendDocument (or reconciliation) result, once known. */
  telegram: TelegramMediaRecord | null;
  dbAcknowledgedAt: string | null;
  updatedAt: string;
}

const fingerprint = z.string().refine(isFingerprint);
const record = z.object({
  botType: z.enum(["movie", "series"]),
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
  fileId: z.string().min(1),
  fileUniqueId: z.string().min(1),
  mediaKind: z.enum(["video", "document"]),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  caption: z.string().nullable(),
  fileSizeBytes: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  telegramDate: z.string(),
  sourceFingerprint: fingerprint.nullable(),
});
const entrySchema = z.object({
  version: z.literal(JOURNAL_VERSION),
  fingerprint,
  kind: z.enum(["movie", "series"]),
  intendedChannelId: z.number().int().nullable(),
  fileName: z.string().min(1),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number(),
  discoveryKey: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.object({
    review: z.enum(["discovered", "parsed", "matched", "review_pending", "approved", "rejected", "published"]),
    upload: z.enum(["not_uploaded", "uploading", "uploaded", "upload_failed"]),
    matchedBy: z.enum(["auto", "reviewer"]).nullable(),
    reasons: z.array(z.string()),
    failure: z.object({ code: z.string(), retryable: z.boolean() }).nullable(),
    uploadAttempts: z.number().int().nonnegative(),
    telegram: z.object({ chatId: z.number().int(), messageId: z.number().int() }).nullable(),
  }),
  plan: z.object({ action: z.enum(["skip", "upload", "verify_upload", "retry_upload", "upload_then_review", "hold", "reject"]), stopReasons: z.array(z.string()) }).nullable(),
  attempts: z.array(z.object({
    number: z.number().int().positive(),
    startedAt: z.string(),
    channelHighWater: z.number().int().nonnegative(),
    recoveryFloorMessageId: z.number().int().positive().nullable().default(null),
    outcome: z.enum(["pending", "succeeded", "failed", "uncertain", "confirmed", "abandoned"]),
    code: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })),
  telegram: record.nullable(),
  dbAcknowledgedAt: z.string().nullable(),
  updatedAt: z.string(),
});

/** Resolves and checks the journal directory. `projectRoot` is the repository. */
export function resolveJournalDir(configured: string | undefined, projectRoot: string): string {
  const dir = resolve(configured || join(homedir(), ".velora-ingest", "journal"));
  const inside = relative(resolve(projectRoot), dir);
  // On another drive, relative() returns an absolute path: outside the repository.
  const inRepo = inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  if (inRepo && inside.split(sep)[0] !== IN_REPO_JOURNAL_DIR) {
    throw new Error(`The journal must live outside the repository, or under the ignored ${IN_REPO_JOURNAL_DIR}/ folder.`);
  }
  return dir;
}

export function newJournalEntry(fields: Omit<JournalEntry, "version" | "state" | "plan" | "attempts" | "telegram" | "dbAcknowledgedAt" | "updatedAt">, now: Date): JournalEntry {
  return { version: JOURNAL_VERSION, ...fields, state: initialState(), plan: null, attempts: [], telegram: null, dbAcknowledgedAt: null, updatedAt: now.toISOString() };
}

export interface Journal {
  readonly dir: string;
  get(fingerprint: SourceFingerprint): Promise<JournalEntry | null>;
  put(entry: JournalEntry): Promise<void>;
  list(): Promise<JournalEntry[]>;
  /** Exclusive lock for commands that change journal or remote state. */
  lock(): Promise<() => Promise<void>>;
}

const FILE = /^(sf1-[0-9a-f]{64})\.json$/;

export async function openJournal(dir: string): Promise<Journal> {
  await mkdir(dir, { recursive: true });
  const path = (value: SourceFingerprint) => join(dir, `${value}.json`);

  async function read(file: string, expected: string): Promise<JournalEntry> {
    const parsed = entrySchema.safeParse(JSON.parse(await readFile(join(dir, file), "utf8")));
    if (!parsed.success || parsed.data.fingerprint !== expected) throw new Error(`Journal entry ${file} is invalid; inspect it before continuing.`);
    return parsed.data as JournalEntry;
  }

  return {
    dir,
    async get(value) {
      if (!isFingerprint(value)) throw new Error("Invalid fingerprint.");
      try {
        return await read(`${value}.json`, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async put(entry) {
      const parsed = entrySchema.parse(entry);
      const target = path(entry.fingerprint);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      // flush: the bytes are on disk before the rename makes them visible.
      await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flush: true });
      await rename(temp, target);
    },
    async list() {
      const names = (await readdir(dir)).filter((name) => FILE.test(name)).sort();
      return Promise.all(names.map((name) => read(name, FILE.exec(name)![1])));
    },
    async lock() {
      const lockPath = join(dir, ".lock");
      let handle;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Another uploader holds ${lockPath}. If no uploader is running, delete that file.`);
        }
        throw error;
      }
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      return () => unlink(lockPath);
    },
  };
}
