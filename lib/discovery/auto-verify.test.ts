import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runAutoVerification, runMediaVerification, type AutoVerifyPorts } from "./auto-verify";

const key = (n: number) => n.toString(16).padStart(64, "0");
const evidence = (reasons: string[] = [], media_class = reasons.length ? "unverified" : "original") => ({ media_class, reasons });

describe("upload media-only verification", () => {
  it("processes the backlog sequentially, records actual passes and failures, and stops once idle", async () => {
    let index=0,active=0,maxActive=0;
    const results=[
      {outcome:"recorded",evidence:{assessment:{integrity:"verified",streaming:"verified"}}},
      {outcome:"recorded",evidence:{assessment:{integrity:"incomplete",streaming:"unverified"}}},
      {outcome:"retry",evidence:null},{outcome:"idle",evidence:null},
    ];
    const result=await runMediaVerification({async next(){active++;maxActive=Math.max(active,maxActive);await Promise.resolve();active--;return results[index++];},async sleep(){throw new Error("must_not_wait");},log(){}},
      {signal:new AbortController().signal,intervalMs:30000,once:true});
    expect(maxActive).toBe(1);
    expect(index).toBe(4);
    expect(result).toEqual({passes:1,verified:1,notVerified:1,failed:1,errors:0});
  });
  it("keeps watching for newly uploaded media, and stops on abort without making another claim", async () => {
    const stop=new AbortController();let calls=0;let waits=0;
    const result=await runMediaVerification({async next(){calls++;return {outcome:"idle",evidence:null};},async sleep(){waits++;if(waits===2)stop.abort();},log(){}},
      {signal:stop.signal,intervalMs:30000,once:false});
    expect(calls).toBe(2);expect(waits).toBe(2);expect(result.passes).toBe(2);
  });
  it("backs off on a failed database call and logs no exception text", async () => {
    const logs:unknown[]=[];let calls=0;
    const result=await runMediaVerification({async next(){calls++;throw new Error("https://private.invalid/token");},async sleep(){},log(entry){logs.push(entry);}},
      {signal:new AbortController().signal,intervalMs:30000,once:true});
    expect(calls).toBe(1);expect(result.errors).toBe(1);
    expect(logs).toEqual([{event:"upload_media_verification_error",code:"verification_error"}]);
  });
});

/** A fake database: `queue` lists what is due; a verified key stops being due. */
function fake(queue: string[], results: Record<string, Awaited<ReturnType<AutoVerifyPorts["verify"]>> | Error>) {
  const verified: string[] = []; const logs: Record<string, unknown>[] = []; let sleeps = 0;
  const ports: AutoVerifyPorts = {
    async due(limit) { return queue.slice(0, limit); },
    async verify(item) {
      verified.push(item);
      const result = results[item];
      if (result instanceof Error) throw result;
      if (result?.evidence) queue.splice(queue.indexOf(item), 1);
      return result ?? { outcome: "failed", evidence: null };
    },
    async sleep() { sleeps++; },
    log(entry) { logs.push(entry); },
  };
  return { ports, verified, logs, sleeps: () => sleeps };
}

describe("automatic whole-file verification loop", () => {
  it("verifies every due candidate once, one at a time, then stops when run once", async () => {
    const { ports, verified, logs } = fake([key(1), key(2), key(3)], {
      [key(1)]: { outcome: "needs_review", evidence: evidence() },
      [key(2)]: { outcome: "needs_review", evidence: evidence(["decode_corrupt_data"]) },
      [key(3)]: { outcome: "failed", evidence: null },
    });
    const summary = await runAutoVerification(ports, { signal: new AbortController().signal, intervalMs: 1000, once: true });
    expect(verified).toEqual([key(1), key(2), key(3)]);
    expect(summary).toEqual({ passes: 1, verified: 1, notVerified: 1, failed: 1, errors: 0 });
    // A candidate the database still lists after a failed attempt is not retried in the same pass.
    expect(verified.filter((item) => item === key(3))).toHaveLength(1);
    // The log carries fixed codes and counts, never a key.
    expect(JSON.stringify(logs)).not.toContain(key(1));
  });
  it("a refused claim or a database error is logged by code and the loop carries on", async () => {
    const refused = Object.assign(new Error("not claimable"), { code: "discovery_verification_not_claimable" });
    const { ports, verified, logs } = fake([key(1), key(2)], { [key(1)]: refused, [key(2)]: { outcome: "needs_review", evidence: evidence() } });
    const summary = await runAutoVerification(ports, { signal: new AbortController().signal, intervalMs: 1000, once: true });
    expect(verified).toEqual([key(1), key(2)]);
    expect(summary).toMatchObject({ verified: 1, errors: 1 });
    expect(logs).toContainEqual({ event: "media_verification_refused", code: "discovery_verification_not_claimable" });
    const broken: AutoVerifyPorts = { ...ports, async due() { throw new Error("https://secret.invalid/token"); } };
    const logged: Record<string, unknown>[] = [];
    await runAutoVerification({ ...broken, log: (entry) => logged.push(entry) }, { signal: new AbortController().signal, intervalMs: 1000, once: true });
    expect(logged[0]).toEqual({ event: "media_verification_due_failed", code: "verification_error" });
  });
  it("continuous mode waits between passes and stops at once when asked to", async () => {
    const stop = new AbortController();
    const { ports, sleeps } = fake([], {});
    let passes = 0;
    const counting: AutoVerifyPorts = { ...ports, async sleep() { passes++; if (passes === 3) stop.abort(); } };
    const summary = await runAutoVerification(counting, { signal: stop.signal, intervalMs: 1000, once: false });
    expect(summary.passes).toBe(3); expect(sleeps()).toBe(0);
  });
  it("asks only for what is due and calls nothing that records rights, approves or publishes", () => {
    const source = readFileSync("lib/discovery/auto-verify.ts", "utf8") + readFileSync("services/media-gateway/discovery.mts", "utf8");
    expect(source).not.toMatch(/discovery_review_|catalogue_review|approve_channel|publish_channel|clear_rights|rights_clearances/);
  });
});

