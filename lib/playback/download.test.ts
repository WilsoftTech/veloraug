import { describe, expect, it, vi } from "vitest";
import { DOWNLOAD_GUIDANCE, launchBrowserDownload, prepareDownload } from "./download";
import { createStreamTokenHandler } from "./stream-token";

const URL = "https://media.velora.example/v1/movie-versions/4/download?token=opaque";
const issue = (url = URL) => Response.json({ downloadUrl: url, expiresAt: "2026-10-11T12:10:00Z" }, { headers: { date: "Sun, 11 Oct 2026 12:00:00 GMT" } });
const probe = (mime = "video/x-matroska") => new Response("x", { status: 206, headers: { "content-type": mime, "content-length": "1", "content-range": "bytes 0-0/100" } });
const fake = (...responses: (Response | Error)[]) => vi.fn(async () => {
  const response = responses.shift(); if (response instanceof Error) throw response;
  if (!response) throw new Error("unexpected request"); return response;
});

describe("browser-managed download authorization and bounded readiness", () => {
  it.each(["video/mp4", "video/x-matroska"])("gets fresh authorization and probes one byte for %s", async (mime) => {
    const fetcher = fake(issue(), probe(mime));
    expect(await prepareDownload(4, fetcher)).toEqual({ ok: true, url: URL, format: mime === "video/mp4" ? "MP4" : "MKV" });
    expect(fetcher.mock.calls).toHaveLength(2);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]).toEqual(["/api/media/download-token", expect.objectContaining({ method: "POST", body: '{"movieVersionId":4}', credentials: "same-origin", cache: "no-store" })]);
    expect(calls[1]).toEqual([URL, expect.objectContaining({ headers: { Range: "bytes=0-0" }, credentials: "omit", referrerPolicy: "no-referrer" })]);
  });
  it.each([[401, "auth_required"], [403, "not_entitled"], [404, "unavailable"], [429, "temporarily_unavailable"], [503, "temporarily_unavailable"]] as const)("denied issuance %s never fetches media", async (status, failure) => {
    const fetcher = fake(new Response("{}", { status }));
    expect(await prepareDownload(4, fetcher)).toEqual({ ok: false, failure }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reissues at most once after expiry and checks authentication again", async () => {
    const fetcher = fake(issue(), new Response(null, { status: 401 }), issue(), probe());
    expect((await prepareDownload(4, fetcher)).ok).toBe(true); expect(fetcher).toHaveBeenCalledTimes(4);
    const expired = fake(issue(), new Response(null, { status: 401 }), issue(), new Response(null, { status: 401 }));
    expect(await prepareDownload(4, expired)).toEqual({ ok: false, failure: "expired" }); expect(expired).toHaveBeenCalledTimes(4);
    const signedOut = fake(issue(), new Response(null, { status: 401 }), new Response(null, { status: 401 }));
    expect(await prepareDownload(4, signedOut)).toEqual({ ok: false, failure: "auth_required" });
  });
  it("does not renew revoked or unpublished downloads silently", async () => {
    for (const status of [403, 404]) {
      const fetcher = fake(issue(), new Response(null, { status }));
      expect((await prepareDownload(4, fetcher)).ok).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it("cancels ignored Range bodies without buffering any bytes", async () => {
    const cancel = vi.fn(); const pull = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const fetcher = fake(issue(), new Response(body, { status: 200, headers: { "content-length": "2097152000" } }));
    expect(await prepareDownload(4, fetcher)).toEqual({ ok: false, failure: "temporarily_unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(pull).not.toHaveBeenCalled();
  });
  it("handles network failure and timeout without navigation or an unbounded retry", async () => {
    expect(await prepareDownload(4, fake(new TypeError("offline")))).toEqual({ ok: false, failure: "network" });
    const stalled = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort"))));
    expect(await prepareDownload(4, stalled, undefined, 10)).toEqual({ ok: false, failure: "network" });
  });
  it.each(["javascript:alert(1)", "https://media.velora.example/v1/movie-versions/99/download", "http://public.example/v1/movie-versions/4/download", "https://user:password@media.velora.example/v1/movie-versions/4/download"])("rejects unexpected capability destination %s", async (url) => {
    expect((await prepareDownload(4, fake(issue(url)))).ok).toBe(false);
  });
  it("treats malformed issuer success and unknown MIME as availability failures", async () => {
    for (const response of [new Response("not JSON"), Response.json({}), Response.json({ downloadUrl: "invalid URL", expiresAt: "2026-10-11T12:10:00Z" })]) {
      expect(await prepareDownload(4, fake(response))).toEqual({ ok: false, failure: "temporarily_unavailable" });
    }
    expect(await prepareDownload(4, fake(issue(), probe("application/octet-stream")))).toEqual({ ok: false, failure: "temporarily_unavailable" });
  });
  it("hands off with no filename override or persistent DOM token and explains resume limits", () => {
    const anchor = { click: vi.fn(), remove: vi.fn(), href: "", target: "", rel: "", referrerPolicy: "" };
    const doc = { createElement: vi.fn(() => anchor), body: { append: vi.fn() } } as unknown as Document;
    launchBrowserDownload(URL, doc);
    expect(anchor).toMatchObject({ href: URL, target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" });
    expect(anchor).not.toHaveProperty("download"); expect(anchor.remove).toHaveBeenCalledOnce(); expect(anchor.click).toHaveBeenCalledOnce();
    expect(DOWNLOAD_GUIDANCE).toContain("may restart"); expect(DOWNLOAD_GUIDANCE).toContain("cannot track completion");
    // A started download continues; a link only starts or resumes one for ten minutes. No seamless-resume promise.
    expect(DOWNLOAD_GUIDANCE).toContain("keeps running"); expect(DOWNLOAD_GUIDANCE).toContain("start or resume a download for 10 minutes");
    expect(DOWNLOAD_GUIDANCE).not.toMatch(/seamless|automatically|always resume/i);
  });
});

describe("retry against the real authenticated download issuer", () => {
  it("checks fresh identity, entitlement and publication on every continuation", async () => {
    const state = { signedIn: true, entitled: true, published: true }; const auth = vi.fn(); const decide = vi.fn();
    const post = createStreamTokenHandler({ accountsConfigured: () => true,
      currentUser: async () => { auth(); return state.signedIn ? { id: "00000000-0000-4000-8000-000000000051", email: null } : null; },
      decide: async (user, id) => { decide(); return !user ? { allowed: false, reason: "authentication_required" } : !state.entitled ? { allowed: false, reason: "not_entitled" } : !state.published ? { allowed: false, reason: "unavailable" } : { allowed: true, movieVersionId: id, subject: user.id }; },
      loadConfig: () => ({ secret: new Uint8Array(32).fill(8), gatewayOrigin: "https://media.velora.example" }),
    }, "download");
    let reads = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => input === "/api/media/download-token" ? post(new Request("https://velora.example/api/media/download-token", { ...init, headers: { ...init?.headers, "Sec-Fetch-Site": "same-origin" } })) : (reads++, probe());
    expect((await prepareDownload(4, fetcher)).ok).toBe(true);
    state.signedIn = false; expect(await prepareDownload(4, fetcher)).toEqual({ ok: false, failure: "auth_required" });
    state.signedIn = true; state.entitled = false; expect(await prepareDownload(4, fetcher)).toEqual({ ok: false, failure: "not_entitled" });
    state.entitled = true; state.published = false; expect(await prepareDownload(4, fetcher)).toEqual({ ok: false, failure: "unavailable" });
    state.published = true; expect((await prepareDownload(4, fetcher)).ok).toBe(true);
    expect(auth).toHaveBeenCalledTimes(5); expect(decide).toHaveBeenCalledTimes(5); expect(reads).toBe(2);
  });
});
