/**
 * Automatic whole-file media verification (migration 20261018100000): ask the
 * database which candidates are due, then verify them one at a time through the
 * keyed claim, never in parallel. Each verification reads a whole document, so
 * this runs as its own process beside the listener, never in its polling loop.
 *
 * It only verifies. It has no way to record rights, approve or publish: the
 * database grants its identity none of those commands, and nothing here asks.
 */
export interface AutoVerifyPorts {
  /** Keys of the candidates due now, oldest first. */
  due(limit: number): Promise<string[]>;
  /** One keyed whole-file verification; what the database made of it. */
  verify(key: string, signal: AbortSignal): Promise<{ outcome: string; evidence: { media_class: string; reasons: readonly string[] } | null }>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Fixed codes and counts only: never a key, title, digest or Telegram identifier. */
  log(entry: Record<string, string | number | boolean | null>): void;
}
export interface AutoVerifyOptions {
  signal: AbortSignal;
  /** Wait between passes once nothing is due. */
  intervalMs: number;
  /** Verify what is due now, then stop (an operator's one-off run). */
  once: boolean;
  /** How many due keys one pass reads (the database caps it at 100). */
  batch?: number;
}
export interface AutoVerifySummary { passes: number; verified: number; notVerified: number; failed: number; errors: number }

/** The media-only queue does not depend on film/VJ identity or review status. */
export async function runMediaVerification(ports: {
  next(signal: AbortSignal): Promise<{ outcome: string; evidence: { assessment?: { integrity: string; streaming: string } } | null }>;
  sleep: AutoVerifyPorts["sleep"]; log: AutoVerifyPorts["log"];
}, options: AutoVerifyOptions): Promise<AutoVerifySummary> {
  const summary: AutoVerifySummary = { passes: 0, verified: 0, notVerified: 0, failed: 0, errors: 0 };
  while (!options.signal.aborted) {
    summary.passes++;
    while (!options.signal.aborted) {
      try {
        const result = await ports.next(options.signal);
        if (result.outcome === "idle") break;
        if (result.outcome === "recorded") {
          if (result.evidence?.assessment?.integrity === "verified" && result.evidence.assessment.streaming === "verified") summary.verified++;
          else summary.notVerified++;
        } else summary.failed++;
        ports.log({ event: "upload_media_verification_finished", outcome: result.outcome });
      } catch (error) {
        summary.errors++;
        ports.log({ event: "upload_media_verification_error", code: code(error) });
        break; // Database/transport failure must not become a hot polling loop.
      }
    }
    if (options.once || options.signal.aborted) return summary;
    try { await ports.sleep(options.intervalMs, options.signal); }
    catch { if (!options.signal.aborted) throw new Error("media_verification_sleep_failed"); }
  }
  return summary;
}

const code = (error: unknown) => {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && /^[a-z0-9_]{1,100}$/.test(value) ? value : "verification_error";
};

export async function runAutoVerification(ports: AutoVerifyPorts, options: AutoVerifyOptions): Promise<AutoVerifySummary> {
  const summary: AutoVerifySummary = { passes: 0, verified: 0, notVerified: 0, failed: 0, errors: 0 };
  const batch = Math.min(Math.max(options.batch ?? 20, 1), 100);
  while (!options.signal.aborted) {
    summary.passes++;
    // A key is attempted at most once per pass, so a candidate the database still lists (a lost lease, a refused
    // claim) cannot hold the loop: it waits for the next pass.
    const attempted = new Set<string>();
    for (;;) {
      if (options.signal.aborted) return summary;
      let keys: string[];
      try {
        keys = (await ports.due(batch)).filter((key) => !attempted.has(key));
      } catch (error) {
        summary.errors++;
        ports.log({ event: "media_verification_due_failed", code: code(error) });
        break;
      }
      if (!keys.length) break;
      for (const key of keys) {
        if (options.signal.aborted) return summary;
        attempted.add(key);
        try {
          const result = await ports.verify(key, options.signal);
          // `needs_review` with evidence: the file was read whole; the database decides whether it passed.
          if (result.evidence && result.outcome === "needs_review") {
            if (result.evidence.reasons.length === 0 && result.evidence.media_class === "original") summary.verified++; else summary.notVerified++;
          } else summary.failed++;
          ports.log({ event: "media_verification_finished", outcome: result.outcome, media: result.evidence?.media_class ?? null, reasons: result.evidence?.reasons.length ?? null });
        } catch (error) {
          summary.errors++;
          ports.log({ event: "media_verification_refused", code: code(error) });
        }
      }
    }
    ports.log({ event: "media_verification_pass_finished", pass: summary.passes, verified: summary.verified, not_verified: summary.notVerified, failed: summary.failed, errors: summary.errors });
    if (options.once) return summary;
    try { await ports.sleep(options.intervalMs, options.signal); } catch { if (!options.signal.aborted) throw new Error("media_verification_sleep_failed"); }
  }
  return summary;
}
