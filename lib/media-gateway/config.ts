/**
 * Media gateway configuration from the environment (E1.2). Fails closed:
 * anything missing or malformed stops startup. Error messages name the
 * variable, never its value. All variables are server-only (none is
 * NEXT_PUBLIC_). The Next.js application reads only the shared token secret, to
 * issue stream capabilities (E2: lib/playback/stream-capability.ts).
 */
import { limitsFromEnv, type GatewayLimits } from "@/lib/media-gateway/limits";
import { GATEWAY_DATABASE_ROLE } from "@/lib/media-gateway/resolver-sql";
import { parseMediaTokenSecret } from "@/lib/media-gateway/token";

export interface GatewayConfig {
  host: string;
  port: number;
  tokenSecret: Uint8Array;
  databaseUrl: string;
  sessionFile: string;
  allowBotLogin: boolean;
  allowedOrigins: string[];
  limits: GatewayLimits;
  telegram: {
    apiId: number;
    apiHash: string;
    readerBotId: string;
    readerUsername: string;
    /** Only present when a first bot login is explicitly allowed. */
    readerBotToken?: string;
    moviesChannelId: string;
    ingestionBotIds: string[];
  };
}

export class GatewayConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`media gateway configuration invalid: ${variables.join(", ")}`);
    this.name = "GatewayConfigError";
    this.variables = variables;
  }
}

type Env = Record<string, string | undefined>;

export function gatewayConfigFromEnv(env: Env): GatewayConfig {
  const bad: string[] = [];
  const required = (name: string, pattern: RegExp): string => {
    const value = env[name];
    if (value === undefined || !pattern.test(value)) {
      bad.push(name);
      return "";
    }
    return value;
  };
  const either = (primary: string, fallback: string, pattern: RegExp) => (env[primary] ? required(primary, pattern) : required(fallback, pattern));

  const host = env.MEDIA_GATEWAY_HOST ?? "127.0.0.1";
  if (!/^[A-Za-z0-9.:-]{1,64}$/.test(host)) bad.push("MEDIA_GATEWAY_HOST");
  const port = Number(env.MEDIA_GATEWAY_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad.push("MEDIA_GATEWAY_PORT");

  const secret = parseMediaTokenSecret(env.MEDIA_GATEWAY_TOKEN_SECRET);
  if (!secret) bad.push("MEDIA_GATEWAY_TOKEN_SECRET");

  const databaseUrl = required("MEDIA_GATEWAY_DATABASE_URL", /^postgres(ql)?:\/\/\S+$/);
  if (databaseUrl && !isRestrictedDatabaseUrl(databaseUrl)) bad.push("MEDIA_GATEWAY_DATABASE_URL");
  const sessionFile = required("MEDIA_GATEWAY_SESSION_FILE", /^\S.{0,1023}$/);
  const allowBotLogin = env.MEDIA_GATEWAY_ALLOW_BOT_LOGIN === "true";
  const origins = (env.MEDIA_GATEWAY_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.some((origin) => !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin))) bad.push("MEDIA_GATEWAY_ALLOWED_ORIGINS");

  const apiId = Number(either("TELEGRAM_MEDIA_API_ID", "TELEGRAM_API_ID", /^\d{1,12}$/));
  const apiHash = either("TELEGRAM_MEDIA_API_HASH", "TELEGRAM_API_HASH", /^[0-9a-f]{32}$/);
  const readerBotId = required("TELEGRAM_MEDIA_BOT_ID", /^\d{1,20}$/);
  const readerUsername = required("TELEGRAM_MEDIA_BOT_USERNAME", /^[A-Za-z][A-Za-z0-9_]{3,31}$/);
  const readerBotToken = allowBotLogin ? required("TELEGRAM_MEDIA_BOT_TOKEN", /^\d{1,20}:[A-Za-z0-9_-]{30,}$/) : undefined;
  const moviesChannelId = required("TELEGRAM_MOVIES_CHANNEL_ID", /^-100\d{1,16}$/);
  const ingestionBotIds = ["TELEGRAM_MOVIES_BOT_ID", "TELEGRAM_SERIES_BOT_ID"].map((name) => env[name]).filter((id): id is string => !!id && /^\d{1,20}$/.test(id));
  if (ingestionBotIds.length === 0) bad.push("TELEGRAM_MOVIES_BOT_ID");
  if (readerBotId && ingestionBotIds.includes(readerBotId)) bad.push("TELEGRAM_MEDIA_BOT_ID");
  if (readerBotToken && readerBotId && !readerBotToken.startsWith(`${readerBotId}:`)) bad.push("TELEGRAM_MEDIA_BOT_TOKEN");

  let limits: GatewayLimits | null = null;
  try {
    limits = limitsFromEnv(env);
  } catch {
    bad.push("MEDIA_GATEWAY_* limits");
  }

  if (bad.length > 0 || !limits || !secret) throw new GatewayConfigError(bad);
  return {
    host,
    port,
    tokenSecret: secret,
    databaseUrl,
    sessionFile,
    allowBotLogin,
    allowedOrigins: origins,
    limits,
    telegram: { apiId, apiHash, readerBotId, readerUsername, readerBotToken, moviesChannelId, ingestionBotIds },
  };
}

/**
 * The gateway's database credential must be the dedicated least-privilege role
 * (plain, or `role.<project-ref>` as the Supabase pooler expects) with a
 * password. Owner, service and any other identity is refused: there is no
 * fallback. Readiness re-verifies the identity against the live session.
 */
export function isRestrictedDatabaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const user = decodeURIComponent(url.username);
  const [name, projectRef, ...rest] = user.split(".");
  const role = name === GATEWAY_DATABASE_ROLE && rest.length === 0 && (projectRef === undefined || /^[a-z0-9]{10,40}$/.test(projectRef));
  return (url.protocol === "postgres:" || url.protocol === "postgresql:") && role && url.password.length > 0;
}
