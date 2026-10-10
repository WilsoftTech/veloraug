/**
 * Disposable, isolated database for migration and integration gates (E3.8A).
 *
 *   node scripts/isolated-db.mjs up       fresh container + every migration (+ PostgREST)
 *   (integration: `npm run test:integration:isolated`, which also loads the dev catalogue seed)
 *   node scripts/isolated-db.mjs test     up, then every pgTAP suite in supabase/tests/database
 *   node scripts/isolated-db.mjs down     remove the containers and network
 *
 * Never touches the developer's local Supabase stack (no `db reset`) and never
 * reads .env.local, DATABASE_URL or any hosted credential: it talks only to
 * Docker and to 127.0.0.1. The database lives on tmpfs and is recreated on
 * every `up`. Passwords and the JWT secret are fixed, synthetic, local-only
 * values (the pgTAP suites already assume the local-stack password).
 *
 * The image is the one pinned by the local Supabase stack. Its auth schema is
 * minimal, so `up` installs the hosted-equivalent auth.uid()/auth.jwt() and the
 * auth.users.is_anonymous column (harness setup, not a migration).
 */
import { createHmac } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const ISOLATED = {
  network: "velora-e38a-net",
  db: "velora-e38a-db",
  rest: "velora-e38a-rest",
  dbPort: 54439,
  restPort: 54440,
  password: "postgres",
  jwtSecret: "velora-e38a-isolated-synthetic-jwt-secret-0001",
  image: "public.ecr.aws/supabase/postgres:17.6.1.166",
  restImage: "public.ecr.aws/supabase/postgrest:v14.5",
};

const root = join(import.meta.dirname, "..");

/** HS256 JWT signed with the isolated PostgREST's synthetic secret (tests only). */
export function isolatedJwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${body}.${createHmac("sha256", ISOLATED.jwtSecret).update(body).digest("base64url")}`;
}
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quiet = (...args) => spawnSync("docker", args, { encoding: "utf8" });

export function psql(sql, { user = "postgres", file = null } = {}) {
  const args = ["-X", "-h", "127.0.0.1", "-p", String(ISOLATED.dbPort), "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
  if (file) args.push("-f", file);
  const result = spawnSync("psql", args, { input: file ? undefined : sql, encoding: "utf8", env: { ...process.env, PGPASSWORD: ISOLATED.password, PGCONNECT_TIMEOUT: "5" }, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function waitFor(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
  }
  throw new Error(`${label} did not become ready`);
}

export function down() {
  quiet("rm", "-f", ISOLATED.rest);
  quiet("rm", "-f", ISOLATED.db);
  quiet("network", "rm", ISOLATED.network);
}

export function up({ rest = true, seed = false, stopBefore = null } = {}) {
  down();
  docker("network", "create", ISOLATED.network);
  docker("run", "-d", "--name", ISOLATED.db, "--network", ISOLATED.network, "-p", `127.0.0.1:${ISOLATED.dbPort}:5432`,
    "-e", `POSTGRES_PASSWORD=${ISOLATED.password}`, "--tmpfs", "/var/lib/postgresql/data:rw", ISOLATED.image);
  waitFor(() => quiet("exec", ISOLATED.db, "pg_isready", "-U", "postgres", "-h", "127.0.0.1").status === 0
    && psql("select 1", { user: "supabase_admin" }).code === 0, "isolated database");
  const setup = psql(`
    alter role postgres password '${ISOLATED.password}';
    alter role authenticator password '${ISOLATED.password}';
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
    alter table auth.users add column if not exists is_anonymous boolean not null default false;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;`, { user: "supabase_admin" });
  if (setup.code !== 0) throw new Error(`harness setup failed: ${setup.err}`);
  const migrations = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const name of migrations) {
    if (name === stopBefore) break;
    const result = psql(null, { file: join(root, "supabase/migrations", name) });
    if (result.code !== 0) throw new Error(`migration ${name} failed:\n${result.err}`);
    applied++;
  }
  console.log(`isolated database: ${applied} migrations applied`);
  if (seed) {
    const result = psql(null, { file: join(root, "supabase/seeds/dev-catalogue.sql") });
    if (result.code !== 0) throw new Error(`seed failed:
${result.err}`);
    console.log("isolated database: dev catalogue seed loaded");
  }
  if (rest) {
    docker("run", "-d", "--name", ISOLATED.rest, "--network", ISOLATED.network, "-p", `127.0.0.1:${ISOLATED.restPort}:3000`,
      "-e", `PGRST_DB_URI=postgres://authenticator:${ISOLATED.password}@${ISOLATED.db}:5432/postgres`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${ISOLATED.jwtSecret}`,
      ISOLATED.restImage);
    const probe = `fetch("http://127.0.0.1:${ISOLATED.restPort}/").then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))`;
    waitFor(() => spawnSync(process.execPath, ["-e", probe]).status === 0, "isolated PostgREST", 60_000);
    console.log(`isolated PostgREST: http://127.0.0.1:${ISOLATED.restPort}`);
  }
}

export function testDb() {
  const suites = readdirSync(join(root, "supabase/tests/database")).filter((f) => f.endsWith(".test.sql")).sort();
  let total = 0, failed = 0;
  for (const name of suites) {
    const result = psql(null, { file: join(root, "supabase/tests/database", name) });
    const output = result.out + result.err;
    const planned = Number(/^1\.\.(\d+)/m.exec(output)?.[1] ?? 0);
    const passed = (output.match(/^ok \d+/gm) ?? []).length;
    const bad = result.code !== 0 || planned === 0 || passed !== planned || /^not ok/m.test(output);
    total += passed;
    if (bad) {
      failed++;
      console.log(`${name}: FAIL (${passed}/${planned})`);
      console.log(output.split("\n").filter((line) => /^not ok|^#|ERROR/.test(line)).slice(0, 40).join("\n"));
    } else console.log(`${name}: ${passed}/${planned} passed`);
  }
  console.log(`database suites: ${suites.length - failed}/${suites.length} passed, ${total} assertions`);
  return failed === 0;
}

if (import.meta.main ?? process.argv[1]?.endsWith("isolated-db.mjs")) {
  const command = process.argv[2];
  if (command === "up") up();
  else if (command === "down") down();
  else if (command === "test") {
    up({ rest: process.argv.includes("--rest") });
    const ok = testDb();
    process.exitCode = ok ? 0 : 1;
  } else {
    console.error("usage: node scripts/isolated-db.mjs up | test [--rest] | down");
    process.exitCode = 2;
  }
}
