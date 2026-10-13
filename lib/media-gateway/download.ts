import { GatewayError } from "@/lib/media-gateway/errors";
import type { MediaLocator } from "@/lib/media-gateway/ports";

/** Existing Telegram movie upload ceiling: 2,000 MiB, not the smaller browser staging limit. */
export const DOWNLOAD_MAX_FILE_BYTES = 2000 * 1024 * 1024;
/**
 * Longest whole response for one download. It is independent of the capability:
 * a transfer authorized before its ten-minute capability expires may run on, up
 * to this limit. 2,000 MiB in four hours needs about 1.2 Mbit/s sustained.
 */
export const DOWNLOAD_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
export const DOWNLOAD_LIMITS = {
  maxActiveStreams: 4, maxStreamsPerSubject: 1, maxStreamsPerIp: 2,
  readAhead: 1, requestTimeoutMs: DOWNLOAD_MAX_DURATION_MS, maxTokenLifetimeSeconds: 600,
  recheckMs: 30_000, authorizationTimeoutMs: 5_000,
} as const;
export type DownloadLimits = { [K in keyof typeof DOWNLOAD_LIMITS]: number };

/**
 * Operator settings for downloads. Each one can only tighten its default: the
 * defaults are the ceilings, so raising a duration or a concurrency limit is a
 * code change that needs load-test evidence, never a deployment setting.
 */
const DOWNLOAD_ENV: readonly { name: string; key: keyof DownloadLimits; min: number }[] = [
  { name: "MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS", key: "requestTimeoutMs", min: 60_000 },
  { name: "MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE", key: "maxActiveStreams", min: 1 },
  { name: "MEDIA_GATEWAY_DOWNLOAD_MAX_PER_USER", key: "maxStreamsPerSubject", min: 1 },
  { name: "MEDIA_GATEWAY_DOWNLOAD_MAX_PER_IP", key: "maxStreamsPerIp", min: 1 },
];
export const DOWNLOAD_ENV_NAMES: readonly string[] = DOWNLOAD_ENV.map((setting) => setting.name);

/** Reads download limits from the environment. An unparsable or out-of-bounds value fails closed (throws). */
export function downloadLimitsFromEnv(env: Record<string, string | undefined>): Partial<DownloadLimits> {
  const limits: { -readonly [K in keyof DownloadLimits]?: number } = {};
  for (const { name, key, min } of DOWNLOAD_ENV) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const max = DOWNLOAD_LIMITS[key];
    const value = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= min && value <= max)) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
    limits[key] = value;
  }
  return limits;
}

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
