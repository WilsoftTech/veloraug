import type { EventProvider } from "@/lib/discovery/worker";

/** `pollChannelUpdates` of the existing local Bot API client (lib/telegram/local-bot-api.ts), injected. */
export type ChannelPoll = (params: { offset: number | null; limit: number; timeoutSeconds: number }, cancel: AbortSignal) =>
  Promise<{ status: "ok"; updates: unknown[] } | { status: "conflict" } | { status: "blocked" | "transient"; code: string } | { status: "rate_limited"; retryAfterSeconds: number | null }>;

/** A poll failure with a fixed code. `fatal` stops the worker for the operator; otherwise it backs off and retries. */
export class PollError extends Error {
  constructor(readonly code: string, readonly fatal: boolean, readonly retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "PollError";
  }
}

/**
 * Bot API long polling for the Movies bot (E3.8A/E3.8B). Nothing in the
 * application starts it: only the discovery worker service does, after Gate B.
 *
 * One bounded getUpdates call per batch, channel posts and their edits only,
 * from the durable checkpoint + 1. Telegram confirms (and drops) earlier
 * updates when the next call names a higher offset, so `acknowledge` needs no
 * request: the next batch begins after the committed checkpoint, and a batch
 * that was not committed is delivered again.
 *
 * A null checkpoint is refused: an uninitialized cursor would read the whole
 * pending queue. The owner initializes the cursor with an explicit offset
 * (docs/E3_8B_PRODUCTION_ROLLOUT.md, "Cursor").
 *
 * A conflict (another getUpdates consumer, or a webhook), a refused identity or
 * an unexpected reply is fatal; it never deletes a webhook and never asks
 * Telegram to drop pending updates. Transient failures and rate limits are
 * retried by the service loop with backoff.
 */
export function botApiUpdateProvider(poll: ChannelPoll, options: { timeoutSeconds?: number } = {}): EventProvider {
  const timeoutSeconds = options.timeoutSeconds ?? 25;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) throw new Error("poll_timeout_invalid");
  return {
    async batch(checkpoint, limit, signal) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("poll_limit_invalid");
      if (checkpoint === null) throw new PollError("discovery_cursor_offset_required", true);
      const reply = await poll({ offset: checkpoint + 1, limit, timeoutSeconds }, signal);
      if (signal.aborted) return [];
      if (reply.status === "conflict") throw new PollError("telegram_update_consumer_conflict", true);
      if (reply.status === "rate_limited") throw new PollError("telegram_rate_limited", false, reply.retryAfterSeconds);
      if (reply.status === "blocked") throw new PollError(reply.code, true);
      if (reply.status !== "ok") throw new PollError(reply.code, false);
      // Telegram returns updates in order; anything at or below the checkpoint was already committed.
      return reply.updates.filter((update) => (update as { update_id: number }).update_id > checkpoint);
    },
    async acknowledge() {},
  };
}
