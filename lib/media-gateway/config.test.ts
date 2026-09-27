import { describe, expect, it } from "vitest";
import { GatewayConfigError, gatewayConfigFromEnv } from "@/lib/media-gateway/config";

const SECRET = Buffer.alloc(32, 5).toString("base64url");
const valid = {
  MEDIA_GATEWAY_TOKEN_SECRET: SECRET,
  MEDIA_GATEWAY_DATABASE_URL: "postgresql://user:pw@localhost:5432/postgres",
  MEDIA_GATEWAY_SESSION_FILE: "/run/velora-media/reader.session",
  TELEGRAM_API_ID: "123456",
  TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
  TELEGRAM_MEDIA_BOT_ID: "7000000001",
  TELEGRAM_MEDIA_BOT_USERNAME: "example_reader_bot",
  TELEGRAM_MOVIES_CHANNEL_ID: "-1001234567890",
  TELEGRAM_MOVIES_BOT_ID: "7000000002",
};

const failures = (env: Record<string, string | undefined>) => {
  try {
    gatewayConfigFromEnv(env);
    return [];
  } catch (error) {
    if (!(error instanceof GatewayConfigError)) throw error;
    return error.variables;
  }
};

describe("gatewayConfigFromEnv", () => {
  it("accepts a complete configuration with loopback defaults", () => {
    const config = gatewayConfigFromEnv(valid);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8787, allowBotLogin: false, allowedOrigins: [] });
    expect(config.telegram.readerBotToken).toBeUndefined();
    expect(config.tokenSecret.length).toBe(32);
  });

  it("names missing variables without echoing values", () => {
    let message = "";
    try {
      gatewayConfigFromEnv({ ...valid, MEDIA_GATEWAY_TOKEN_SECRET: undefined, MEDIA_GATEWAY_DATABASE_URL: undefined, TELEGRAM_API_HASH: "not-a-hash-but-secret-looking-value" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MEDIA_GATEWAY_TOKEN_SECRET");
    expect(message).toContain("MEDIA_GATEWAY_DATABASE_URL");
    expect(message).toContain("TELEGRAM_API_HASH");
    expect(message).not.toContain("secret-looking");
  });

  it("refuses a short token secret", () => {
    expect(failures({ ...valid, MEDIA_GATEWAY_TOKEN_SECRET: Buffer.alloc(16).toString("base64url") })).toContain("MEDIA_GATEWAY_TOKEN_SECRET");
  });

  it("refuses a reader that is an ingestion bot", () => {
    expect(failures({ ...valid, TELEGRAM_MEDIA_BOT_ID: valid.TELEGRAM_MOVIES_BOT_ID })).toContain("TELEGRAM_MEDIA_BOT_ID");
  });

  it("requires the reader token only when a first login is explicitly allowed, and checks it belongs to the reader", () => {
    expect(failures({ ...valid, MEDIA_GATEWAY_ALLOW_BOT_LOGIN: "true" })).toContain("TELEGRAM_MEDIA_BOT_TOKEN");
    expect(failures({ ...valid, MEDIA_GATEWAY_ALLOW_BOT_LOGIN: "true", TELEGRAM_MEDIA_BOT_TOKEN: `7000000002:${"a".repeat(35)}` })).toContain("TELEGRAM_MEDIA_BOT_TOKEN");
    expect(failures({ ...valid, MEDIA_GATEWAY_ALLOW_BOT_LOGIN: "yes", TELEGRAM_MEDIA_BOT_TOKEN: "x" })).toEqual([]);
  });

  it("prefers dedicated media API credentials when present", () => {
    const config = gatewayConfigFromEnv({ ...valid, TELEGRAM_MEDIA_API_ID: "999", TELEGRAM_MEDIA_API_HASH: "f".repeat(32) });
    expect(config.telegram).toMatchObject({ apiId: 999, apiHash: "f".repeat(32) });
  });

  it.each([
    ["TELEGRAM_MOVIES_CHANNEL_ID", "12345"],
    ["MEDIA_GATEWAY_PORT", "70000"],
    ["MEDIA_GATEWAY_ALLOWED_ORIGINS", "javascript:alert(1)"],
    ["MEDIA_GATEWAY_DATABASE_URL", "mysql://x"],
    ["MEDIA_GATEWAY_MAX_READS_IN_FLIGHT", "1000"],
  ])("fails closed on bad %s", (name, value) => {
    expect(failures({ ...valid, [name]: value }).length).toBeGreaterThan(0);
  });
});
