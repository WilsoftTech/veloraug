import Link from "next/link";
import { buttonClass } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/form-field";
import { PosterImage } from "@/components/media-image";
import { SeriesMetadataForm } from "@/components/series-metadata-form";
import { postersConfigured } from "@/lib/artwork-storage";
import { DiscoveryStoreError } from "@/lib/discovery/database";
import { databaseReviewClient, requireReviewAdmin, reviewMode } from "@/lib/discovery/runtime";
import { seriesItemStage, type SeriesItemStage, type SeriesReviewItem, type SeriesReviewQueue } from "@/lib/series-review";
import { saveSeriesDetails, seriesFileAction } from "./actions";

const RESULT: Record<string, { notice?: string; error?: string }> = {
  assigned: { notice: "Episode saved. Record the rights decision next." },
  unassigned: { notice: "Assignment cleared." },
  rights_cleared: { notice: "Rights recorded. The episode can be published once its media check passes." },
  rights_withdrawn: { notice: "Rights decision withdrawn." },
  published: { notice: "Episode published." },
  unauthorized: { error: "Your account does not have permission for that step." },
  stale: { error: "This file changed since the page loaded. Check it and try again." },
  conflict: { error: "Another file is already that episode for that VJ." },
  not_verified: { error: "The media check has not passed for this file yet." },
  rights: { error: "Record the rights decision before publishing." },
  vj: { error: "Choose an active VJ." },
  published_already: { error: "This file is already published." },
  unavailable: { error: "Series review is waiting for the database update." },
  invalid: { error: "That could not be saved. Check the fields and try again." },
};

const STAGE: Record<SeriesItemStage, { label: string; tone: string }> = {
  unassigned: { label: "Needs series and episode", tone: "border-accent text-foreground" },
  awaiting_rights: { label: "Needs rights decision", tone: "border-accent text-foreground" },
  checking: { label: "Media check running", tone: "border-border text-muted" },
  awaiting_check: { label: "Waiting for media check", tone: "border-border text-muted" },
  check_failed: { label: "Media check failed", tone: "border-destructive text-destructive" },
  ready: { label: "Ready to publish", tone: "border-highlight text-foreground" },
  published: { label: "Published", tone: "border-border text-muted" },
};
// Files that need a person first, then those waiting on the checks, then the done ones.
const ORDER: SeriesItemStage[] = ["ready", "unassigned", "awaiting_rights", "check_failed", "checking", "awaiting_check", "published"];

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

