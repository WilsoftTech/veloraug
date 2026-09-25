// Velora UG ingestion uploader CLI (Phase C2). Operator machine only; never
// part of the Next.js bundle. Run through `npm run ingest -- <command>`.
//
//   scan <root> --kind movie|series [--vjs vjs.json] [--match]
//   inspect <file> --kind movie|series [--vjs vjs.json] [--match] [--full-hash]
//   upload [--limit n] [--execute]
//   resume [--execute]
//   status
//
// Dry run is the default. `--execute` additionally needs the local Bot API
// configuration AND the Supabase worker boundary; in C2A that boundary is not
// deployed, so nothing can be uploaded or reconciled from here yet.
// Tokens are never printed. Paths are shown only in this terminal.
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { parseFilename } from "@/lib/ingestion/parser";
import { matchTitle } from "@/lib/ingestion/match";
import { planSource } from "@/lib/ingestion/plan";
import { titleKey } from "@/lib/ingestion/duplicates";
import { resolveVj } from "@/lib/ingestion/vj";
import { buildUploadCaption, TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { createLocalBotApiClient, loadLocalBotApiConfig, type LocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { isTmdbConfigured } from "@/lib/tmdb/client";
import { searchTmdbForIngestion } from "@/lib/tmdb/ingestion-search";
import { JOURNAL_DIR_ENV, newJournalEntry, openJournal, resolveJournalDir, type Journal, type JournalEntry } from "@/lib/uploader/journal";
import { fingerprintFile, hashFile, toSourceFile, walkMedia, type DiscoveredFile } from "@/lib/uploader/scan";
import { unavailableStore } from "@/lib/uploader/store";
import { planResume, resumeEntry, uploadEntry, type UploaderDeps } from "@/lib/uploader/upload";
import type { CatalogueKind } from "@/types/catalogue";
import type { DuplicateSubject, KnownVj, MatchOutcome } from "@/types/ingestion";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const MIB = 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: "string" },
    vjs: { type: "string" },
    match: { type: "boolean", default: false },
    "full-hash": { type: "boolean", default: false },
    execute: { type: "boolean", default: false },
    limit: { type: "string" },
  },
});
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
        console.log(`${"hold".padEnd(18)} ${mib(file.sizeBytes).padStart(12)}  ${file.relativePath}
${" ".repeat(20)}stop: kind_changed (journaled as ${existing.kind})`);
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

function uploaderDeps(store: Journal, config: LocalBotApiConfig): UploaderDeps {
  return {
    journal: store,
    store: unavailableStore,
    telegram: createLocalBotApiClient(config, {
      fetch,
      stat: async (path) => {
        const facts = await stat(path);
        return { isFile: facts.isFile(), size: facts.size };
      },
      uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    }),
    async channelHighWater(kind) {
      const entries = await store.list();
      return Math.max(0, ...entries.filter((entry) => entry.kind === kind && entry.telegram).map((entry) => entry.telegram!.messageId));
    },
    now: () => new Date(),
  };
}

/** Gate for every command that could reach Telegram or write to Supabase. */
function executionConfig(): LocalBotApiConfig {
  const loaded = loadLocalBotApiConfig(process.env);
  if (!loaded.ok) fail(`--execute needs the local Bot API configuration:\n  ${loaded.errors.join("\n  ")}`);
  if (!unavailableStore.available) fail("--execute needs the Supabase ingestion write boundary (migration 9), which is not deployed. Nothing was sent.");
  return loaded.config;
}

async function upload() {
  const store = await journal();
  const limit = values.limit ? Number.parseInt(values.limit, 10) : Number.POSITIVE_INFINITY;
  const candidates = (await store.list()).filter((entry) => entry.plan && ["upload", "upload_then_review", "retry_upload"].includes(entry.plan.action)).slice(0, limit);
  const caption = (entry: JournalEntry) => {
    const parse = parseFilename(entry.fileName);
    return buildUploadCaption({ kind: entry.kind, title: parse.title, year: parse.year, vjName: parse.vjText, season: parse.season, episode: parse.episode, fingerprint: entry.fingerprint });
  };

  if (!values.execute) {
    for (const entry of candidates) console.log(`${entry.intendedChannelId === null ? "blocked (rescan with Telegram config)" : "would upload"}  ${entry.kind.padEnd(6)} ${mib(entry.sizeBytes).padStart(12)}  ${entry.relativePath}\n  caption: ${caption(entry).split("\n").join(" | ")}`);
    console.log(`\ndry run: ${candidates.length} file(s). Nothing was sent.`);
    return;
  }

  const deps = uploaderDeps(store, executionConfig());
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

async function resume() {
  const store = await journal();
  const entries = (await store.list()).filter((entry) => entry.state.upload === "uploading" || (entry.telegram !== null && entry.dbAcknowledgedAt === null));
  if (!values.execute) {
    for (const entry of entries) {
      console.log(`${entry.relativePath}: ${JSON.stringify(await planResume(entry, unavailableStore))}`);
    }
    console.log(`\ndry run: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to settle. Nothing was sent.`);
    return;
  }
  const deps = uploaderDeps(store, executionConfig());
  const release = await store.lock();
  try {
    for (const entry of entries) console.log(`${entry.relativePath}: ${JSON.stringify(await resumeEntry(entry, deps))}`);
  } finally {
    await release();
  }
}

async function status() {
  const entries = await (await journal()).list();
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

const commands: Record<string, () => Promise<void>> = { scan, inspect, upload, resume, status };
const run = command ? commands[command] : undefined;
if (!run) fail(`usage: ingest <${Object.keys(commands).join("|")}> …`);
await run();
