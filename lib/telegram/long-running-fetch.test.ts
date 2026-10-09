import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { longRunningFetch } from "@/lib/telegram/long-running-fetch";

/**
 * Real loopback servers, no mocks of node:http. The >300 s case itself is an
 * operator experiment (docs/PHASE_C_INGESTION_DESIGN.md, "C2B.2F"): here the
 * same mechanism is exercised at small scale, with the caller's signal as the
 * only limit.
 */
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const requests: Array<{ method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/botTOKEN/sendDocument`, port, requests };
}

const hold = (ms: number, status = 200, payload: unknown = { ok: true, result: { message_id: 7 } }) => (_req: IncomingMessage, res: ServerResponse) => {
  const timer = setTimeout(() => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }, ms);
  res.on("close", () => clearTimeout(timer));
};

const post = (url: string, signal: AbortSignal, body = JSON.stringify({ chat_id: 1, document: "file:///media/movies/x.mkv" })) =>
  longRunningFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });

describe("longRunningFetch (sendDocument transport)", () => {
  it("waits for headers as long as the signal allows, then returns a fetch Response", async () => {
    const { url, requests } = await serve(hold(1500));
    const started = Date.now();
    const response = await post(url, AbortSignal.timeout(10_000));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { message_id: 7 } });
    // One POST with the JSON body, Content-Type and exact Content-Length.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/botTOKEN/sendDocument", body: JSON.stringify({ chat_id: 1, document: "file:///media/movies/x.mkv" }) });
    expect(requests[0].headers["content-type"]).toBe("application/json");
    expect(requests[0].headers["content-length"]).toBe(String(requests[0].body.length));
  });

  it("never goes through the global fetch (and so never through undici's 300 s headersTimeout)", async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error("global fetch must not be used")));
    vi.stubGlobal("fetch", globalFetch);
    const { url } = await serve(hold(200));
    expect((await post(url, AbortSignal.timeout(5_000))).status).toBe(200);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("the caller's signal is the finite limit: at its deadline the request is aborted with a TimeoutError", async () => {
    let closed = false;
    const { url } = await serve((req, res) => {
      res.on("close", () => (closed = true));
      hold(10_000)(req, res);
    });
    const started = Date.now();
    await expect(post(url, AbortSignal.timeout(300))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The connection is torn down, not left hanging.
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("an already-aborted signal sends nothing", async () => {
    const { url, requests } = await serve(hold(0));
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(post(url, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);
  });

  it("a server idle disconnect rejects the request while detached work can still finish", async () => {
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => (complete = resolve));
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => (disconnected = resolve));
    const { url, requests } = await serve((_req, res) => {
      // Model the Bot API's separate HTTP and upload lifetimes, not TDLib itself.
      res.on("close", disconnected);
      res.destroy();
      void closed.then(complete);
    });
    await expect(post(url, AbortSignal.timeout(5_000))).rejects.toMatchObject({
      name: "TypeError",
      cause: { code: "ECONNRESET" },
    });
    await completed;
    expect(requests).toHaveLength(1);
  });

  it("the deadline also destroys a response whose body has stalled", async () => {
    let closed = false;
    const { url, requests } = await serve((_req, res) => {
      res.on("close", () => (closed = true));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
      res.write('{"ok":tr');
    });
    await expect(post(url, AbortSignal.timeout(300))).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(requests).toHaveLength(1);
  });

  it("keeps fetch's error shape: a refused connection is TypeError with an ECONNREFUSED cause", async () => {
    const { port } = await serve(hold(0));
    const [server] = servers.splice(0);
    await new Promise((resolve) => server.close(resolve));
    const error = await post(`http://127.0.0.1:${port}/botTOKEN/sendDocument`, AbortSignal.timeout(5_000)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("fetch failed");
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("ECONNREFUSED");
  });

  it("a connection dropped mid-response is a fetch-shaped failure, never a partial success", async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
      res.write('{"ok":tr');
      setTimeout(() => res.destroy(), 50);
    });
    const error = await post(url, AbortSignal.timeout(5_000)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("fetch failed");
  });

  it("returns non-2xx replies as responses for the adapter to classify", async () => {
    const { url } = await serve(hold(0, 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }));
    const response = await post(url, AbortSignal.timeout(5_000));
    expect(response.status).toBe(429);
    expect((await response.json()).parameters.retry_after).toBe(3);
  });

  it("refuses anything but http and https", async () => {
    await expect(longRunningFetch("file:///etc/passwd", { method: "POST", body: "" })).rejects.toBeInstanceOf(TypeError);
  });
});
