import { describe, expect, it, vi } from "vitest";
import { botApiUpdateProvider } from "./bot-api-provider";
import { boundedHistoryProvider } from "./worker";

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
