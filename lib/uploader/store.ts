import "server-only";
import { createClient } from "@supabase/supabase-js";
import * as z from "zod";
import { fingerprintFromCaption } from "@/lib/ingestion/telegram";
import type { CatalogueKind } from "@/types/catalogue";
import type { ServerUploadStatus, SourceFingerprint, SourceIdentity, TelegramMediaRecord, UploadFailureOutcome } from "@/types/ingestion";

/**
 * The uploader's view of the Supabase ingestion write boundary: the worker
 * commands of migrations 20260925004059 and 20260925194322, and nothing else. There is no table
 * access and no SQL here: every call is a PostgREST `rpc/` call that only
 * service_role may execute. None of the commands approves or publishes.
 */
export interface IngestionStore {
  readonly available: boolean;
  /** What the server knows about this source's upload (ingest_upload_status). */
  getUploadStatus(fingerprint: SourceFingerprint, kind: CatalogueKind): Promise<ServerUploadStatus>;
  /**
   * Registers the source (idempotent by fingerprint) and starts an attempt
   * towards `channelId`, which must be the allow-listed channel for `kind`
   * (ingest_upload_start). Refused while uploading, uncertain, uploaded or blocked.
   * Returns the attempt's recovery floor, which the server computed and persisted.
   */
  markUploadStarted(input: { source: SourceIdentity; kind: CatalogueKind; channelId: number }): Promise<{ attempt: number; floorMessageId: number }>;
  /**
   * Records the Telegram message (ingest_upload_record). An exact replay is
   * `already_recorded`; different or foreign evidence is `conflict` (review),
   * never an overwrite.
   */
  recordUploadSucceeded(fingerprint: SourceFingerprint, record: TelegramMediaRecord): Promise<"recorded" | "already_recorded" | "conflict">;
  /** Records a failed or unresolved attempt (ingest_upload_fail). */
  recordUploadFailed(fingerprint: SourceFingerprint, kind: CatalogueKind, failure: { outcome: UploadFailureOutcome; code: string }): Promise<void>;
  /**
   * Reports a message id observed in the channel (a recovery marker). The
   * server advances the channel checkpoint only if that is safe, and returns
   * the checkpoint after the call (ingest_channel_checkpoint).
   */
  advanceCheckpoint(kind: CatalogueKind, channelId: number, messageId: number): Promise<number>;
}

/**
 * A failed store call, reduced to a fixed code: one of the database's
 * `ingest_*` codes, or `store_unavailable` / `store_error` / `store_bad_reply`.
 * The message never carries the URL, key or the raw server text.
 */
export class IngestStoreError extends Error {
  // A declared field, not a parameter property: the CLI runs on Node's
  // type stripping, which supports erasable TypeScript syntax only.
  readonly code: string;
  constructor(code: string) {
    super(`Ingestion store: ${code}`);
    this.name = "IngestStoreError";
    this.code = code;
  }
}

/** Used when no store is configured. Status is `unknown`; every write refuses. */
export const offlineStore: IngestionStore = {
  available: false,
  getUploadStatus: async () => ({ status: "unknown" }),
  markUploadStarted: async () => {
    throw new IngestStoreError("store_not_configured");
  },
  recordUploadSucceeded: async () => {
    throw new IngestStoreError("store_not_configured");
  },
  recordUploadFailed: async () => {
    throw new IngestStoreError("store_not_configured");
  },
  advanceCheckpoint: async () => {
    throw new IngestStoreError("store_not_configured");
  },
};

// ---------------------------------------------------------------------------
// RPC transport
// ---------------------------------------------------------------------------

export type WorkerRpc = "ingest_upload_status" | "ingest_upload_start" | "ingest_upload_record" | "ingest_upload_fail" | "ingest_channel_checkpoint";

export type RpcTransport = (
  fn: WorkerRpc,
  args: Record<string, string | number | null>,
) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;

const DB_CODE = /^ingest_[a-z_]{1,60}$/;

async function call(rpc: RpcTransport, fn: WorkerRpc, args: Record<string, string | number | null>): Promise<unknown> {
  let reply: Awaited<ReturnType<RpcTransport>>;
  try {
    reply = await rpc(fn, args);
  } catch {
    throw new IngestStoreError("store_unavailable");
  }
  if (reply.error) {
    const message = reply.error.message ?? "";
    throw new IngestStoreError(DB_CODE.test(message) ? message : "store_error");
  }
  return reply.data;
}

const statusRow = z.object({
  upload_state: z.enum(["new", "uploading", "uncertain", "uploaded", "upload_failed", "blocked"]),
  upload_attempt_count: z.number().int().nonnegative(),
  upload_failure_code: z.string().nullable(),
  needs_review: z.boolean(),
  chat_id: z.number().int().nullable(),
  message_id: z.number().int().positive().nullable(),
  file_id: z.string().min(1).nullable(),
  file_unique_id: z.string().min(1).nullable(),
  media_kind: z.enum(["video", "document"]).nullable(),
  file_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  caption: z.string().nullable(),
  file_size_bytes: z.number().int().nonnegative().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  telegram_date: z.string().nullable(),
  upload_started_at: z.string().nullable(),
  upload_age_seconds: z.number().int().nullable(),
  upload_floor_message_id: z.number().int().positive().nullable(),
});
const startRow = z.object({
  upload_state: z.literal("uploading"),
  upload_attempt_count: z.number().int().positive(),
  upload_floor_message_id: z.number().int().positive(),
});

/** The current attempt, for an uploading or uncertain source. A reply without a start time is malformed. */
function attempt(row: z.infer<typeof statusRow>) {
  if (row.upload_started_at === null || row.upload_age_seconds === null) throw new IngestStoreError("store_bad_reply");
  return { floorMessageId: row.upload_floor_message_id, startedAt: new Date(row.upload_started_at).toISOString(), ageSeconds: Math.max(0, row.upload_age_seconds) };
}

