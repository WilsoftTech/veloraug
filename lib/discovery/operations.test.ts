import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { botApiUpdateProvider } from "./bot-api-provider";
import { boundedHistoryProvider } from "./worker";

describe("persistent worker offline configuration", () => {
  const check = (inspection: string, live = false, emptyReader = false) => {
    const env: NodeJS.ProcessEnv = { ...process.env,
      VELORA_DISCOVERY_DATABASE_URL: "postgres://velora_discovery_worker:synthetic-password@127.0.0.1:1/postgres",
      TELEGRAM_BOT_API_URL: "http://127.0.0.1:1", TELEGRAM_MOVIES_BOT_TOKEN: `123456:${"a".repeat(35)}`,
      TELEGRAM_MOVIES_BOT_ID: "123456", TELEGRAM_MOVIES_BOT_USERNAME: "SyntheticBot", TELEGRAM_MOVIES_CHANNEL_ID: "-1001111111111",
      VELORA_DISCOVERY_INSPECTION: inspection, VELORA_DISCOVERY_HEALTH_PORT: "8790",
    };
    for (const key of ["VELORA_DISCOVERY_LIVE_AUTHORIZED", "VELORA_DISCOVERY_SESSION_FILE", "TELEGRAM_MEDIA_API_ID", "TELEGRAM_MEDIA_API_HASH", "TELEGRAM_MEDIA_BOT_ID", "TELEGRAM_MEDIA_BOT_USERNAME"]) delete env[key];
    if (emptyReader) for (const key of ["VELORA_DISCOVERY_SESSION_FILE", "TELEGRAM_MEDIA_API_ID", "TELEGRAM_MEDIA_API_HASH", "TELEGRAM_MEDIA_BOT_ID", "TELEGRAM_MEDIA_BOT_USERNAME"]) env[key] = "";
    return spawnSync(process.execPath, ["--experimental-transform-types", "--import", "./scripts/ingest/register.mjs", "services/media-gateway/discovery.mts", ...(live ? [] : ["--check"])], { env, encoding: "utf8", timeout: 10000 });
  };
  it("metadata matching config needs no reader session and touches neither unreachable endpoint", () => {
    const result = check("metadata");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"event":"discovery_configuration_valid","inspection":"metadata"');
  });
  it("bounded inspection still fails closed without dedicated reader configuration", () => {
    const result = check("bounded");
    expect(result.status).toBe(78); expect(result.stdout).toContain("VELORA_DISCOVERY_SESSION_FILE");
  });
  it("empty reader template values do not prevent metadata-only configuration", () => {
    const result = check("metadata", false, true);
    expect(result.status, result.stderr).toBe(0);
  });
  it("metadata mode does not bypass separate live activation authorization", () => {
    const result = check("metadata", true);
    expect(result.status).toBe(78); expect(result.stdout).toContain("discovery_gate_b_required");
  });
});

describe("controlled discovery cursor and ownership", () => {
  it("never polls an uninitialized cursor, then resumes strictly after the durable offset", async () => {
    const poll = vi.fn(async () => ({ status: "ok" as const, updates: [{ update_id: 7 }, { update_id: 8 }] }));
    const provider = botApiUpdateProvider(poll); const signal = new AbortController().signal;
    await expect(provider.batch(null, 100, signal)).rejects.toMatchObject({ code: "discovery_cursor_offset_required", fatal: true });
    expect(poll).not.toHaveBeenCalled();
    expect(await provider.batch(7, 100, signal)).toEqual([{ update_id: 8 }]);
    expect(poll).toHaveBeenCalledWith({ offset: 8, limit: 100, timeoutSeconds: 25 }, signal);
  });
  it("stops on competing polling/webhook ownership; rate limit carries a bounded retry instruction", async () => {
    const signal = new AbortController().signal;
    await expect(botApiUpdateProvider(async () => ({ status: "conflict" })).batch(1, 100, signal)).rejects.toMatchObject({ code: "telegram_update_consumer_conflict", fatal: true });
    await expect(botApiUpdateProvider(async () => ({ status: "rate_limited", retryAfterSeconds: 5 })).batch(1, 100, signal)).rejects.toMatchObject({ code: "telegram_rate_limited", fatal: false, retryAfterSeconds: 5 });
  });
  it("bounds approved history, resumes enumerated IDs and never fabricates deletions for gaps", async () => {
    const requested: number[][] = [];
    const history = boundedHistoryProvider({ fromMessageId: 20, toMessageId: 24 }, async (ids) => { requested.push([...ids]); return { posts: [], inaccessible: 1 }; });
    const signal = new AbortController().signal;
    expect(await history.page(null, 2, signal)).toEqual({ updates: [], next: "m:22", complete: false, inaccessible: 1 });
    expect(await history.page("m:22", 2, signal)).toMatchObject({ updates: [], next: "m:24", complete: false });
    expect(requested).toEqual([[20, 21], [22, 23]]);
    await expect(history.page("m:19", 2, signal)).rejects.toThrow("history_cursor_foreign");
    expect(() => boundedHistoryProvider({ fromMessageId: 1, toMessageId: 5001 }, async () => ({ posts: [], inaccessible: 0 }))).toThrow("history_range_invalid");
  });
});
