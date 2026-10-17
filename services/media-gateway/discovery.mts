/** Persistent discovery host, explicitly gated; never imported by Next.js. */
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { createLocalBotApiClient, parseBotApiBaseUrl, type LocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { databasePersistence, databaseCataloguePorts } from "@/lib/discovery/database";
import { botApiUpdateProvider } from "@/lib/discovery/bot-api-provider";
import { classifyFailure, runDiscoveryService, serviceHealth, type ServiceState } from "@/lib/discovery/service";
import { channelMediaPort, channelVerificationPort } from "@/lib/discovery/media-verification";
import { searchTmdbForIngestion, fetchMovieSnapshot } from "@/lib/tmdb/ingestion-search";
import { mediaReaderRange } from "@/lib/media-gateway/range-reader";
import { decodeStreams, headProbe, probeMedia, resolveMediaTools, runProcess, spoolDocument } from "@/lib/uploader/media-tools";
import { createLogger } from "@/lib/media-gateway/log";
import { createMtcuteReader } from "./mtcute-reader.mts";
import { createDiscoveryPg } from "./discovery-pg.mts";

// No .env.local loading. --check returns before database, Telegram or tool calls.
const log = (entry: Record<string, string | number | boolean | null>) => console.log(JSON.stringify(entry));
const readerConfigSchema = z.object({
  TELEGRAM_MEDIA_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_MEDIA_API_HASH: z.string().regex(/^[0-9a-f]{32}$/),
  TELEGRAM_MEDIA_BOT_ID: z.string().regex(/^\d{5,15}$/),
  TELEGRAM_MEDIA_BOT_USERNAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/),
  VELORA_DISCOVERY_SESSION_FILE: z.string().min(1),
});
const configSchema = z.object({
  VELORA_DISCOVERY_DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_API_URL: z.string().refine((value) => parseBotApiBaseUrl(value) !== null),
  TELEGRAM_MOVIES_BOT_TOKEN: z.string().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/),
  TELEGRAM_MOVIES_BOT_ID: z.string().regex(/^\d{5,15}$/),
  TELEGRAM_MOVIES_BOT_USERNAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/),
  TELEGRAM_MOVIES_CHANNEL_ID: z.string().regex(/^-100\d{5,13}$/),
  ...readerConfigSchema.partial().shape,
  VELORA_DISCOVERY_INSPECTION: z.enum(["disabled", "metadata", "bounded"]).default("disabled"),
  VELORA_DISCOVERY_HEALTH_PORT: z.coerce.number().int().min(1024).max(65535).default(8790),
  // Where a whole-file verification holds the document while it reads it (--verify only).
  VELORA_DISCOVERY_SPOOL_DIR: z.string().refine(isAbsolute).optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.VELORA_DISCOVERY_INSPECTION !== "bounded") return;
  const reader = readerConfigSchema.safeParse(cfg);
  if (!reader.success) for (const issue of reader.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: "Bounded inspection requires reader configuration" });
});

// The longest one whole-file verification may hold its candidate: the database's own ceiling for the keyed claim.
const VERIFICATION_LEASE_SECONDS = 14_400;

/**
 * `--verify <candidate key>`: one whole-file verification of one candidate whose film and VJ a reviewer has
 * confirmed, then exit (the Policy 3 verification contract). It takes no part in polling: no Bot API call and no
 * consumer lease, so it runs beside the listener and never in its loop. The candidate is claimed by its key, so it
 * cannot land on another film. It reads the whole document from Telegram through the dedicated reader, which is a
 * live media operation: the same explicit switch as the listener applies, and nothing starts it but an operator.
 */
