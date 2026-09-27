/**
 * The media gateway's two external boundaries (E1.2). The HTTP core depends only
 * on these interfaces; the Postgres and MTProto adapters live in
 * services/media-gateway and are never imported by the Next.js application.
 */

/**
 * Where a published version's bytes live. Server-internal: it holds Telegram
 * identifiers, so it is never logged, serialized or derived from client input.
 * It only ever comes from the catalogue resolver.
 */
export interface MediaLocator {
  /** The internal movie-version id this location was resolved for (the reader's cache key). */
  movieVersionId: number;
  /** Telegram channel id in Bot API form (-100…), as stored in the catalogue. */
  chatId: string;
  messageId: number;
  /** Bot API file_unique_id: the reader checks the resolved document against it. */
  fileUniqueId: string;
  fileSize: number;
  mimeType: string | null;
}

export interface CatalogueMediaResolver {
  /**
   * Returns the media of one movie version only if it is publicly playable
   * (published movie, ready version, cleared rights, active VJ, media in the
   * registered Movies channel), otherwise null. Throws GatewayError
   * `catalogue_unavailable` when the catalogue cannot be read.
   */
  resolveMovieVersion(movieVersionId: number, signal: AbortSignal): Promise<MediaLocator | null>;
}

export interface ReaderReadiness {
  ready: boolean;
  /** Safe state label for /readyz and logs (never an id or message). */
  state: string;
}

export interface MediaReader {
  readiness(): ReaderReadiness;
  /**
   * One aligned `upload.getFile` read: `offset` and `limit` are 1 KiB multiples,
   * `limit` ≤ 1 MiB, inside one 1 MiB window (the E1.1 planner guarantees this).
   * Must honour `signal` (cancel, or at least stop retrying). Throws GatewayError.
   * `rpcCount` counts every MTProto call the read needed (resolution, retries).
   */
  readPart(locator: MediaLocator, offset: number, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; rpcCount: number }>;
}
