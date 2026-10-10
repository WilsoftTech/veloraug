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

/**
 * Where the worker keeps deliveries, checkpoints and candidates (E3.8A). The
 * offline JSON inbox and the Supabase database (lib/discovery/database.ts) both
 * implement it; the worker loop below is the same for both. Every `receive`
 * commits its batch and the checkpoint together, before any acknowledgement.
 */
export interface DiscoveryPersistence {
  checkpoint(): Promise<number | null>;
  receive(updates: readonly unknown[], now: Date): Promise<{ detected: number; duplicates: number; ignored: number }>;
  reconciliation(): Promise<{ cursor: string | null; checkedAt: string | null; incomplete: boolean }>;
  receiveHistory(updates: readonly unknown[], position: { cursor: string | null; incomplete: boolean }, now: Date): Promise<void>;
  inspectNext(ports: InspectionPorts, now: () => Date): Promise<boolean>;
  summary(now: Date): Promise<{ candidates: number; awaitingReview: number; metadataFailures: number; mediaBlocked: number; rightsBlocked: number; approved: number; published: number; reconciliationIncomplete: number; reconciliationLagSeconds: number }>;
}

/** The offline JSON inbox as a persistence adapter (E3.8 behaviour, unchanged). */
export function inboxPersistence(store: InboxStore): DiscoveryPersistence {
  return {
    async checkpoint() { return (await store.read()).checkpoint; },
    receive: (updates, now) => store.transaction((inbox) => receive(inbox, updates, now.toISOString())),
    async reconciliation() { return (await store.read()).reconciliation; },
    async receiveHistory(updates, position, now) {
      await store.transaction((inbox) => {
        receive(inbox, updates, now.toISOString(), true);
        // Exhaustion never resets the last durable position to the initial history cursor.
        inbox.reconciliation = { cursor: position.cursor, checkedAt: now.toISOString(), incomplete: position.incomplete };
      });
    },
    inspectNext: (ports, now) => inspectNext(store, ports, now),
    async summary(now) {
      const inbox = await store.read();
      const candidates = Object.values(inbox.candidates);
      return { candidates: candidates.length,
        awaitingReview: candidates.filter((item) => item.status.startsWith("awaiting_")).length,
        metadataFailures: candidates.filter((item) => item.error === "inspection_provider_failed").length,
        mediaBlocked: candidates.filter((item) => !item.evidence?.browser).length,
        rightsBlocked: candidates.filter((item) => !item.rights).length,
        approved: candidates.filter((item) => item.status === "approved").length,
        published: candidates.filter((item) => item.status === "published").length,
        reconciliationIncomplete: Number(inbox.reconciliation.incomplete),
        reconciliationLagSeconds: inbox.reconciliation.checkedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(inbox.reconciliation.checkedAt)) / 1000)) : -1 };
    },
  };
}
// The store is wrapped at call time, so a replaced store method (a test double) is honoured.
const persistence = (target: InboxStore | DiscoveryPersistence): DiscoveryPersistence => "transaction" in target ? inboxPersistence(target) : target;

export function replayProvider(updates: readonly unknown[]): EventProvider {
  let position = 0;
  return { async batch(_checkpoint, limit, signal) {
    signal.throwIfAborted();
    const batch = updates.slice(position, position + limit);
    position += batch.length;
    return batch;
  }, async acknowledge() {} };
}

export async function reconcile(store: InboxStore | DiscoveryPersistence, provider: ReconciliationProvider, now: () => Date, signal: AbortSignal, maxPages = 3): Promise<{ pages: number; incomplete: boolean }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error("reconciliation_bound_invalid");
  const target = persistence(store);
  let pages = 0, incomplete = true;
  while (pages < maxPages && !signal.aborted) {
    const cursor = (await target.reconciliation()).cursor;
    const page = await provider.page(cursor, 100, signal);
    if (page.updates.length > 100 || page.inaccessible < 0 || (!page.complete && (!page.next || page.next === cursor))) throw new Error("reconciliation_provider_invalid");
    const position = { cursor: page.next ?? cursor, incomplete: !page.complete || page.inaccessible > 0 };
    await target.receiveHistory(page.updates, position, now());
    incomplete = position.incomplete;
    pages++;
    if (page.complete || page.inaccessible > 0) break;
  }
  return { pages, incomplete };
}
export async function runReplay(store: InboxStore | DiscoveryPersistence, provider: EventProvider, ports: InspectionPorts, options: { signal: AbortSignal; now: () => Date; concurrency?: number; paceMs?: number; log?: (metrics: Record<string, number | string>) => void }) {
  const concurrency = options.concurrency ?? 1;
  const pace = options.paceMs ?? 10;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || pace < 0 || pace > 1000) throw new Error("worker_bounds_invalid");
  const target = persistence(store);
  let received = 0, duplicates = 0, processed = 0, failures = 0;
  while (!options.signal.aborted) {
    const batch = await provider.batch(await target.checkpoint(), 100, options.signal);
    if (!batch.length) break;
    const counts = await target.receive(batch, options.now());
    // If the store throws, no acknowledgement can be sent. Replay the whole batch after restart.
    await provider.acknowledge(await target.checkpoint());
    received += batch.length; duplicates += counts.duplicates;
    options.log?.({ event: "discovery_received", updates: received, duplicates });
    if (pace) await new Promise((done) => setTimeout(done, pace));
  }
  while (!options.signal.aborted) {
    const done = await Promise.all(Array.from({ length: concurrency }, () => target.inspectNext(ports, options.now).catch(() => { failures++; return false; })));
    processed += done.filter(Boolean).length;
    if (!done.some(Boolean)) break;
    if (pace) await new Promise((done) => setTimeout(done, pace));
  }
  const summary = await target.summary(options.now());
  const metrics = { event: "discovery_health", updates: received, duplicates, processed, failures, ...summary, stopped: Number(options.signal.aborted) };
  options.log?.(metrics);
  if (failures) throw new Error("worker_persistence_or_processing_failure");
  return metrics;
}
