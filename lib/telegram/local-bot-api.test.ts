import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRecoveryMarker, reconcileUpload } from "@/lib/ingestion/recovery";
import { buildUploadCaption, fingerprintFromCaption, TELEGRAM_CAPTION_MAX, TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import {
  createLocalBotApiClient,
  loadLocalBotApiConfig,
  parseBotApiBaseUrl,
  toServerFileUri,
  type Env,
  type LocalBotApiConfig,
  type StatFile,
  type UploadRequest,
} from "@/lib/telegram/local-bot-api";
import type { SourceFingerprint } from "@/types/ingestion";

// Fake credentials: the right shape, never real.
const MOVIE_TOKEN = "1111111:AAAAmovieFAKEtokenFAKEtokenFAKEtok";
const SERIES_TOKEN = "2222222:BBBBseriesFAKEtokenFAKEtokenFAKEto";
const MOVIES = -1001111111111;
const SERIES = -1002222222222;
const OPS = -1003333333333;
const FP = `sf1-${"a".repeat(64)}` as SourceFingerprint;
const SIZE = 1_500_000_000;

const ENV: Env = {
  TELEGRAM_BOT_API_URL: "http://127.0.0.1:8081",
  TELEGRAM_MOVIES_BOT_TOKEN: MOVIE_TOKEN,
  TELEGRAM_SERIES_BOT_TOKEN: SERIES_TOKEN,
  TELEGRAM_MOVIES_CHANNEL_ID: String(MOVIES),
  TELEGRAM_SERIES_CHANNEL_ID: String(SERIES),
  TELEGRAM_RECONCILE_CHAT_ID: String(OPS),
};

function config(env: Env = ENV): LocalBotApiConfig {
  const loaded = loadLocalBotApiConfig(env);
  if (!loaded.ok) throw new Error(loaded.errors.join("; "));
  return loaded.config;
}

const caption = (fingerprint = FP) => buildUploadCaption({ kind: "movie", title: "John Wick", year: 2014, vjName: "VJ Junior", season: null, episode: null, fingerprint });

function request(overrides: Partial<UploadRequest> = {}): UploadRequest {
  return { transport: "movie", kind: "movie", intendedChannelId: MOVIES, absolutePath: "C:\\Media\\Movies\\John.Wick.2014.VJ.Junior.mkv", sizeBytes: SIZE, fingerprint: FP, caption: caption(), ...overrides };
}

function sentMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 42,
    date: 1_790_000_000,
    chat: { id: MOVIES, type: "channel", title: "Movies" },
    caption: caption(),
    document: { file_id: "BQACAgQAAx0-file", file_unique_id: "AgADuniq", file_name: "John.Wick.2014.VJ.Junior.mkv", mime_type: "video/x-matroska", file_size: SIZE },
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const regularFile: StatFile = async () => ({ isFile: true, size: SIZE });

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, stat: StatFile = regularFile, cfg = config()) {
  const fetch = vi.fn(fetchImpl);
  return { fetch, api: createLocalBotApiClient(cfg, { fetch: fetch as unknown as typeof globalThis.fetch, stat, uploadTimeoutMs: 1000, requestTimeoutMs: 1000 }) };
}

const noNetwork = () => Promise.reject(new Error("the network must not be reached"));

afterEach(() => vi.restoreAllMocks());

