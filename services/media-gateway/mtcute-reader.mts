/**
 * The MTProto media reader (E1.2), on mtcute. One long-lived client for the
 * dedicated media-reader bot, which is never on any Bot API server.
 *
 * Startup (fail closed at every step; readiness stays false until all pass):
 * 1. import the persisted session (a bot login happens only when explicitly
 *    allowed and no session exists);
 * 2. connect with updates disabled (the reader needs none);
 * 3. assert identity: the configured reader id and username, a bot, and none of
 *    the ingestion bots;
 * 4. assert Movies-channel access: the channel resolves (bot pattern: access
 *    hash 0 → full channel), the reader is a member, and its admin rights are
 *    the least possible (`other` only; any write right fails readiness);
 * 5. persist the session again (atomic, owner-only file).
 *
 * Reads use `upload.getFile` with `precise` on the document's own DC. The E1.1
 * planner supplies legal, window-local offsets, so mtcute's `downloadChunk`
 * (which aligns but does not keep a read inside one 1 MiB window, and trims by
 * the requested length even at EOF) is deliberately not used. Every read
 * carries the caller's AbortSignal, which mtcute turns into a local rejection
 * plus an `rpc_drop_answer` to Telegram.
 *
 * Nothing here logs or returns Telegram identifiers, hashes, file references
 * or session material. Errors leave this module only as GatewayError codes.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseUniqueFileId } from "@mtcute/file-id";
import { Long, MemoryStorage, TelegramClient, tl } from "@mtcute/node";

const { RpcError } = tl;
import { GatewayError } from "@/lib/media-gateway/errors";
import type { GatewayLogger } from "@/lib/media-gateway/log";
import type { MediaLocator, MediaReader, ReaderReadiness } from "@/lib/media-gateway/ports";

export interface MtcuteReaderConfig {
  apiId: number;
  apiHash: string;
  /** Owner-only file holding the exported mtcute session. */
  sessionFile: string;
  /** Used only when no session exists and `allowBotLogin` is true. */
  botToken?: string;
  allowBotLogin: boolean;
  expectedBotId: string;
  expectedUsername: string;
  /** Ingestion bot ids the reader must never be. */
  forbiddenBotIds: string[];
  /** The Movies channel in Bot API form (-100…). */
  moviesChannelId: string;
  /** How long a resolved document (and its file reference) is reused. */
  documentCacheTtlMs?: number;
  /** Interval of the periodic channel-access re-check. */
  accessRecheckMs?: number;
  /** mtcute connection pool used for file reads. `main` measured about 2× faster than `download` (E1.2). */
  readConnection?: "main" | "download";
  logger: GatewayLogger;
}

type ReaderState =
  | "starting"
  | "session_missing"
  | "connecting"
  | "identity_mismatch"
  | "channel_unavailable"
  | "rights_too_broad"
  | "ready"
  | "stopped";

interface CachedDocument {
  location: tl.RawInputDocumentFileLocation;
  dcId: number;
  fetchedAt: number;
}

/** Bot API channel id (-100XXXXXXXXXX) → MTProto channel id. */
export function mtprotoChannelId(botApiChatId: string): number {
  if (!/^-100\d{1,16}$/.test(botApiChatId)) throw new GatewayError("document_resolution_failed");
  const id = -BigInt(botApiChatId) - 1_000_000_000_000n;
  if (id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) throw new GatewayError("document_resolution_failed");
  return Number(id);
}

const RIGHTS_ALLOWED = new Set(["other"]);

/** Admin-right flags set to true, ignoring TL bookkeeping keys. */
export const grantedRights = (rights: object | undefined) =>
  Object.entries(rights ?? {})
    .filter(([key, value]) => value === true && key !== "_")
    .map(([key]) => key);

