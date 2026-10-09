import { requireReviewAdmin, offlineReviewRuntime } from "@/lib/discovery/runtime";
import { ReviewQueue } from "@/components/discovery-review";

export const dynamic = "force-dynamic";
export default async function DiscoveryQueue({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requireReviewAdmin();
  const { store } = await offlineReviewRuntime();
  const params = await searchParams;
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><h1 className="mb-6 text-headline-md">Movie review queue</h1><ReviewQueue candidates={Object.values((await store.read()).candidates)} search={(params.q ?? "").slice(0, 300)} status={params.status ?? ""} /></main>;
}
