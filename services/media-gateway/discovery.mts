/** Persistent discovery host, explicitly gated; never imported by Next.js. */
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { createLocalBotApiClient, parseBotApiBaseUrl, type LocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { databasePersistence, databaseCataloguePorts } from "@/lib/discovery/database";
import { botApiUpdateProvider } from "@/lib/discovery/bot-api-provider";
import { classifyFailure, runDiscoveryService, serviceHealth, type ServiceState } from "@/lib/discovery/service";
import { channelMediaPort } from "@/lib/discovery/media-verification";
import { searchTmdbForIngestion, fetchMovieSnapshot } from "@/lib/tmdb/ingestion-search";
import { mediaReaderRange } from "@/lib/media-gateway/range-reader";
import { resolveMediaTools, headProbe, runProcess } from "@/lib/uploader/media-tools";
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
}).superRefine((cfg, ctx) => {
  if (cfg.VELORA_DISCOVERY_INSPECTION !== "bounded") return;
  const reader = readerConfigSchema.safeParse(cfg);
  if (!reader.success) for (const issue of reader.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: "Bounded inspection requires reader configuration" });
});

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
  const abort = new AbortController();
  const stop = () => abort.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
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
  const configuration = ["discovery_gate_b_required", "discovery_wrong_database_identity", "discovery_bot_identity_invalid", "discovery_verified_media_tools_required"].includes(failure.code);
  process.exitCode = configuration || failure.action === "stop" ? 78 : 1;
});
