/**
 * The media gateway's HTTP core (E1.2), on `node:http` with no framework.
 *
 *   GET /healthz                                   process liveness; no dependency is called
 *   GET /readyz                                    503 unless the media reader can serve now
 *   GET /v1/movie-versions/{id}/stream?token=…     206 byte ranges of a published version
 *   GET /v1/movie-versions/{id}/download?token=…   not implemented; proves operation separation
 *   OPTIONS on the media routes                    CORS preflight, allow-listed origins only
 *
 * Order per stream request (each step fails closed before the next runs):
 * route → token (MAC, expiry, operation, version) → rate and stream limits →
 * reader readiness → catalogue resolution (publication) → Range → bytes.
 * No Telegram call happens before authorization and publication both pass,
 * and a client can name only an internal version id, never Telegram media.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { GatewayError, gatewayCodeOf, publicError, type GatewayErrorCode } from "@/lib/media-gateway/errors";
import { Semaphore, StreamAdmission, WindowRateLimiter, type GatewayLimits } from "@/lib/media-gateway/limits";
import type { GatewayLogFields, GatewayLogger } from "@/lib/media-gateway/log";
import type { CatalogueMediaResolver, MediaReader } from "@/lib/media-gateway/ports";
import { pumpRange } from "@/lib/media-gateway/pump";
import { contentRange, parseRangeHeader, unsatisfiedContentRange } from "@/lib/media-gateway/range";
import { verifyMediaToken, type MediaOperation } from "@/lib/media-gateway/token";

export interface MediaGatewayDeps {
  limits: GatewayLimits;
  tokenSecret: Uint8Array;
  resolver: CatalogueMediaResolver;
  reader: MediaReader;
  logger: GatewayLogger;
  /** Browser origins allowed to read responses from script (CORS). Media elements need none. */
  allowedOrigins?: readonly string[];
  /** Milliseconds clock. */
  now?: () => number;
  requestId?: () => string;
  /** Client address for per-IP limits. Defaults to the socket peer (no proxy header is trusted). */
  clientIp?: (request: IncomingMessage) => string;
}

export interface MediaGateway {
  handle(request: IncomingMessage, response: ServerResponse): void;
  /** Readiness turns false and new streams are refused; running streams finish. */
  beginShutdown(): void;
  readonly activeStreams: number;
}

