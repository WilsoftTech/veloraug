import { requireReviewAdmin, offlineReviewRuntime, reviewMode, databaseReviewClient } from "@/lib/discovery/runtime";
import { ReviewQueue } from "@/components/discovery-review";
import { DiscoveryStoreError } from "@/lib/discovery/database";
import type { ReviewCandidate } from "@/lib/discovery/model";

export const dynamic = "force-dynamic";
export default async function DiscoveryQueue({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requireReviewAdmin();
  const params = await searchParams;
  const search = (params.q ?? "").slice(0, 300);
  const status = params.status ?? "";
  if (reviewMode() === "database") {
    let candidates: ReviewCandidate[] = [];
    let error: string | undefined;
    try {
      candidates = await (await databaseReviewClient()).list({ query: search || null });
    } catch (failure) {
      const code = failure instanceof DiscoveryStoreError ? failure.code : "store_error";
      console.warn(JSON.stringify({ event: "review_queue_unavailable", code }));
      error = code === "review_not_authorized" ? "This account has no review permission." : "The review queue is unavailable. Try again shortly.";
    }
    return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><h1 className="mb-6 text-headline-md">Movie review queue</h1><ReviewQueue candidates={candidates} search={search} status={status} mode="database" error={error} /></main>;
  }
  const { store } = await offlineReviewRuntime();
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><h1 className="mb-6 text-headline-md">Movie review queue</h1><ReviewQueue candidates={Object.values((await store.read()).candidates)} search={search} status={status} /></main>;
}
