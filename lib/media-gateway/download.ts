import { GatewayError } from "@/lib/media-gateway/errors";
import type { MediaLocator } from "@/lib/media-gateway/ports";

/** Existing Telegram movie upload ceiling: 2,000 MiB, not the smaller browser staging limit. */
export const DOWNLOAD_MAX_FILE_BYTES = 2000 * 1024 * 1024;
export const DOWNLOAD_LIMITS = {
  maxActiveStreams: 4, maxStreamsPerSubject: 1, maxStreamsPerIp: 2,
  readAhead: 1, requestTimeoutMs: 600_000, maxTokenLifetimeSeconds: 600,
  recheckMs: 30_000, authorizationTimeoutMs: 5_000,
} as const;
export type DownloadLimits = { [K in keyof typeof DOWNLOAD_LIMITS]: number };

export function downloadHeaders(locator: MediaLocator) {
  const extension = locator.mimeType === "video/mp4" ? "mp4" : locator.mimeType === "video/x-matroska" ? "mkv" : null;
  if (!extension || locator.fileSize > DOWNLOAD_MAX_FILE_BYTES) throw new GatewayError("version_unavailable");
  const original = locator.fileName;
  // Invalid historical names are never echoed or repaired into a path/header.
  const safe = typeof original === "string" && original.length > 0 && original.length <= 1024
    && original.isWellFormed() && !/[\\/\p{Cc}\p{Cf}]/u.test(original)
    && !original.startsWith(".") && original.trim() === original
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(original)
    && original.toLowerCase().endsWith(`.${extension}`);
  const name = safe ? original : `velora-movie-version-${locator.movieVersionId}.${extension}`;
  const ascii = name.replace(/[^a-zA-Z0-9 .()_-]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    "Content-Type": locator.mimeType!,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
}
