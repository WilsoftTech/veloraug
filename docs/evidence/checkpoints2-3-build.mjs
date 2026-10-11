// Offline production-build verification: no hosted credentials or database.
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isolatedJwt } from "../../scripts/isolated-db.mjs";

const env = { ...process.env };
for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(file)) for (const name of Object.keys(parseEnv(readFileSync(file, "utf8")))) env[name] = "";
}
const catalogue = createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method) || !request.url.startsWith("/rest/v1/")) {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, { "content-type": "application/json", "content-range": "*/0" });
  response.end("[]");
});
await new Promise((done) => catalogue.listen(0, "127.0.0.1", done));
Object.assign(env, {
  NODE_ENV: "production", VERCEL_ENV: "", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000",
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${catalogue.address().port}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: isolatedJwt({ role: "anon" }),
  NEXT_TELEMETRY_DISABLED: "1", TMDB_ACCESS_TOKEN: "", TMDB_API_KEY: "",
});
try {
  const status = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", done);
  });
  process.exitCode = status ?? 1;
} finally {
  catalogue.close(); catalogue.closeAllConnections();
}
