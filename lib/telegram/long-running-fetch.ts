import "server-only";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * A fetch-compatible POST for local Bot API media calls (sendDocument), C2B.2F.
 *
 * Node's built-in fetch runs on undici's global dispatcher, which aborts a
 * request after 300 s without response headers (`headersTimeout`, error
 * UND_ERR_HEADERS_TIMEOUT), whatever AbortSignal the caller passes. The local
 * Bot API server sends no headers until Telegram has taken the whole file, so
 * every upload longer than 300 s ended `uncertain` while the server finished
 * it (C2B.2D).
 *
 * node:http and node:https have no header or body timeout of their own. Here
 * the caller's AbortSignal is the only limit, which makes the adapter's finite
 * upload timeout the real bound. The scope is one request:
 * - a fresh connection (`agent: false`);
 * - no global dispatcher or `fetch` change;
 * - no effect on any other request.
 *
 * Errors keep fetch's shape, so the adapter classifies them the same way:
 * - an abort rejects with the signal's reason (TimeoutError), so it is
 *   "uncertain";
 * - a transport failure rejects as TypeError("fetch failed") with the socket
 *   error as `cause`, so ECONNREFUSED is "unreachable" and anything else is
 *   "uncertain".
 */
export const longRunningFetch = ((input: string | URL | Request, init: RequestInit = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new TypeError("fetch failed", { cause: new Error("unsupported protocol") }));
      return;
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const body = typeof init.body === "string" ? init.body : "";
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), "Content-Length": String(Buffer.byteLength(body)) };

    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const failed = (error: unknown) => finish(() => reject(new TypeError("fetch failed", { cause: error })));

    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: init.method ?? "POST", headers, agent: false }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", failed);
      res.on("aborted", () => failed(new Error("response aborted")));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === "string") responseHeaders.set(name, value);
          else if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        }
        const empty = status === 204 || status === 205 || status === 304 || status < 200;
        finish(() => resolve(new Response(empty ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage, headers: responseHeaders })));
      });
    });
    function onAbort() {
      // The server may already be uploading: the caller treats this as uncertain, never as "not sent".
      finish(() => reject(signal!.reason));
      req.destroy();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", failed);
    req.end(body);
  })) as typeof fetch;
