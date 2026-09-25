import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRpcIngestionStore, IngestStoreError, supabaseRpcTransport, type RpcTransport } from "@/lib/uploader/store";
import type { SourceFingerprint, TelegramMediaRecord } from "@/types/ingestion";

// No Supabase: every call goes through a mocked RPC transport.
const FP = `sf1-${"e".repeat(64)}` as SourceFingerprint;
const MOVIES = -1001111111111;
const CAPTION = `John Wick (2014)\nVJ Junior\nMovie\nvelora-src:${FP}`;
const RECORD: TelegramMediaRecord = {
  botType: "movie", chatId: MOVIES, messageId: 42, fileId: "file-42", fileUniqueId: "uniq-42", mediaKind: "document",
  fileName: "John.Wick.2014.VJ.Junior.mkv", mimeType: "video/x-matroska", caption: CAPTION, fileSizeBytes: 1000,
  durationSeconds: null, width: null, height: null, telegramDate: "2026-09-25T10:00:00.000Z", sourceFingerprint: FP,
};
const EMPTY_MEDIA = {
  chat_id: null, message_id: null, file_id: null, file_unique_id: null, media_kind: null, file_name: null, mime_type: null,
  caption: null, file_size_bytes: null, duration_seconds: null, width: null, height: null, telegram_date: null,
};

function transport(reply: Awaited<ReturnType<RpcTransport>>) {
  return vi.fn<RpcTransport>(async () => reply);
}

