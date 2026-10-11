import Link from "next/link";
import { buttonClass } from "@/components/button";
import { listMovies } from "@/lib/catalogue";
import { guidance, inspectionExhausted, REVIEW_GROUPS, type ReviewGroup } from "@/lib/discovery/guidance";
import { loadReviewCandidates, requireReviewAdmin } from "@/lib/discovery/runtime";

const GROUP_HELP: Record<ReviewGroup, string> = {
  action: "Waiting for a decision from a reviewer.",
  progress: "Being inspected, or waiting for an automatic check.",
  published: "Published from the Movies channel.",
  closed: "Rejected, duplicate or blocked.",
};
const STEPS = [
  ["Post the file in the Movies channel", "It is detected automatically while the listener is running."],
  ["Confirm the film and the VJ", "In the review queue. The film is suggested from the file name; you choose."],
  ["Media check", "Automatic. Only a browser-ready MP4 passes."],
  ["Rights clearance", "A reviewer with the rights permission records the licence reference."],
  ["Approve and publish", "A reviewer approves; an account with the publish permission publishes. Both are buttons on the movie’s page."],
];

/** Published movies for the overview figure; the public catalogue read, so a failure only hides the figure. */
async function publishedMovies(): Promise<string | null> {
  try {
    const page = await listMovies({ limit: 50 });
    return `${page.items.length}${page.nextCursor ? "+" : ""}`;
  } catch (failure) {
    console.warn(JSON.stringify({ event: "admin_catalogue_count_unavailable", name: failure instanceof Error ? failure.name : "unknown" }));
    return null;
  }
}

export const dynamic = "force-dynamic";
export default async function AdminOverview() {
  await requireReviewAdmin();
  const { mode, candidates, error } = await loadReviewCandidates();
  const stuck = candidates.filter(inspectionExhausted).length;
  const live = mode === "database" ? await publishedMovies() : null;
  return <div className="space-y-8">
    <div>
      <h1 className="text-headline-md">Overview</h1>
      <p className="mt-2 text-body-md text-muted">{mode === "database" ? "Movies detected in the Telegram Movies channel and where each one stands." : "Synthetic offline review. Nothing here is real or published."}</p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4">{error}</p>}
    {stuck > 0 && <section aria-labelledby="stuck-heading" className="rounded-lg border border-destructive p-5">
      <h2 id="stuck-heading" className="text-headline-sm">{stuck} {stuck === 1 ? "movie needs" : "movies need"} reinspection</h2>
      <p className="mt-1 text-body-md">Automatic inspection gave up on {stuck === 1 ? "it" : "them"}. Open the review queue and press “Reinspect all failed”.</p>
      <Link href="/admin/discovery?show=action" className={buttonClass("primary", "mt-4")}>Open review queue</Link>
    </section>}
    <section aria-labelledby="queue-heading">
      <h2 id="queue-heading" className="mb-4 text-headline-sm">Review queue</h2>
      <ul className="grid grid-cols-2 gap-4 lg:grid-cols-4">{REVIEW_GROUPS.map((group) => <li key={group.id}>
        <Link href={`/admin/discovery?show=${group.id}`} className="block h-full rounded-lg border border-border bg-surface p-5 transition-colors hover:border-highlight/40">
          <span className="block text-headline-lg">{candidates.filter((item) => guidance(item).group === group.id).length}</span>
          <span className="mt-1 block text-label-lg">{group.label}</span>
          <span className="mt-1 block text-body-sm text-muted">{GROUP_HELP[group.id]}</span>
        </Link>
      </li>)}</ul>
    </section>
    {live !== null && <section aria-labelledby="live-heading" className="rounded-lg border border-border bg-surface p-5">
      <h2 id="live-heading" className="text-headline-sm">{live} {live === "1" ? "movie" : "movies"} live on the site</h2>
      <Link href="/admin/catalogue" className={buttonClass("secondary", "mt-4")}>Open catalogue</Link>
    </section>}
    <section aria-labelledby="steps-heading">
      <h2 id="steps-heading" className="mb-4 text-headline-sm">How a movie reaches the site</h2>
      <ol className="space-y-3">{STEPS.map(([title, detail], index) => <li key={title} className="flex gap-4 rounded-lg border border-border p-4">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-highlight/40 bg-accent/12 text-label-lg text-highlight">{index + 1}</span>
        <span><span className="block text-body-md font-semibold">{title}</span><span className="block text-body-sm text-muted">{detail}</span></span>
      </li>)}</ol>
    </section>
  </div>;
}
