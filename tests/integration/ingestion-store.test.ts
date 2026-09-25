import { describe, expect, it } from "vitest";
import { createRpcIngestionStore, IngestStoreError, supabaseRpcTransport } from "@/lib/uploader/store";
import type { SourceFingerprint } from "@/types/ingestion";

/**
 * The C2A.1 worker store against the LOCAL stack's real PostgREST (never
 * hosted; see vitest.integration.config.mts). The channel allow-list is empty
 * on a fresh database, so these checks need no privileged seeding: the
 * commands are reachable for service_role, fail closed without a configured
 * channel, and are unreachable with the browser key.
 */

const FP = `sf1-${"a".repeat(64)}` as SourceFingerprint;
const env = process.env;

function store(key: string | undefined) {
  const transport = supabaseRpcTransport({ NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: key });
  if (!transport.ok) throw new Error(transport.errors.join("; "));
  return createRpcIngestionStore(transport.rpc);
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IngestStoreError) return error.code;
    throw error;
  }
  return "resolved";
}

describe("ingestion worker store (local PostgREST)", () => {
  it("reads status through ingest_upload_status as service_role", async () => {
    expect(await store(env.SUPABASE_SERVICE_ROLE_KEY).getUploadStatus(FP, "movie")).toEqual({ status: "absent" });
  });

  it("fails closed while no channel is allow-listed", async () => {
    const start = store(env.SUPABASE_SERVICE_ROLE_KEY).markUploadStarted({ source: { fingerprint: FP, sizeBytes: 1000, fileName: "x.mkv" }, kind: "movie", channelId: -1001111111111 });
    expect(await codeOf(start)).toBe("ingest_channel_not_allowed");
    expect(await store(env.SUPABASE_SERVICE_ROLE_KEY).getUploadStatus(FP, "movie")).toEqual({ status: "absent" });
  });

  it("maps the database's fixed codes", async () => {
    expect(await codeOf(store(env.SUPABASE_SERVICE_ROLE_KEY).recordUploadFailed(FP, "movie", { outcome: "retryable", code: "x" }))).toBe("ingest_not_registered");
  });

  it("is unreachable with the browser (anon) key", async () => {
    // A publishable key is refused before any request; the legacy anon JWT reaches PostgREST and is denied.
    expect(supabaseRpcTransport({ NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }).ok).toBe(false);
    expect(await codeOf(store(env.LOCAL_ANON_JWT).getUploadStatus(FP, "movie"))).toBe("store_error");
  });
});
