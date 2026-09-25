import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildUploadCaption } from "@/lib/ingestion/telegram";
import type { LocalBotApiClient } from "@/lib/telegram/local-bot-api";
import { newJournalEntry, openJournal, type JournalEntry } from "@/lib/uploader/journal";
import { createRpcIngestionStore, supabaseRpcTransport } from "@/lib/uploader/store";
import { resumeEntry, uploadEntry, type UploaderDeps } from "@/lib/uploader/upload";
import type { ChannelProbeResult, SourceFingerprint, TelegramMediaRecord, UploadOutcome } from "@/types/ingestion";

/**
 * C2B.1B fresh-machine recovery against the LOCAL database (never hosted;
 * see vitest.integration.config.mts): the real worker store over PostgREST,
 * the real uploader and journal code, and a fake Telegram.
 *
 * Machine A starts an upload, which ends uncertain, then loses its whole
 * journal. Machine B has never seen it: it recovers from ingest_upload_status
 * alone, scanning only above the floor the database fixed at start.
 *
 * The channel allow-list is private (owner-only), so the fixture channel is
 * written with psql inside the local database container and removed after.
 */

const PROJECT_ID = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(__dirname, "../../supabase/config.toml"), "utf8"))![1];
const MOVIES = -1004444444444;
const FP = `sf1-${"b".repeat(64)}` as SourceFingerprint;
const OTHER = `sf1-${"d".repeat(64)}` as SourceFingerprint;
const SIZE = 1000;
const CHECKPOINT = 500;
const TARGET = 512;
const MARKER = 520;