async function verifyCandidate(cfg: z.infer<typeof configSchema>, key: string): Promise<void> {
  const readerCfg = readerConfigSchema.safeParse(cfg);
  const spoolDir = cfg.VELORA_DISCOVERY_SPOOL_DIR;
  if (!/^[a-f0-9]{64}$/.test(key) || !readerCfg.success || !spoolDir) throw new Error("discovery_verification_configuration_required");
  const tools = await resolveMediaTools(process.env);
  if (!tools.ok) throw new Error("discovery_verified_media_tools_required");
  // A stop request ends the read; the failed attempt then gives the candidate's lease back.
  const abort = new AbortController();
  const halt = () => abort.abort();
  process.on("SIGINT", halt); process.on("SIGTERM", halt);
  const database = createDiscoveryPg(cfg.VELORA_DISCOVERY_DATABASE_URL);
  const target = databasePersistence(database.rpc, { channelId: Number(cfg.TELEGRAM_MOVIES_CHANNEL_ID) });
  const reader = createMtcuteReader({ apiId: readerCfg.data.TELEGRAM_MEDIA_API_ID, apiHash: readerCfg.data.TELEGRAM_MEDIA_API_HASH, sessionFile: readerCfg.data.VELORA_DISCOVERY_SESSION_FILE, allowBotLogin: false,
    expectedBotId: readerCfg.data.TELEGRAM_MEDIA_BOT_ID, expectedUsername: readerCfg.data.TELEGRAM_MEDIA_BOT_USERNAME, forbiddenBotIds: [cfg.TELEGRAM_MOVIES_BOT_ID], moviesChannelId: cfg.TELEGRAM_MOVIES_CHANNEL_ID, logger: createLogger() });
  try {
    await database.check();
    await reader.start();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(VERIFICATION_LEASE_SECONDS * 1000)]);
    const media = channelVerificationPort((doc) => mediaReaderRange(reader, { movieVersionId: 0, chatId: String(doc.chatId), messageId: doc.messageId, fileUniqueId: doc.fileUniqueId, fileSize: doc.sizeBytes, mimeType: doc.mimeType }, signal), {
      probe: headProbe(tools.tools.ffprobe, (file, args, options) => runProcess(file, args, { ...options, timeoutMs: Math.min(options.timeoutMs, 20000) })),
      gatewayCompatible: true,
      spool: (read, sizeBytes, handle) => spoolDocument(spoolDir, read, sizeBytes, handle),
      inspect: async (path) => { const probe = await probeMedia(tools.tools.ffprobe, path); return probe.ok ? probe.inspection : null; },
      decoder: (path) => ({ decode: (streams, window) => decodeStreams(tools.tools.ffmpeg, path, streams, window) }),
      tools: { ffmpeg: tools.tools.ffmpeg.version, ffprobe: tools.tools.ffprobe.version }, now: () => new Date(),
    });
    const result = await target.verifyOne(key, media, () => new Date(), VERIFICATION_LEASE_SECONDS);
    // Fixed codes and counts only: no key, title, digest or Telegram identifier.
    log({ event: "discovery_verification_finished", outcome: result.outcome, media: result.evidence?.media_class ?? null, reasons: result.evidence?.reasons.length ?? null });
    if (result.outcome !== "needs_review") process.exitCode = 1;
  } finally {
    abort.abort();
    await reader.stop(); await database.close();
    process.removeListener("SIGINT", halt); process.removeListener("SIGTERM", halt);
  }
}