describe("local Bot API configuration: fail closed", () => {
  it("accepts a loopback or HTTPS self-hosted origin", () => {
    expect(parseBotApiBaseUrl("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
    expect(parseBotApiBaseUrl("http://localhost:8081/")).toBe("http://localhost:8081");
    expect(parseBotApiBaseUrl("https://bot-api.internal.example")).toBe("https://bot-api.internal.example");
  });

  it("never accepts Telegram's cloud endpoint, however it is written", () => {
    for (const url of ["https://api.telegram.org", "https://API.Telegram.org/", "http://api.telegram.org:443", "https://telegram.org", "https://x.api.telegram.org"]) {
      expect(parseBotApiBaseUrl(url), url).toBeNull();
    }
  });

  it("rejects missing, malformed, plain-HTTP-remote and credential-bearing URLs", () => {
    for (const url of [undefined, "", "not a url", "ftp://127.0.0.1", "http://192.168.1.5:8081", "http://user:pass@127.0.0.1:8081", "http://127.0.0.1:8081/bot123/", "http://127.0.0.1:8081?x=1"]) {
      expect(parseBotApiBaseUrl(url), String(url)).toBeNull();
    }
  });

  it("has no default: without the URL the whole configuration fails", () => {
    const loaded = loadLocalBotApiConfig({ ...ENV, TELEGRAM_BOT_API_URL: undefined });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.join(" ")).toContain("TELEGRAM_BOT_API_URL");
  });

  it("reports variable names, never values", () => {
    const loaded = loadLocalBotApiConfig({ ...ENV, TELEGRAM_MOVIES_BOT_TOKEN: "leaky-secret-value", TELEGRAM_SERIES_CHANNEL_ID: "@series" });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      const text = loaded.errors.join("\n");
      expect(text).toContain("TELEGRAM_MOVIES_BOT_TOKEN");
      expect(text).toContain("TELEGRAM_SERIES_CHANNEL_ID");
      expect(text).not.toContain("leaky-secret-value");
      expect(text).not.toContain("@series");
      expect(text).not.toContain(SERIES_TOKEN);
    }
  });

  it("requires two distinct bots and two distinct channels", () => {
    expect(loadLocalBotApiConfig({ ...ENV, TELEGRAM_SERIES_BOT_TOKEN: MOVIE_TOKEN }).ok).toBe(false);
    expect(loadLocalBotApiConfig({ ...ENV, TELEGRAM_SERIES_CHANNEL_ID: String(MOVIES) }).ok).toBe(false);
    expect(loadLocalBotApiConfig({ ...ENV, TELEGRAM_RECONCILE_CHAT_ID: String(MOVIES) }).ok).toBe(false);
  });
});