const ROUTE = /^\/v1\/movie-versions\/([1-9]\d{0,14})\/(stream|download)$/;
const SAFE_MIME = /^(video|audio)\/[a-z0-9][a-z0-9.+-]{0,63}$/i;
const COMMON_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export function createMediaGateway(deps: MediaGatewayDeps): MediaGateway {
  const { limits, logger } = deps;
  const now = deps.now ?? Date.now;
  const newRequestId = deps.requestId ?? (() => randomUUID());
  const clientIp = deps.clientIp ?? ((request: IncomingMessage) => request.socket.remoteAddress ?? "unknown");
  const semaphore = new Semaphore(limits.maxReadsInFlight);
  const admission = new StreamAdmission(limits);
  const bySubject = new WindowRateLimiter(limits.requestsPerSubjectPerWindow, limits.rateWindowMs);
  const byIp = new WindowRateLimiter(limits.requestsPerIpPerWindow, limits.rateWindowMs);
  const origins = new Set(deps.allowedOrigins ?? []);
  let shuttingDown = false;

  function corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origins.has(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
      Vary: "Origin",
    };
  }

  function sendJson(request: IncomingMessage, response: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, {
      ...COMMON_HEADERS,
      ...corsHeaders(request),
      ...extra,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  }

  function sendError(request: IncomingMessage, response: ServerResponse, code: GatewayErrorCode, extra: Record<string, string> = {}) {
    const { status, body } = publicError(code);
    sendJson(request, response, status, body, extra);
    return status;
  }

  async function handleMedia(request: IncomingMessage, response: ServerResponse, url: URL, versionId: number, op: MediaOperation) {
    const startedAt = now();
    const log: GatewayLogFields = { event: "media_request", requestId: newRequestId(), movieVersionId: versionId, route: op, rpcCount: 0 };
    const finish = (fields: Partial<GatewayLogFields>, level: "info" | "warn" | "error" = "info") => {
      logger[level]({ ...log, ...fields, latencyMs: now() - startedAt });
    };
    const deny = (code: GatewayErrorCode, extra: Record<string, string> = {}) => {
      const status = sendError(request, response, code, extra);
      finish({ status, code, outcome: "denied" }, status >= 500 ? "warn" : "info");
    };

    // 1. The only accepted parameter is the token. Anything else, including an
    //    attempt to name Telegram media, is refused rather than ignored.
    const params = [...url.searchParams.keys()];
    if (params.some((name) => name !== "token") || url.searchParams.getAll("token").length > 1) return deny("invalid_request");
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (authorization !== undefined && bearer === undefined) return deny("authorization_invalid");
    const queryToken = url.searchParams.get("token") ?? undefined;
    if (bearer !== undefined && queryToken !== undefined) return deny("invalid_request");

    // 2. Authorization, before any catalogue or Telegram work.
    const verified = verifyMediaToken(deps.tokenSecret, bearer ?? queryToken, {
      op,
      movieVersionId: versionId,
      nowSeconds: Math.floor(now() / 1000),
      maxLifetimeSeconds: limits.maxTokenLifetimeSeconds,
    });
    if (!verified.ok) return deny(verified.code);
    // The download endpoint is reserved: a download token is recognised, and still no bytes are served.
    if (op === "download") return deny("not_implemented");

    // 3. Abuse and resource limits.
    const subject = verified.claims.sub;
    const ip = clientIp(request);
    const nowMs = now();
    if (!bySubject.hit(subject, nowMs) || !byIp.hit(ip, nowMs)) return deny("rate_limited", { "Retry-After": String(Math.ceil(limits.rateWindowMs / 1000)) });
    if (shuttingDown) return deny("not_ready");
    let release: () => void;
    try {
      release = admission.admit(subject, ip);
    } catch (error) {
      return deny(gatewayCodeOf(error));
    }

    const controller = new AbortController();
    const abort = (reason: GatewayError | "client_closed") => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onClose = () => {
      if (!response.writableFinished) abort("client_closed");
    };
    response.on("close", onClose);
    const requestTimer = setTimeout(() => abort(new GatewayError("upstream_timeout")), limits.requestTimeoutMs);
    let idleTimer = setTimeout(() => abort(new GatewayError("upstream_timeout")), limits.idleTimeoutMs);
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort(new GatewayError("upstream_timeout")), limits.idleTimeoutMs);
    };

    try {
      // 4. The reader must be able to serve before the catalogue is consulted.
      if (!deps.reader.readiness().ready) return deny("not_ready");

      // 5. Publication is rechecked on every request, whatever the token says.
      const locator = await deps.resolver.resolveMovieVersion(versionId, controller.signal);
      if (controller.signal.aborted) return finish({ outcome: "client_closed", code: "client_closed" });
      if (!locator) return deny("version_unavailable");

      // 6. Range, against the catalogue's recorded size.
      const parsed = parseRangeHeader(request.headers.range, locator.fileSize, limits.maxResponseBytes);
      if (!parsed.ok) {
        const extra: Record<string, string> =
          parsed.code === "range_not_satisfiable" ? { "Content-Range": unsatisfiedContentRange(locator.fileSize), "Accept-Ranges": "bytes" } : {};
        return deny(parsed.code, extra);
      }
      log.requestedBytes = parsed.range.length;
      log.readsPlanned = parsed.plan.reads.length;

      // 7. Bytes. Headers go out only once the first read has succeeded, so an
      //    upstream failure before any byte is still a clean error status.
      let firstByteMs: number | undefined;
      const result = await pumpRange({
        plan: parsed.plan,
        locator,
        reader: deps.reader,
        semaphore,
        readAhead: limits.readAheadPerStream,
        readTimeoutMs: limits.readTimeoutMs,
        signal: controller.signal,
        onProgress: touch,
        beforeFirstWrite: () => {
          firstByteMs = now() - startedAt;
          response.writeHead(206, {
            ...COMMON_HEADERS,
            ...corsHeaders(request),
            "Accept-Ranges": "bytes",
            "Content-Range": contentRange(parsed.range, locator.fileSize),
            "Content-Length": String(parsed.range.length),
            "Content-Type": locator.mimeType && SAFE_MIME.test(locator.mimeType) ? locator.mimeType : "application/octet-stream",
          });
        },
        sink: {
          write: (chunk) => response.write(chunk),
          waitForDrain: (signal) =>
            new Promise<void>((resolve, reject) => {
              const done = () => {
                signal.removeEventListener("abort", aborted);
                resolve();
              };
              const aborted = () => {
                response.off("drain", done);
                reject(signal.reason);
              };
              response.once("drain", done);
              signal.addEventListener("abort", aborted, { once: true });
            }),
        },
      });
      const fields = { servedBytes: result.bytesWritten, rpcCount: result.rpcCount, readsIssued: result.readsIssued, firstByteMs, status: response.headersSent ? 206 : undefined };
      if (result.outcome === "complete") {
        response.end();
        return finish({ ...fields, outcome: "complete" });
      }
      const reason = controller.signal.reason;
      if (reason instanceof GatewayError) {
        if (!response.headersSent) return deny(reason.code);
        response.destroy();
        return finish({ ...fields, outcome: "timeout", code: reason.code }, "warn");
      }
      response.destroy();
      return finish({ ...fields, outcome: "client_closed", code: "client_closed" });
    } catch (error) {
      const code = gatewayCodeOf(error);
      const retryAfter = error instanceof GatewayError && error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined;
      if (!response.headersSent) {
        const status = sendError(request, response, code, retryAfter);
        return finish({ status, code, outcome: "failed" }, status >= 500 ? "error" : "warn");
      }
      // Mid-body failure: the status is already sent, so the only honest signal is a cut connection.
      response.destroy();
      return finish({ status: 206, code, outcome: "failed" }, "error");
    } finally {
      clearTimeout(requestTimer);
      clearTimeout(idleTimer);
      response.off("close", onClose);
      release();
    }
  }

  /**
   * CORS preflight. Browsers send one for a Range header that is not a "simple"
   * range (for example a suffix range such as `bytes=-65536`). It answers only
   * allow-listed origins, only for GET with the Range/Authorization headers, and
   * never touches the catalogue or Telegram (preflights carry no credentials).
   */
  function handlePreflight(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    const method = request.headers["access-control-request-method"];
    const requested = String(request.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const allowed = typeof origin === "string" && origins.has(origin) && method === "GET" && requested.every((name) => name === "range" || name === "authorization");
    if (!allowed) {
      sendError(request, response, "method_not_allowed", { Allow: "GET" });
      return;
    }
    response.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Range, Authorization",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
      "Cache-Control": "no-store",
    });
    response.end();
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://gateway.invalid");
    } catch {
      sendError(request, response, "not_found");
      return;
    }
    if (request.method === "OPTIONS" && ROUTE.test(url.pathname)) {
      handlePreflight(request, response);
      return;
    }
    if (request.method !== "GET") {
      sendError(request, response, "method_not_allowed", { Allow: "GET" });
      return;
    }
    if (url.pathname === "/healthz") {
      sendJson(request, response, 200, JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/readyz") {
      const readiness = deps.reader.readiness();
      const ready = readiness.ready && !shuttingDown;
      sendJson(request, response, ready ? 200 : 503, JSON.stringify({ status: ready ? "ready" : "not_ready", state: shuttingDown ? "shutting_down" : readiness.state }));
      return;
    }
    const match = ROUTE.exec(url.pathname);
    if (!match) {
      sendError(request, response, "not_found");
      return;
    }
    handleMedia(request, response, url, Number(match[1]), match[2] as MediaOperation).catch((error: unknown) => {
      // handleMedia handles its own failures; this only guards against a bug there.
      logger.error({ event: "media_request_bug", code: gatewayCodeOf(error) });
      if (!response.headersSent) sendError(request, response, "internal_error");
      else response.destroy();
    });
  }

  return {
    handle,
    beginShutdown() {
      shuttingDown = true;
    },
    get activeStreams() {
      return admission.activeStreams;
    },
  };
}
