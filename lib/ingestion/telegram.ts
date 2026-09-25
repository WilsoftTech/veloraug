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

/**
 * Bot API caption limit for media (characters after entity parsing). Captions
 * are sent as plain text, with no parse_mode, so this is a character count.
 */
export const TELEGRAM_CAPTION_MAX = 1024;
const CAPTION_LINE_MAX = 200;

export interface UploadCaptionInput {
  kind: CatalogueKind;
  title: string | null;
  year: number | null;
  /** Display name of the resolved VJ, else the parsed VJ text. */
  vjName: string | null;
  season: number | null;
  episode: number | null;
  fingerprint: SourceFingerprint;
}

const captionLine = (text: string) =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, CAPTION_LINE_MAX).trim();
const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * The deterministic caption for an uploaded file: human-readable title, VJ
 * and movie/episode identity, then the machine-readable source token as the
 * last line. It never contains the local path or file name (Telegram keeps
 * the file name anyway), a token or any other secret. The token is always
 * present and intact; human lines are bounded so the whole caption fits.
 */
export function buildUploadCaption(input: UploadCaptionInput): string {
  const title = captionLine(input.title ?? "") || "Untitled";
  const lines = [input.year === null ? title : `${title} (${input.year})`];
  const vj = captionLine(input.vjName ?? "");
  if (vj) lines.push(/^vj\b/i.test(vj) ? vj : `VJ ${vj}`);
  lines.push(
    input.kind === "movie"
      ? "Movie"
      : `Series ${input.season === null ? "S??" : `S${pad2(input.season)}`}${input.episode === null ? "E??" : `E${pad2(input.episode)}`}`,
  );
  lines.push(sourceCaptionToken(input.fingerprint));
  return lines.join("\n");
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
