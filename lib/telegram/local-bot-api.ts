import "server-only";
import { isIP } from "node:net";
import { extname, isAbsolute, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { SUPPORTED_EXTENSIONS } from "@/lib/ingestion/parser";
import { isRecoveryMarker } from "@/lib/ingestion/recovery";
import { fingerprintFromCaption, TELEGRAM_CAPTION_MAX, TELEGRAM_MAX_FILE_BYTES, telegramMediaMessageSchema, toTelegramMediaRecord } from "@/lib/ingestion/telegram";
import type { CatalogueKind } from "@/types/catalogue";
import type { ChannelProbeResult, MarkerPostResult, RecoveryAccessResult, RecoveryCallFailure, SourceFingerprint, TelegramMediaRecord, UploadOutcome } from "@/types/ingestion";

/**
 * Telegram transport for the ingestion uploader (C2): a self-hosted Bot API
 * server (telegram-bot-api, started with `--local`), never Telegram's cloud
 * endpoint. The cloud Bot API caps uploads at 50 MB; the local server accepts
 * files up to TELEGRAM_MAX_FILE_BYTES and reads them from its own disk by
 * path, so the uploader never streams a multi-GB file through Node.
 *
 * Server/CLI only. Tokens appear in the request path and nowhere else: no
 * error, log line or return value built here contains a token or URL.
 *
 * Two bots, two channels: a movie goes through the movie bot to the Movies
 * channel, an episode through the series bot to the Series channel. The
 * transport kind, the ingestion kind and the journal's intended channel must
 * all agree before anything is sent.
 */

export interface BotTarget {
  token: string;
  channelId: number;
}

export interface LocalBotApiConfig {
  /** Origin of the self-hosted Bot API server, without a trailing slash. */
  baseUrl: string;
  bots: Record<CatalogueKind, BotTarget>;
  /** Private chat where both bots forward channel messages during reconciliation. */
  reconcileChatId: number | null;
  /** Local library prefix -> the same folder as the Bot API server sees it. */
  pathMap: { local: string; server: string } | null;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const ENV = {
  baseUrl: "TELEGRAM_BOT_API_URL",
  movieToken: "TELEGRAM_MOVIES_BOT_TOKEN",
  seriesToken: "TELEGRAM_SERIES_BOT_TOKEN",
  movieChannel: "TELEGRAM_MOVIES_CHANNEL_ID",
  seriesChannel: "TELEGRAM_SERIES_CHANNEL_ID",
  reconcileChat: "TELEGRAM_RECONCILE_CHAT_ID",
  pathMap: "TELEGRAM_BOT_API_PATH_MAP",
} as const;

const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CHANNEL_ID = /^-100\d{5,13}$/;
const CHAT_ID = /^-?\d{5,16}$/;

const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || (isIP(hostname) === 4 && hostname.startsWith("127."));

/**
 * Parses the base URL and refuses anything that is not a self-hosted server.
 * There is deliberately no default: an unset or cloud URL fails closed, so a
 * 1.5 GB upload can never be sent to api.telegram.org by mistake. Plain HTTP
 * is accepted only on loopback, because the token travels in the path.
 */
export function parseBotApiBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "telegram.org" || host.endsWith(".telegram.org") || host === "t.me") return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "http:" && !isLoopback(host)) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

/**
 * Reads the uploader's Telegram configuration. Errors name the variable,
 * never its value.
 */
