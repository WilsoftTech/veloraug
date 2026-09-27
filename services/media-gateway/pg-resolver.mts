/**
 * Catalogue resolver over Postgres (E1.2). Runs the one fixed statement from
 * lib/media-gateway/resolver-sql.ts in a READ ONLY transaction with a short
 * statement timeout, sent as one simple-protocol batch: one network round trip
 * instead of four (measured on the hosted pooler: ~225 ms against ~1.15 s).
 * Startup parameters cannot carry the read-only default through the Supabase
 * pooler (it drops them; measured), so the batch sets it explicitly. The only
 * interpolated value is the version id, which must be a positive safe integer.
 * The gateway never writes to the catalogue.
 *
 * Credential: MEDIA_GATEWAY_DATABASE_URL. For E1.2 it is the owner connection
 * the ingestion tooling already uses, because private.telegram_media has no
 * grant for any API role (hosted is unchanged in this checkpoint). A dedicated
 * least-privilege role or a narrow SECURITY DEFINER function is follow-up work.
 */
import postgres from "postgres";
import { GatewayError } from "@/lib/media-gateway/errors";
import type { CatalogueMediaResolver, MediaLocator } from "@/lib/media-gateway/ports";
import { RESOLVE_MOVIE_VERSION_SQL, locatorFromRow, type ResolverRow } from "@/lib/media-gateway/resolver-sql";

export interface PgResolver extends CatalogueMediaResolver {
  /** Opens the pool's connections ahead of traffic (a pooler connect costs seconds). */
  warm(): Promise<void>;
  /** Readiness probe: true only if the catalogue answers inside a read-only transaction. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPgResolver(databaseUrl: string, options: { statementTimeoutMs?: number; maxConnections?: number } = {}): PgResolver {
  const timeout = Math.max(100, Math.min(options.statementTimeoutMs ?? 3000, 10_000));
  const maxConnections = options.maxConnections ?? 4;
  const sql = postgres(databaseUrl, {
    max: maxConnections,
    idle_timeout: 600,
    connect_timeout: 10,
    // Pooler (transaction mode) compatible: no named prepared statements.
    prepare: false,
    // The library must not print connection notices or parameters.
    onnotice: () => {},
    connection: { application_name: "velora-media-gateway" },
  });

  /**
   * One round trip. A multi-statement simple query runs as one implicit transaction, so
   * SET TRANSACTION READ ONLY and SET LOCAL apply to the statement and end with it
   * (verified on the hosted pooler: writes refused with 25006, nothing carries over).
   */
  async function readOnly<T>(statement: string): Promise<T[]> {
    const results = (await sql.unsafe(`set transaction read only; set local statement_timeout = ${timeout}; ${statement}`)) as unknown as (T[] & { columns?: unknown[] })[];
    // postgres.js tags batch results unreliably (the SELECT's rows arrive labelled COMMIT), but only a
    // row-returning statement carries a column description, even with zero rows.
    const selected = results.filter((result) => (result.columns?.length ?? 0) > 0);
    if (selected.length !== 1) throw new GatewayError("internal_error");
    return selected[0];
  }

  return {
    async resolveMovieVersion(movieVersionId: number, signal: AbortSignal): Promise<MediaLocator | null> {
      // The id is interpolated into the batch, so it must be exactly a positive safe integer.
      if (!Number.isSafeInteger(movieVersionId) || movieVersionId <= 0) return null;
      if (signal.aborted) throw new GatewayError("catalogue_unavailable");
      try {
        const rows = await readOnly<ResolverRow>(RESOLVE_MOVIE_VERSION_SQL.replace("$1", String(movieVersionId)));
        if (rows.length > 1) throw new GatewayError("internal_error"); // telegram_media_id is unique; more than one row is a schema breach
        return locatorFromRow(rows[0]);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        // Driver errors can carry connection details; only the classification leaves this module.
        throw new GatewayError("catalogue_unavailable");
      }
    },
    async ping() {
      try {
        const [row] = await readOnly<{ read_only: string }>("select current_setting('transaction_read_only') as read_only");
        return row?.read_only === "on";
      } catch {
        return false; // readiness reports "catalogue unreachable"; the detail stays out of logs
      }
    },
    async warm() {
      await Promise.all(Array.from({ length: maxConnections }, () => this.ping()));
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
