import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createDiscoveryPg } from "../../services/media-gateway/discovery-pg.mts";
import { databasePersistence, databaseCataloguePorts } from "@/lib/discovery/database";
import { replayProvider, runReplay } from "@/lib/discovery/worker";
import { isolatedSql } from "./isolated-env";

describe("E3.8B direct restricted worker transport", () => {
  it("requires its own login, acquires and releases a durable lease, and cannot publish", async () => {
    isolatedSql(`alter role velora_discovery_worker login password 'postgres';
      insert into private.telegram_channels(bot_type,chat_id,checkpoint_message_id) values ('movie', -1005555555555, 1);
      insert into private.discovery_cursors(bot_type,update_offset) values ('movie', 987);`);
    const db = createDiscoveryPg("postgres://velora_discovery_worker:postgres@127.0.0.1:54439/postgres");
    try {
      await db.check();
      const target = databasePersistence(db.rpc, { channelId: -1005555555555 });
      expect(await target.checkpoint()).toBe(987);
      expect((await target.health(new Date())).consumerActive).toBe(true);
      expect((await db.rpc("approve_channel_candidate", {})).error?.message).toBe("discovery_invalid_input");
      const event = { update_id: 988, channel_post: { message_id: 777, date: 1791633600, chat: { id: -1005555555555, type: "channel" }, document: { file_id: "synthetic-only", file_unique_id: "AgADworker777", file_size: 10000, file_name: "Worker.Test.2025.VJ.Test.mp4", mime_type: "video/mp4" } } };
      const ports = { ...databaseCataloguePorts(db.rpc), search: async () => [], snapshot: async () => null, media: async () => ({ duplicateOf: null, source: null, evidence: null }) };
      const metrics = await runReplay(target, replayProvider([event, event]), ports, { signal: new AbortController().signal, now: () => new Date(), paceMs: 0 });
      expect(metrics).toMatchObject({ updates: 2, duplicates: 1, processed: 1, failures: 0 });
      const second = databasePersistence(db.rpc, { channelId: -1005555555555 });
      await expect(second.checkpoint()).rejects.toMatchObject({ code: "discovery_consumer_busy" });
      await target.release(); expect(await second.checkpoint()).toBe(988); await second.release();
      expect(isolatedSql("select count(*) from private.catalogue_reviewers where user_id not in ('00000000-0000-4000-8000-00000000e3a1','00000000-0000-4000-8000-00000000e3a2','00000000-0000-4000-8000-00000000e3a3')")).toBe("0");
    } finally { await db.close(); isolatedSql("alter role velora_discovery_worker nologin; delete from private.discovery_cursors where bot_type='movie';"); }
  });
  it("refuses elevated credentials before connecting", () => {
    expect(() => createDiscoveryPg("postgres://postgres:postgres@127.0.0.1:54439/postgres")).toThrow("discovery_wrong_database_identity");
  });
  it("executes the prepared read-only inspection commands with restricted authentication", () => {
    const key = isolatedSql("select discovery_key from private.channel_reviews order by ingestion_event_id limit 1");
    const result = spawnSync("psql", ["-X", "-h", "127.0.0.1", "-p", "54439", "-U", "velora_review_service", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", `candidate=${key}`, "-v", "reviewer=00000000-0000-4000-8000-00000000e3a1", "-f", "scripts/discovery/review-operator.sql"], { env: { ...process.env, PGPASSWORD: "postgres" }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const field of ["candidate", "rights", "readiness", "capability", "publication"]) expect(result.stdout).toContain(field);
  });
});
