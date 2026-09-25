import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("forwards one message to the private chat, reads it, and deletes the copy", async () => {
    const { fetch, api } = client(async (url) => (url.endsWith("/forwardMessage") ? json({ ok: true, result: forwarded() }) : json({ ok: true, result: true })));
    const result = await api.probeChannelMessage("movie", 42);
    expect(result).toMatchObject({ status: "found", record: { chatId: MOVIES, messageId: 42, fileUniqueId: "AgADuniq", sourceFingerprint: FP, telegramDate: new Date(1_790_000_000 * 1000).toISOString() } });
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ chat_id: OPS, from_chat_id: MOVIES, message_id: 42, disable_notification: true });
    expect(fetch.mock.calls[1][0]).toContain("/deleteMessage");
  });

  it("reports a missing message as missing", async () => {
    const { api } = client(async () => json({ ok: false, error_code: 400, description: "Bad Request: message to forward not found" }, 400));
    expect(await api.probeChannelMessage("movie", 43)).toEqual({ status: "missing" });
  });

  it("reports protected content as an error, never as missing", async () => {
    const { api } = client(async () => json({ ok: false, error_code: 400, description: "Bad Request: message can't be forwarded" }, 400));
    expect(await api.probeChannelMessage("movie", 43)).toEqual({ status: "error", code: "channel_content_protected" });
  });

  it("reports a non-media message and rejects a forward from the wrong origin", async () => {
    expect(await client(async (url) => (url.endsWith("/forwardMessage") ? json({ ok: true, result: forwarded({ caption: undefined, document: undefined, text: "hi" }) }) : json({ ok: true, result: true }))).api.probeChannelMessage("movie", 42)).toEqual({ status: "not_media" });
    expect(await client(async (url) => (url.endsWith("/forwardMessage") ? json({ ok: true, result: forwarded({ forward_origin: { type: "channel", chat: { id: SERIES }, message_id: 42, date: 1 } }) }) : json({ ok: true, result: true }))).api.probeChannelMessage("movie", 42)).toEqual({ status: "error", code: "unexpected_forward" });
  });

  it("needs a reconciliation chat", async () => {
    const { fetch, api } = client(noNetwork, regularFile, config({ ...ENV, TELEGRAM_RECONCILE_CHAT_ID: undefined }));
    expect(await api.probeChannelMessage("movie", 42)).toEqual({ status: "error", code: "reconcile_chat_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
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