function single<T>(schema: z.ZodType<T>, data: unknown): T {
  const rows = z.array(schema).length(1).safeParse(data);
  if (!rows.success) throw new IngestStoreError("store_bad_reply");
  return rows.data[0];
}

function toStatus(kind: CatalogueKind, row: z.infer<typeof statusRow>): ServerUploadStatus {
  switch (row.upload_state) {
    case "new":
      return { status: "absent" };
    case "uploading":
      return { status: "uploading", attempt: attempt(row) };
    case "uncertain":
      return { status: "uncertain", attempt: attempt(row) };
    case "upload_failed":
      return { status: "failed" };
    case "blocked":
      return { status: "blocked", code: row.upload_failure_code };
    case "uploaded": {
      const { chat_id, message_id, file_id, file_unique_id, media_kind, telegram_date } = row;
      if (chat_id === null || message_id === null || file_id === null || file_unique_id === null || media_kind === null || telegram_date === null) {
        throw new IngestStoreError("store_bad_reply");
      }
      return {
        status: "uploaded",
        record: {
          botType: kind,
          chatId: chat_id,
          messageId: message_id,
          fileId: file_id,
          fileUniqueId: file_unique_id,
          mediaKind: media_kind,
          fileName: row.file_name,
          mimeType: row.mime_type,
          caption: row.caption,
          fileSizeBytes: row.file_size_bytes,
          durationSeconds: row.duration_seconds,
          width: row.width,
          height: row.height,
          telegramDate: new Date(telegram_date).toISOString(),
          sourceFingerprint: fingerprintFromCaption(row.caption),
        },
      };
    }
  }
}

/**
 * The store over an RPC transport. Payloads carry only what each command
 * takes: fingerprint, kind, size, channel and the Telegram message identity.
 * No local path, token or journal data is sent; a file name travels only
 * inside the Telegram identity, as Telegram reported it.
 */
export function createRpcIngestionStore(rpc: RpcTransport): IngestionStore {
  return {
    available: true,

    async getUploadStatus(fingerprint, kind) {
      const data = await call(rpc, "ingest_upload_status", { p_source_fingerprint: fingerprint, p_bot_type: kind });
      return toStatus(kind, single(statusRow, data));
    },

    async markUploadStarted({ source, kind, channelId }) {
      const data = await call(rpc, "ingest_upload_start", {
        p_source_fingerprint: source.fingerprint,
        p_bot_type: kind,
        p_chat_id: channelId,
        p_source_size_bytes: source.sizeBytes,
      });
      const row = single(startRow, data);
      return { attempt: row.upload_attempt_count, floorMessageId: row.upload_floor_message_id };
    },

    async recordUploadSucceeded(fingerprint, record) {
      const data = await call(rpc, "ingest_upload_record", {
        p_source_fingerprint: fingerprint,
        p_bot_type: record.botType,
        p_chat_id: record.chatId,
        p_message_id: record.messageId,
        p_file_id: record.fileId,
        p_file_unique_id: record.fileUniqueId,
        p_media_kind: record.mediaKind,
        p_file_name: record.fileName,
        p_mime_type: record.mimeType,
        p_caption: record.caption,
        p_file_size_bytes: record.fileSizeBytes,
        p_duration_seconds: record.durationSeconds,
        p_width: record.width,
        p_height: record.height,
        p_telegram_date: record.telegramDate,
      });
      const outcome = z.enum(["recorded", "already_recorded", "conflict"]).safeParse(data);
      if (!outcome.success) throw new IngestStoreError("store_bad_reply");
      return outcome.data;
    },

    async recordUploadFailed(fingerprint, kind, failure) {
      const data = await call(rpc, "ingest_upload_fail", {
        p_source_fingerprint: fingerprint,
        p_bot_type: kind,
        p_outcome: failure.outcome,
        p_failure_code: failure.code,
      });
      if (!z.enum(["upload_failed", "uncertain", "blocked"]).safeParse(data).success) throw new IngestStoreError("store_bad_reply");
    },

    async advanceCheckpoint(kind, channelId, messageId) {
      const data = await call(rpc, "ingest_channel_checkpoint", { p_bot_type: kind, p_chat_id: channelId, p_message_id: messageId });
      const checkpoint = z.number().int().nonnegative().safeParse(data);
      if (!checkpoint.success) throw new IngestStoreError("store_bad_reply");
      return checkpoint.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase transport (CLI only)
// ---------------------------------------------------------------------------

export const STORE_ENV = { url: "NEXT_PUBLIC_SUPABASE_URL", key: "SUPABASE_SERVICE_ROLE_KEY" } as const;

/**
 * The service-role key never leaves the operator machine: it is read here for
 * the CLI only, and the app never imports this module. Errors name variables,
 * never values.
 */
export function supabaseRpcTransport(env: Readonly<Record<string, string | undefined>>): { ok: true; rpc: RpcTransport } | { ok: false; errors: string[] } {
  const url = env[STORE_ENV.url];
  const key = env[STORE_ENV.key];
  const errors: string[] = [];
  let parsed: URL | null = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(parsed.hostname))) {
    errors.push(`${STORE_ENV.url} must be the Supabase project URL (https, or http on localhost)`);
  }
  if (!key || key.startsWith("sb_publishable_")) errors.push(`${STORE_ENV.key} must be the service-role (secret) key`);
  if (errors.length > 0 || !url || !key) return { ok: false, errors };

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return { ok: true, rpc: async (fn, args) => client.rpc(fn, args) };
}