export function createMtcuteReader(config: MtcuteReaderConfig): MediaReader & { start(): Promise<void>; stop(): Promise<void> } {
  const { logger } = config;
  const cacheTtl = config.documentCacheTtlMs ?? 10 * 60_000;
  let state: ReaderState = "starting";
  let connection: string = "offline";
  let client: TelegramClient | null = null;
  let channel: tl.RawInputChannel | null = null;
  let recheck: ReturnType<typeof setInterval> | null = null;
  const documents = new Map<number, CachedDocument>();
  const resolving = new Map<number, Promise<CachedDocument>>();

  const setState = (next: ReaderState) => {
    if (next !== state) logger.info({ event: "reader_state", state: next });
    state = next;
  };

  async function persistSession() {
    if (!client) return;
    const data = await client.exportSession();
    const temporary = `${config.sessionFile}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, config.sessionFile);
  }

  async function assertChannelAccess(active: TelegramClient) {
    const channelId = mtprotoChannelId(config.moviesChannelId);
    // Bots use access hash 0 when none is stored, and receive the full channel (https://core.telegram.org/api/peers).
    const resolved = await active.call({ _: "channels.getChannels", id: [{ _: "inputChannel", channelId, accessHash: Long.ZERO }] });
    const movies = resolved.chats.find((chat) => chat._ === "channel" && chat.id === channelId);
    if (!movies || movies._ !== "channel" || movies.min || movies.left || !movies.broadcast || !movies.accessHash) {
      setState("channel_unavailable");
      throw new GatewayError("document_resolution_failed");
    }
    const input: tl.RawInputChannel = { _: "inputChannel", channelId, accessHash: movies.accessHash };
    const participant = await active.call({ _: "channels.getParticipant", channel: input, participant: { _: "inputPeerSelf" } });
    const self = participant.participant;
    const rights = self._ === "channelParticipantAdmin" ? grantedRights(self.adminRights) : null;
    if (!rights || rights.some((right) => !RIGHTS_ALLOWED.has(right))) {
      setState("rights_too_broad");
      throw new GatewayError("document_resolution_failed");
    }
    channel = input;
  }

  async function start() {
    setState("starting");
    let session: string | null = null;
    try {
      session = (await readFile(config.sessionFile, "utf8")).trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!session && !(config.allowBotLogin && config.botToken)) {
      setState("session_missing");
      throw new Error("media reader session missing");
    }

    const active = new TelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      // In-memory storage plus an exported session file: no native SQLite addon is loaded.
      storage: new MemoryStorage(),
      disableUpdates: true,
      logLevel: 0, // library logs off: they can include peer and file details
    });
    client = active;
    active.onConnectionState.add((next) => {
      connection = next;
      logger.info({ event: "mtproto_connection", state: next });
    });

    setState("connecting");
    if (session) {
      await active.importSession(session);
      await active.connect();
    } else {
      await active.start({ botToken: config.botToken });
    }

    const me = await active.getMe();
    const isolated =
      String(me.id) === config.expectedBotId &&
      (me.username ?? "").toLowerCase() === config.expectedUsername.toLowerCase() &&
      me.isBot &&
      !config.forbiddenBotIds.includes(String(me.id));
    if (!isolated) {
      setState("identity_mismatch");
      throw new Error("media reader identity mismatch");
    }

    await assertChannelAccess(active);
    await persistSession();
    setState("ready");

    recheck = setInterval(() => {
      if (state === "stopped" || !client) return;
      assertChannelAccess(client).then(
        () => setState("ready"),
        (error: unknown) => {
          // The state was already set to the failed check; a transport error keeps the last verdict.
          logger.warn({ event: "reader_access_recheck_failed", code: error instanceof GatewayError ? error.code : "telegram_unavailable" });
        },
      );
    }, config.accessRecheckMs ?? 5 * 60_000);
    recheck.unref();
  }

  async function stop() {
    if (recheck) clearInterval(recheck);
    const active = client;
    if (active && state === "ready") {
      try {
        await persistSession();
      } catch {
        logger.warn({ event: "reader_session_persist_failed" });
      }
    }
    setState("stopped");
    client = null;
    await active?.destroy();
  }

  function readiness(): ReaderReadiness {
    const connected = connection === "connected" || connection === "updating";
    if (state !== "ready") return { ready: false, state };
    return connected ? { ready: true, state: "ready" } : { ready: false, state: `mtproto_${connection}` };
  }

  /** Fetches the document behind the locator and checks it is exactly the catalogued file. */
  async function resolveDocument(locator: MediaLocator, signal: AbortSignal): Promise<CachedDocument> {
    const active = client;
    if (!active || !channel) throw new GatewayError("mtproto_disconnected");
    const reply = await active.call({ _: "channels.getMessages", channel, id: [{ _: "inputMessageID", id: locator.messageId }] }, { abortSignal: signal });
    if (reply._ === "messages.messagesNotModified") throw new GatewayError("document_resolution_failed");
    const message = reply.messages.find((m) => m._ === "message" && m.id === locator.messageId);
    const media = message && message._ === "message" ? message.media : undefined;
    const document = media?._ === "messageMediaDocument" ? media.document : undefined;
    if (!document || document._ !== "document") throw new GatewayError("document_resolution_failed");

    const unique = parseUniqueFileId(locator.fileUniqueId);
    const sameFile = unique.type === 2 /* UniqueFileIdType.Document */ && "id" in unique && unique.id.equals(document.id);
    const sameSize = Long.isLong(document.size) ? document.size.equals(Long.fromNumber(locator.fileSize)) : Number(document.size) === locator.fileSize;
    const sameType = locator.mimeType === null || document.mimeType === locator.mimeType;
    if (!sameFile || !sameSize || !sameType) {
      logger.error({ event: "document_mismatch", code: "document_resolution_failed" });
      throw new GatewayError("document_resolution_failed");
    }
    return {
      location: { _: "inputDocumentFileLocation", id: document.id, accessHash: document.accessHash, fileReference: document.fileReference, thumbSize: "" },
      dcId: document.dcId,
      fetchedAt: Date.now(),
    };
  }

  async function documentFor(locator: MediaLocator, signal: AbortSignal, refresh: boolean): Promise<{ doc: CachedDocument; rpcs: number }> {
    const cached = documents.get(locator.mediaId);
    if (!refresh && cached && Date.now() - cached.fetchedAt < cacheTtl) return { doc: cached, rpcs: 0 };
    let pending = resolving.get(locator.mediaId);
    if (!pending) {
      // Concurrent readers share one resolution; it is not tied to any single request's signal.
      pending = resolveDocument(locator, new AbortController().signal).finally(() => resolving.delete(locator.mediaId));
      resolving.set(locator.mediaId, pending);
    }
    const doc = await abortable(pending, signal);
    documents.set(locator.mediaId, doc);
    return { doc, rpcs: 1 };
  }

  function classify(error: unknown, signal: AbortSignal): GatewayError {
    if (signal.aborted) return signal.reason instanceof GatewayError ? signal.reason : new GatewayError("upstream_timeout");
    if (error instanceof GatewayError) return error;
    if (RpcError.is(error, "FLOOD_WAIT_%d")) return new GatewayError("flood_wait", { retryAfterSeconds: Math.min(Math.max(error.seconds, 1), 300) });
    if (RpcError.is(error)) {
      // 5xx and -503 are Telegram-side and transient; anything else is a request we should not have made.
      return error.code >= 500 || error.code < 0 ? new GatewayError("telegram_unavailable") : new GatewayError("internal_error");
    }
    return connection === "connected" || connection === "updating" ? new GatewayError("telegram_unavailable") : new GatewayError("mtproto_disconnected");
  }

  async function readPart(locator: MediaLocator, offset: number, limit: number, signal: AbortSignal) {
    const active = client;
    if (!active || !readiness().ready) throw new GatewayError("mtproto_disconnected");
    if (locator.chatId !== config.moviesChannelId) throw new GatewayError("document_resolution_failed");
    let rpcCount = 0;
    let refreshed = false;
    let forceRefresh = false;
    let dcOverride: number | undefined;
    try {
      // At most three attempts: the first, one after a fresh file reference, one after a DC redirect.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { doc, rpcs } = await documentFor(locator, signal, forceRefresh);
        forceRefresh = false;
        rpcCount += rpcs + 1;
        try {
          const result = await active.call(
            { _: "upload.getFile", location: doc.location, offset, limit, precise: true, cdnSupported: false },
            { dcId: dcOverride ?? doc.dcId, kind: config.readConnection ?? "main", abortSignal: signal, floodSleepThreshold: 0, maxRetryCount: 0 },
          );
          if (result._ !== "upload.file") throw new GatewayError("document_resolution_failed");
          return { bytes: result.bytes, rpcCount };
        } catch (error) {
          if (signal.aborted) throw error;
          if (!refreshed && (RpcError.is(error, "FILE_REFERENCE_EXPIRED") || RpcError.is(error, "FILE_REFERENCE_INVALID"))) {
            // Bounded: one fresh reference, one retry.
            refreshed = true;
            forceRefresh = true;
            continue;
          }
          if (dcOverride === undefined && RpcError.is(error, "FILE_MIGRATE_%d")) {
            dcOverride = error.newDc;
            continue;
          }
          throw error;
        }
      }
      throw new GatewayError("document_resolution_failed");
    } catch (error) {
      throw classify(error, signal);
    }
  }

  return { start, stop, readiness, readPart };
}

/** Rejects with the signal's reason as soon as it aborts, without cancelling the shared promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
