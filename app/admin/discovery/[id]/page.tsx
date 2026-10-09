import { notFound } from "next/navigation";
import { requireReviewAdmin, offlineReviewRuntime } from "@/lib/discovery/runtime";
import { ReviewDetail } from "@/components/discovery-review";
import { reviewAction } from "../actions";

export const dynamic = "force-dynamic";
export default async function DiscoveryDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  await requireReviewAdmin();
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) notFound();
  const { store, fixture } = await offlineReviewRuntime();
  const candidate = (await store.read()).candidates[id];
  if (!candidate) notFound();
  const { result } = await searchParams;
  const message = result === "blocked" ? "This action is blocked. Check readiness, rights, identity and the latest revision before retrying." : result === "prepared" ? "Owner script prepared in the local ignored discovery folder. Nothing was published." : undefined;
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><ReviewDetail candidate={candidate} vjs={fixture.vjs} action={reviewAction} error={message} /></main>;
}