export function loadLocalBotApiConfig(env: Env): { ok: true; config: LocalBotApiConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const baseUrl = parseBotApiBaseUrl(env[ENV.baseUrl]);
  if (baseUrl === null) errors.push(`${ENV.baseUrl} must be the self-hosted Bot API server origin (http only on loopback; never api.telegram.org)`);

  const token = (name: string) => {
    const value = env[name];
    if (!value || !BOT_TOKEN.test(value)) errors.push(`${name} is missing or not a bot token`);
    return value ?? "";
  };
  const channel = (name: string) => {
    const value = env[name];
    if (!value || !CHANNEL_ID.test(value)) errors.push(`${name} is missing or not a channel id (-100…)`);
    return Number(value);
  };
  const bots = {
    movie: { token: token(ENV.movieToken), channelId: channel(ENV.movieChannel) },
    series: { token: token(ENV.seriesToken), channelId: channel(ENV.seriesChannel) },
  };
  if (bots.movie.token && bots.movie.token === bots.series.token) errors.push(`${ENV.movieToken} and ${ENV.seriesToken} must be different bots`);
  if (bots.movie.channelId === bots.series.channelId && Number.isFinite(bots.movie.channelId)) errors.push(`${ENV.movieChannel} and ${ENV.seriesChannel} must be different channels`);

  const reconcileRaw = env[ENV.reconcileChat];
  if (reconcileRaw && !CHAT_ID.test(reconcileRaw)) errors.push(`${ENV.reconcileChat} is not a chat id`);
  const reconcileChatId = reconcileRaw && CHAT_ID.test(reconcileRaw) ? Number(reconcileRaw) : null;
  if (reconcileChatId !== null && (reconcileChatId === bots.movie.channelId || reconcileChatId === bots.series.channelId)) {
    errors.push(`${ENV.reconcileChat} must not be a catalogue channel`);
  }

  let pathMap: LocalBotApiConfig["pathMap"] = null;
  const mapRaw = env[ENV.pathMap];
  if (mapRaw) {
    const [local, server, ...rest] = mapRaw.split("=>");
    if (!local || !server || rest.length > 0) errors.push(`${ENV.pathMap} must look like <local prefix>=><server prefix>`);
    else pathMap = { local: local.trim(), server: server.trim() };
  }

  if (errors.length > 0 || baseUrl === null) return { ok: false, errors };
  return { ok: true, config: { baseUrl, bots, reconcileChatId, pathMap } };
}

// ---------------------------------------------------------------------------
// Preflight: everything that can be checked without the network
// ---------------------------------------------------------------------------

export interface UploadRequest {
  /** The transport (bot and channel) the caller chose. */
  transport: CatalogueKind;
  /** The ingestion record's resolved kind. Must equal `transport`. */
  kind: CatalogueKind;
  /** The channel the journal recorded when the attempt was planned. */
  intendedChannelId: number;
  absolutePath: string;
  /** Size recorded when the file was fingerprinted. */
  sizeBytes: number;
  fingerprint: SourceFingerprint;
  caption: string;
}

export interface FileFacts {
  isFile: boolean;
  size: number;
}

/** Only `stat` is injected: the adapter never opens or reads the media file. */
export type StatFile = (path: string) => Promise<FileFacts>;

export type PreflightResult =
  | { ok: true; target: BotTarget; serverFileUri: string }
  | { ok: false; code: string; permanent: boolean };

const reject = (code: string, permanent = false): PreflightResult => ({ ok: false, code, permanent });

/** The path the Bot API server must open, as a file URI (`--local` mode). */
export function toServerFileUri(absolutePath: string, pathMap: LocalBotApiConfig["pathMap"]): string | null {
  // A dot segment passes the prefix check, then the file URL resolves it outside
  // the mapped root (for example into the server's own --dir), so refuse it.
  if (absolutePath.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return null;
  let path = absolutePath;
  if (pathMap) {
    const normalize = (value: string) => value.split("\\").join("/").replace(/\/+$/, "");
    const local = normalize(pathMap.local);
    const current = normalize(path);
    const insensitive = /^[A-Za-z]:/.test(pathMap.local);
    const under = insensitive ? current.toLowerCase().startsWith(`${local.toLowerCase()}/`) : current.startsWith(`${local}/`);
    if (!under) return null;
    path = `${normalize(pathMap.server)}/${current.slice(local.length + 1)}`;
  }
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  if (windows ? !win32.isAbsolute(path) : !posix.isAbsolute(path)) return null;
  return pathToFileURL(path, { windows }).href;
}

export async function preflightUpload(request: UploadRequest, config: LocalBotApiConfig, stat: StatFile): Promise<PreflightResult> {
  if (request.transport !== request.kind) return reject("transport_kind_mismatch", true);
  const target = config.bots[request.transport];
  if (request.intendedChannelId !== target.channelId) return reject("channel_changed_since_plan");
  if (!isFingerprint(request.fingerprint)) return reject("invalid_fingerprint", true);
  if (fingerprintFromCaption(request.caption) !== request.fingerprint) return reject("caption_token_mismatch", true);
  if (request.caption.length > TELEGRAM_CAPTION_MAX) return reject("caption_too_long", true);
  if (!isAbsolute(request.absolutePath)) return reject("path_not_absolute", true);
  if (!SUPPORTED_EXTENSIONS.includes(extname(request.absolutePath).slice(1).toLowerCase())) return reject("unsupported_extension", true);
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes <= 0) return reject("empty_file", true);
  if (request.sizeBytes > TELEGRAM_MAX_FILE_BYTES) return reject("file_too_large", true);

  let facts: FileFacts;
  try {
    facts = await stat(request.absolutePath);
  } catch {
    return reject("source_unreadable");
  }
  if (!facts.isFile) return reject("not_a_regular_file", true);
  if (facts.size === 0) return reject("empty_file", true);
  if (facts.size > TELEGRAM_MAX_FILE_BYTES) return reject("file_too_large", true);
  // The fingerprint describes the bytes seen at scan time; a changed file must be rescanned.
  if (facts.size !== request.sizeBytes) return reject("source_changed_since_scan");

  const serverFileUri = toServerFileUri(request.absolutePath, config.pathMap);
  if (serverFileUri === null) return reject("path_outside_server_map");
  return { ok: true, target, serverFileUri };
}

