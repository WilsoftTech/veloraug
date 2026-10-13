import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open, readFile, type FileHandle } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DownloadLimits } from "@/lib/media-gateway/download";
import { DEFAULT_LIMITS, type GatewayLimits } from "@/lib/media-gateway/limits";
import type { CatalogueMediaResolver, MediaLocator, MediaReader } from "@/lib/media-gateway/ports";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { signMediaToken } from "@/lib/media-gateway/token";
import manifest from "./fixtures/manifest.json";

/**
 * Serves the browser fixtures through the real media gateway core
 * (lib/media-gateway/server.ts), so a browser under test meets exactly what
 * production sends: a signed stream URL, a required Range header, bounded 206
 * responses, the stored media type and the same headers. Only the two ports
 * are test doubles: the catalogue is the fixture manifest and the reader reads
 * local files in place of Telegram. Loopback only; nothing leaves the machine.
 *
 * The page that drives the <video> element is served from the same origin, so
 * the page may read the audio it plays (Web Audio) and the frames it draws.
 */

export type Fixture = (typeof manifest.fixtures)[number];
export const FIXTURES: readonly Fixture[] = manifest.fixtures;
export const FIXTURE_GENERATOR: string = manifest.generator;
/** What the harness needs to serve a file: the committed fixtures, or larger files generated on demand. */
export type ServedFile = Pick<Fixture, "id" | "file" | "sizeBytes" | "mime">;

/**
 * Production allows 8 MiB per response. The fixtures are about 300 KB, so the
 * harness shortens the window: every file then needs several range requests,
 * and an MP4 whose index is at the end forces a real seek to the tail.
 */
export const HARNESS_MAX_RESPONSE_BYTES = 32 * 1024;

const limits = (maxResponseBytes: number): GatewayLimits => ({
  ...DEFAULT_LIMITS,
  maxResponseBytes,
  // Many short range requests from one address are the point here, not abuse.
  maxActiveStreams: 256,
  maxStreamsPerSubject: 32,
  maxStreamsPerIp: 64,
  requestsPerSubjectPerWindow: 10_000,
  requestsPerIpPerWindow: 10_000,
});

const FIXTURE_DIR = join(__dirname, "fixtures");
const SECRET = new Uint8Array(32).fill(7);
const SILENT = { info() {}, warn() {}, error() {} };

/** One media request as the browser made it and as the gateway answered it. */
export interface MediaRequest {
  versionId: number;
  range: string | null;
  /** 0 when the browser closed the connection before any status was sent. */
  status: number;
  contentRange: string | null;
  contentLength: number;
  contentType: string | null;
  /** Milliseconds after the last reset at which the request arrived. */
  startedMs: number;
  /** Body bytes actually written: fewer than contentLength when the browser stopped reading. */
  bytesSent: number;
}

/** One request to the download route: what a browser's download manager asked for, and the answer. */
export interface DownloadRequest extends MediaRequest {
  ifRange: string | null;
  /** The validator the gateway sent, which a resume has to quote in If-Range. */
  etag: string | null;
  /** The capability the request carried, to tell a reused link from a newly issued one. */
  token: string | null;
}

export interface HarnessOptions {
  /** Optional original-download adapter for the frontend fixture tests; never contacts Telegram. */
  downloads?: boolean;
  downloadAccess?: () => boolean;
  allowedOrigins?: readonly string[];
  beforeRead?: (offset: number, limit: number) => void;
  /** Defaults to the committed fixtures. */
  fixtures?: readonly ServedFile[];
  fixtureDir?: string;
  maxResponseBytes?: number;
  /** Delay before each read of up to 1 MiB: a slow origin, for startup measurements. */
  readDelayMs?: number;
  /** The gateway's clock, to move a running transfer past its capability's expiry. */
  now?: () => number;
  /** Download limits to tighten (the gateway refuses anything looser than its defaults). */
  downloadLimits?: Partial<DownloadLimits>;
}