describe("routing: two bots, two channels", () => {
  it("sends a movie with the movie bot to the Movies channel", async () => {
    const { fetch, api } = client(async () => json({ ok: true, result: sentMessage() }));
    const outcome = await api.sendDocument(request());
    expect(outcome.status).toBe("succeeded");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8081/bot${MOVIE_TOKEN}/sendDocument`);
    expect(JSON.parse(String(init.body)).chat_id).toBe(MOVIES);
  });

  it("sends an episode with the series bot to the Series channel", async () => {
    const seriesCaption = buildUploadCaption({ kind: "series", title: "Prison Break", year: null, vjName: "Junior", season: 1, episode: 2, fingerprint: FP });
    const { fetch, api } = client(async () => json({ ok: true, result: sentMessage({ chat: { id: SERIES, type: "channel" }, caption: seriesCaption }) }));
    const outcome = await api.sendDocument(request({ transport: "series", kind: "series", intendedChannelId: SERIES, caption: seriesCaption }));
    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") expect(outcome.record.botType).toBe("series");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8081/bot${SERIES_TOKEN}/sendDocument`);
    expect(JSON.parse(String(init.body)).chat_id).toBe(SERIES);
  });

  it("refuses a movie through the series transport, and an episode through the movie transport, before the network", async () => {
    const { fetch, api } = client(noNetwork);
    expect(await api.sendDocument(request({ transport: "series" }))).toEqual({ status: "rejected", code: "transport_kind_mismatch", permanent: true });
    expect(await api.sendDocument(request({ kind: "series" }))).toEqual({ status: "rejected", code: "transport_kind_mismatch", permanent: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses when the configured channel differs from the one planned (a file name never picks the channel)", async () => {
    const { fetch, api } = client(noNetwork);
    expect(await api.sendDocument(request({ intendedChannelId: SERIES }))).toMatchObject({ status: "rejected", code: "channel_changed_since_plan" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("preflight: rejected before any network call", () => {
  const cases: [string, Partial<UploadRequest>, StatFile, string][] = [
    ["over the 2000 MiB ceiling (declared)", { sizeBytes: TELEGRAM_MAX_FILE_BYTES + 1 }, async () => ({ isFile: true, size: TELEGRAM_MAX_FILE_BYTES + 1 }), "file_too_large"],
    ["over the ceiling on disk", {}, async () => ({ isFile: true, size: TELEGRAM_MAX_FILE_BYTES + 1 }), "file_too_large"],
    ["zero bytes (declared)", { sizeBytes: 0 }, regularFile, "empty_file"],
    ["zero bytes on disk", {}, async () => ({ isFile: true, size: 0 }), "empty_file"],
    ["unsupported extension", { absolutePath: "C:\\Media\\Movies\\John.Wick.srt" }, regularFile, "unsupported_extension"],
    ["not a regular file", {}, async () => ({ isFile: false, size: SIZE }), "not_a_regular_file"],
    ["missing file", {}, async () => { throw new Error("ENOENT"); }, "source_unreadable"],
    ["changed since the scan", {}, async () => ({ isFile: true, size: SIZE - 1 }), "source_changed_since_scan"],
    ["relative path", { absolutePath: "Movies/John.Wick.mkv" }, regularFile, "path_not_absolute"],
    ["caption without this fingerprint", { caption: caption(`sf1-${"b".repeat(64)}` as SourceFingerprint) }, regularFile, "caption_token_mismatch"],
    ["caption too long", { caption: `${"x".repeat(TELEGRAM_CAPTION_MAX)}\nvelora-src:${FP}` }, regularFile, "caption_too_long"],
    ["invalid fingerprint", { fingerprint: "sf1-nope" as SourceFingerprint }, regularFile, "invalid_fingerprint"],
  ];

  for (const [name, overrides, stat, code] of cases) {
    it(name, async () => {
      const { fetch, api } = client(noNetwork, stat);
      expect(await api.sendDocument(request(overrides))).toMatchObject({ status: "rejected", code });
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("accepts exactly the ceiling", async () => {
    const { api } = client(noNetwork, async () => ({ isFile: true, size: TELEGRAM_MAX_FILE_BYTES }));
    expect(await api.preflight(request({ sizeBytes: TELEGRAM_MAX_FILE_BYTES }))).toEqual({ ok: true, channelId: MOVIES });
  });

  it("the public preflight result never carries the token", async () => {
    const { api } = client(noNetwork);
    expect(JSON.stringify(await api.preflight(request()))).not.toContain(MOVIE_TOKEN);
  });
});

describe("local-path upload: the file never passes through Node", () => {
  it("sends a file URI, not file bytes", async () => {
    const { fetch, api } = client(async () => json({ ok: true, result: sentMessage() }));
    await api.sendDocument(request());
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body.document).toBe("file:///C:/Media/Movies/John.Wick.2014.VJ.Junior.mkv");
    expect(String(fetch.mock.calls[0][1].body).length).toBeLessThan(2000);
  });

  it("the adapter module never imports a file-reading API (only an injected stat)", () => {
    const source = readFileSync(join(__dirname, "local-bot-api.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']node:fs|createReadStream|readFile|openAsBlob/);
  });

  it("maps a local library prefix to the server's view of it", () => {
    const map = { local: "C:\\Media", server: "/srv/media" };
    expect(toServerFileUri("C:\\Media\\Movies\\A b.mkv", map)).toBe("file:///srv/media/Movies/A%20b.mkv");
    expect(toServerFileUri("c:\\media\\Movies\\A.mkv", map)).toBe("file:///srv/media/Movies/A.mkv");
    expect(toServerFileUri("D:\\Other\\A.mkv", map)).toBeNull();
    expect(toServerFileUri("/home/op/Media/A.mkv", null)).toBe("file:///home/op/Media/A.mkv");
  });
});

describe("sendDocument reply handling", () => {
  it("maps a successful reply onto the telegram_media identity", async () => {
    const { api } = client(async () => json({ ok: true, result: sentMessage() }));
    expect(await api.sendDocument(request())).toEqual({
      status: "succeeded",
      record: {
        botType: "movie",
        chatId: MOVIES,
        messageId: 42,
        fileId: "BQACAgQAAx0-file",
        fileUniqueId: "AgADuniq",
        mediaKind: "document",
        fileName: "John.Wick.2014.VJ.Junior.mkv",
        mimeType: "video/x-matroska",
        caption: caption(),
        fileSizeBytes: SIZE,
        durationSeconds: null,
        width: null,
        height: null,
        telegramDate: new Date(1_790_000_000 * 1000).toISOString(),
        sourceFingerprint: FP,
      },
    });
  });

  it("tolerates absent optional fields without inventing them", async () => {
    const { api } = client(async () => json({ ok: true, result: sentMessage({ document: { file_id: "f", file_unique_id: "u" } }) }));
    const outcome = await api.sendDocument(request());
    expect(outcome).toMatchObject({ status: "succeeded", record: { fileName: null, mimeType: null, fileSizeBytes: null } });
  });

  it("treats a reply that cannot be validated as uncertain, never as a partial identity", async () => {
    const replies: [unknown, string][] = [
      [sentMessage({ document: undefined }), "message_without_media"],
      [sentMessage({ message_id: "42" }), "malformed_message"],
      [sentMessage({ chat: { id: SERIES, type: "channel" } }), "unexpected_chat"],
      [sentMessage({ caption: "no token" }), "caption_token_missing"],
      [sentMessage({ document: { file_id: "f", file_unique_id: "u", file_size: SIZE - 1 } }), "size_mismatch"],
    ];
    for (const [result, code] of replies) {
      const { api } = client(async () => json({ ok: true, result }));
      expect(await api.sendDocument(request())).toEqual({ status: "uncertain", code });
    }
  });

  it("treats a malformed or unreadable envelope as uncertain", async () => {
    expect(await client(async () => json({ hello: "world" })).api.sendDocument(request())).toEqual({ status: "uncertain", code: "malformed_reply_200" });
    expect(await client(async () => new Response("<html>bad gateway</html>", { status: 502 })).api.sendDocument(request())).toEqual({ status: "uncertain", code: "unreadable_reply_502" });
  });

  it("classifies Telegram errors: 4xx definite, 5xx uncertain", async () => {
    const error = (code: number, description: string, retryAfter?: number) => async () => json({ ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) }, code);
    expect(await client(error(400, "Bad Request: file is too big")).api.sendDocument(request())).toEqual({ status: "failed", code: "file_too_large", retryable: false, retryAfterSeconds: null });
    expect(await client(error(403, "Forbidden: bot is not a member of the channel chat")).api.sendDocument(request())).toEqual({ status: "failed", code: "telegram_forbidden", retryable: true, retryAfterSeconds: null });
    expect(await client(error(429, "Too Many Requests", 30)).api.sendDocument(request())).toEqual({ status: "failed", code: "telegram_rate_limited", retryable: true, retryAfterSeconds: 30 });
    expect(await client(error(500, "Internal Server Error")).api.sendDocument(request())).toEqual({ status: "uncertain", code: "telegram_server_500" });
  });

  it("a timeout is uncertain (the local server may still post the file)", async () => {
    const { api } = client(() => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
    expect(await api.sendDocument(request())).toEqual({ status: "uncertain", code: "timeout" });
  });

  it("a refused connection is a definite, retryable failure", async () => {
    const { api } = client(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));
    expect(await api.sendDocument(request())).toEqual({ status: "failed", code: "bot_api_unreachable", retryable: true, retryAfterSeconds: null });
  });

  it("never echoes a transport error (which could contain the URL and token) or logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api } = client(() => Promise.reject(new TypeError(`fetch failed for http://127.0.0.1:8081/bot${MOVIE_TOKEN}/sendDocument`)));
    const outcome = await api.sendDocument(request());
    expect(outcome).toEqual({ status: "uncertain", code: "network_error" });
    expect(JSON.stringify(outcome)).not.toContain(MOVIE_TOKEN);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("channel probe for reconciliation", () => {
  const forwarded = (overrides: Record<string, unknown> = {}) => ({
    message_id: 900,
    date: 1_790_000_500,
    chat: { id: OPS, type: "channel" },
    forward_origin: { type: "channel", chat: { id: MOVIES, type: "channel" }, message_id: 42, date: 1_790_000_000 },
    caption: caption(),
    document: { file_id: "BQACAgQAAx0-file", file_unique_id: "AgADuniq", file_size: SIZE },
    ...overrides,
  });
  const refusal = (error_code: number, description: string, retry_after?: number) =>
    json({ ok: false, error_code, description, ...(retry_after === undefined ? {} : { parameters: { retry_after } }) }, error_code);
  const probeWith = async (reply: () => Promise<Response>) => client(reply).api.probeChannelMessage("movie", 43);

  it("forwards one message to the private group, reads it, and deletes the copy", async () => {
    const { fetch, api } = client(async (url) => (url.endsWith("/forwardMessage") ? json({ ok: true, result: forwarded() }) : json({ ok: true, result: true })));
    const result = await api.probeChannelMessage("movie", 42);
    expect(result).toMatchObject({ status: "found", record: { chatId: MOVIES, messageId: 42, fileUniqueId: "AgADuniq", sourceFingerprint: FP, telegramDate: new Date(1_790_000_000 * 1000).toISOString() } });
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ chat_id: OPS, from_chat_id: MOVIES, message_id: 42, disable_notification: true });
    expect(fetch.mock.calls[1][0]).toContain("/deleteMessage");
    expect(JSON.parse(String(fetch.mock.calls[1][1].body)).chat_id).toBe(OPS);
  });

  it("only Telegram's exact not-found reply means missing", async () => {
    expect(await probeWith(async () => refusal(400, "Bad Request: message to forward not found"))).toEqual({ status: "missing" });
    // Any other 400 (a service message, protected content, or new wording) could hide a message.
    for (const description of ["Bad Request: message can't be forwarded", "Bad Request: message has protected content and can't be forwarded", "Bad Request: MESSAGE_ID_INVALID", "Bad Request: message to forward not found (retry)", ""]) {
      expect(await probeWith(async () => refusal(400, description)), description).toEqual({ status: "uninspectable", code: "telegram_rejected_400" });
    }
    expect(await probeWith(async () => refusal(404, "Not Found"))).toEqual({ status: "uninspectable", code: "telegram_rejected_404" });
  });

  it("classifies rate limits, transient failures and permission failures by status code, never as missing", async () => {
    expect(await probeWith(async () => refusal(429, "Too Many Requests: retry after 7", 7))).toEqual({ status: "rate_limited", retryAfterSeconds: 7 });
    expect(await probeWith(async () => refusal(429, "Too Many Requests"))).toEqual({ status: "rate_limited", retryAfterSeconds: null });
    expect(await probeWith(async () => refusal(502, "Bad Gateway"))).toEqual({ status: "transient", code: "telegram_server_502" });
    expect(await probeWith(async () => refusal(403, "Forbidden: bot is not a member of the channel chat"))).toEqual({ status: "blocked", code: "telegram_forbidden" });
    expect(await probeWith(async () => refusal(401, "Unauthorized"))).toEqual({ status: "blocked", code: "telegram_unauthorized" });
    expect(await probeWith(async () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })))).toEqual({ status: "transient", code: "probe_timeout" });
    expect(await probeWith(async () => Promise.reject(Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } })))).toEqual({ status: "transient", code: "bot_api_unreachable" });
  });

  it("reports a non-media message, and an unreadable forward as uninspectable", async () => {
    const reply = (result: unknown) => async (url: string) => (url.endsWith("/forwardMessage") ? json({ ok: true, result }) : json({ ok: true, result: true }));
    expect(await client(reply(forwarded({ caption: undefined, document: undefined, text: "hi" }))).api.probeChannelMessage("movie", 42)).toEqual({ status: "not_media" });
    expect(await client(reply(forwarded({ forward_origin: { type: "channel", chat: { id: SERIES }, message_id: 42, date: 1 } }))).api.probeChannelMessage("movie", 42)).toEqual({ status: "uninspectable", code: "unexpected_forward" });
    expect(await client(reply({ message_id: 900 })).api.probeChannelMessage("movie", 42)).toEqual({ status: "uninspectable", code: "unexpected_forward" });
  });

  it("needs a recovery group", async () => {
    const { fetch, api } = client(noNetwork, regularFile, config({ ...ENV, TELEGRAM_RECONCILE_CHAT_ID: undefined }));
    expect(await api.probeChannelMessage("movie", 42)).toEqual({ status: "blocked", code: "reconcile_chat_not_configured" });
    expect(await api.checkRecoveryAccess("movie")).toEqual({ status: "blocked", code: "reconcile_chat_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("recovery access check (read-only)", () => {
  const chat = (id: number, extra: Record<string, unknown> = {}) => json({ ok: true, result: { id, type: "channel", ...extra } });

  it("reads the kind's channel and the recovery group with the kind's bot, and nothing else", async () => {
    for (const [kind, token, channel] of [["movie", MOVIE_TOKEN, MOVIES], ["series", SERIES_TOKEN, SERIES]] as const) {
      const { fetch, api } = client(async (_url, init) => chat(JSON.parse(String(init.body)).chat_id));
      expect(await api.checkRecoveryAccess(kind)).toEqual({ status: "ok" });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([`http://127.0.0.1:8081/bot${token}/getChat`, `http://127.0.0.1:8081/bot${token}/getChat`]);
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ chat_id: channel }, { chat_id: OPS }]);
    }
  });

  it("stops before any marker when the channel protects its content", async () => {
    const { fetch, api } = client(async () => chat(MOVIES, { has_protected_content: true }));
    expect(await api.checkRecoveryAccess("movie")).toEqual({ status: "blocked", code: "channel_content_protected" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps failures without reading descriptions", async () => {
    expect(await client(async () => json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400)).api.checkRecoveryAccess("movie")).toEqual({ status: "blocked", code: "get_chat_rejected_400" });
    expect(await client(async () => json({ ok: false, error_code: 429, description: "x", parameters: { retry_after: 3 } }, 429)).api.checkRecoveryAccess("movie")).toEqual({ status: "rate_limited", retryAfterSeconds: 3 });
    expect(await client(async () => chat(SERIES)).api.checkRecoveryAccess("movie")).toEqual({ status: "blocked", code: "get_chat_unexpected_reply" });
  });
});

describe("recovery marker post", () => {
  const MARKER_TEXT = buildRecoveryMarker(FP, 1, new Date("2026-09-25T10:00:00Z"));
  const sent = (chatId: number, text = MARKER_TEXT, messageId = 77) => json({ ok: true, result: { message_id: messageId, date: 1_790_000_000, chat: { id: chatId, type: "channel" }, text } });

  it("posts the movie marker with the movie bot to the Movies channel, and the series marker with the series bot to the Series channel", async () => {
    for (const [kind, token, channel] of [["movie", MOVIE_TOKEN, MOVIES], ["series", SERIES_TOKEN, SERIES]] as const) {
      const { fetch, api } = client(async () => sent(channel));
      expect(await api.postRecoveryMarker(kind, MARKER_TEXT)).toEqual({ status: "posted", messageId: 77 });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:8081/bot${token}/sendMessage`);
      expect(JSON.parse(String(fetch.mock.calls[0][1].body)).chat_id).toBe(channel);
    }
  });

  it("is a text message only: no document, file, path or caption, and never sendDocument", async () => {
    const { fetch, api } = client(async () => sent(MOVIES));
    await api.postRecoveryMarker("movie", MARKER_TEXT);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ chat_id: MOVIES, text: MARKER_TEXT, disable_notification: true, link_preview_options: { is_disabled: true } });
    expect(fetch.mock.calls.some(([url]) => /sendDocument|sendVideo|deleteMessage/.test(url))).toBe(false);
  });

  it("refuses any text that is not a marker, without a network call", async () => {
    const { fetch, api } = client(noNetwork);
    for (const text of [caption(), `velora-src:${FP}`, "C:\\Media\\Movies\\John.Wick.2014.VJ.Junior.mkv", `${MARKER_TEXT}\n${caption()}`, ""]) {
      expect(await api.postRecoveryMarker("movie", text)).toEqual({ status: "blocked", code: "marker_text_invalid" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept a reply for another chat or other text as the upper bound", async () => {
    expect(await client(async () => sent(SERIES)).api.postRecoveryMarker("movie", MARKER_TEXT)).toEqual({ status: "blocked", code: "marker_unexpected_reply" });
    expect(await client(async () => sent(MOVIES, "edited")).api.postRecoveryMarker("movie", MARKER_TEXT)).toEqual({ status: "blocked", code: "marker_unexpected_reply" });
    expect(await client(async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))).api.postRecoveryMarker("movie", MARKER_TEXT)).toEqual({ status: "transient", code: "marker_timeout" });
    expect(await client(async () => json({ ok: false, error_code: 403, description: "Forbidden: not enough rights" }, 403)).api.postRecoveryMarker("movie", MARKER_TEXT)).toEqual({ status: "blocked", code: "telegram_forbidden" });
  });
});

describe("bounded recovery over the real client (fake Telegram)", () => {
  /** A fake local Bot API: channel messages by id, a marker landing at `markerId`, and no delete rights anywhere. */
  function telegramServer(messages: Record<number, Record<string, unknown>>, markerId: number) {
    return async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/getChat")) return json({ ok: true, result: { id: body.chat_id, type: "channel" } });
      if (url.endsWith("/sendMessage")) return json({ ok: true, result: { message_id: markerId, date: 1_790_000_000, chat: { id: body.chat_id, type: "channel" }, text: body.text } });
      if (url.endsWith("/deleteMessage")) return json({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }, 400);
      if (url.endsWith("/forwardMessage")) {
        const message = messages[body.message_id];
        if (!message) return json({ ok: false, error_code: 400, description: "Bad Request: message to forward not found" }, 400);
        return json({ ok: true, result: { message_id: 5000 + body.message_id, date: 1_790_000_500, chat: { id: OPS, type: "supergroup" }, forward_origin: { type: "channel", chat: { id: MOVIES, type: "channel" }, message_id: body.message_id, date: 1_790_000_000 }, ...message } });
      }
      throw new Error(`unexpected call ${url}`);
    };
  }
  const transport = (api: ReturnType<typeof client>["api"]) => ({
    checkAccess: () => api.checkRecoveryAccess("movie"),
    postMarker: (text: string) => api.postRecoveryMarker("movie", text),
    probe: (id: number) => api.probeChannelMessage("movie", id),
  });
  const run = (api: ReturnType<typeof client>["api"]) =>
    reconcileUpload({ fingerprint: FP, sizeBytes: SIZE, attemptNumber: 1, floorMessageId: 10, transport: transport(api), sleep: async () => {}, now: () => new Date("2026-09-25T10:00:00Z") });

  it("finds the file behind a 150-id deleted gap, although neither marker nor copies can be deleted", async () => {
    const { fetch, api } = client(telegramServer({ 161: { caption: caption(), document: { file_id: "f", file_unique_id: "u", file_size: SIZE } } }, 175));
    expect(await run(api)).toMatchObject({ status: "found", record: { messageId: 161, sourceFingerprint: FP } });
    const calls = fetch.mock.calls.map(([url, init]) => ({ method: url.slice(url.lastIndexOf("/") + 1), body: JSON.parse(String(init.body)) }));
    // Nothing was ever deleted from the channel, and no media was sent.
    expect(calls.filter(({ method }) => method === "deleteMessage").every(({ body }) => body.chat_id === OPS)).toBe(true);
    expect(calls.some(({ method }) => /sendDocument|sendVideo/.test(method))).toBe(false);
    expect(calls.filter(({ method }) => method === "sendMessage")).toHaveLength(1);
    expect(calls.filter(({ method }) => method === "forwardMessage").map(({ body }) => body.message_id)).toEqual(Array.from({ length: 164 }, (_, index) => 11 + index));
  });

  it("confirms absence only across the full interval, and a non-forwardable message blocks that conclusion", async () => {
    expect(await run(client(telegramServer({ 12: { text: "a note" } }, 40)).api)).toMatchObject({ status: "not_found_confirmed", marker: { messageId: 40 } });
    const service = async (url: string, init: RequestInit) =>
      url.endsWith("/forwardMessage") && JSON.parse(String(init.body)).message_id === 20
        ? json({ ok: false, error_code: 400, description: "Bad Request: message can't be forwarded" }, 400)
        : telegramServer({}, 40)(url, init);
    expect(await run(client(service).api)).toEqual({ status: "incomplete", reason: "uninspectable_message", messageIds: [20] });
  });
});

describe("upload caption", () => {
  it("is deterministic, human-readable, and ends with the machine token", () => {
    const input = { kind: "series" as const, title: "Prison  Break\n", year: 2005, vjName: "Junior", season: 1, episode: 2, fingerprint: FP };
    expect(buildUploadCaption(input)).toBe(buildUploadCaption(input));
    expect(buildUploadCaption(input)).toBe(`Prison Break (2005)\nVJ Junior\nSeries S01E02\nvelora-src:${FP}`);
    expect(fingerprintFromCaption(buildUploadCaption(input))).toBe(FP);
  });

  it("never contains a path and always fits Telegram's caption limit with the token intact", () => {
    const text = buildUploadCaption({ kind: "movie", title: "T".repeat(5000), year: null, vjName: "V".repeat(5000), season: null, episode: null, fingerprint: FP });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX);
    expect(fingerprintFromCaption(text)).toBe(FP);
    expect(caption()).not.toMatch(/[\\/]|\.mkv/);
  });
});
