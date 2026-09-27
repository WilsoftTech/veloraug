/**
 * The media gateway's only catalogue query (E1.2): a movie version's private
 * media, returned only when the version is publicly playable. It applies the
 * same rule as catalogue_access.movie_is_public (published movie, ready
 * version, cleared rights, active VJ) and two more: the media belongs to the
 * movie bot and sits in the registered Movies channel. Everything else
 * (drafts, Fuze-style uploads with no version, unknown ids) returns no row.
 *
 * $1 is the internal public.movie_versions id, the only client-derived input,
 * and appears exactly once. The adapter substitutes a validated positive safe
 * integer and runs the statement in a READ ONLY transaction with a timeout.
 */
export const RESOLVE_MOVIE_VERSION_SQL = `
select tm.id                  as media_id,
       tm.chat_id::text       as chat_id,
       tm.message_id          as message_id,
       tm.file_unique_id      as file_unique_id,
       tm.file_size_bytes     as file_size_bytes,
       tm.mime_type           as mime_type
  from public.movie_versions mv
  join public.movies m          on m.id = mv.movie_id
  join public.vjs v             on v.id = mv.vj_id
  join private.telegram_media tm
       on tm.id = mv.telegram_media_id
      and tm.bot_type = 'movie'
  join private.telegram_channels c
       on c.bot_type = 'movie'
      and c.chat_id = tm.chat_id
 where mv.id = $1
   and m.publication_status = 'published'
   and m.published_at is not null
   and mv.availability_status = 'ready'
   and mv.rights_status = 'cleared'
   and v.is_active
   and tm.file_size_bytes > 0
`;

export interface ResolverRow {
  media_id: number | string;
  chat_id: string;
  message_id: number | string;
  file_unique_id: string;
  file_size_bytes: number | string;
  mime_type: string | null;
}

/** Validates a resolver row into a MediaLocator, or null if any field is out of shape. */
export function locatorFromRow(row: ResolverRow | undefined) {
  if (!row) return null;
  const mediaId = Number(row.media_id);
  const messageId = Number(row.message_id);
  const fileSize = Number(row.file_size_bytes);
  if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return null;
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  if (!/^-100\d{1,16}$/.test(row.chat_id)) return null;
  if (typeof row.file_unique_id !== "string" || row.file_unique_id.length === 0) return null;
  return { mediaId, chatId: row.chat_id, messageId, fileUniqueId: row.file_unique_id, fileSize, mimeType: row.mime_type ?? null };
}
