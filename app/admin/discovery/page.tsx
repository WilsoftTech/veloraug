import { requireReviewAdmin, loadReviewCandidates, databaseReviewClient } from "@/lib/discovery/runtime";
import { ReviewQueue } from "@/components/discovery-review";
import { REVIEW_GROUPS, resultMessage, type ReviewGroup } from "@/lib/discovery/guidance";
import { listVjs } from "@/lib/catalogue";
import type { ReviewVj } from "@/lib/discovery/model";
import { addDetectedVjAction, reinspectAllAction } from "./actions";

/**
 * The VJ list and the account's publish permission, for the "New VJs detected" panel. Active VJs only:
 * that is all the public catalogue read returns. A failure leaves the panel out, never the queue.
 */
async function vjPanel(): Promise<{ vjs: ReviewVj[]; canAddVj: boolean } | null> {
  try {
    const [vjs, capabilities] = await Promise.all([listVjs(), (await databaseReviewClient()).capabilities()]);
    return { vjs: vjs.map((vj) => ({ id: vj.id, slug: vj.slug, name: vj.name, isActive: true })), canAddVj: capabilities?.publish === true };
  } catch (failure) {
    console.warn(JSON.stringify({ event: "review_vj_panel_unavailable", code: failure instanceof Error ? failure.message.slice(0, 60) : "unknown" }));
    return null;
  }
}

export const dynamic = "force-dynamic";
export default async function DiscoveryQueue({ searchParams }: { searchParams: Promise<{ q?: string; show?: string; result?: string }> }) {
  await requireReviewAdmin();
  const params = await searchParams;
  const search = (params.q ?? "").slice(0, 300);
  const group: ReviewGroup | "" = REVIEW_GROUPS.find((item) => item.id === params.show)?.id ?? "";
  const { mode, candidates, error } = await loadReviewCandidates();
  const panel = mode === "database" && !error ? await vjPanel() : null;
  const message = resultMessage(params.result);
  return <>
    <h1 className="mb-6 text-headline-md">Movie review queue</h1>
    <ReviewQueue candidates={candidates} search={search} group={group} mode={mode} error={error ?? message.error} notice={message.notice} reinspectAll={reinspectAllAction}
      {...(panel ? { vjs: panel.vjs, canAddVj: panel.canAddVj, addVj: addDetectedVjAction } : {})} />
  </>;
}