describe("RPC ingestion store: command selection and payloads", () => {
  it("status calls ingest_upload_status with fingerprint and kind only", async () => {
    const rpc = transport({ data: [{ upload_state: "new", upload_attempt_count: 0, upload_failure_code: null, needs_review: false, ...EMPTY_MEDIA }], error: null });
    expect(await createRpcIngestionStore(rpc).getUploadStatus(FP, "movie")).toEqual({ status: "absent" });
    expect(rpc).toHaveBeenCalledWith("ingest_upload_status", { p_source_fingerprint: FP, p_bot_type: "movie" });
  });

  it("maps every server upload state", async () => {
    const row = (upload_state: string, extra = {}) => ({ upload_state, upload_attempt_count: 1, upload_failure_code: null, needs_review: false, ...EMPTY_MEDIA, ...extra });
    const cases: [object, object][] = [
      [row("uploading"), { status: "uploading" }],
      [row("uncertain"), { status: "uncertain" }],
      [row("upload_failed"), { status: "failed" }],
      [row("blocked", { upload_failure_code: "reconcile_multiple_matches", needs_review: true }), { status: "blocked", code: "reconcile_multiple_matches" }],
    ];
    for (const [data, expected] of cases) {
      expect(await createRpcIngestionStore(transport({ data: [data], error: null })).getUploadStatus(FP, "movie")).toEqual(expected);
    }
  });

  it("rebuilds the Telegram record of an uploaded source (for adoption)", async () => {
    const data = [{
      upload_state: "uploaded", upload_attempt_count: 1, upload_failure_code: null, needs_review: false,
      chat_id: MOVIES, message_id: 42, file_id: "file-42", file_unique_id: "uniq-42", media_kind: "document",
      file_name: "John.Wick.2014.VJ.Junior.mkv", mime_type: "video/x-matroska", caption: CAPTION, file_size_bytes: 1000,
      duration_seconds: null, width: null, height: null, telegram_date: "2026-09-25T13:00:00+03:00",
    }];
    expect(await createRpcIngestionStore(transport({ data, error: null })).getUploadStatus(FP, "movie")).toEqual({ status: "uploaded", record: RECORD });
  });

  it("start sends fingerprint, kind, channel and size: no path, file name, token or journal data", async () => {
    const rpc = transport({ data: [{ upload_state: "uploading", upload_attempt_count: 2 }], error: null });
    const source = { fingerprint: FP, sizeBytes: 1000, fileName: "John.Wick.2014.VJ.Junior.mkv" };
    expect(await createRpcIngestionStore(rpc).markUploadStarted({ source, kind: "movie", channelId: MOVIES })).toEqual({ attempt: 2 });
    expect(rpc).toHaveBeenCalledWith("ingest_upload_start", { p_source_fingerprint: FP, p_bot_type: "movie", p_chat_id: MOVIES, p_source_size_bytes: 1000 });
  });

  it("record sends exactly the telegram_media identity and returns the server's verdict", async () => {
    for (const verdict of ["recorded", "already_recorded", "conflict"] as const) {
      const rpc = transport({ data: verdict, error: null });
      expect(await createRpcIngestionStore(rpc).recordUploadSucceeded(FP, RECORD)).toBe(verdict);
      expect(rpc).toHaveBeenCalledWith("ingest_upload_record", {
        p_source_fingerprint: FP, p_bot_type: "movie", p_chat_id: MOVIES, p_message_id: 42, p_file_id: "file-42", p_file_unique_id: "uniq-42",
        p_media_kind: "document", p_file_name: "John.Wick.2014.VJ.Junior.mkv", p_mime_type: "video/x-matroska", p_caption: CAPTION,
        p_file_size_bytes: 1000, p_duration_seconds: null, p_width: null, p_height: null, p_telegram_date: "2026-09-25T10:00:00.000Z",
      });
    }
  });

  it("fail sends the outcome class and a code", async () => {
    const rpc = transport({ data: "uncertain", error: null });
    await createRpcIngestionStore(rpc).recordUploadFailed(FP, "series", { outcome: "uncertain", code: "timeout" });
    expect(rpc).toHaveBeenCalledWith("ingest_upload_fail", { p_source_fingerprint: FP, p_bot_type: "series", p_outcome: "uncertain", p_failure_code: "timeout" });
  });

  it("only ever calls the four worker commands", () => {
    const source = readFileSync(join(__dirname, "store.ts"), "utf8");
    expect([...new Set(source.match(/"ingest_[a-z_]+"/g))].sort()).toEqual(['"ingest_upload_fail"', '"ingest_upload_record"', '"ingest_upload_start"', '"ingest_upload_status"']);
    expect(source).not.toMatch(/\.from\(|\.schema\(|private\./);
  });
});

describe("RPC ingestion store: errors are normalized", () => {
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(IngestStoreError);
      return (error as IngestStoreError).code;
    }
    throw new Error("expected a rejection");
  };

  it("passes the database's fixed ingest_* codes through", async () => {
    const store = createRpcIngestionStore(transport({ data: null, error: { message: "ingest_channel_not_allowed", code: "P0001" } }));
    expect(await code(store.markUploadStarted({ source: { fingerprint: FP, sizeBytes: 1, fileName: "x" }, kind: "movie", channelId: MOVIES }))).toBe("ingest_channel_not_allowed");
  });

  it("never surfaces other server text (which could contain details)", async () => {
    const store = createRpcIngestionStore(transport({ data: null, error: { message: 'permission denied for function ingest_upload_start; key=sb_secret_abc', code: "42501" } }));
    const result = await code(store.getUploadStatus(FP, "movie"));
    expect(result).toBe("store_error");
  });

  it("a thrown transport is store_unavailable, and replies of the wrong shape are rejected", async () => {
    const down = vi.fn<RpcTransport>(async () => {
      throw new TypeError("fetch failed https://project.supabase.co key=secret");
    });
    const unavailable = await code(createRpcIngestionStore(down).getUploadStatus(FP, "movie"));
    expect(unavailable).toBe("store_unavailable");
    expect(await code(createRpcIngestionStore(transport({ data: [], error: null })).getUploadStatus(FP, "movie"))).toBe("store_bad_reply");
    expect(await code(createRpcIngestionStore(transport({ data: "published", error: null })).recordUploadSucceeded(FP, RECORD))).toBe("store_bad_reply");
    expect(await code(createRpcIngestionStore(transport({ data: [{ upload_state: "uploaded", upload_attempt_count: 1, upload_failure_code: null, needs_review: false, ...EMPTY_MEDIA }], error: null })).getUploadStatus(FP, "movie"))).toBe("store_bad_reply");
  });

  it("error messages carry the code only", async () => {
    const error = new IngestStoreError("store_error");
    expect(error.message).toBe("Ingestion store: store_error");
  });
});

describe("Supabase transport configuration", () => {
  it("requires the project URL and the service-role key, naming variables, never values", () => {
    const missing = supabaseRpcTransport({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join(" ")).toMatch(/NEXT_PUBLIC_SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);

    const publishable = supabaseRpcTransport({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_leaky" });
    expect(publishable.ok).toBe(false);
    if (!publishable.ok) expect(publishable.errors.join(" ")).not.toContain("leaky");

    expect(supabaseRpcTransport({ NEXT_PUBLIC_SUPABASE_URL: "http://evil.example", SUPABASE_SERVICE_ROLE_KEY: "k" }).ok).toBe(false);
  });

  it("builds a client for https or localhost without making a request", () => {
    expect(supabaseRpcTransport({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "service-key" }).ok).toBe(true);
  });
});
