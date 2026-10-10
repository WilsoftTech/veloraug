/** Compare actual private env values without ever printing them. */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { join } from "node:path";
const local = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {};
const privateValues = [...new Set(Object.entries({ ...process.env, ...local }).filter(([name, value]) => !name.startsWith("NEXT_PUBLIC_") && /TOKEN|SECRET|PASSWORD|API_HASH|DATABASE_URL|SERVICE_ROLE|API_KEY/.test(name) && value.length >= 12).map(([, value]) => value))];
const files = new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split(/\r?\n/).filter((file) => !file.startsWith(".claude/")));
function walk(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dev" || entry.name === "cache") continue; // unrelated development cache, outside this release
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path); else files.add(path);
  }
}
walk(".next");
let checked = 0; const hits = [];
const tracedOperationalFiles = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file); checked++;
  if (privateValues.some((value) => bytes.includes(Buffer.from(value)))) hits.push(file);
  if (file.endsWith(".nft.json")) {
    const trace = JSON.parse(bytes.toString("utf8"));
    if (trace.files?.some((entry) => /(?:^|\/)\.env[^/]*$|\.velora-ingest\/|\.claude\/|(?:^|\/)services\/|\.(?:session|dump|mp4|mkv)$/.test(entry))) tracedOperationalFiles.push(file);
  }
}
console.log(JSON.stringify({ event: "release_private_value_scan", checkedFiles: checked, privateValues: privateValues.length, matches: hits.length, paths: hits, tracesWithOperationalFiles: tracedOperationalFiles }));
process.exitCode = hits.length || tracedOperationalFiles.length ? 1 : 0;