function FileCard({ item, queue, canReview, canRights, canPublish }: { item: SeriesReviewItem; queue: SeriesReviewQueue; canReview: boolean; canRights: boolean; canPublish: boolean }) {
  const stage = seriesItemStage(item);
  const series = queue.series.find((choice) => choice.id === item.series_id);
  const prefix = `file-${item.media_id}-`;
  const published = stage === "published";
  return (
    <li id={`file-${item.media_id}`} className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-body-lg font-semibold">{item.file_name ?? "Unnamed file"}</h3>
          <p className="text-body-sm text-muted">Post {item.post} · {gigabytes(item.file_size_bytes)}{series && ` · ${series.metadata.title} S${item.season_number} E${item.episode_number}`}</p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-label-lg ${STAGE[stage].tone}`}>{STAGE[stage].label}</span>
      </div>
      {stage === "check_failed" && <p className="text-body-sm text-destructive">Reasons: {item.verification?.reasons.join(", ") || "not reported"}</p>}
      {item.job?.error && !item.verification && <p className="text-body-sm text-muted">Last check attempt failed ({item.job.error}); it is retried automatically.</p>}
      {published ? (
        series && <Link className="underline" href={`/series/${series.slug}?season=${item.season_number}&episode=${item.episode_number}`}>Open the episode page</Link>
      ) : (
        <>
          <form action={seriesFileAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={`Assign ${item.file_name ?? "file"}`}>
            <input type="hidden" name="mediaId" value={item.media_id} />
            <input type="hidden" name="revision" value={item.revision} />
            <div className="sm:col-span-2">
              <Field id={prefix + "series"} label="Series">
                {(props) => (
                  <select {...props} name="seriesId" required defaultValue={item.series_id ?? ""} disabled={!canReview}>
                    <option value="">Choose a series</option>
                    {queue.series.map((choice) => <option key={choice.id} value={choice.id}>{choice.metadata.title}{choice.metadata.first_air_date ? ` (${choice.metadata.first_air_date.slice(0, 4)})` : ""}</option>)}
                  </select>
                )}
              </Field>
            </div>
            <Field id={prefix + "season"} label="Season">
              {(props) => <input {...props} type="number" inputMode="numeric" name="season" required min={0} max={999} defaultValue={item.season_number ?? 1} disabled={!canReview} />}
            </Field>
            <Field id={prefix + "episode"} label="Episode">
              {(props) => <input {...props} type="number" inputMode="numeric" name="episode" required min={1} max={9999} defaultValue={item.episode_number ?? ""} disabled={!canReview} />}
            </Field>
            <div className="sm:col-span-2">
              <Field id={prefix + "title"} label="Episode title (optional)">
                {(props) => <input {...props} name="episodeTitle" maxLength={300} defaultValue={item.episode_title ?? ""} disabled={!canReview} />}
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field id={prefix + "vj"} label="VJ">
                {(props) => (
                  <select {...props} name="vjId" required defaultValue={item.vj_id ?? ""} disabled={!canReview}>
                    <option value="">Choose a VJ</option>
                    {queue.vjs.map((vj) => <option key={vj.id} value={vj.id}>{vj.name}</option>)}
                  </select>
                )}
              </Field>
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <Field id={prefix + "overview"} label="Episode description (optional)">
                {(props) => <textarea {...props} name="episodeOverview" rows={2} maxLength={10000} defaultValue={item.episode_overview ?? ""} disabled={!canReview} />}
              </Field>
            </div>
            <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4">
              <button name="command" value="assign" className={buttonClass(stage === "unassigned" ? "primary" : "secondary")} disabled={!canReview}>Save episode</button>
              {item.series_id !== null && <button name="command" value="unassign" formNoValidate className={buttonClass("ghost", "border border-border")} disabled={!canReview}>Clear</button>}
            </div>
          </form>
          {item.series_id !== null && (
            <form action={seriesFileAction} className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <input type="hidden" name="mediaId" value={item.media_id} />
              <input type="hidden" name="revision" value={item.revision} />
              {item.rights_cleared
                ? <button name="command" value="withdraw_rights" className={buttonClass("ghost", "border border-border")} disabled={!canRights}>Withdraw rights decision</button>
                : <button name="command" value="clear_rights" className={buttonClass(stage === "awaiting_rights" ? "primary" : "secondary")} disabled={!canRights}>Confirm distribution rights</button>}
              <button name="command" value="publish" className={buttonClass(stage === "ready" ? "primary" : "secondary")} disabled={!canPublish || stage !== "ready"}>Publish episode</button>
              {stage !== "ready" && <span className="text-body-sm text-muted">Publishing needs the series and episode, the rights decision and a passed media check.</span>}
            </form>
          )}
        </>
      )}
    </li>
  );
}

export const dynamic = "force-dynamic";
export default async function AdminSeriesPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  await requireReviewAdmin();
  if (reviewMode() !== "database") return <EmptyState as="h1" title="Series review" description="Series review runs in database review mode." />;
  const client = await databaseReviewClient();
  let queue: SeriesReviewQueue | null;
  try {
    queue = await client.seriesQueue();
  } catch (failure) {
    console.warn(JSON.stringify({ event: "series_review_unavailable", code: failure instanceof DiscoveryStoreError ? failure.code : "store_error" }));
    return <EmptyState as="h1" title="Series review unavailable" description="This account cannot view series review, or the database is unavailable. Try again shortly." />;
  }
  if (!queue) return <EmptyState as="h1" title="Series review" description="Series review is waiting for its database update." />;
  const capabilities = await client.capabilities();
  const result = RESULT[(await searchParams).result ?? ""];
  const items = [...queue.items].sort((a, b) => ORDER.indexOf(seriesItemStage(a)) - ORDER.indexOf(seriesItemStage(b)) || a.post - b.post);
  const manual = queue.series.filter((series) => series.manual);
  const posters = postersConfigured();

  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <h1 className="text-headline-md">Series review</h1>
        <p className="max-w-3xl text-body-md text-muted">
          Files posted in the Series channel wait here. Add the series by hand if TMDB has no record of it, then give each file its season, episode and VJ.
          A reviewer with the rights permission confirms the distribution rights, and an account with the publish permission publishes once the media check has passed.
        </p>
      </div>
      {result?.error && <p role="alert" className="rounded-lg border border-destructive p-3">{result.error}</p>}
      {result?.notice && <p role="status" className="rounded-lg border border-highlight/40 p-3">{result.notice}</p>}

      <section aria-labelledby="series-files" className="space-y-4">
        <h2 id="series-files" className="text-headline-sm">Files ({items.filter((item) => !item.published_at).length} waiting)</h2>
        {items.length === 0
          ? <p className="text-body-md text-muted">No Series-channel files are waiting.</p>
          : <ul className="space-y-4">{items.map((item) => <FileCard key={item.media_id} item={item} queue={queue} canReview={capabilities?.review === true} canRights={capabilities?.rights === true} canPublish={capabilities?.publish === true} />)}</ul>}
      </section>

      <section aria-labelledby="series-manual" className="space-y-4">
        <h2 id="series-manual" className="text-headline-sm">Series entered by hand</h2>
        {manual.map((series) => (
          <details key={series.id} className="rounded-lg border border-border bg-surface p-4 sm:p-5">
            <summary className="flex min-h-11 cursor-pointer items-center gap-4">
              <span className="w-12 shrink-0"><PosterImage path={series.metadata.poster_path} title={series.metadata.title} sizes="48px" /></span>
              <span className="min-w-0">
                <span className="block font-semibold">{series.metadata.title}</span>
                <span className="block text-body-sm text-muted">{series.publication_status === "published" ? "Published" : "Not published yet"}</span>
              </span>
            </summary>
            <div className="mt-4"><SeriesMetadataForm action={saveSeriesDetails} series={series} postersEnabled={posters} /></div>
          </details>
        ))}
        <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <h3 className="mb-1 text-body-lg font-semibold">Add a series TMDB doesn&apos;t have</h3>
          <p className="mb-4 text-body-sm text-muted">Adding a series publishes nothing. It becomes public with its first published episode.</p>
          <SeriesMetadataForm action={saveSeriesDetails} postersEnabled={posters} />
        </div>
      </section>
    </div>
  );
}
