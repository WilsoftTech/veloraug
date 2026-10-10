import { z } from "zod";
import type { EventProvider } from "@/lib/discovery/worker";

/**
 * Bot API long polling for the Movies bot (E3.8A; not started anywhere). One
 * bounded getUpdates call per batch, only channel posts and their edits, from
 * the durable checkpoint + 1. Telegram confirms (and drops) earlier updates when
 * the next call names a higher offset, so `acknowledge` needs no request: the
 * next batch begins after the committed checkpoint. A conflict (another
 * getUpdates consumer, or a webhook) or any API error stops the worker; it never
 * deletes a webhook and never asks Telegram to drop pending updates.
 * `call` is the existing local Bot API transport, injected.
 */
export function botApiUpdateProvider(call: (method: "getUpdates", params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, options: { timeoutSeconds?: number } = {}): EventProvider {
  const timeout = options.timeoutSeconds ?? 25;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 50) throw new Error("poll_timeout_invalid");
  const reply = z.object({ ok: z.literal(true), result: z.array(z.object({ update_id: z.number().int().nonnegative() }).passthrough()).max(100) });
  return {
    async batch(checkpoint, limit, signal) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("poll_limit_invalid");
      let raw: unknown;
      try {
        raw = await call("getUpdates", { offset: checkpoint === null ? undefined : checkpoint + 1, limit, timeout, allowed_updates: ["channel_post", "edited_channel_post"] }, signal);
      } catch (error) {
        if (signal.aborted) return [];
        throw new Error((error as { status?: number }).status === 409 ? "telegram_update_consumer_conflict" : "telegram_poll_failed");
      }
      const parsed = reply.safeParse(raw);
      if (!parsed.success) throw new Error("telegram_poll_invalid");
      // Telegram returns updates in order; anything at or below the checkpoint was already committed.
      return parsed.data.result.filter((update) => checkpoint === null || update.update_id > checkpoint);
    },
    async acknowledge() {},
  };
}
