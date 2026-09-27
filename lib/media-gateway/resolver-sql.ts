/**
 * The media gateway's only catalogue query (E1.2A). It calls the resolver that
 * migration 20260927210453_media_gateway_least_privilege.sql defines, and the
 * gateway connects as the dedicated role that migration creates. That role can
 * execute this one function and nothing else, so the database, not this code,
 * enforces the boundary.
 *
 * The function applies the publication rule (published movie, ready version,
 * cleared rights, active VJ, movie-bot media in the registered Movies channel,
 * a recorded size) and returns exactly five transport fields. Anything else,
 * including Fuze-style media with no version and unknown ids, yields no row.
 *
 * $1 is the internal public.movie_versions id, the only client-derived input,
 * and appears exactly once. The adapter substitutes a validated positive safe
 * integer and runs the statement in a READ ONLY transaction with a timeout.
 */
export const RESOLVE_MOVIE_VERSION_SQL = `
select r.chat_id::text as chat_id, r.message_id, r.file_unique_id, r.file_size_bytes, r.mime_type
  from media_gateway.resolve_movie_version($1::bigint) as r
`;

/** The only database identity the gateway accepts (created by the E1.2A migration). */
export const GATEWAY_DATABASE_ROLE = "velora_media_gateway";

/** The resolver's exact output columns; anything more would be a boundary change. */
export const RESOLVER_COLUMNS = ["chat_id", "message_id", "file_unique_id", "file_size_bytes", "mime_type"] as const;

export interface ResolverRow {
  chat_id: string;
  message_id: number | string;
  file_unique_id: string;
  file_size_bytes: number | string;
  mime_type: string | null;
}

/** Validates a resolver row into a MediaLocator for the given version, or null if any field is out of shape. */
export function locatorFromRow(movieVersionId: number, row: ResolverRow | undefined) {
  if (!row) return null;
  const messageId = Number(row.message_id);
  const fileSize = Number(row.file_size_bytes);
  if (!Number.isSafeInteger(movieVersionId) || movieVersionId <= 0) return null;
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  if (typeof row.chat_id !== "string" || !/^-100\d{1,16}$/.test(row.chat_id)) return null;
  if (typeof row.file_unique_id !== "string" || row.file_unique_id.length === 0) return null;
  return { movieVersionId, chatId: row.chat_id, messageId, fileUniqueId: row.file_unique_id, fileSize, mimeType: row.mime_type ?? null };
}
