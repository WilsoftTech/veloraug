/** Build with synthetic catalogue credentials; erase local operational secrets. */
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isolatedJwt, ISOLATED } from "../isolated-db.mjs";
const env = { ...process.env };
for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(file)) for (const name of Object.keys(parseEnv(readFileSync(file, "utf8")))) env[name] = "";
}
// Supabase clients append /rest/v1; isolated PostgREST has no API gateway.
// A read-only loopback proxy supplies that prefix during this build only.
const port = ISOLATED.restPort + 1;
const proxy = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method) || !request.url.startsWith("/rest/v1/")) { response.writeHead(404); response.end(); return; }
  try {
    const upstream = await fetch(`http://127.0.0.1:${ISOLATED.restPort}${request.url.slice(8)}`, { method: request.method, headers: { authorization: `Bearer ${isolatedJwt({ role: "anon" })}` }, signal: AbortSignal.timeout(10000) });
    response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([key]) => ["content-type", "content-range"].includes(key))));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { response.writeHead(502); response.end(); }
});
await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(port, "127.0.0.1", resolve); });
Object.assign(env, { NODE_ENV: "production", VERCEL_ENV: "", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000", NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: isolatedJwt({ role: "anon" }), NEXT_TELEMETRY_DISABLED: "1", TMDB_ACCESS_TOKEN: "", TMDB_API_KEY: "", VELORA_DISCOVERY_MODE: "" });
try {
  const status = await new Promise((resolve, reject) => { const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env, stdio: "inherit" }); child.once("error", reject); child.once("exit", resolve); });
  process.exitCode = status ?? 1;
} finally { proxy.close(); proxy.closeAllConnections(); }
