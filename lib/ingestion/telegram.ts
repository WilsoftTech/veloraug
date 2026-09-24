import * as z from "zod";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import type { CatalogueKind } from "@/types/catalogue";
import type { SourceFingerprint, TelegramMediaRecord } from "@/types/ingestion";

/**
 * Telegram media identity contract. Pure: no network, no credentials, no
 * environment access. A private.telegram_media row is only ever written from a
 * message the movie or series bot itself observed, because `file_id` is
 * bot-specific. The uploader (C2) contributes one thing: a caption token
 * carrying the source fingerprint, which links the channel message back to
 * the local file after a crash. Everything here stays server/worker side;
 * no public catalogue shape contains Telegram identifiers.
 */

/** Telegram's per-file ceiling for uploads the uploader can make (2000 MiB). */
export const TELEGRAM_MAX_FILE_BYTES = 2000 * 1024 * 1024;

const TOKEN_PREFIX = "velora-src:";
const TOKEN = /(?:^|\s)velora-src:(sf1-[0-9a-f]{64})(?=\s|$)/g;

/** The caption line the uploader appends. Contains no path, name or secret. */
export function sourceCaptionToken(fingerprint: SourceFingerprint): string {
  return `${TOKEN_PREFIX}${fingerprint}`;
}

/** The fingerprint in a caption, or null when there is none or more than one. */
export function fingerprintFromCaption(caption: string | null | undefined): SourceFingerprint | null {
  const found = [...(caption ?? "").matchAll(TOKEN)].map((match) => match[1]);
  const unique = [...new Set(found)];
  return unique.length === 1 && isFingerprint(unique[0]) ? unique[0] : null;
}

const file = z.object({
  file_id: z.string().min(1).max(1024),
  file_unique_id: z.string().min(1).max(128),
  file_name: z.string().min(1).max(1024).optional(),
  mime_type: z.string().min(1).max(255).optional(),
  file_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** The subset of a Bot API `Message` that identifies a delivered media file. */
export const telegramMediaMessageSchema = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int().positive(),
  chat: z.object({ id: z.number().int(), type: z.literal("channel") }),
  caption: z.string().max(4096).optional(),
  video: file
    .extend({ duration: z.number().int().nonnegative().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() })
    .optional(),
  document: file.optional(),
});

export type TelegramMediaMessage = z.infer<typeof telegramMediaMessageSchema>;

/**
 * Maps a validated channel message to the telegram_media row shape. Returns
 * null for a message with no video or document. The caller has already
 * checked the webhook secret and that `chat.id` is the bot's own channel.
 */
export function toTelegramMediaRecord(botType: CatalogueKind, message: TelegramMediaMessage): TelegramMediaRecord | null {
  const media = message.video ? { kind: "video" as const, ...message.video } : message.document ? { kind: "document" as const, ...message.document } : null;
  if (media === null) return null;
  return {
    botType,
    chatId: message.chat.id,
    messageId: message.message_id,
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
    mediaKind: media.kind,
    fileName: media.file_name ?? null,
    mimeType: media.mime_type ?? null,
    caption: message.caption ?? null,
    fileSizeBytes: media.file_size ?? null,
    durationSeconds: "duration" in media ? (media.duration ?? null) : null,
    width: "width" in media ? (media.width ?? null) : null,
    height: "height" in media ? (media.height ?? null) : null,
    telegramDate: new Date(message.date * 1000).toISOString(),
    sourceFingerprint: fingerprintFromCaption(message.caption),
  };
}
