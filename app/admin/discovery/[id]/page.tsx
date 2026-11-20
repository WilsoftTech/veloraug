import { notFound } from "next/navigation";
import { requireReviewAdmin, offlineReviewRuntime, reviewMode, databaseReviewClient } from "@/lib/discovery/runtime";
import { MovieMetadataForm } from "@/components/movie-metadata-form";
import { saveMovieMetadata } from "@/app/admin/catalogue/actions";
import { postersConfigured } from "@/lib/artwork-storage";
import { ReviewDetail } from "@/components/discovery-review";
import { addDetectedVjAction, reviewAction } from "../actions";
import { resultMessage } from "@/lib/discovery/guidance";
import { downloadsEnabled } from "@/lib/playback/stream-capability";

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
    const manualMovies = capabilities?.review ? await client.manualMovies() : null;
    return <><ReviewDetail candidate={detail.candidate} vjs={detail.vjs} action={reviewAction} {...message} mode="database" capabilities={capabilities} downloads={downloadsEnabled()} addVj={addDetectedVjAction} />
      {manualMovies && !detail.candidate.publication && !["rejected","duplicate","blocked"].includes(detail.candidate.status) && <div className="mt-6"><MovieMetadataForm target="review" id={id} revision={detail.candidate.revision} initial={detail.candidate.manualMetadata ?? {title:detail.candidate.title ?? ""}} vjs={detail.vjs} vjId={detail.candidate.vjId} existingMovies={manualMovies} action={saveMovieMetadata} postersEnabled={postersConfigured()}/></div>}
    </>;
  }
  const { store, fixture } = await offlineReviewRuntime();
  const candidate = (await store.read()).candidates[id];
  if (!candidate) notFound();
  return <ReviewDetail candidate={candidate} vjs={fixture.vjs} action={reviewAction} {...message} />;
}
