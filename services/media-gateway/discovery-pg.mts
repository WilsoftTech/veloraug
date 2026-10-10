import postgres from "postgres";
import type { DiscoveryRpc } from "@/lib/discovery/database";

// Fixed function names, named arguments and casts. Never interpolate a caller's SQL.
const calls: Record<string, readonly (readonly [string, string])[]> = {
  discovery_acquire_consumer: [["p_token", "uuid"], ["p_lease_seconds", "integer"]],
  discovery_receive: [["p_token", "uuid"], ["p_chat_id", "bigint"], ["p_deliveries", "jsonb"], ["p_reconciliation", "jsonb"]],
  discovery_claim: [["p_lease_seconds", "integer"]],
  discovery_complete: [["p_key", "text"], ["p_lease", "uuid"], ["p_revision", "integer"], ["p_result", "jsonb"]],
  discovery_fail: [["p_key", "text"], ["p_lease", "uuid"], ["p_revision", "integer"], ["p_code", "text"]],
  discovery_catalogue_lookup: [["p_title", "text"]], discovery_vjs: [], discovery_health: [], discovery_release_consumer: [["p_token", "uuid"]],
};
export function createDiscoveryPg(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (!/^velora_discovery_worker(?:\.[a-z0-9]{10,40})?$/.test(decodeURIComponent(url.username)) || !url.password || !["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("discovery_wrong_database_identity");
  const sql = postgres(databaseUrl, { max: 2, prepare: false, connect_timeout: 5, idle_timeout: 30, onnotice: () => {}, connection: { application_name: "velora-discovery" },
    types: { safeBigint: { to: 20, from: [20], serialize: String, parse: (value: string) => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error("discovery_integer_out_of_range"); return number; } } },
    transform: { value: (value) => value instanceof Date ? value.toISOString() : value },
  });
  async function check() {
    const rows = await sql`select current_user as role, session_user as login,
      (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication
        or pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER')
        or pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER')) as elevated
      from pg_catalog.pg_roles r where r.rolname = current_user`;
    if (rows.length !== 1 || rows[0].role !== "velora_discovery_worker" || rows[0].login !== "velora_discovery_worker" || rows[0].elevated) throw new Error("discovery_wrong_database_identity");
  }
  const rpc: DiscoveryRpc = async (fn, args) => {
    const spec = calls[fn];
    if (!spec || Object.keys(args).length !== spec.length || spec.some(([name]) => !(name in args))) return { data: null, error: { message: "discovery_invalid_input" } };
    try {
      const values = spec.map(([name, cast]) => args[name] === null ? null : cast === "jsonb" ? sql.json(args[name] as postgres.JSONValue) : String(args[name]));
      const parameters = spec.map(([name, cast], index) => `${name} => $${index + 1}::${cast}`).join(", ");
      const table = fn === "discovery_acquire_consumer" || fn === "discovery_catalogue_lookup" || fn === "discovery_vjs";
      const rows = await sql.unsafe(`select ${table ? "* from" : ""} public.${fn}(${parameters})${table ? "" : " as result"}`, values);
      return { data: table ? rows : rows[0]?.result ?? null, error: null };
    } catch (error) {
      const detail = error as { code?: string; message?: string };
      return { data: null, error: { code: detail.code, message: detail.message } };
    }
  };
  return { rpc, check, close: () => sql.end({ timeout: 5 }) };
}
