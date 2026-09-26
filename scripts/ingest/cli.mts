// Velora UG ingestion uploader CLI (Phase C2). Operator machine only; never
// part of the Next.js bundle. Run through `npm run ingest -- <command>`.
//
//   scan <root> --kind movie|series [--vjs vjs.json] [--match]
//   inspect <file> --kind movie|series [--vjs vjs.json] [--match] [--full-hash]
//   upload [--limit n | --fingerprint sf1-… [--kind movie|series]] [--execute]
//   resume [--server] [--execute]
//   checkpoint --kind movie|series --message-id <n> [--execute]
//   status
//
// Dry run is the default. `upload`/`resume --execute` need the runtime
// authorization (REAL_TELEGRAM_UPLOADS_AUTHORIZED exactly "true", set for that
// one command only; unset or any other value denies), the local Bot API
// configuration and the Supabase worker store (service-role key).
// `resume --server` reads upload status through the worker RPC; it never
// writes. It checks every journal entry, because after a lost journal only
// the server knows which uploads are unresolved. `checkpoint --execute`
// reports a message id the operator observed in the channel to the server,
// which advances the recovery checkpoint only if that is safe; it makes no
// Telegram call.
// `upload --fingerprint` selects exactly one already-scanned journal entry
// (never a path) and runs it through the same checks as any other upload.
// Tokens are never printed. Paths are shown only in this terminal.
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import * as z from "zod";
import { parseFilename } from "@/lib/ingestion/parser";
import { matchTitle } from "@/lib/ingestion/match";
import { planSource } from "@/lib/ingestion/plan";
import { titleKey } from "@/lib/ingestion/duplicates";
import { resolveVj } from "@/lib/ingestion/vj";
import { buildUploadCaption, TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { createLocalBotApiClient, loadLocalBotApiConfig, type LocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { longRunningFetch } from "@/lib/telegram/long-running-fetch";
import { isTmdbConfigured } from "@/lib/tmdb/client";
import { searchTmdbForIngestion } from "@/lib/tmdb/ingestion-search";
import { JOURNAL_DIR_ENV, newJournalEntry, openJournal, resolveJournalDir, type Journal, type JournalEntry } from "@/lib/uploader/journal";
import { fingerprintFile, hashFile, toSourceFile, walkMedia, type DiscoveredFile } from "@/lib/uploader/scan";
import { createRpcIngestionStore, offlineStore, supabaseRpcTransport, type IngestionStore } from "@/lib/uploader/store";
import { isRealTelegramUploadAuthorized, isUploadPlanned, planResume, REAL_UPLOADS_ENV, resumeEntry, selectUploadEntries, uploadEntry, verifySourceFingerprint, type UploaderDeps, type UploadSelectionError } from "@/lib/uploader/upload";
import type { CatalogueKind } from "@/types/catalogue";
import type { DuplicateSubject, KnownVj, MatchOutcome } from "@/types/ingestion";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const MIB = 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

const options = {
  kind: { type: "string" },
  vjs: { type: "string" },
  match: { type: "boolean", default: false },
  "full-hash": { type: "boolean", default: false },
  execute: { type: "boolean", default: false },
  limit: { type: "string" },
  server: { type: "boolean", default: false },
  "message-id": { type: "string" },
  // Collected as a list so a repeated option is refused, not "last one wins".
  fingerprint: { type: "string", multiple: true },
} as const;

let parsed: ReturnType<typeof parseArgs<{ allowPositionals: true; options: typeof options }>>;
try {
  parsed = parseArgs({ allowPositionals: true, options });
} catch (error) {
  // Node names the option, never its value, so no path or input is echoed.
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
const { positionals, values } = parsed;
const [command, target] = positionals;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function kindOption(): CatalogueKind {
  if (values.kind !== "movie" && values.kind !== "series") fail("--kind movie|series is required (it selects the bot and channel)");
  return values.kind;
}

const vjSchema = z.array(z.object({ id: z.number().int().positive(), slug: z.string(), name: z.string(), isActive: z.boolean(), aliases: z.array(z.string()).optional() }));

async function loadVjs(): Promise<KnownVj[]> {
  if (!values.vjs) return [];
  const parsed = vjSchema.safeParse(JSON.parse(await readFile(resolve(values.vjs), "utf8")));
  if (!parsed.success) fail("--vjs must be a JSON array of { id, slug, name, isActive, aliases? }");
  return parsed.data;
}

function telegramConfig(): LocalBotApiConfig | null {
  const loaded = loadLocalBotApiConfig(process.env);
  return loaded.ok ? loaded.config : null;
}

async function match(kind: CatalogueKind, title: string | null, year: number | null): Promise<MatchOutcome> {
  if (!values.match || title === null) return { outcome: "error", code: "match_not_requested" };
  if (!isTmdbConfigured()) return { outcome: "error", code: "tmdb_not_configured" };
  return matchTitle({ kind, title, year }, searchTmdbForIngestion);
}

/** Journal entries that already hold or are sending a file, as duplicate subjects. */
function knownSubjects(entries: JournalEntry[], vjs: KnownVj[], except: string): DuplicateSubject[] {
  return entries
    .filter((entry) => entry.fingerprint !== except && (entry.state.upload === "uploading" || entry.state.upload === "uploaded"))
    .map((entry) => {
      const parse = parseFilename(entry.fileName);
      const vj = resolveVj(parse.vjText, vjs);
      return {
        fingerprint: entry.fingerprint,
        fileName: entry.fileName,
        fileUniqueId: entry.telegram?.fileUniqueId ?? null,
        title: titleKey(entry.kind, { tmdbId: null, title: parse.title, year: parse.year }),
        vjId: vj.status === "resolved" || vj.status === "inactive" ? vj.vjId : null,
        season: parse.season,
        episode: parse.episode,
      };
    });
}

const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;
const headroom = (bytes: number) => TELEGRAM_MAX_FILE_BYTES - bytes;

async function journal(): Promise<Journal> {
  return openJournal(resolveJournalDir(process.env[JOURNAL_DIR_ENV], PROJECT_ROOT));
}

async function planFile(file: DiscoveredFile, kind: CatalogueKind, fingerprint: JournalEntry["fingerprint"], entries: JournalEntry[], vjs: KnownVj[], existing: JournalEntry | null) {
  const source = toSourceFile(file, fingerprint, kind, new Date());
  const parse = parseFilename(file.fileName);
  return planSource({
    source,
    parse,
    vjs,
    match: await match(kind, parse.title, parse.year),
    known: knownSubjects(entries, vjs, fingerprint),
    journal: existing ? existing.state : null,
  });
}

async function scan() {
  if (!target) fail("scan <library root> --kind movie|series");
  const kind = kindOption();
  const [vjs, store] = await Promise.all([loadVjs(), journal()]);
  const release = await store.lock();
  try {
    const entries = await store.list();
    const byDiscovery = new Map(entries.map((entry) => [entry.discoveryKey, entry]));
    const channelId = telegramConfig()?.bots[kind].channelId ?? null;
    const counts = new Map<string, number>();
    let largest: DiscoveredFile | null = null;

    for await (const file of walkMedia(resolve(target))) {
      if (largest === null || file.sizeBytes > largest.sizeBytes) largest = file;
      const cached = byDiscovery.get(file.discoveryKey);
      const fingerprint = cached?.fingerprint ?? (await fingerprintFile(file.absolutePath, file.sizeBytes));
      const existing = cached ?? (await store.get(fingerprint));
      if (existing && existing.kind !== kind) {
        // The kind selects the bot and channel; it never changes silently.
        console.log(`${"hold".padEnd(18)} ${mib(file.sizeBytes).padStart(12)}  ${file.relativePath}\n${" ".repeat(20)}stop: kind_changed (journaled as ${existing.kind})`);
        counts.set("hold", (counts.get("hold") ?? 0) + 1);
        continue;
      }
      const plan = await planFile(file, kind, fingerprint, entries, vjs, existing);
      const now = new Date();
      const base = existing ?? newJournalEntry({ fingerprint, kind, intendedChannelId: channelId, ...file }, now);
      // A rename or move keeps the fingerprint; the journal follows the file.
      await store.put({ ...base, fileName: file.fileName, relativePath: file.relativePath, absolutePath: file.absolutePath, modifiedAtMs: file.modifiedAtMs, discoveryKey: file.discoveryKey, intendedChannelId: base.intendedChannelId ?? channelId, plan: { action: plan.action, stopReasons: plan.stopReasons }, updatedAt: now.toISOString() });
      counts.set(plan.action, (counts.get(plan.action) ?? 0) + 1);
      const unit = plan.season !== null || plan.episode !== null ? ` S${plan.season ?? "?"}E${plan.episode ?? "?"}` : "";
      console.log(`${plan.action.padEnd(18)} ${mib(file.sizeBytes).padStart(12)}  ${plan.title ?? "?"}${plan.year ? ` (${plan.year})` : ""}${unit}  VJ:${plan.vjText ?? "?"}  ${file.relativePath}${plan.stopReasons.length ? `\n${" ".repeat(20)}stop: ${plan.stopReasons.join(", ")}` : ""}`);
    }

    console.log(`\n${[...counts].map(([action, count]) => `${action}: ${count}`).join("  ") || "no media files found"}`);
    if (largest) {
      const room = headroom(largest.sizeBytes);
      console.log(`largest: ${mib(largest.sizeBytes)} (${largest.sizeBytes} bytes), ${room >= 0 ? `${mib(room)} under` : `${mib(-room)} OVER`} the ${TELEGRAM_MAX_FILE_BYTES}-byte ceiling`);
    }
    if (channelId === null) console.log("note: Telegram configuration absent or invalid; entries have no intended channel and cannot be uploaded until rescanned.");
  } finally {
    await release();
  }
}

async function inspect() {
  if (!target) fail("inspect <file> --kind movie|series");
  const kind = kindOption();
  const path = resolve(target);
  const facts = await stat(path);
  if (!facts.isFile()) fail("not a regular file");
  const [vjs, store] = await Promise.all([loadVjs(), journal()]);
  const file: DiscoveredFile = { absolutePath: path, relativePath: basename(path), fileName: basename(path), extension: extname(path).slice(1).toLowerCase(), sizeBytes: facts.size, modifiedAtMs: facts.mtimeMs, discoveryKey: "" };
  const fingerprint = await fingerprintFile(path, facts.size);
  const plan = await planFile(file, kind, fingerprint, await store.list(), vjs, await store.get(fingerprint));
  const parse = parseFilename(file.fileName);
  console.log(JSON.stringify({
    ...plan,
    ceiling: { maxBytes: TELEGRAM_MAX_FILE_BYTES, headroomBytes: headroom(facts.size) },
    caption: buildUploadCaption({ kind, title: parse.title, year: parse.year, vjName: parse.vjText, season: parse.season, episode: parse.episode, fingerprint }),
    ...(values["full-hash"] ? { fullSha256: await hashFile(path, facts.size) } : {}),
  }, null, 2));
}

function uploaderDeps(store: Journal, config: LocalBotApiConfig, server: IngestionStore): UploaderDeps {
  return {
    journal: store,
    store: server,
    telegram: createLocalBotApiClient(config, {
      fetch,
      // sendDocument only: no 300 s header wait; UPLOAD_TIMEOUT_MS is its real, finite limit.
      mediaFetch: longRunningFetch,
      stat: async (path) => {
        const facts = await stat(path);
        return { isFile: facts.isFile(), size: facts.size };
      },
      uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    }),
    fingerprintSource: fingerprintFile,
    async channelHighWater(kind) {
      const entries = await store.list();
      return Math.max(0, ...entries.filter((entry) => entry.kind === kind && entry.telegram).map((entry) => entry.telegram!.messageId));
    },
    now: () => new Date(),
    sleep: (ms) => sleep(ms),
  };
}

function workerStore(): IngestionStore {
  const transport = supabaseRpcTransport(process.env);
  if (!transport.ok) fail(`the worker store needs:\n  ${transport.errors.join("\n  ")}`);
  return createRpcIngestionStore(transport.rpc);
}

/** Sanitized: whether real uploads are enabled for this process, never the raw value. */
const realUploadsState = () => `Real Telegram uploads: ${isRealTelegramUploadAuthorized() ? "ENABLED" : "disabled"}`;

/**
 * Gate for every command that could reach Telegram or write to Supabase. This
 * refuses early; uploadEntry and resumeEntry check the same gate again.
 */
function executionDeps(store: Journal): UploaderDeps {
  if (!isRealTelegramUploadAuthorized()) {
    fail(`real Telegram uploads are not authorized for this process (${REAL_UPLOADS_ENV} must be exactly "true", set for this command only). Nothing was sent.`);
  }
  const loaded = loadLocalBotApiConfig(process.env);
  if (!loaded.ok) fail(`--execute needs the local Bot API configuration:\n  ${loaded.errors.join("\n  ")}`);
  return uploaderDeps(store, loaded.config, workerStore());
}

const SELECTION_ERRORS: Record<UploadSelectionError, string> = {
  fingerprint_invalid: "--fingerprint must be a complete source fingerprint: sf1- followed by 64 lowercase hex characters",
  fingerprint_repeated: "--fingerprint may be given once",
  fingerprint_not_found: "no journal entry has that fingerprint; scan the library first",
  fingerprint_ambiguous: "more than one journal entry has that fingerprint; the journal needs inspection",
  fingerprint_kind_mismatch: "the selected entry is not of the --kind given",
  limit_conflicts_with_fingerprint: "--fingerprint selects one entry; --limit may only be 1 with it",
};

async function upload() {
  const store = await journal();
  const all = await store.list();
  const selection = selectUploadEntries(all, { fingerprints: values.fingerprint, limit: values.limit, kind: values.kind });
  if (!selection.ok) fail(`${selection.code}: ${SELECTION_ERRORS[selection.code]}. Nothing was sent.`);
  const candidates = selection.entries;
  const caption = (entry: JournalEntry) => {
    const parse = parseFilename(entry.fileName);
    return buildUploadCaption({ kind: entry.kind, title: parse.title, year: parse.year, vjName: parse.vjText, season: parse.season, episode: parse.episode, fingerprint: entry.fingerprint });
  };

  if (!values.execute && values.fingerprint !== undefined) {
    await describeSelected(candidates[0], all.length, caption(candidates[0]));
    return;
  }
  if (!values.execute) {
    for (const entry of candidates) console.log(`${entry.intendedChannelId === null ? "blocked (rescan with Telegram config)" : "would upload"}  ${entry.kind.padEnd(6)} ${mib(entry.sizeBytes).padStart(12)}  ${entry.relativePath}\n  caption: ${caption(entry).split("\n").join(" | ")}`);
    console.log(`\ndry run: ${candidates.length} file(s). Nothing was sent. ${realUploadsState()}.`);
    return;
  }

  const deps = executionDeps(store);
  const release = await store.lock();
  try {
    for (const entry of candidates) {
      const result = await uploadEntry(entry, caption(entry), deps);
      console.log(`${entry.relativePath}: ${JSON.stringify(result)}`);
      // An uncertain upload stops the run: the next file waits until `resume` settles it.
      if (result.result === "uncertain") break;
    }
  } finally {
    await release();
  }
}

/**
 * Dry run of a fingerprint selection. It shows what uploadEntry would be given
 * and runs the adapter's offline preflight (stat and path mapping only, with a
 * fetch that refuses). The server is not asked: at execution uploadEntry
 * checks its status before any start.
 */
async function describeSelected(entry: JournalEntry, total: number, text: string) {
  console.log(`selected     ${entry.fingerprint}  (exact match, 1 of ${total} journal entr${total === 1 ? "y" : "ies"})`);
  console.log(`kind         ${entry.kind}`);
  console.log(`file         ${entry.relativePath}  ${mib(entry.sizeBytes)} (${entry.sizeBytes} bytes)`);
  console.log(`plan         ${entry.plan?.action ?? "none"}${entry.plan?.stopReasons.length ? `  stop: ${entry.plan.stopReasons.join(", ")}` : ""}`);
  console.log(`journal      upload ${entry.state.upload}, attempts ${entry.state.uploadAttempts}, review ${entry.state.review}`);

  const reasons: string[] = [];
  if (!isUploadPlanned(entry)) reasons.push(`plan_${entry.plan?.action ?? "missing"}`);
  if (entry.state.upload === "uploading" || entry.state.upload === "uploaded") reasons.push(`journal_${entry.state.upload}`);
  if (entry.intendedChannelId === null) reasons.push("channel_not_planned");

  const config = telegramConfig();
  if (config === null) {
    console.log("destination  unknown: Telegram configuration absent or invalid");
    reasons.push("telegram_config_invalid");
  } else {
    const offline = (async () => {
      throw new Error("dry run: no network");
    }) as unknown as typeof fetch;
    const client = createLocalBotApiClient(config, {
      fetch: offline,
      mediaFetch: offline,
      stat: async (path) => {
        const facts = await stat(path);
        return { isFile: facts.isFile(), size: facts.size };
      },
      uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const preflight = entry.intendedChannelId === null ? null : await client.preflight({
      transport: entry.kind, kind: entry.kind, intendedChannelId: entry.intendedChannelId, absolutePath: entry.absolutePath,
      sizeBytes: entry.sizeBytes, fingerprint: entry.fingerprint, caption: text,
    });
    // Ids stay out of the output: only whether the channel is the configured one for this kind.
    const channel = entry.intendedChannelId === config.bots[entry.kind].channelId ? `the configured ${entry.kind} channel` : "NOT the configured channel";
    const transport = config.bots[entry.kind].local ? "local Bot API" : "not on the local Bot API";
    console.log(`destination  ${entry.kind} bot -> ${channel} (${transport})`);
    console.log(`preflight    ${preflight === null ? "not run" : preflight.ok ? "ok (sendDocument by local path)" : `refused: ${preflight.code}`}`);
    if (preflight !== null && !preflight.ok) reasons.push(preflight.code);
  }
  // The same check uploadEntry runs before any start: current bytes, one sf1 algorithm, exact equality.
  const source = await verifySourceFingerprint(entry, fingerprintFile);
  console.log(`source       ${source.ok ? "current bytes fingerprint to the selected value (exact match)" : `refused: ${source.code}`}`);
  if (!source.ok) reasons.push(source.code);
  console.log(`caption      ${text.split("\n").join(" | ")}`);
  console.log(`\ndry run: ${reasons.length === 0 ? "would upload this entry only" : `would not upload (${reasons.join(", ")})`}. Server status is checked at execution. Nothing was sent.`);
  console.log(realUploadsState());
}

/** Nothing to settle: a fresh or definitely failed source, or one already recorded on both sides. */
const settled = (action: { action: string }) => action.action === "upload_allowed" || action.action === "none";

async function resume() {
  const store = await journal();
  const all = await store.list();
  const locallyPending = (entry: JournalEntry) => entry.state.upload === "uploading" || (entry.telegram !== null && entry.dbAcknowledgedAt === null);
  if (!values.execute) {
    // Offline unless --server: then only the read-only status RPC is called,
    // for every entry, since the server may know of uploads the journal lost.
    const server = values.server ? workerStore() : offlineStore;
    let count = 0;
    for (const entry of values.server ? all : all.filter(locallyPending)) {
      const action = await planResume(entry, server);
      if (values.server && settled(action)) continue;
      count += 1;
      console.log(`${entry.relativePath}: ${JSON.stringify(action)}`);
    }
    console.log(`\ndry run: ${count} entr${count === 1 ? "y" : "ies"} to settle. Nothing was sent.`);
    return;
  }
  const deps = executionDeps(store);
  const release = await store.lock();
  try {
    for (const entry of all) {
      if (settled(await planResume(entry, deps.store))) continue;
      console.log(`${entry.relativePath}: ${JSON.stringify(await resumeEntry(entry, deps))}`);
    }
  } finally {
    await release();
  }
}

async function checkpoint() {
  const kind = kindOption();
  const messageId = Number(values["message-id"]);
  if (!Number.isSafeInteger(messageId) || messageId < 1) fail("--message-id must be a positive message id observed in that channel");
  const channelId = telegramConfig()?.bots[kind].channelId;
  if (channelId === undefined) fail("the Telegram configuration (channel ids) is required to name the channel");
  if (!values.execute) {
    console.log(`dry run: would report message ${messageId} observed in the ${kind} channel. Nothing was sent.`);
    return;
  }
  // The server decides: never backwards, never past an unresolved upload.
  console.log(`${kind} channel checkpoint: ${await workerStore().advanceCheckpoint(kind, channelId, messageId)}`);
}

async function status() {
  const entries = await (await journal()).list();
  console.log(realUploadsState());
  const tally = (key: (entry: JournalEntry) => string) => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
    return [...counts].map(([name, count]) => `${name}: ${count}`).join("  ") || "none";
  };
  console.log(`entries: ${entries.length}`);
  console.log(`plan:    ${tally((entry) => entry.plan?.action ?? "unplanned")}`);
  console.log(`upload:  ${tally((entry) => entry.state.upload)}`);
  console.log(`db ack:  ${tally((entry) => (entry.telegram === null ? "n/a" : entry.dbAcknowledgedAt ? "acknowledged" : "pending"))}`);
  const reasons = new Map<string, number>();
  for (const reason of entries.flatMap((entry) => entry.plan?.stopReasons ?? [])) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  console.log(`stops:   ${[...reasons].map(([name, count]) => `${name}: ${count}`).join("  ") || "none"}`);
}

const commands: Record<string, () => Promise<void>> = { scan, inspect, upload, resume, checkpoint, status };
const run = command ? commands[command] : undefined;
if (!run) fail(`usage: ingest <${Object.keys(commands).join("|")}> …`);
await run();
