/**
 * Catalogue resolver over Postgres (E1.2A). The gateway connects as the
 * dedicated role `velora_media_gateway`, which can execute
 * media_gateway.resolve_movie_version and nothing else. PostgreSQL privileges,
 * not this module, are the boundary; this module only refuses to run as anyone
 * else.
 *
 * Each resolve is one simple-protocol batch: SET TRANSACTION READ ONLY, a short
 * statement timeout, and the fixed call from lib/media-gateway/resolver-sql.ts.
 * PostgreSQL runs such a batch as one implicit transaction, so it costs one
 * network round trip (~225 ms on the hosted pooler, against ~1.15 s for four).
 * The only interpolated value is the version id, which must be a positive safe
 * integer.
 *
 * Readiness (`check`) re-verifies the identity: the session user must be exactly
 * the gateway role, with no elevated attribute and no membership in postgres or
 * service_role, and the transaction must be read-only. An owner or service
 * credential therefore never becomes ready: there is no fallback.
 */
import postgres from "postgres";
import { GatewayError } from "@/lib/media-gateway/errors";
import type { CatalogueMediaResolver, MediaLocator } from "@/lib/media-gateway/ports";
import { GATEWAY_DATABASE_ROLE, RESOLVE_MOVIE_VERSION_SQL, locatorFromRow, type ResolverRow } from "@/lib/media-gateway/resolver-sql";

export type CatalogueState = "reachable" | "unreachable" | "wrong_identity";

export interface PgResolver extends CatalogueMediaResolver {
  /** Opens the pool's connections ahead of traffic (a pooler connect costs seconds). */
  warm(): Promise<void>;
  /** Readiness probe: `reachable` only for the restricted gateway identity inside a read-only transaction. */
  check(): Promise<CatalogueState>;
  close(): Promise<void>;
}

interface IdentityRow {
  role: string;
  read_only: string;
  elevated: boolean;
  owner_member: boolean;
}

const IDENTITY_SQL = `
select current_user::text as role,
       pg_catalog.current_setting('transaction_read_only') as read_only,
       (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication) as elevated,
       (pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER')
         or pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER')) as owner_member
  from pg_catalog.pg_roles r
 where r.rolname = current_user`;

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

  const resolver: PgResolver = {
    async resolveMovieVersion(movieVersionId: number, signal: AbortSignal): Promise<MediaLocator | null> {
      // The id is interpolated into the batch, so it must be exactly a positive safe integer.
      if (!Number.isSafeInteger(movieVersionId) || movieVersionId <= 0) return null;
      if (signal.aborted) throw new GatewayError("catalogue_unavailable");
      try {
        const rows = await readOnly<ResolverRow>(RESOLVE_MOVIE_VERSION_SQL.replace("$1", String(movieVersionId)));
        if (rows.length > 1) throw new GatewayError("internal_error"); // telegram_media_id is unique; more than one row is a schema breach
        return locatorFromRow(movieVersionId, rows[0]);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        // Driver errors can carry connection details; only the classification leaves this module.
        throw new GatewayError("catalogue_unavailable");
      }
    },
    async check() {
      let row: IdentityRow | undefined;
      try {
        [row] = await readOnly<IdentityRow>(IDENTITY_SQL);
      } catch {
        return "unreachable"; // the driver error can carry connection details; only the state is reported
      }
      const restricted = row?.role === GATEWAY_DATABASE_ROLE && row.read_only === "on" && row.elevated === false && row.owner_member === false;
      return restricted ? "reachable" : "wrong_identity";
    },
    async warm() {
      await Promise.all(Array.from({ length: maxConnections }, () => resolver.check()));
    },
    close: () => sql.end({ timeout: 5 }),
  };
  return resolver;
}
