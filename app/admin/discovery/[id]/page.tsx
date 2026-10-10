import { notFound } from "next/navigation";
import { requireReviewAdmin, offlineReviewRuntime, reviewMode, databaseReviewClient } from "@/lib/discovery/runtime";
import { ReviewDetail } from "@/components/discovery-review";
import { reviewAction } from "../actions";
import { approvalCommand, publicationCommand } from "@/lib/discovery/owner-commands";

const MESSAGES: Record<string, string> = {
  blocked: "This action is blocked. Check readiness, rights, identity and the latest revision before retrying.",
  prepared: "Owner script prepared in the local ignored discovery folder. Nothing was published.",
  stale: "This candidate changed since you opened it. Review the latest revision and try again.",
  unauthorized: "Your account does not have permission for this action.",
  refreshed: "Public catalogue pages were refreshed.",
};

export const dynamic = "force-dynamic";
export default async function DiscoveryDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  const actor = await requireReviewAdmin();
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) notFound();
  const { result } = await searchParams;
  const message = result ? MESSAGES[result] : undefined;
  if (reviewMode() === "database") {
    const detail = await (await databaseReviewClient()).get(id);
    if (!detail) notFound();
    const candidate = detail.candidate;
    // Prepared only when the database reports no blocking gate (approval) or an approval at this revision (publication).
    const ownerCommand = candidate.status === "awaiting_review" && !candidate.gates?.length
      ? { kind: "approve" as const, sql: approvalCommand(id, candidate.revision, actor.id) }
      : candidate.status === "approved" && candidate.approval?.revision === candidate.revision
        ? { kind: "publish" as const, sql: publicationCommand(id, candidate.revision, actor.id) }
        : null;
    return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><ReviewDetail candidate={candidate} vjs={detail.vjs} action={reviewAction} error={message} mode="database" ownerCommand={ownerCommand} /></main>;
  }
  const { store, fixture } = await offlineReviewRuntime();
  const candidate = (await store.read()).candidates[id];
  if (!candidate) notFound();
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6"><ReviewDetail candidate={candidate} vjs={fixture.vjs} action={reviewAction} error={message} /></main>;
}
