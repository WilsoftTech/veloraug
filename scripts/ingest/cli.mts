// Velora UG ingestion uploader CLI (Phase C2). Operator machine only; never
// part of the Next.js bundle. Run through `npm run ingest -- <command>`.
//
//   scan <root> --kind movie|series [--vjs vjs.json] [--match]
//   inspect <file> --kind movie|series [--vjs vjs.json] [--match] [--full-hash]
//   upload [--limit n | --fingerprint sf1-… [--kind movie|series]] [--execute]
//   resume [--server] [--execute]
//   checkpoint --kind movie|series --message-id <n> [--execute]
//   status
//   evaluate --fingerprint sf1-… --kind movie --vjs vjs.json [--year <reviewed-year>] [--execute]
//   publication-sql --fingerprint sf1-… --tmdb-id <n> --out <file.sql> [--rights-cleared]
//   normalize --fingerprint sf1-… [--vjs vjs.json] [--execute]   (E3.5, local only)
//   show --fingerprint sf1-…                                     (E3.5, read-only)
//   cleanup --fingerprint sf1-… [--execute]                      (E3.5, local only)
//   stage --fingerprint sf1-… --staging-root <dir> --staging-server-root <dir> --sha256 <digest> [--execute]
//   cleanup-staging --fingerprint sf1-… [--execute]               (local copy only)
//
// Media (E3.5): `scan` probes every file with ffprobe (VELORA_FFPROBE_PATH or
// PATH) and classifies it (lib/ingestion/media.ts); only canonical bytes are
// ever planned for upload. A Class 2 source plans `normalize`: `normalize
// --execute` repackages it by stream copy into a verified fast-start MP4
// under the renditions root (VELORA_RENDITIONS_DIR, default
// <TELEGRAM_BOT_API_PATH_MAP local root>/.velora-renditions) and journals that
// rendition as its own entry, which `upload --fingerprint` then sends like any
// other. `normalize` and `cleanup` never call Telegram or a database.
// The film's video and audio stream are chosen by meaning, not position
// (E3.6): verified cover art is left out of the rendition, and any other
// extra stream stops the file for review. `show` and `normalize` list every
// stream with its role.
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
// `evaluate` matches one UPLOADED source from the server's own Telegram record
// (no local file or journal needed) and, with --execute, records the parse and
// the scored candidates through the worker RPC; the server decides matched or
// needs_review. `publication-sql` writes the owner's approve+publish script for
// one source from its TMDB snapshot; the worker key cannot run it, and it
// touches no database itself.
// Tokens are never printed. Paths are shown only in this terminal.
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import * as z from "zod";
import { decideKind, parseFilename } from "@/lib/ingestion/parser";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { matchTitle } from "@/lib/ingestion/match";
import { planSource } from "@/lib/ingestion/plan";
import { titleKey } from "@/lib/ingestion/duplicates";
import { resolveVj } from "@/lib/ingestion/vj";
import { buildUploadCaption, TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { artworkStreams, classifyMedia, MEDIA_POLICY_VERSION, playableVideo, audioStreams, selectPlaybackStreams, unreadableMedia, type MediaInspection, type MediaStream } from "@/lib/ingestion/media";
import { createLocalBotApiClient, loadLocalBotApiConfig, toServerFileUri, type LocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { longRunningFetch } from "@/lib/telegram/long-running-fetch";
import { isTmdbConfigured } from "@/lib/tmdb/client";
import { fetchMovieSnapshot, searchTmdbForIngestion } from "@/lib/tmdb/ingestion-search";
import { publicationScript } from "@/lib/uploader/publication";
import { JOURNAL_DIR_ENV, mediaAllowsUpload, mediaVerdict, newJournalEntry, openJournal, resolveJournalDir, type Journal, type JournalEntry, type JournalMedia } from "@/lib/uploader/journal";
import { digestPackets, freeBytes, probeMedia, remux, remuxSpaceNeeded, resolveMediaTools, type MediaTools } from "@/lib/uploader/media-tools";
import { cleanupRendition, normalizeEntry, renditionTarget, type NormalizeDeps } from "@/lib/uploader/normalize";
import { fingerprintFile, hashFile, walkMedia, type DiscoveredFile } from "@/lib/uploader/scan";
import { cleanupStage, stageEntry, stagingIO, stagingPaths, verifyStagedEntry } from "@/lib/uploader/staging";
import { createRpcIngestionStore, evaluationPayload, offlineStore, supabaseRpcTransport, type EvaluationEvidence, type IngestionStore } from "@/lib/uploader/store";
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
  "tmdb-id": { type: "string" },
  out: { type: "string" },
  "rights-cleared": { type: "boolean", default: false },
  "staging-root": { type: "string" },
  "staging-server-root": { type: "string" },
  sha256: { type: "string" },
  year: { type: "string" },
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

async function planFile(file: Pick<DiscoveredFile, "fileName" | "relativePath" | "sizeBytes">, kind: CatalogueKind, fingerprint: JournalEntry["fingerprint"], entries: JournalEntry[], vjs: KnownVj[], existing: JournalEntry | null, media: JournalMedia | null) {
  const parse = parseFilename(file.fileName);
  return planSource({
    source: { fileName: file.fileName, relativePath: file.relativePath, sizeBytes: file.sizeBytes, fingerprint, declaredKind: kind },
    parse,
    vjs,
    match: await match(kind, parse.title, parse.year),
    known: knownSubjects(entries, vjs, fingerprint),
    journal: existing ? existing.state : null,
    media: mediaVerdict(media),
  });
}

/** The planner's decision for a journal entry as it stands (used after normalize and cleanup). */
async function planEntry(entry: JournalEntry, vjs: KnownVj[], store: Journal) {
  const plan = await planFile(entry, entry.kind, entry.fingerprint, await store.list(), vjs, entry, entry.media);
  return { action: plan.action, stopReasons: plan.stopReasons };
}

/** Media tools for this process, resolved once. */
let toolsCache: Promise<Awaited<ReturnType<typeof resolveMediaTools>>> | null = null;
const mediaTools = () => (toolsCache ??= resolveMediaTools(process.env));

/**
 * A source file's media record: reused from the journal when its bytes are
 * unchanged (same fingerprint) and re-classified from the stored inspection if
 * the policy changed; otherwise probed. Null when no ffprobe is available.
 */
async function sourceMedia(path: string, existing: JournalEntry | null, tools: MediaTools | null): Promise<JournalMedia | null> {
  const stored = existing?.media;
  if (stored && stored.role === "source" && stored.inspection !== null) {
    return stored.classification.policyVersion === MEDIA_POLICY_VERSION ? stored : { ...stored, classification: classifyMedia(stored.inspection) };
  }
  if (tools === null) return stored ?? null;
  const probed = await probeMedia(tools.ffprobe, path);
  return {
    role: "source",
    inspectedAt: new Date().toISOString(),
    tools: { ffprobe: tools.ffprobe.version, ffmpeg: tools.ffmpeg.version },
    inspection: probed.ok ? probed.inspection : null,
    classification: probed.ok ? classifyMedia(probed.inspection) : unreadableMedia(probed.code),
    rendition: stored?.rendition ?? null,
    derivedFrom: null,
    normalizationFailure: stored?.normalizationFailure ?? null,
  };
}

const CLASS_LABEL: Record<string, string> = { canonical: "CANONICAL", remux: "REMUX", audio_normalization: "AUDIO_NORMALIZATION", video_transcode_required: "VIDEO_TRANSCODE_REQUIRED", manual_review: "MANUAL_REVIEW" };
const mediaLabel = (media: JournalMedia | null) => (media === null ? "NOT_INSPECTED" : CLASS_LABEL[media.classification.class]);

function describeStream(s: MediaStream): string {
  if (s.type === "audio") return `${s.codec ?? "?"}${s.profile ? ` ${s.profile}` : ""} ${s.sampleRate ?? "?"} Hz ${s.channels ?? "?"} ch${s.channelLayout ? ` ${s.channelLayout}` : ""}`;
  if (s.type !== "video") return s.codec ?? "?";
  if (s.attachedPicture) return `${s.codec ?? "?"} ${s.width ?? "?"}x${s.height ?? "?"} image`;
  // ffprobe reports H.264 levels × 10 (40 = 4.0); other codecs use other scales, so only H.264 shows one.
  const level = s.level === null || s.codec !== "h264" ? "" : ` L${(s.level / 10).toFixed(1)}`;
  return `${s.codec ?? "?"} ${s.profile ?? ""}${level} ${s.width ?? "?"}x${s.height ?? "?"} ${s.frameRate ?? "?"} fps ${s.pixelFormat ?? ""}`.replace(/\s+/g, " ").trim();
}

function describeVideo(inspection: MediaInspection | null): string {
  const video = inspection ? playableVideo(inspection) : [];
  return video.length === 0 ? "none" : video.map(describeStream).join("; ");
}

function describeAudio(inspection: MediaInspection | null): string {
  const audio = inspection ? audioStreams(inspection) : [];
  return audio.length === 0 ? "none" : audio.map(describeStream).join("; ");
}

/** Every stream and what playback does with it (E3.6), so a cover-art or ambiguity decision reads without ffprobe JSON. */
function streamRoles(inspection: MediaInspection): string[] {
  const selection = selectPlaybackStreams(inspection);
  const artwork = new Set(artworkStreams(inspection).map((s) => s.index));
  return inspection.streams.map((s) => {
    const role =
      selection !== null && (s.index === selection.video || s.index === selection.audio) ? "selected"
      : artwork.has(s.index) ? "attached artwork: ignored for playback, kept in the source"
      : s.type === "video" && s.attachedPicture ? "flagged as artwork but not a still image: review"
      : selection === null && (s.type === "video" || s.type === "audio") ? "one of several candidates: review, never guessed"
      : "not carried by playback: review";
    return `stream ${s.index}  ${s.type} ${describeStream(s)}  (${role})`;
  });
}

function printStreams(inspection: MediaInspection | null) {
  if (inspection === null) return line("streams", "not inspected");
  streamRoles(inspection).forEach((text, i) => line(i === 0 ? "streams" : "", text));
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
    const resolved = await mediaTools();
    const tools = resolved.ok ? resolved.tools : null;
    if (!resolved.ok) console.log(`note: media tools unavailable (${resolved.errors.join("; ")}); files cannot be inspected and none is planned for upload.\n`);
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
      const media = await sourceMedia(file.absolutePath, existing, tools);
      const plan = await planFile(file, kind, fingerprint, entries, vjs, existing, media);
      const now = new Date();
      const base = existing ?? newJournalEntry({ fingerprint, kind, intendedChannelId: channelId, ...file }, now);
      // A rename or move keeps the fingerprint; the journal follows the file.
      await store.put({ ...base, fileName: file.fileName, relativePath: file.relativePath, absolutePath: file.absolutePath, modifiedAtMs: file.modifiedAtMs, discoveryKey: file.discoveryKey, intendedChannelId: base.intendedChannelId ?? channelId, plan: { action: plan.action, stopReasons: plan.stopReasons }, media, updatedAt: now.toISOString() });
      counts.set(plan.action, (counts.get(plan.action) ?? 0) + 1);
      const unit = plan.season !== null || plan.episode !== null ? ` S${plan.season ?? "?"}E${plan.episode ?? "?"}` : "";
      console.log(`${plan.action.padEnd(18)} ${mib(file.sizeBytes).padStart(12)}  ${mediaLabel(media).padEnd(24)} ${plan.title ?? "?"}${plan.year ? ` (${plan.year})` : ""}${unit}  VJ:${plan.vjText ?? "?"}  ${file.relativePath}${plan.stopReasons.length ? `\n${" ".repeat(20)}stop: ${plan.stopReasons.join(", ")}` : ""}${plan.action === "normalize" && media?.classification.reasons.length ? `\n${" ".repeat(20)}media: ${media.classification.reasons.join(", ")}` : ""}`);
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
  const existing = await store.get(fingerprint);
  const resolved = await mediaTools();
  const media = await sourceMedia(path, existing, resolved.ok ? resolved.tools : null);
  const plan = await planFile(file, kind, fingerprint, await store.list(), vjs, existing, media);
  const parse = parseFilename(file.fileName);
  console.log(JSON.stringify({
    ...plan,
    media: media === null ? { class: "not_inspected", tools: resolved.ok ? null : resolved.errors } : { class: media.classification.class, reasons: media.classification.reasons, video: describeVideo(media.inspection), audio: describeAudio(media.inspection), inspection: media.inspection, tools: media.tools },
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
    stagedSource: (entry) => verifyStagedEntry(entry, config.pathMap, stagingIO()),
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

  console.log(`media        ${mediaLabel(entry.media)}${entry.media?.role === "rendition" ? " rendition (stream copy verified)" : ""}`);
  const reasons: string[] = [];
  if (!isUploadPlanned(entry)) reasons.push(`plan_${entry.plan?.action ?? "missing"}`);
  if (!mediaAllowsUpload(entry.media)) reasons.push("media_not_verified");
  if (entry.state.upload === "uploading" || entry.state.upload === "uploaded") reasons.push(`journal_${entry.state.upload}`);
  if (entry.intendedChannelId === null) reasons.push("channel_not_planned");

  const config = telegramConfig();
  let absolutePath = entry.absolutePath;
  if (entry.staging && entry.staging.phase !== "removed") {
    const staged = await verifyStagedEntry(entry, config?.pathMap ?? null, {
      ...stagingIO(),
      // Dry runs verify bytes/mapping only, never launch Docker or certify a live mount.
      verifyMount: async () => true,
    });
    if (staged.ok) absolutePath = staged.absolutePath;
    else reasons.push(staged.code);
    console.log(`staging      ${staged.ok ? "bytes and path map verified; isolated mount check required at execution" : `refused: ${staged.code}`}`);
  }
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
      transport: entry.kind, kind: entry.kind, intendedChannelId: entry.intendedChannelId, absolutePath,
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
  const source = await verifySourceFingerprint({ ...entry, absolutePath }, fingerprintFile);
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
  console.log(`media:   ${tally((entry) => `${entry.media?.role === "rendition" ? "rendition " : ""}${mediaLabel(entry.media)}`)}`);
  console.log(`upload:  ${tally((entry) => entry.state.upload)}`);
  console.log(`db ack:  ${tally((entry) => (entry.telegram === null ? "n/a" : entry.dbAcknowledgedAt ? "acknowledged" : "pending"))}`);
  const reasons = new Map<string, number>();
  for (const reason of entries.flatMap((entry) => entry.plan?.stopReasons ?? [])) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  console.log(`stops:   ${[...reasons].map(([name, count]) => `${name}: ${count}`).join("  ") || "none"}`);
}

/** Exactly one canonical --fingerprint; a path or a partial value is never accepted. */
function oneFingerprint() {
  const given = values.fingerprint ?? [];
  if (given.length !== 1 || !isFingerprint(given[0])) fail("exactly one --fingerprint sf1-<64 lowercase hex> is required");
  return given[0];
}

async function evaluate() {
  if (values.year !== undefined && !/^(18|19|20|21)[0-9]{2}$/.test(values.year)) fail("--year must be a reviewed four-digit release year (1800–2199)");
  const kind = kindOption();
  if (kind !== "movie") fail("evaluate supports --kind movie only in this checkpoint");
  const fingerprint = oneFingerprint();
  const vjs = await loadVjs();
  if (vjs.length === 0) fail("--vjs is required (the VJs to resolve against)");
  if (!isTmdbConfigured()) fail("TMDB is not configured; matching needs it");
  const server = workerStore();

  // The server's own record of the upload is the source of truth: its Telegram
  // file name and caption, not a local file.
  const current = await server.getUploadStatus(fingerprint, kind);
  if (current.status !== "uploaded") fail(`the source is not uploaded (server: ${current.status}); nothing to evaluate`);
  if (current.record.sourceFingerprint !== fingerprint) fail("the recorded caption does not carry this fingerprint");
  if (current.record.fileName === null) fail("the recorded Telegram document has no file name");

  const parse = parseFilename(current.record.fileName);
  if (parse.title === null) fail("no title could be parsed from the recorded file name");
  const year = values.year === undefined ? parse.year : Number(values.year);
  // An explicit operator correction; the filename and upload identity remain untouched.
  if (values.year !== undefined) console.log(JSON.stringify({ yearReview: { fileName: current.record.fileName, filenameYear: parse.year, reviewedYear: year } }));
  const evidence: EvaluationEvidence = {
    kind: decideKind(kind, parse),
    title: parse.title,
    vjText: parse.vjText,
    vj: resolveVj(parse.vjText, vjs),
    year,
    season: parse.season,
    episode: parse.episode,
    match: await matchTitle({ kind, title: parse.title, year }, searchTmdbForIngestion),
  };
  if (evidence.match?.outcome === "error") fail(`TMDB search failed (${evidence.match.code}); nothing was recorded`);
  const payload = evaluationPayload(evidence);
  console.log(JSON.stringify({
    fingerprint,
    telegramFileName: current.record.fileName,
    parsed: payload.p_parsed,
    match: evidence.match?.outcome === "matched"
      ? { outcome: "matched", confidence: evidence.match.confidence, tmdbId: evidence.match.best.candidate.tmdbId, title: evidence.match.best.candidate.title, year: evidence.match.best.candidate.year }
      : { outcome: evidence.match?.outcome },
    candidates: payload.p_candidates,
  }, null, 2));
  if (!values.execute) {
    console.log("\ndry run: nothing was recorded. The server re-derives matched/needs_review at --execute.");
    return;
  }
  console.log(`\nrecorded: ${await server.recordEvaluation(fingerprint, kind, evidence)}`);
}

async function publicationSql() {
  const fingerprint = oneFingerprint();
  const tmdbId = Number(values["tmdb-id"]);
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) fail("--tmdb-id must be the approved TMDB movie id");
  if (!values.out) fail("--out <file.sql> is required (outside the repository, e.g. .velora-ingest/)");
  if (!isTmdbConfigured()) fail("TMDB is not configured; the snapshot needs it");
  // Checked before any request too, so a refusal never exits with a socket open.
  if (await stat(resolve(values.out)).then(() => true, () => false)) fail("--out already exists; it is never overwritten (choose a new file)");
  const snapshot = await fetchMovieSnapshot(tmdbId);
  if (snapshot === null) fail("TMDB returned no usable movie for that id");
  // "wx": never overwrite a script someone may already have reviewed.
  try {
    await writeFile(resolve(values.out), publicationScript({ fingerprint, tmdbId, snapshot, rightsCleared: values["rights-cleared"] }), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("--out already exists; it is never overwritten (choose a new file)");
    throw error;
  }
  console.log(JSON.stringify({ tmdbId, title: snapshot.title, releaseDate: snapshot.release_date, genres: snapshot.genres.map((genre) => genre.name), poster: snapshot.poster_path !== null, backdrop: snapshot.backdrop_path !== null }, null, 2));
  console.log(`\nwrote the owner script${values["rights-cleared"] ? "" : " WITHOUT the rights attestation (the database will refuse to publish)"}. Nothing was sent to any database.`);
}

// ---------------------------------------------------------------------------
// Media normalization (E3.5): local only, never Telegram or a database
// ---------------------------------------------------------------------------

const RENDITIONS_ENV = "VELORA_RENDITIONS_DIR";
const GIB = 1024 * MIB;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(2)} GiB`;

/**
 * Where renditions are written: VELORA_RENDITIONS_DIR, else `.velora-renditions`
 * under the local Bot API's path-map root (the only place it can read files
 * from). Never inside the repository.
 */
function renditionsRoot(): string {
  const configured = process.env[RENDITIONS_ENV];
  const mapped = telegramConfig()?.pathMap?.local;
  const root = configured ? resolve(configured) : mapped ? join(mapped, ".velora-renditions") : null;
  if (root === null) fail(`set ${RENDITIONS_ENV} (or the local Bot API path map) to choose where renditions are written`);
  if (!isAbsolute(root)) fail(`${RENDITIONS_ENV} must be an absolute directory`);
  const inside = relative(PROJECT_ROOT, root);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) fail("the renditions directory must be outside the repository");
  return root;
}

/** Deletes one file; one that is already gone is not an error. */
async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** The path itself or its closest existing parent: a dry run measures free space without creating anything. */
async function nearestExisting(path: string): Promise<string> {
  let current = path;
  while (!(await stat(current).then(() => true, () => false))) {
    const parent = resolve(current, "..");
    if (parent === current) throw new Error("no existing parent");
    current = parent;
  }
  return current;
}

async function fileFacts(path: string) {
  try {
    const facts = await stat(path);
    return facts.isFile() ? { sizeBytes: facts.size, modifiedAtMs: facts.mtimeMs } : null;
  } catch {
    return null;
  }
}

function normalizeDeps(store: Journal, tools: MediaTools, root: string, vjs: KnownVj[]): NormalizeDeps {
  return {
    journal: store,
    tools,
    renditionsRoot: root,
    probe: (path) => probeMedia(tools.ffprobe, path),
    digest: (path, selection) => digestPackets(tools.ffmpeg, path, selection),
    remux: (source, output, selection) => remux(tools.ffmpeg, source, output, selection),
    freeBytes,
    fingerprint: fingerprintFile,
    fileFacts,
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    rename,
    remove: removeFile,
    plan: (entry) => planEntry(entry, vjs, store),
    now: () => new Date(),
  };
}

async function entryOrFail(store: Journal, fingerprint: JournalEntry["fingerprint"]): Promise<JournalEntry> {
  const entry = await store.get(fingerprint);
  if (entry === null) fail("no journal entry has that fingerprint; scan the library first");
  return entry;
}

const line = (label: string, value: string) => console.log(`${label.padEnd(15)}${value}`);

async function normalize() {
  const fingerprint = oneFingerprint();
  const store = await journal();
  const source = await entryOrFail(store, fingerprint);
  const vjs = await loadVjs();
  const media = source.media;
  const root = renditionsRoot();
  const resolved = await mediaTools();

  line("source", `${source.relativePath}  ${mib(source.sizeBytes)} (${source.sizeBytes} bytes)`);
  line("fingerprint", source.fingerprint);
  line("media", `${mediaLabel(media)}${media?.classification.reasons.length ? `  (${media.classification.reasons.join(", ")})` : ""}`);
  printStreams(media?.inspection ?? null);
  line("tools", resolved.ok ? `ffmpeg ${resolved.tools.ffmpeg.version} (${resolved.tools.ffmpeg.source}), ffprobe ${resolved.tools.ffprobe.version} (${resolved.tools.ffprobe.source})` : `unavailable: ${resolved.errors.join("; ")}`);

  const reasons: string[] = [];
  if (media === null) reasons.push("media_not_inspected (scan with media tools first)");
  else if (media.classification.class !== "remux") reasons.push(`media_${media.classification.class}: only Class 2 (remux) is normalized automatically`);
  if (source.state.upload !== "not_uploaded" || source.attempts.length > 0) reasons.push("source_has_upload_history (a replacement needs a reviewer, not normalize)");
  if (!resolved.ok) reasons.push("media_tools_unavailable");

  const target = renditionTarget(source, root);
  if (target === null) reasons.push("rendition_name_unsafe");
  else {
    const config = telegramConfig();
    const reachable = config !== null && toServerFileUri(target.path, config.pathMap) !== null;
    const selection = media?.inspection ? selectPlaybackStreams(media.inspection) : null;
    if (media?.inspection && selection === null) reasons.push("stream_selection_ambiguous");
    line("action", selection === null ? "none: the film's video and audio stream cannot be selected unambiguously" : `stream copy (-c copy) of stream ${selection.video} (video) and stream ${selection.audio} (audio) into a fast-start MP4${selection.artwork.length ? `; artwork stream ${selection.artwork.join(", ")} left out` : ""}`);
    line("encoding", "none");
    line("rendition", `${target.path}${media?.rendition ? `  (recorded ${media.rendition.fingerprint}${media.rendition.removedAt ? ", file removed" : ""})` : ""}`);
    line("telegram", reachable ? `readable by the local Bot API; the ${source.kind} channel after a separate, authorized upload` : "NOT under the local Bot API path map: the rendition could not be uploaded from there");
    try {
      const free = await freeBytes(await nearestExisting(root));
      const needed = remuxSpaceNeeded(source.sizeBytes);
      line("disk", `free ${gib(free)}, needed ${gib(needed)}${free < needed ? "  INSUFFICIENT" : ""}`);
      if (free < needed) reasons.push("insufficient_disk_space");
    } catch {
      line("disk", "unknown (the renditions directory is not reachable)");
      reasons.push("renditions_directory_unreachable");
    }
  }
  line("writes", "the rendition file and the local journal only: no Telegram call, no database write");
  line("publication", "none: an uploaded rendition still needs evaluation, review, rights clearance and the owner's publication");
  if (media?.normalizationFailure) line("last failure", `${media.normalizationFailure.code}${media.normalizationFailure.details.length ? ` (${media.normalizationFailure.details.join(", ")})` : ""} at ${media.normalizationFailure.at}`);

  if (!values.execute) {
    console.log(`\ndry run: ${reasons.length === 0 ? "would normalize this source" : `would not normalize (${reasons.join("; ")})`}. Nothing was written.`);
    return;
  }
  if (!resolved.ok) fail("media tools are unavailable; nothing was written");
  const release = await store.lock();
  try {
    const started = Date.now();
    const result = await normalizeEntry(source, normalizeDeps(store, resolved.tools, root, vjs));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.result === "normalized") {
      const { video, audio } = result.verification.source;
      console.log(`\nnormalized in ${seconds} s: ${result.rendition.relativePath}  ${mib(result.rendition.sizeBytes)} (${result.rendition.sizeBytes} bytes)`);
      console.log(`verified: fast-start MP4; ${video.packets} video and ${audio.packets} audio packets identical in order, size and content; source unchanged`);
      console.log(`rendition ${result.rendition.fingerprint}  plan: ${result.rendition.plan?.action}${result.rendition.plan?.stopReasons.length ? ` (${result.rendition.plan.stopReasons.join(", ")})` : ""}`);
      console.log(`next: upload --fingerprint ${result.rendition.fingerprint} (dry run first; --execute needs ${REAL_UPLOADS_ENV}=true)`);
    } else if (result.result === "already_normalized") {
      console.log(`\nalready normalized (${result.reason}): rendition ${result.rendition.fingerprint}, upload ${result.rendition.state.upload}. Nothing was written.`);
    } else {
      console.log(`\n${result.result}: ${result.code}${result.details?.length ? ` (${result.details.join(", ")})` : ""}. No rendition was recorded.`);
      process.exitCode = 1;
    }
  } finally {
    await release();
  }
}

/** One item's state, readable without JSON. Read-only. */
async function show() {
  const store = await journal();
  const entry = await entryOrFail(store, oneFingerprint());
  const media = entry.media;
  const rendition = media?.rendition ? await store.get(media.rendition.fingerprint) : null;
  const source = media?.derivedFrom ? await store.get(media.derivedFrom.fingerprint) : null;
  line("item", `${entry.relativePath}  ${mib(entry.sizeBytes)}  (${media?.role ?? "source"})`);
  line("media", `${mediaLabel(media)}${media?.classification.reasons.length ? `  (${media.classification.reasons.join(", ")})` : ""}`);
  printStreams(media?.inspection ?? null);
  if (media?.role === "rendition" && media.derivedFrom) {
    const v = media.derivedFrom.verification;
    line("derived from", `${source?.relativePath ?? media.derivedFrom.fingerprint}  (stream copy ${v.passed ? `verified: ${v.source.video.packets} video + ${v.source.audio.packets} audio packets identical` : `FAILED: ${v.failures.join(", ")}`})`);
  } else if (media?.classification.class === "remux") {
    line("normalization", media.rendition ? `complete: rendition ${media.rendition.fingerprint}${media.rendition.removedAt ? " (file removed after use)" : ""}` : media.normalizationFailure ? `failed: ${media.normalizationFailure.code}` : "not started (normalize --fingerprint …)");
    if (rendition) line("rendition", `upload ${rendition.state.upload}${rendition.telegram ? `, Telegram message ${rendition.telegram.messageId}` : ""}`);
  }
  line("plan", `${entry.plan?.action ?? "none"}${entry.plan?.stopReasons.length ? `  (${entry.plan.stopReasons.join(", ")})` : ""}`);
  line("upload", mediaAllowsUpload(media) ? `allowed by media policy; ${realUploadsState()}` : "blocked by media policy (only canonical bytes or a verified rendition are uploaded)");
  line("telegram", entry.telegram ? `uploaded, message ${entry.telegram.messageId}${entry.dbAcknowledgedAt ? ", server acknowledged" : ", server acknowledgement pending (resume)"}` : entry.state.upload === "uploading" ? "uploading or uncertain: settle with resume before anything else" : "not uploaded");
  line("review", entry.state.review);
  line("publication", "separate: evaluate, review, rights clearance, then the owner's publication script");
}

async function cleanup() {
  const store = await journal();
  const entry = await entryOrFail(store, oneFingerprint());
  if (entry.media?.role !== "rendition") fail("cleanup removes rendition files only; that entry is not a rendition");
  const uploaded = entry.state.upload === "uploaded" && entry.dbAcknowledgedAt !== null;
  const untouched = entry.state.upload === "not_uploaded" && entry.attempts.length === 0;
  line("rendition", `${entry.absolutePath}  ${mib(entry.sizeBytes)}`);
  line("upload", `${entry.state.upload}${entry.dbAcknowledgedAt ? " (server acknowledged)" : ""}, attempts ${entry.attempts.length}`);
  if (!values.execute) {
    console.log(`\ndry run: ${uploaded ? "would delete the file (uploaded and acknowledged; playback uses the Telegram copy)" : untouched ? "would delete the file (never uploaded; normalize can recreate it)" : "would NOT delete: the upload is not settled, and recovery may still need the file"}. Nothing was deleted.`);
    return;
  }
  const release = await store.lock();
  try {
    const vjs = await loadVjs();
    const result = await cleanupRendition(entry, { journal: store, remove: removeFile, plan: (next) => planEntry(next, vjs, store), now: () => new Date() });
    if (result.result === "removed") {
      // Its fingerprint-named directory too, if now empty (rmdir never removes a non-empty one).
      await rmdir(dirname(entry.absolutePath)).catch(() => {});
      console.log(`removed (${result.reason})`);
    } else {
      console.log(`refused: ${result.code}. Nothing was deleted.`);
      process.exitCode = 1;
    }
  } finally {
    await release();
  }
}

async function stage() {
  const fingerprint = oneFingerprint();
  if (!values["staging-root"] || !isAbsolute(values["staging-root"]) || !values["staging-server-root"] || !values.sha256 || !/^[0-9a-f]{64}$/.test(values.sha256)) {
    fail("stage requires --staging-root <absolute directory>, --staging-server-root <container directory>, and --sha256 <64 lowercase hex>");
  }
  const store = await journal();
  const entry = await entryOrFail(store, fingerprint);
  const options = { root: values["staging-root"], serverRoot: values["staging-server-root"], sha256: values.sha256 };
  if (!values.execute) {
    const target = stagingPaths(entry, options.root);
    console.log(`would stage ${entry.fingerprint} (${entry.sizeBytes} bytes) to ${target.path}`);
    console.log("dry run: no copy, integrity reads, Docker command, Telegram or database call. Use --execute for local staging and an isolated Docker mount check.");
    return;
  }
  const release = await store.lock();
  try {
    const result = await stageEntry(await entryOrFail(store, fingerprint), options, store, stagingIO());
    console.log(JSON.stringify(result));
    if (result.result === "refused") process.exitCode = 1;
  } finally { await release(); }
}

async function cleanupStaging() {
  const fingerprint = oneFingerprint();
  const store = await journal();
  if (!values.execute) {
    const entry = await entryOrFail(store, fingerprint);
    console.log(`staging: ${entry.staging?.phase ?? "none"}. Dry run: nothing deleted; execution requires recorded upload success and database acknowledgement.`);
    return;
  }
  const release = await store.lock();
  try {
    const result = await cleanupStage(await entryOrFail(store, fingerprint), store, new Date());
    console.log(JSON.stringify(result));
    if (result.result === "refused") process.exitCode = 1;
  } finally { await release(); }
}

const commands: Record<string, () => Promise<void>> = { scan, inspect, upload, resume, checkpoint, status, evaluate, "publication-sql": publicationSql, normalize, show, cleanup, stage, "cleanup-staging": cleanupStaging };
const run = command ? commands[command] : undefined;
if (!run) fail(`usage: ingest <${Object.keys(commands).join("|")}> …`);
await run();
