import { requireReviewAdmin, loadReviewCandidates } from "@/lib/discovery/runtime";
import { ReviewQueue } from "@/components/discovery-review";
import { REVIEW_GROUPS, resultMessage, type ReviewGroup } from "@/lib/discovery/guidance";
import { reinspectAllAction } from "./actions";

export const dynamic = "force-dynamic";
export default async function DiscoveryQueue({ searchParams }: { searchParams: Promise<{ q?: string; show?: string; result?: string }> }) {
  await requireReviewAdmin();
  const params = await searchParams;
  const search = (params.q ?? "").slice(0, 300);
  const group: ReviewGroup | "" = REVIEW_GROUPS.find((item) => item.id === params.show)?.id ?? "";
  const { mode, candidates, error } = await loadReviewCandidates();
  const message = resultMessage(params.result);
  return <>
    <h1 className="mb-6 text-headline-md">Movie review queue</h1>
    <ReviewQueue candidates={candidates} search={search} group={group} mode={mode} error={error ?? message.error} notice={message.notice} reinspectAll={reinspectAllAction} />
  </>;
}