// ---------------------------------------------------------------------------
// Bot API calls
// ---------------------------------------------------------------------------

const errorReply = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string().max(1000).optional(),
  parameters: z.object({ retry_after: z.number().int().nonnegative().optional() }).optional(),
});
const okReply = z.object({ ok: z.literal(true), result: z.unknown() });

type Reply =
  | { kind: "ok"; result: unknown }
  | { kind: "error"; code: number; description: string; retryAfter: number | null }
  /** Nothing reached the server (connection refused): definitely not processed. */
  | { kind: "unreachable" }
  /** Timeout, dropped connection or unreadable reply: may have been processed. */
  | { kind: "uncertain"; code: string };

export interface TransportDeps {
  fetch: typeof fetch;
  stat: StatFile;
  /** Per-call timeout for sendDocument. The local server copies then uploads the whole file. */
  uploadTimeoutMs: number;
  requestTimeoutMs: number;
}

const REFUSED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function connectCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : null;
}

async function call(config: LocalBotApiConfig, deps: TransportDeps, token: string, method: string, body: object, timeoutMs: number): Promise<Reply> {
  let response: Response;
  try {
    response = await deps.fetch(`${config.baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Only a code crosses this line: fetch errors are never echoed, so no URL
    // (and therefore no token) can leak into a log or a journal.
    const code = connectCode(error);
    if (code !== null && REFUSED.has(code)) return { kind: "unreachable" };
    const name = (error as { name?: unknown } | null)?.name;
    return { kind: "uncertain", code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: "uncertain", code: `unreadable_reply_${response.status}` };
  }
  const ok = okReply.safeParse(json);
  if (ok.success) return { kind: "ok", result: ok.data.result };
  const failed = errorReply.safeParse(json);
  if (failed.success) {
    return { kind: "error", code: failed.data.error_code, description: failed.data.description ?? "", retryAfter: failed.data.parameters?.retry_after ?? null };
  }
  return { kind: "uncertain", code: `malformed_reply_${response.status}` };
}

/**
 * Maps a Bot API refusal to an outcome. 4xx means the request was refused
 * before anything was posted, so it is a definite failure. 5xx from the local
 * server can come after the upload began, so it is uncertain.
 */
function refusal(reply: Extract<Reply, { kind: "error" }>): UploadOutcome {
  if (reply.code === 429) return { status: "failed", code: "telegram_rate_limited", retryable: true, retryAfterSeconds: reply.retryAfter };
  if (reply.code >= 500) return { status: "uncertain", code: `telegram_server_${reply.code}` };
  if (/too big|too large/i.test(reply.description)) return { status: "failed", code: "file_too_large", retryable: false, retryAfterSeconds: null };
  if (reply.code === 401) return { status: "failed", code: "telegram_unauthorized", retryable: true, retryAfterSeconds: null };
  if (reply.code === 403) return { status: "failed", code: "telegram_forbidden", retryable: true, retryAfterSeconds: null };
  return { status: "failed", code: `telegram_rejected_${reply.code}`, retryable: true, retryAfterSeconds: null };
}

/**
 * Validates a successful sendDocument result against what was sent. A reply
 * that cannot be fully validated is `uncertain`, never a partially invented
 * identity: reconciliation then finds the real message by its caption token.
 */
export function mapSentMessage(result: unknown, request: UploadRequest, target: BotTarget): UploadOutcome {
  const parsed = telegramMediaMessageSchema.safeParse(result);
  if (!parsed.success) return { status: "uncertain", code: "malformed_message" };
  if (parsed.data.chat.id !== target.channelId) return { status: "uncertain", code: "unexpected_chat" };
  const record = toTelegramMediaRecord(request.kind, parsed.data);
  if (record === null) return { status: "uncertain", code: "message_without_media" };
  if (record.sourceFingerprint !== request.fingerprint) return { status: "uncertain", code: "caption_token_missing" };
  if (record.fileSizeBytes !== null && record.fileSizeBytes !== request.sizeBytes) return { status: "uncertain", code: "size_mismatch" };
  return { status: "succeeded", record };
}

// ---------------------------------------------------------------------------
// Recovery calls (C2B.1A): read-only access check, marker, channel probe
// ---------------------------------------------------------------------------

/**
 * Maps a failed recovery call. Only a status code and Telegram's `retry_after`
 * are used: never the description text. A 4xx other than 401/403/429 on a
 * setup call is a configuration problem for the operator.
 */
function recoveryFailure(reply: Exclude<Reply, { kind: "ok" }>, prefix: string): RecoveryCallFailure {
  if (reply.kind === "unreachable") return { status: "transient", code: "bot_api_unreachable" };
  if (reply.kind === "uncertain") return { status: "transient", code: `${prefix}_${reply.code}` };
  if (reply.code === 429) return { status: "rate_limited", retryAfterSeconds: reply.retryAfter };
  if (reply.code >= 500) return { status: "transient", code: `telegram_server_${reply.code}` };
  if (reply.code === 401) return { status: "blocked", code: "telegram_unauthorized" };
  if (reply.code === 403) return { status: "blocked", code: "telegram_forbidden" };
  return { status: "blocked", code: `${prefix}_rejected_${reply.code}` };
}

/**
 * The one description the probe reads. Bot API has no error code that
 * separates "no such message" from other 400s, so this text is the only
 * signal that an id is empty. Any other 400 (a service message, protected
 * content, a changed wording) is `uninspectable`: if Telegram rewords this,
 * scans become incomplete, never falsely empty.
 */
const MESSAGE_NOT_FOUND = /^Bad Request: message to forward not found$/i;

const chatInfo = z.object({ id: z.number().int(), has_protected_content: z.boolean().optional() });
const sentText = z.object({ message_id: z.number().int().positive(), chat: z.object({ id: z.number().int() }), text: z.string() });

const forwardOrigin = z.object({
  forward_origin: z.object({
    type: z.literal("channel"),
    chat: z.object({ id: z.number().int() }),
    message_id: z.number().int().positive(),
    date: z.number().int().positive(),
  }),
  message_id: z.number().int().positive(),
});

export interface LocalBotApiClient {
  /** Every check sendDocument makes before the network, without sending. */
  preflight(request: UploadRequest): Promise<{ ok: true; channelId: number } | { ok: false; code: string; permanent: boolean }>;
  sendDocument(request: UploadRequest): Promise<UploadOutcome | { status: "rejected"; code: string; permanent: boolean }>;
  /** Read-only (getChat): the kind's channel and the recovery group are reachable, and forwarding can work. */
  checkRecoveryAccess(kind: CatalogueKind): Promise<RecoveryAccessResult>;
  /** Posts a recovery marker (sendMessage, text only) to the kind's channel with the kind's bot. */
  postRecoveryMarker(kind: CatalogueKind, text: string): Promise<MarkerPostResult>;
  /** A channel probe for reconcileUpload(). */
  probeChannelMessage(kind: CatalogueKind, messageId: number): Promise<ChannelProbeResult>;
}

export function createLocalBotApiClient(config: LocalBotApiConfig, deps: TransportDeps): LocalBotApiClient {
  return {
    async preflight(request) {
      const result = await preflightUpload(request, config, deps.stat);
      // The target carries the token; callers only need to know where it goes.
      return result.ok ? { ok: true, channelId: result.target.channelId } : result;
    },

    async sendDocument(request) {
      const preflight = await preflightUpload(request, config, deps.stat);
      if (!preflight.ok) return { status: "rejected", code: preflight.code, permanent: preflight.permanent };
      const reply = await call(config, deps, preflight.target.token, "sendDocument", {
        chat_id: preflight.target.channelId,
        document: preflight.serverFileUri,
        caption: request.caption,
        // Keep the file a document: no server-side type guessing or conversion.
        disable_content_type_detection: true,
        disable_notification: true,
      }, deps.uploadTimeoutMs);
      if (reply.kind === "unreachable") return { status: "failed", code: "bot_api_unreachable", retryable: true, retryAfterSeconds: null };
      if (reply.kind === "uncertain") return { status: "uncertain", code: reply.code };
      if (reply.kind === "error") return refusal(reply);
      return mapSentMessage(reply.result, request, preflight.target);
    },

    /**
     * `has_protected_content` is a stable getChat field, so a channel that
     * forbids forwarding is caught here, before any marker is posted.
     */
    async checkRecoveryAccess(kind) {
      if (config.reconcileChatId === null) return { status: "blocked", code: "reconcile_chat_not_configured" };
      const target = config.bots[kind];
      for (const chatId of [target.channelId, config.reconcileChatId]) {
        const reply = await call(config, deps, target.token, "getChat", { chat_id: chatId }, deps.requestTimeoutMs);
        if (reply.kind !== "ok") return recoveryFailure(reply, "get_chat");
        const chat = chatInfo.safeParse(reply.result);
        if (!chat.success || chat.data.id !== chatId) return { status: "blocked", code: "get_chat_unexpected_reply" };
        if (chatId === target.channelId && chat.data.has_protected_content === true) return { status: "blocked", code: "channel_content_protected" };
      }
      return { status: "ok" };
    },

    /**
     * A text message only: there is no document, file or path parameter, and
     * the text must be a recovery marker. A timed-out post may still exist;
     * that is harmless, because a marker is never media and never matches.
     */
    async postRecoveryMarker(kind, text) {
      if (!isRecoveryMarker(text)) return { status: "blocked", code: "marker_text_invalid" };
      const target = config.bots[kind];
      const reply = await call(config, deps, target.token, "sendMessage", {
        chat_id: target.channelId,
        text,
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      }, deps.requestTimeoutMs);
      if (reply.kind !== "ok") return recoveryFailure(reply, "marker");
      const sent = sentText.safeParse(reply.result);
      if (!sent.success || sent.data.chat.id !== target.channelId || sent.data.text !== text) return { status: "blocked", code: "marker_unexpected_reply" };
      return { status: "posted", chatId: sent.data.chat.id, messageId: sent.data.message_id };
    },

    /**
     * Bot API cannot read channel history, so a probe forwards one message id
     * into the private recovery group, reads the forwarded copy (caption and
     * file identity survive a forward), then deletes that copy. Only
     * Telegram's "not found" reply means `missing`; a message that exists but
     * cannot be forwarded (a service message, protected content) or any other
     * refusal is `uninspectable`.
     */
    async probeChannelMessage(kind, messageId) {
      if (config.reconcileChatId === null) return { status: "blocked", code: "reconcile_chat_not_configured" };
      const target = config.bots[kind];
      const reply = await call(config, deps, target.token, "forwardMessage", {
        chat_id: config.reconcileChatId,
        from_chat_id: target.channelId,
        message_id: messageId,
        disable_notification: true,
      }, deps.requestTimeoutMs);
      if (reply.kind === "error" && reply.code === 400) {
        return MESSAGE_NOT_FOUND.test(reply.description) ? { status: "missing" } : { status: "uninspectable", code: "telegram_rejected_400" };
      }
      if (reply.kind === "error" && reply.code < 500 && ![401, 403, 429].includes(reply.code)) return { status: "uninspectable", code: `telegram_rejected_${reply.code}` };
      if (reply.kind !== "ok") return recoveryFailure(reply, "probe");

      const origin = forwardOrigin.safeParse(reply.result);
      const copy = reply.result as Record<string, unknown>;
      if (origin.success) {
        // Best effort: a leftover copy in the private group is harmless.
        await call(config, deps, target.token, "deleteMessage", { chat_id: config.reconcileChatId, message_id: origin.data.message_id }, deps.requestTimeoutMs);
      }
      if (!origin.success || origin.data.forward_origin.chat.id !== target.channelId || origin.data.forward_origin.message_id !== messageId) {
        return { status: "uninspectable", code: "unexpected_forward" };
      }
      const message = telegramMediaMessageSchema.safeParse({
        message_id: messageId,
        date: origin.data.forward_origin.date,
        chat: { id: target.channelId, type: "channel" },
        caption: copy.caption,
        video: copy.video,
        document: copy.document,
      });
      if (!message.success) return { status: "uninspectable", code: "malformed_message" };
      const record: TelegramMediaRecord | null = toTelegramMediaRecord(kind, message.data);
      return record === null ? { status: "not_media" } : { status: "found", record };
    },
  };
}
