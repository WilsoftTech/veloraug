import { ISOLATED, isolatedJwt, psql } from "../../scripts/isolated-db.mjs";

export { isolatedJwt };

/**
 * The disposable E3.8A integration environment (scripts/isolated-db.mjs):
 * Postgres on 127.0.0.1:54439 and PostgREST on 127.0.0.1:54440, both recreated
 * on tmpfs for every run. Synthetic, local-only credentials; never hosted,
 * never .env.local, never the developer's local Supabase stack.
 */
export const ISOLATED_DB_PORT: number = ISOLATED.dbPort;
export const ISOLATED_REST = `http://127.0.0.1:${ISOLATED.restPort}`;

/** SQL against the isolated database as a named role (login roles only). */
export function isolatedSql(statement: string, user = "postgres"): string {
  if (process.env.VELORA_E38_ISOLATED_TESTS !== "true") throw new Error("isolated_tests_only");
  const result = psql(statement, { user, quiet: true });
  if (result.code !== 0) throw Object.assign(new Error((result.err || "psql_failed").trim()), { stderr: result.err });
  return result.out.trim();
}
