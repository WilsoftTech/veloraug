import { notFound } from "next/navigation";
import { requireReviewAdmin, offlineReviewRuntime, reviewMode, databaseReviewClient } from "@/lib/discovery/runtime";
import { ReviewDetail } from "@/components/discovery-review";
import { reviewAction } from "../actions";
import { resultMessage } from "@/lib/discovery/guidance";

export const dynamic = "force-dynamic";
export default async function DiscoveryDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  await requireReviewAdmin();
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) notFound();
  const message = resultMessage((await searchParams).result);
  if (reviewMode() === "database") {
    const client = await databaseReviewClient();
    // The capabilities only decide which controls are offered; the database checks each action again.
    const [detail, capabilities] = await Promise.all([client.get(id), client.capabilities()]);
    if (!detail) notFound();
    return <ReviewDetail candidate={detail.candidate} vjs={detail.vjs} action={reviewAction} {...message} mode="database" capabilities={capabilities} />;
  }
  const { store, fixture } = await offlineReviewRuntime();
  const candidate = (await store.read()).candidates[id];
  if (!candidate) notFound();
  return <ReviewDetail candidate={candidate} vjs={fixture.vjs} action={reviewAction} {...message} />;
}