describe("--verify-due is off unless switched on twice, and refuses before any network call", () => {
  const run = (extra: Record<string, string>, mode = "--verify-due") => {
    const env: NodeJS.ProcessEnv = { ...process.env,
      VELORA_DISCOVERY_DATABASE_URL: "postgres://velora_discovery_worker:synthetic-password@127.0.0.1:1/postgres",
      TELEGRAM_BOT_API_URL: "http://127.0.0.1:1", TELEGRAM_MOVIES_BOT_TOKEN: `123456:${"a".repeat(35)}`,
      TELEGRAM_MOVIES_BOT_ID: "123456", TELEGRAM_MOVIES_BOT_USERNAME: "SyntheticBot", TELEGRAM_MOVIES_CHANNEL_ID: "-1001111111111",
      VELORA_DISCOVERY_INSPECTION: "metadata", ...extra };
    for (const name of ["VELORA_DISCOVERY_LIVE_AUTHORIZED", "VELORA_DISCOVERY_AUTO_VERIFY", "VELORA_DISCOVERY_SESSION_FILE", "VELORA_DISCOVERY_SPOOL_DIR", "TELEGRAM_MEDIA_API_ID", "TELEGRAM_MEDIA_API_HASH", "TELEGRAM_MEDIA_BOT_ID", "TELEGRAM_MEDIA_BOT_USERNAME"])
      if (!(name in extra)) delete env[name];
    return spawnSync(process.execPath, ["--experimental-transform-types", "--import", "./scripts/ingest/register.mjs", "services/media-gateway/discovery.mts", mode, "--once"], { env, encoding: "utf8", timeout: 30000 });
  };
  it("without the live switch", () => {
    const result = run({});
    expect(result.status).toBe(78); expect(result.stdout).toContain("discovery_gate_b_required");
  });
  it("with the live switch but not the automatic one", () => {
    const result = run({ VELORA_DISCOVERY_LIVE_AUTHORIZED: "true" });
    expect(result.status).toBe(78); expect(result.stdout).toContain("discovery_auto_verification_not_enabled");
  });
  it("with both, it still needs the dedicated reader and a spool directory", () => {
    const result = run({ VELORA_DISCOVERY_LIVE_AUTHORIZED: "true", VELORA_DISCOVERY_AUTO_VERIFY: "true" });
    expect(result.status).toBe(78); expect(result.stdout).toContain("discovery_verification_configuration_required");
  });
  it.each<{name:string;extra:Record<string,string>;expected:string}>([
    {name:"live switch",extra:{},expected:"discovery_gate_b_required"},
    {name:"automatic switch",extra:{VELORA_DISCOVERY_LIVE_AUTHORIZED:"true"},expected:"discovery_auto_verification_not_enabled"},
    {name:"dedicated reader",extra:{VELORA_DISCOVERY_LIVE_AUTHORIZED:"true",VELORA_DISCOVERY_AUTO_VERIFY:"true"},expected:"discovery_verification_configuration_required"},
  ])("all-upload mode requires $name", ({extra,expected}) => {
    const result=run(extra,"--verify-uploads");
    expect(result.status).toBe(78);expect(result.stdout).toContain(expected);
  });
});
