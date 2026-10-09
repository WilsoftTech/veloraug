import { receive } from "@/lib/discovery/events";
import { inspectNext, type InspectionPorts } from "@/lib/discovery/pipeline";
import type { InboxStore } from "@/lib/discovery/model";

export interface EventProvider {
  batch(checkpoint: number | null, limit: number, signal: AbortSignal): Promise<unknown[]>;
  acknowledge(checkpoint: number | null): Promise<void>;
}
export interface ReconciliationProvider {
  // A cursor covers an enumerated history page, never an assumed contiguous interval of message IDs.
  page(cursor: string | null, limit: number, signal: AbortSignal): Promise<{ updates: unknown[]; next: string | null; complete: boolean; inaccessible: number }>;
}
export function replayProvider(updates: readonly unknown[]): EventProvider {
  let position = 0;
  return { async batch(_checkpoint, limit, signal) {
    signal.throwIfAborted();
    const batch = updates.slice(position, position + limit);
    position += batch.length;
    return batch;
  }, async acknowledge() {} };
}
export async function reconcile(store: InboxStore, provider: ReconciliationProvider, now: () => Date, signal: AbortSignal, maxPages = 3): Promise<{ pages: number; incomplete: boolean }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error("reconciliation_bound_invalid");
  let pages = 0, incomplete = true;
  while (pages < maxPages && !signal.aborted) {
    const cursor = (await store.read()).reconciliation.cursor;
    const page = await provider.page(cursor, 100, signal);
    if (page.updates.length > 100 || page.inaccessible < 0 || (!page.complete && (!page.next || page.next === cursor))) throw new Error("reconciliation_provider_invalid");
    await store.transaction((inbox) => {
      receive(inbox, page.updates, now().toISOString(), true);
      // Exhaustion never resets the last durable position to the initial history cursor.
      inbox.reconciliation = { cursor: page.next ?? cursor, checkedAt: now().toISOString(), incomplete: !page.complete || page.inaccessible > 0 };
      incomplete = inbox.reconciliation.incomplete;
    });
    pages++;
    if (page.complete || page.inaccessible > 0) break;
  }
  return { pages, incomplete };
}
export async function runReplay(store: InboxStore, provider: EventProvider, ports: InspectionPorts, options: { signal: AbortSignal; now: () => Date; concurrency?: number; paceMs?: number; log?: (metrics: Record<string, number | string>) => void }) {
  const concurrency = options.concurrency ?? 1;
  const pace = options.paceMs ?? 10;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || pace < 0 || pace > 1000) throw new Error("worker_bounds_invalid");
  let received = 0, duplicates = 0, processed = 0, failures = 0;
  while (!options.signal.aborted) {
    const batch = await provider.batch((await store.read()).checkpoint, 100, options.signal);
    if (!batch.length) break;
    const counts = await store.transaction((inbox) => receive(inbox, batch, options.now().toISOString()));
    // If the store throws, no acknowledgement can be sent. Replay the whole batch after restart.
    await provider.acknowledge((await store.read()).checkpoint);
    received += batch.length; duplicates += counts.duplicates;
    options.log?.({ event: "discovery_received", updates: received, duplicates });
    if (pace) await new Promise((done) => setTimeout(done, pace));
  }
  while (!options.signal.aborted) {
    const done = await Promise.all(Array.from({ length: concurrency }, () => inspectNext(store, ports, options.now).catch(() => { failures++; return false; })));
    processed += done.filter(Boolean).length;
    if (!done.some(Boolean)) break;
    if (pace) await new Promise((done) => setTimeout(done, pace));
  }
  const inbox = await store.read();
  const candidates = Object.values(inbox.candidates);
  const metrics = { event: "discovery_health", updates: received, duplicates, processed, failures, candidates: candidates.length,
    awaitingReview: candidates.filter((item) => item.status.startsWith("awaiting_")).length,
    metadataFailures: candidates.filter((item) => item.error === "inspection_provider_failed").length,
    mediaBlocked: candidates.filter((item) => !item.evidence?.browser).length,
    rightsBlocked: candidates.filter((item) => !item.rights).length,
    approved: candidates.filter((item) => item.status === "approved").length,
    published: candidates.filter((item) => item.status === "published").length,
    reconciliationIncomplete: Number(inbox.reconciliation.incomplete),
    reconciliationLagSeconds: inbox.reconciliation.checkedAt ? Math.max(0, Math.floor((options.now().getTime() - Date.parse(inbox.reconciliation.checkedAt)) / 1000)) : -1,
    stopped: Number(options.signal.aborted) };
  options.log?.(metrics);
  if (failures) throw new Error("worker_persistence_or_processing_failure");
  return metrics;
}