function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${PROJECT_ID}`, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input: sql, encoding: "utf8" }).trim();
}

function cleanup() {
  psql(`
    delete from private.ingestion_events where origin = 'uploader' and source_fingerprint in ('${FP}', '${OTHER}');
    delete from private.telegram_media where chat_id = ${MOVIES};
    delete from private.telegram_channels where chat_id = ${MOVIES};`);
}

const store = (() => {
  const transport = supabaseRpcTransport({ NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY });
  if (!transport.ok) throw new Error(transport.errors.join("; "));
  return createRpcIngestionStore(transport.rpc);
})();

const caption = buildUploadCaption({ kind: "movie", title: "Recovery Drill", year: 2026, vjName: "Test", season: null, episode: null, fingerprint: FP });

function record(messageId: number, fingerprint: SourceFingerprint): TelegramMediaRecord {
  return {
    botType: "movie", chatId: MOVIES, messageId, fileId: `file-${messageId}`, fileUniqueId: `uniq-c2b1b-${messageId}`, mediaKind: "document",
    fileName: "Recovery.Drill.2026.VJ.Test.mkv", mimeType: "video/x-matroska",
    caption: fingerprint === FP ? caption : `other\nvelora-src:${fingerprint}`, fileSizeBytes: SIZE, durationSeconds: null,
    width: null, height: null, telegramDate: new Date().toISOString(), sourceFingerprint: fingerprint,
  };
}

/** Fake Telegram: sendDocument times out; the channel holds the file at TARGET and another source below the floor. */
function telegram() {
  const channel: Record<number, ChannelProbeResult> = { 3: { status: "found", record: record(3, OTHER) }, [TARGET]: { status: "found", record: record(TARGET, FP) } };
  return {
    preflight: vi.fn<LocalBotApiClient["preflight"]>(async () => ({ ok: true, channelId: MOVIES })),
    sendDocument: vi.fn<LocalBotApiClient["sendDocument"]>(async (): Promise<UploadOutcome> => ({ status: "uncertain", code: "timeout" })),
    checkRecoveryAccess: vi.fn<LocalBotApiClient["checkRecoveryAccess"]>(async () => ({ status: "ok" })),
    postRecoveryMarker: vi.fn<LocalBotApiClient["postRecoveryMarker"]>(async () => ({ status: "posted", chatId: MOVIES, messageId: MARKER })),
    probeChannelMessage: vi.fn<LocalBotApiClient["probeChannelMessage"]>(async (_kind, id) => channel[id] ?? { status: "missing" }),
  };
}

function entry(): JournalEntry {
  const fresh = newJournalEntry({
    fingerprint: FP, kind: "movie", intendedChannelId: MOVIES, fileName: "Recovery.Drill.2026.VJ.Test.mkv", relativePath: "Recovery.Drill.2026.VJ.Test.mkv",
    absolutePath: "C:\\Media\\Movies\\Recovery.Drill.2026.VJ.Test.mkv", sizeBytes: SIZE, modifiedAtMs: 1, discoveryKey: "f".repeat(64),
  }, new Date());
  return { ...fresh, plan: { action: "upload", stopReasons: [] } };
}

const dirs: string[] = [];
async function machine() {
  const dir = mkdtempSync(join(tmpdir(), "velora-c2b1b-"));
  dirs.push(dir);
  return { dir, journal: await openJournal(dir) };
}

function deps(journal: UploaderDeps["journal"], api: ReturnType<typeof telegram>): UploaderDeps {
  // channelHighWater 0: the journal knows nothing; only the server floor may bound the scan.
  return { journal, store, telegram: api, telegramEnabled: true, channelHighWater: async () => 0, now: () => new Date(), sleep: async () => {} };
}

beforeAll(() => {
  cleanup();
  psql(`insert into private.telegram_channels (bot_type, chat_id) values ('movie', ${MOVIES})
        on conflict (bot_type) do update set chat_id = excluded.chat_id;`);
});
afterAll(() => {
  cleanup();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("C2B.1B: recovery from Supabase state alone (local database)", () => {
  it("refuses to start an attempt while the channel has no floor", async () => {
    await expect(store.markUploadStarted({ source: { fingerprint: FP, sizeBytes: SIZE, fileName: "x.mkv" }, kind: "movie", channelId: MOVIES }))
      .rejects.toMatchObject({ code: "ingest_recovery_floor_unknown" });
  });

  it("advances the checkpoint through the worker command", async () => {
    expect(await store.advanceCheckpoint("movie", MOVIES, CHECKPOINT)).toBe(CHECKPOINT);
    expect(await store.advanceCheckpoint("movie", MOVIES, 1)).toBe(CHECKPOINT);
  });

  it("machine A crashes uncertain and loses its journal; machine B recovers without scanning from id 1", async () => {
    const a = await machine();
    const apiA = telegram();
    await a.journal.put(entry());
    expect(await uploadEntry(entry(), caption, deps(a.journal, apiA))).toEqual({ result: "uncertain", code: "timeout" });
    expect((await a.journal.get(FP))!.attempts.at(-1)?.recoveryFloorMessageId).toBe(CHECKPOINT);

    const status = await store.getUploadStatus(FP, "movie");
    expect(status).toMatchObject({ status: "uncertain", attempt: { floorMessageId: CHECKPOINT } });
    // While it is unresolved, the checkpoint cannot move past it.
    await expect(store.advanceCheckpoint("movie", MOVIES, 9_999)).rejects.toMatchObject({ code: "ingest_recovery_unresolved" });

    rmSync(a.dir, { recursive: true, force: true });

    const b = await machine();
    const apiB = telegram();
    const rescanned = entry();
    await b.journal.put(rescanned);
    expect(rescanned.attempts).toEqual([]);
    expect(await resumeEntry(rescanned, deps(b.journal, apiB))).toEqual({ result: "uploaded", acknowledged: true });

    const probed = apiB.probeChannelMessage.mock.calls.map(([, id]) => id);
    expect(Math.min(...probed)).toBe(CHECKPOINT + 1);
    expect(Math.max(...probed)).toBe(MARKER - 1);
    expect(apiB.sendDocument).not.toHaveBeenCalled();
    expect(apiA.sendDocument).toHaveBeenCalledTimes(1);

    expect(await store.getUploadStatus(FP, "movie")).toMatchObject({ status: "uploaded", record: { messageId: TARGET, chatId: MOVIES } });
    // The resolution was recorded, so the marker became the channel checkpoint.
    expect(psql(`select checkpoint_message_id from private.telegram_channels where chat_id = ${MOVIES}`)).toBe(String(MARKER));
  });
});
