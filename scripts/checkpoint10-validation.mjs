/** The verification contract on the recorded hosted schema, disposable tmpfs database only.
 * node scripts/checkpoint10-validation.mjs
 *
 * The channel half of Checkpoint 10 must not need the admin upload chain. This
 * applies the recorded hosted set of 17 migrations, then only the two channel
 * migrations (20261011192618 and 20261014090000), and runs their two suites
 * there. The full chain is covered by `npm run test:db:isolated`, and both
 * ingestion paths end to end by tests/integration/original-verification.test.tsx.
 * No operational configuration is read.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { up, down, psql } from "./isolated-db.mjs";

const NOT_APPLIED = ["20261011083200_admin_upload_sessions.sql", "20261011084309_admin_upload_disk_chunks.sql", "20261011085220_admin_upload_inspection.sql", "20261011093300_admin_upload_r2_staging.sql",
  "20261011094004_admin_upload_r2_worker.sql", "20261011095632_admin_upload_r2_visibility.sql", "20261011192619_admin_original_media_evidence.sql", "20261014090001_admin_original_media_verification.sql",
  "20261011200813_original_media_download_resolver.sql"];
const sql = (statement) => { const result = psql(statement); assert.equal(result.code, 0, result.err); return result.out.trim(); };

try {
  assert.equal(readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).length, 28);
  up({ rest: false, excludeMigrations: NOT_APPLIED });
  assert.equal(sql("select to_regclass('private.admin_upload_sessions') is null and to_regrole('velora_upload_worker') is null"), "t", "the admin upload chain is absent");
  // What the migration must leave as it found it: the gate's predicate, and the gateway's streaming resolver.
  assert.equal(sql("select count(*) from pg_proc where oid in ('private.media_evidence_publishable(private.media_evidence)'::regprocedure, 'media_gateway.resolve_movie_version(bigint)'::regprocedure)"), "2");
  for (const suite of ["018_original_media_evidence.test.sql", "021_original_media_verification.test.sql"]) {
    const result = psql(readFileSync(`supabase/tests/database/${suite}`, "utf8"));
    const output = result.out + result.err;
    const passed = (output.match(/^ok \d+/gm) ?? []).length;
    assert.equal(result.code, 0, output.slice(-2000));
    assert.equal((output.match(/^not ok/gm) ?? []).length, 0, output.split("\n").filter((line) => /^not ok|^#/.test(line)).join("\n"));
    assert.ok(passed > 0);
    console.log(`${suite}: ${passed} assertions passed on hosted 17 + the two channel migrations`);
  }
  // The worker role gained exactly one function, and nothing on a table.
  assert.equal(sql("select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'discovery_%' and has_function_privilege('velora_discovery_worker', p.oid, 'EXECUTE')"),
    "discovery_acquire_consumer,discovery_catalogue_lookup,discovery_claim,discovery_claim_verification,discovery_complete,discovery_fail,discovery_health,discovery_receive,discovery_release_consumer,discovery_vjs");
  assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('private','public') and c.relkind in ('r','v','m','p') and has_table_privilege('velora_discovery_worker', c.oid, 'SELECT,INSERT,UPDATE,DELETE')"), "0");
  console.log("hosted 17 + channel Policy 3 + verification contract: applies without the admin upload chain; the worker role has ten functions and no table access");
} finally { down(); }
