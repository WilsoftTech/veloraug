/** Synthetic data only. No env files or external database arguments accepted. */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { up, down, psql, ISOLATED } from "../isolated-db.mjs";

const root = join(import.meta.dirname, "../..");
const migration = "20261010090000_direct_channel_publication.sql";
const temp = mkdtempSync(join(tmpdir(), "velora-synthetic-backup-"));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const query = (sql) => { const result = psql(sql); if (result.code) throw new Error(result.err); return result.out.trim(); };
const snapshot = `select jsonb_build_object('movies',(select jsonb_agg(to_jsonb(m) order by id) from public.movies m), 'versions',(select jsonb_agg(to_jsonb(v) order by id) from public.movie_versions v), 'media',(select jsonb_agg(to_jsonb(t) order by id) from private.telegram_media t))::text`;
const started = Date.now();
try {
  up({ rest: false, stopBefore: migration });
  const seed = psql(null, { file: join(root, "supabase/seeds/dev-catalogue.sql") });
  if (seed.code) throw new Error(seed.err);
  const before = query(snapshot);
  docker("exec", ISOLATED.db, "pg_dump", "-U", "supabase_admin", "-Fc", "-f", "/tmp/e38b-synthetic.dump", "postgres");
  docker("cp", `${ISOLATED.db}:/tmp/e38b-synthetic.dump`, join(temp, "synthetic.dump"));
  // Verify archive parsing and contents before restore. Never print database data.
  const manifest = docker("exec", ISOLATED.db, "pg_restore", "--list", "/tmp/e38b-synthetic.dump");
  if (!manifest.includes("TABLE DATA public movies") || !manifest.includes("TABLE DATA private telegram_media")) throw new Error("backup_manifest_incomplete");
  writeFileSync(join(temp, "manifest.txt"), manifest);
  for (const name of readdirSync(join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql") && name >= migration).sort()) {
    const result = psql(null, { file: join(root, "supabase/migrations", name) });
    if (result.code) throw new Error(result.err);
  }
  if (query(snapshot) !== before) throw new Error("migration_changed_existing_catalogue");
  if (query("select count(*) from private.catalogue_reviewers") !== "0") throw new Error("reviewers_auto_enrolled");
  // Migration 13 is single-apply history, not repeatable SQL: replay must fail
  // atomically. Run against the disposable database with a transaction wrapper.
  const replay = spawnSync("psql", ["-X", "-h", "127.0.0.1", "-p", String(ISOLATED.dbPort), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", join(root, "supabase/migrations", migration)], {
    env: { ...process.env, PGPASSWORD: ISOLATED.password }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (replay.status !== 3 || !String(replay.stderr).includes("already exists")) throw new Error("migration_replay_result_unexpected");
  if (query(snapshot) !== before) throw new Error("replay_changed_catalogue");
  const restoreStarted = Date.now();
  // Restore into a FRESH disposable instance. In-place --clean cannot remove
  // post-backup objects/foreign keys and is not a production rollback strategy.
  up({ rest: false, stopBefore: "20260919000000_profiles_and_watchlist.sql" });
  query("create role velora_media_gateway nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit");
  docker("cp", join(temp, "synthetic.dump"), `${ISOLATED.db}:/tmp/e38b-synthetic.dump`);
  docker("exec", ISOLATED.db, "pg_restore", "-U", "supabase_admin", "--clean", "--if-exists", "--exit-on-error", "-d", "postgres", "/tmp/e38b-synthetic.dump");
  if (query(snapshot) !== before) throw new Error("restore_catalogue_mismatch");
  const version = query("select count(*) from information_schema.tables where table_schema='private' and table_name='channel_reviews'");
  if (version !== "0") throw new Error("restore_schema_mismatch");
  console.log(JSON.stringify({ event: "synthetic_backup_restore_pass", migration13ExistingRecordsUnchanged: true, replayFailedAtomically: true, restoredPreMigrationSchema: true, restoreMs: Date.now() - restoreStarted, totalMs: Date.now() - started, archiveSha256: createHash("sha256").update(readFileSync(join(temp, "synthetic.dump"))).digest("hex") }));
} finally {
  down(); rmSync(temp, { recursive: true, force: true });
}