async function main() {
  if (!process.argv.includes("--check") && process.env.VELORA_DISCOVERY_LIVE_AUTHORIZED !== "true") throw new Error("discovery_gate_b_required");
  const configValues = { ...process.env };
  // Empty optional template entries do not provision a media reader.
  for (const name of Object.keys(readerConfigSchema.shape)) if (configValues[name] === "") delete configValues[name];
  const parsed = configSchema.safeParse(configValues);
  if (!parsed.success) { log({ event: "discovery_config_invalid", variables: [...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(",") }); process.exitCode = 78; return; }
  const cfg = parsed.data;
  const url = new URL(cfg.VELORA_DISCOVERY_DATABASE_URL);
  if (!/^velora_discovery_worker(?:\.[a-z0-9]{10,40})?$/.test(decodeURIComponent(url.username)) || !url.password || !["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("discovery_wrong_database_identity");
  if (cfg.TELEGRAM_MOVIES_BOT_ID === cfg.TELEGRAM_MEDIA_BOT_ID || !cfg.TELEGRAM_MOVIES_BOT_TOKEN.startsWith(`${cfg.TELEGRAM_MOVIES_BOT_ID}:`)) throw new Error("discovery_bot_identity_invalid");
  if (process.argv.includes("--check")) { log({ event: "discovery_configuration_valid", inspection: cfg.VELORA_DISCOVERY_INSPECTION }); return; }
  const verifyAt = process.argv.indexOf("--verify");
  if (verifyAt >= 0) return verifyCandidate(cfg, process.argv[verifyAt + 1] ?? "");
  const abort = new AbortController();
  const stop = () => abort.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const db = createDiscoveryPg(cfg.VELORA_DISCOVERY_DATABASE_URL);
  // Covers bounded media reads/probe, metadata timeouts and database round trips.
  const target = databasePersistence(db.rpc, { channelId: Number(cfg.TELEGRAM_MOVIES_CHANNEL_ID), inspectionLeaseSeconds: 240 });
  const bot = { token: cfg.TELEGRAM_MOVIES_BOT_TOKEN, channelId: Number(cfg.TELEGRAM_MOVIES_CHANNEL_ID), local: { id: Number(cfg.TELEGRAM_MOVIES_BOT_ID), username: cfg.TELEGRAM_MOVIES_BOT_USERNAME } };
  const botConfig: LocalBotApiConfig = { baseUrl: parseBotApiBaseUrl(cfg.TELEGRAM_BOT_API_URL)!, bots: { movie: bot, series: { ...bot, token: "", local: null } }, reconcileChatId: null, pathMap: null };
  const api = createLocalBotApiClient(botConfig, { fetch, mediaFetch: fetch, stat: async (path) => { const item = await stat(path); return { isFile: item.isFile(), size: item.size }; }, requestTimeoutMs: 15000, uploadTimeoutMs: 15000 });
  let state: ServiceState = { state: "starting", startedAt: new Date().toISOString(), lastCycleAt: null, lastProgressAt: null, cycles: 0, consecutiveFailures: 0, lastErrorCode: null, lastMetrics: null };
  const server = createServer((_request, response) => {
    const health = serviceHealth(state, new Date());
    response.writeHead(_request.url === "/healthz" ? health.alive ? 200 : 503 : _request.url === "/readyz" ? health.ready ? 200 : 503 : 404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(health));
  });
  let reader: ReturnType<typeof createMtcuteReader> | null = null;
  try {
    await db.check();
    // The durable lease is acquired BEFORE even checking Telegram ownership.
    if (await target.checkpoint() === null) throw new Error("discovery_cursor_offset_required");
    const ownership = await api.updateOwnership();
    if (ownership.status !== "ok" || ownership.webhookSet) throw new Error("telegram_update_consumer_conflict");
    let media: ReturnType<typeof channelMediaPort> = async () => ({ duplicateOf: null, source: null, evidence: null });
    if (cfg.VELORA_DISCOVERY_INSPECTION === "bounded") {
      const readerCfg = readerConfigSchema.parse(cfg);
      const tools = await resolveMediaTools(process.env);
      if (!tools.ok) throw new Error("discovery_verified_media_tools_required");
      const boundedReader = createMtcuteReader({ apiId: readerCfg.TELEGRAM_MEDIA_API_ID, apiHash: readerCfg.TELEGRAM_MEDIA_API_HASH, sessionFile: readerCfg.VELORA_DISCOVERY_SESSION_FILE, allowBotLogin: false,
        expectedBotId: readerCfg.TELEGRAM_MEDIA_BOT_ID, expectedUsername: readerCfg.TELEGRAM_MEDIA_BOT_USERNAME, forbiddenBotIds: [cfg.TELEGRAM_MOVIES_BOT_ID], moviesChannelId: cfg.TELEGRAM_MOVIES_CHANNEL_ID, logger: createLogger() });
      reader = boundedReader;
      await boundedReader.start();
      // One cache slot bounds the reader's map regardless of the discovery backlog.
      media = channelMediaPort((doc) => mediaReaderRange(boundedReader, { movieVersionId: 0, chatId: String(doc.chatId), messageId: doc.messageId, fileUniqueId: doc.fileUniqueId, fileSize: doc.sizeBytes, mimeType: doc.mimeType }, AbortSignal.any([abort.signal, AbortSignal.timeout(60000)])), headProbe(tools.tools.ffprobe, (file, args, options) => runProcess(file, args, { ...options, timeoutMs: Math.min(options.timeoutMs, 20000) })));
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(cfg.VELORA_DISCOVERY_HEALTH_PORT, "127.0.0.1", resolve); });
    const ports = { ...databaseCataloguePorts(db.rpc), search: searchTmdbForIngestion, snapshot: fetchMovieSnapshot, media };
    // Detection-only retains received candidates for later inspection, without consuming retry budgets.
    const persistence = cfg.VELORA_DISCOVERY_INSPECTION === "disabled" ? { ...target, inspectNext: async () => false } : target;
    const result = await runDiscoveryService(persistence, botApiUpdateProvider(api.pollChannelUpdates), ports, {
      signal: abort.signal, now: () => new Date(), log, onState: (next) => { state = { ...next }; },
      sleep: async (ms, signal) => { try { await pause(ms, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; } },
    });
    if (result.state === "fatal") process.exitCode = 78;
  } finally {
    abort.abort(); server.close(); server.closeAllConnections();
    await target.release().catch(() => log({ event: "discovery_lease_release_failed" }));
    await reader?.stop(); await db.close();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
main().catch((error) => {
  const failure = classifyFailure(error);
  log({ event: "discovery_start_failed", code: failure.code });
  const configuration = ["discovery_gate_b_required", "discovery_wrong_database_identity", "discovery_bot_identity_invalid", "discovery_verified_media_tools_required", "discovery_verification_configuration_required"].includes(failure.code);
  process.exitCode = configuration || failure.action === "stop" ? 78 : 1;
});
