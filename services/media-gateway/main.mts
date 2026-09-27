/**
 * Velora UG media gateway entrypoint (E1.2). A long-running Node process, not
 * a serverless function: it keeps one MTProto connection warm for the
 * dedicated media reader and serves published-only HTTP byte ranges.
 *
 *   node --import ../../scripts/ingest/register.mjs main.mts
 *
 * Lifecycle: listen first (so /healthz answers and /readyz reports progress),
 * then start the reader, retrying transient failures with backoff. SIGTERM or
 * SIGINT: readiness drops, new streams are refused, running streams get a
 * grace period, then the session is persisted and connections close.
 */
import { createServer } from "node:http";
import { gatewayConfigFromEnv, GatewayConfigError } from "@/lib/media-gateway/config";
import { createLogger } from "@/lib/media-gateway/log";
import type { MediaReader } from "@/lib/media-gateway/ports";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { createMtcuteReader } from "./mtcute-reader.mts";
import { createPgResolver } from "./pg-resolver.mts";

const logger = createLogger();

let config;
try {
  config = gatewayConfigFromEnv(process.env);
} catch (error) {
  // Variable names only; values are never printed.
  process.stderr.write(`${error instanceof GatewayConfigError ? error.message : "media gateway configuration invalid"}\n`);
  process.exit(78);
}

const resolver = createPgResolver(config.databaseUrl);
const reader = createMtcuteReader({
  apiId: config.telegram.apiId,
  apiHash: config.telegram.apiHash,
  sessionFile: config.sessionFile,
  allowBotLogin: config.allowBotLogin,
  botToken: config.telegram.readerBotToken,
  expectedBotId: config.telegram.readerBotId,
  expectedUsername: config.telegram.readerUsername,
  forbiddenBotIds: config.telegram.ingestionBotIds,
  moviesChannelId: config.telegram.moviesChannelId,
  logger,
});

// Readiness also requires the catalogue: without it no request can be authorized for bytes.
let catalogueReachable = false;
const probeCatalogue = async () => {
  const reachable = await resolver.ping();
  if (reachable !== catalogueReachable) logger.info({ event: "catalogue_state", state: reachable ? "reachable" : "unreachable" });
  catalogueReachable = reachable;
};
const catalogueProbe = setInterval(probeCatalogue, 30_000);
catalogueProbe.unref();

const gatedReader: MediaReader = {
  readiness: () => (catalogueReachable ? reader.readiness() : { ready: false, state: "catalogue_unreachable" }),
  readPart: (locator, offset, limit, signal) => reader.readPart(locator, offset, limit, signal),
};

const gateway = createMediaGateway({
  limits: config.limits,
  tokenSecret: config.tokenSecret,
  resolver,
  reader: gatedReader,
  logger,
  allowedOrigins: config.allowedOrigins,
});

const server = createServer({ headersTimeout: 15_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 }, gateway.handle);
// requestTimeout bounds receiving the request only; response time is bounded by the gateway's own limits.
server.listen(config.port, config.host, () => logger.info({ event: "listening", state: "starting" }));

const TRANSIENT = new Set(["starting", "connecting"]);
let stopping = false;
async function startReader(attempt = 0): Promise<void> {
  const startedAt = Date.now();
  try {
    await probeCatalogue();
    await resolver.warm();
    await reader.start();
    logger.info({ event: "reader_ready", latencyMs: Date.now() - startedAt });
  } catch {
    const state = reader.readiness().state;
    logger.error({ event: "reader_start_failed", state });
    await reader.stop();
    // Identity, channel, rights and missing-session failures are configuration: stay not ready.
    if (stopping || !TRANSIENT.has(state)) return;
    const delay = Math.min(60_000, 2_000 * 2 ** attempt);
    setTimeout(() => void startReader(attempt + 1), delay).unref();
  }
}
void startReader();

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "shutdown", state: signal, activeStreams: gateway.activeStreams });
  gateway.beginShutdown();
  server.close();
  const deadline = Date.now() + 15_000;
  while (gateway.activeStreams > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  server.closeAllConnections();
  clearInterval(catalogueProbe);
  await reader.stop();
  await resolver.close();
  logger.info({ event: "stopped" });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