export interface Harness {
  origin: string;
  /** A signed stream URL for one fixture, as the E2 issuer would build it. */
  streamUrl(fixture: ServedFile, subject: string): string;
  /** Media requests since the last reset. */
  requests: MediaRequest[];
  /** Download-route requests since the last reset, the readiness probe included. */
  downloads: DownloadRequest[];
  reset(): void;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const fixtureDir = options.fixtureDir ?? FIXTURE_DIR;
  const handles = new Map<number, Promise<FileHandle>>();
  const byId = new Map((options.fixtures ?? FIXTURES).map((fixture): [number, ServedFile] => [fixture.id, fixture]));
  const locator = (fixture: ServedFile): MediaLocator => ({
    movieVersionId: fixture.id,
    chatId: "-1000000000001",
    messageId: fixture.id,
    fileUniqueId: `fixture-${fixture.id}`,
    fileSize: fixture.sizeBytes,
    mimeType: fixture.mime,
    fileName: fixture.file,
  });
  const resolver: CatalogueMediaResolver = {
    ...(options.downloads ? { async resolveDownload(movieVersionId: number) {
      const fixture = byId.get(movieVersionId);
      return fixture && (options.downloadAccess?.() ?? true) ? locator(fixture) : null;
    } } : {}),
    async resolveMovieVersion(movieVersionId) {
      const fixture = byId.get(movieVersionId);
      return fixture ? locator(fixture) : null;
    },
  };
  const reader: MediaReader = {
    readiness: () => ({ ready: true, state: "ready" }),
    async readPart(target, offset, limit) {
      options.beforeRead?.(offset, limit);
      const fixture = byId.get(target.movieVersionId);
      if (!fixture) throw new Error("unknown fixture");
      if (options.readDelayMs) await new Promise((resolve) => setTimeout(resolve, options.readDelayMs));
      let handle = handles.get(fixture.id);
      if (!handle) handles.set(fixture.id, (handle = open(join(fixtureDir, fixture.file), "r")));
      const length = Math.max(0, Math.min(limit, fixture.sizeBytes - offset));
      const bytes = new Uint8Array(length);
      const { bytesRead } = await (await handle).read(bytes, 0, length, offset);
      return { bytes: bytes.subarray(0, bytesRead), rpcCount: 1 };
    },
  };
  const gateway = createMediaGateway({ limits: limits(options.maxResponseBytes ?? HARNESS_MAX_RESPONSE_BYTES), tokenSecret: SECRET, resolver, reader, logger: SILENT, allowedOrigins: options.allowedOrigins, now: options.now, downloadLimits: options.downloadLimits });
  const page = await readFile(join(__dirname, "probe.html"));
  const requests: MediaRequest[] = [];
  const downloads: DownloadRequest[] = [];
  let resetAt = Date.now();

  function observe(request: IncomingMessage, response: ServerResponse, versionId: number, download: boolean) {
    const entry: MediaRequest = { versionId, range: typeof request.headers.range === "string" ? request.headers.range : null, status: 0, contentRange: null, contentLength: 0, contentType: null, startedMs: Date.now() - resetAt, bytesSent: 0 };
    if (download) {
      const ifRange = request.headers["if-range"];
      downloads.push(Object.assign(entry, { ifRange: typeof ifRange === "string" ? ifRange : null, etag: null, token: new URL(request.url ?? "/", "http://harness.invalid").searchParams.get("token") }));
    } else requests.push(entry);
    // The gateway passes its headers to writeHead, so that is the only place they can be read.
    const writeHead = response.writeHead.bind(response) as (status: number, headers?: Record<string, string>) => ServerResponse;
    response.writeHead = ((status: number, headers?: Record<string, string>) => {
      entry.status = status;
      entry.contentRange = headers?.["Content-Range"] ?? null;
      entry.contentLength = Number(headers?.["Content-Length"] ?? 0);
      entry.contentType = headers?.["Content-Type"] ?? null;
      if ("etag" in entry) entry.etag = headers?.ETag ?? null;
      return writeHead(status, headers);
    }) as ServerResponse["writeHead"];
    const write = response.write.bind(response) as (chunk: Uint8Array) => boolean;
    response.write = ((chunk: Uint8Array) => {
      entry.bytesSent += chunk.byteLength;
      return write(chunk);
    }) as ServerResponse["write"];
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://harness.invalid").pathname;
    if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(page);
      return;
    }
    const version = /^\/v1\/movie-versions\/(\d+)\/(stream|download)$/.exec(path);
    // Stream requests are recorded as before; for downloads only the GETs count, not a preflight.
    if (version && (version[2] === "stream" || request.method === "GET")) observe(request, response, Number(version[1]), version[2] === "download");
    gateway.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
    downloads,
    reset() {
      requests.splice(0);
      downloads.splice(0);
      resetAt = Date.now();
    },
    streamUrl(fixture, subject) {
      const token = signMediaToken(SECRET, { op: "stream", movieVersionId: fixture.id, subject, ttlSeconds: 600, nowSeconds: Math.floor(Date.now() / 1000) });
      return `${origin}/v1/movie-versions/${fixture.id}/stream?token=${token}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const handle of handles.values()) await (await handle).close();
    },
  };
}
