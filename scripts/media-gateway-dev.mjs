/**
 * Runs the media gateway locally for playback development (E3.4):
 *
 *   npm run gateway:dev            start (builds the image the first time)
 *   npm run gateway:dev -- --build rebuild the image from this checkout, then start
 *   npm run gateway:dev -- --stop  stop it
 *
 * The gateway is a separate long-running service (services/media-gateway), so
 * `npm run dev` alone cannot play movies. This starts the existing Docker image
 * with the existing reader session and waits for /readyz. Docker Desktop must
 * already be running; this never starts it.
 *
 * Values come from .env.local (the same file Next.js reads, so both hold the
 * same MEDIA_GATEWAY_TOKEN_SECRET). Only the gateway's own variables are passed
 * to the container, by name, so no value appears in a command line or here. The
 * reader bot token and MEDIA_GATEWAY_ALLOW_BOT_LOGIN are never passed: this
 * reuses the existing session and can never log in to Telegram.
 */
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const IMAGE = "velora-media-gateway:dev";
const CONTAINER = "velora-media-gateway-dev";
const CONTAINER_SESSION_DIR = "/run/velora-media";
const DEV_APP_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000";
const PASSED = [
  "MEDIA_GATEWAY_DATABASE_URL",
  "MEDIA_GATEWAY_TOKEN_SECRET",
  "MEDIA_GATEWAY_ALLOWED_ORIGINS",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_MEDIA_API_ID",
  "TELEGRAM_MEDIA_API_HASH",
  "TELEGRAM_MEDIA_BOT_ID",
  "TELEGRAM_MEDIA_BOT_USERNAME",
  "TELEGRAM_MOVIES_BOT_ID",
  "TELEGRAM_SERIES_BOT_ID",
  "TELEGRAM_MOVIES_CHANNEL_ID",
  // Optional limits (lib/media-gateway/limits.ts).
  "MEDIA_GATEWAY_MAX_ACTIVE_STREAMS",
  "MEDIA_GATEWAY_MAX_STREAMS_PER_SUBJECT",
  "MEDIA_GATEWAY_MAX_STREAMS_PER_IP",
  "MEDIA_GATEWAY_MAX_READS_IN_FLIGHT",
  "MEDIA_GATEWAY_READ_AHEAD_PER_STREAM",
  "MEDIA_GATEWAY_MAX_RESPONSE_BYTES",
  "MEDIA_GATEWAY_REQUEST_TIMEOUT_MS",
  "MEDIA_GATEWAY_IDLE_TIMEOUT_MS",
  "MEDIA_GATEWAY_READ_TIMEOUT_MS",
  "MEDIA_GATEWAY_MAX_TOKEN_LIFETIME_SECONDS",
  "MEDIA_GATEWAY_REQUESTS_PER_SUBJECT_PER_WINDOW",
  "MEDIA_GATEWAY_REQUESTS_PER_IP_PER_WINDOW",
  "MEDIA_GATEWAY_RATE_WINDOW_MS",
];

const args = new Set(process.argv.slice(2));
const fail = (message) => {
  console.error(`gateway:dev: ${message}`);
  process.exit(1);
};
const docker = (dockerArgs, options = {}) => spawnSync("docker", dockerArgs, { encoding: "utf8", ...options });

if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) fail("Docker is not running. Start Docker Desktop, then run this again.");

// SIGTERM first: the gateway drains its streams and persists the reader session (main.mts).
docker(["stop", "-t", "20", CONTAINER]);
docker(["rm", "-f", CONTAINER]);
if (args.has("--stop")) {
  console.log("gateway:dev: stopped");
  process.exit(0);
}

const origin = process.env.MEDIA_GATEWAY_PUBLIC_ORIGIN;
let url;
try {
  url = new URL(origin ?? "");
} catch {
  fail("MEDIA_GATEWAY_PUBLIC_ORIGIN is not set in .env.local (for example http://127.0.0.1:8787).");
}
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) fail("MEDIA_GATEWAY_PUBLIC_ORIGIN must be a loopback http:// origin for local development.");
const port = url.port || "80";

const sessionFile = process.env.MEDIA_GATEWAY_SESSION_FILE ? resolve(process.env.MEDIA_GATEWAY_SESSION_FILE) : null;
if (!sessionFile || !existsSync(sessionFile)) fail("MEDIA_GATEWAY_SESSION_FILE must name the existing reader session file. This command never logs in.");

if (args.has("--build") || docker(["image", "inspect", IMAGE]).status !== 0) {
  console.log(`gateway:dev: building ${IMAGE} from this checkout`);
  if (docker(["build", "-f", "services/media-gateway/Dockerfile", "-t", IMAGE, "."], { stdio: "inherit" }).status !== 0) fail("image build failed");
}

const env = { ...process.env, MEDIA_GATEWAY_ALLOWED_ORIGINS: process.env.MEDIA_GATEWAY_ALLOWED_ORIGINS || DEV_APP_ORIGINS };
const names = PASSED.filter((name) => env[name]);
const run = docker(
  [
    "run", "-d", "--rm", "--name", CONTAINER,
    "--read-only", "--tmpfs", "/tmp", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1",
    "-p", `127.0.0.1:${port}:8787`,
    "-v", `${dirname(sessionFile)}:${CONTAINER_SESSION_DIR}`,
    "-e", `MEDIA_GATEWAY_SESSION_FILE=${CONTAINER_SESSION_DIR}/${basename(sessionFile)}`,
    ...names.flatMap((name) => ["-e", name]),
    IMAGE,
  ],
  { env },
);
if (run.status !== 0) fail(`the container did not start: ${(run.stderr ?? "").trim().slice(0, 300)}`);

// Readiness covers the reader's identity, the Movies channel and the restricted database role.
let state = "unreachable";
for (let attempt = 0; attempt < 45; attempt += 1) {
  try {
    const response = await fetch(`${url.origin}/readyz`, { signal: AbortSignal.timeout(2_000) });
    state = (await response.json()).state ?? String(response.status);
    if (response.ok) {
      console.log(`gateway:dev: ready at ${url.origin} (stop with: npm run gateway:dev -- --stop)`);
      process.exit(0);
    }
  } catch {
    // Not listening yet.
  }
  await new Promise((wait) => setTimeout(wait, 2_000));
}
fail(`not ready after 90 s (state: ${state}). See: docker logs ${CONTAINER}`);
