import type { ReactNode } from "react";
import Link from "next/link";
import { Check, Circle } from "lucide-react";
import { buttonClass } from "@/components/button";
import { Field } from "@/components/form-field";
import { EmptyState } from "@/components/empty-state";
import { TabLinks } from "@/components/tab-links";
import { PosterImage, BackdropImage } from "@/components/media-image";
import { canReinspect, guidance, inspectionExhausted, otherGates, reviewOpen, steps, REVIEW_GROUPS, type ReviewGroup, type ReviewGuidance } from "@/lib/discovery/guidance";
import { cn } from "@/lib/utils";
import type { ReviewCandidate, ReviewVj } from "@/lib/discovery/model";
import type { ReviewCapabilities } from "@/lib/discovery/database";

/** fixture: the E3.8 offline inbox. database: E3.8A review against Supabase (decisions are real). */
export type ReviewUiMode = "fixture" | "database";
type Action = (data: FormData) => Promise<void>;

const human = (text: string) => text.replaceAll("_", " ");
const size = (bytes: number | null) => bytes === null ? "Unknown size" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const readiness = (candidate: ReviewCandidate) => candidate.evidence?.browser && candidate.evidence.container && candidate.evidence.gateway && candidate.evidence.accessible ? "Verified" : "Awaiting verification";
const name = (candidate: ReviewCandidate) => candidate.title ?? candidate.event.media.name ?? "Untitled document";

const BADGE: Record<ReviewGroup, string> = {
  action: "border-highlight/40 bg-accent/12 text-highlight",
  progress: "border-border text-foreground",
  published: "border-border text-muted",
  closed: "border-border text-muted",
};
function StatusBadge({ guide, problem }: { guide: ReviewGuidance; problem: boolean }) {
  return <span className={cn("shrink-0 rounded-full border px-3 py-1 text-label-md", problem ? "border-destructive text-destructive" : BADGE[guide.group])}>{guide.label}</span>;
}
/** A blocked or failed candidate is a problem to look at, whichever queue group it sits in. */
const isProblem = (candidate: ReviewCandidate) => candidate.status === "blocked" || candidate.status === "failed";
function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-highlight/40 bg-accent/12 p-4">{notice}</p>}
  </>;
}

export function ReviewQueue({ candidates, search, group, mode = "fixture", error, notice, reinspectAll }: { candidates: ReviewCandidate[]; search: string; group: ReviewGroup | ""; mode?: ReviewUiMode; error?: string; notice?: string; reinspectAll?: Action }) {
  const database = mode === "database";
  const found = candidates.filter((item) => name(item).toLowerCase().includes(search.toLowerCase()));
  const shown = found.filter((item) => !group || guidance(item).group === group);
  const stuck = candidates.filter(inspectionExhausted).length;
  const href = (id: string) => `/admin/discovery?${new URLSearchParams({ ...(id ? { show: id } : {}), ...(search ? { q: search } : {}) })}`;
  return <div className="space-y-6">
    <p className="text-body-md text-muted">{database ? "Movies detected in the Telegram Movies channel. Nothing is published without explicit review, rights clearance and a publish decision." : "Synthetic offline review. Production discovery and publication are disabled."}</p>
    <Message error={error} notice={notice} />
    <TabLinks label="Review groups" tabs={[{ id: "" as const, label: "All" }, ...REVIEW_GROUPS].map((tab) => ({
      label: `${tab.label} (${found.filter((item) => !tab.id || guidance(item).group === tab.id).length})`, href: href(tab.id), active: group === tab.id }))} />
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <form className="flex min-w-0 flex-1 items-end gap-3" method="get">
        {group && <input type="hidden" name="show" value={group} />}
        <div className="min-w-0 flex-1 sm:max-w-sm"><Field id="q" label="Search title">{(props) => <input {...props} name="q" defaultValue={search} maxLength={300} />}</Field></div>
        <button className={buttonClass("secondary")} type="submit">Search</button>
      </form>
      {database && reinspectAll && stuck > 0 && <form action={reinspectAll}><button className={buttonClass("primary", "w-full sm:w-auto")}>Reinspect all failed ({stuck})</button></form>}
    </div>
    {!shown.length ? <EmptyState title="No review candidates" description={database ? "No detected movie matches this view." : "Run the explicit synthetic replay, or change these filters."} /> : <ul className="grid gap-4 md:grid-cols-2">
      {shown.map((item) => { const guide = guidance(item); return <li key={item.id} className="min-w-0 rounded-lg border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-headline-sm"><Link className="underline decoration-highlight/40 underline-offset-4" href={`/admin/discovery/${item.id}`}>{name(item)}</Link></h2>
          <StatusBadge guide={guide} problem={isProblem(item)} />
        </div>
        <p className="mt-2 text-body-md">{item.year ?? "Year unresolved"} · {item.vjText ?? "VJ unresolved"} · {size(item.event.media.size)}</p>
        <p className="mt-2 text-body-sm text-muted">{guide.next}</p>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-body-sm">
          <dt className="text-muted">Detected</dt><dd>{new Date(item.firstSeen).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
          <dt className="text-muted">Source</dt><dd>{database ? "Movies channel" : "Movies fixture channel"}</dd>
          <dt className="text-muted">Identity</dt><dd>{human(item.identity)}</dd>
          <dt className="text-muted">Media</dt><dd>{readiness(item)}</dd>
          <dt className="text-muted">Rights</dt><dd>{item.rights ? (database ? "Clearance recorded" : "Fixture clearance recorded") : "Awaiting clearance"}</dd>
          <dt className="text-muted">Status</dt><dd>{human(item.status)}</dd>
        </dl>
      </li>; })}
    </ul>}
  </div>;
}

/** What the person should do now, with the one action that moves a stuck candidate on. */
function NextStep({ candidate, database, children }: { candidate: ReviewCandidate; database: boolean; children: ReactNode }) {
  const guide = guidance(candidate);
  const noFilm = database && reviewOpen(candidate) && candidate.identity !== "confirmed" && candidate.choices.length === 0;
  const next = noFilm ? "No film was found for this title. See below for how to fix the post in Telegram." : guide.next;
  return <section aria-labelledby="next-heading" className={cn("rounded-lg border p-5", isProblem(candidate) ? "border-destructive" : "border-highlight/40 bg-accent/12")}>
    <p className="text-label-md text-muted">What happens next</p>
    <h2 id="next-heading" className="mt-1 text-headline-sm">{guide.label}</h2>
    <p className="mt-1 text-body-md">{next}</p>
    {children}
  </section>;
}

function Gates({ gates }: { gates: readonly string[] }) {
  const extra = otherGates(gates);
  return <section className="rounded-lg border border-border p-5" aria-labelledby="gates-heading"><h2 id="gates-heading" className="text-headline-sm">Publication gates</h2>
    {!gates.length ? <p className="mt-3 text-body-md">Every mandatory gate passes.</p> : <>
      <ul className="mt-3 space-y-2 text-body-md">{steps(gates).map((step) => <li key={step.label} className="flex items-start gap-3">
        {step.done ? <Check aria-hidden className="mt-0.5 size-5 shrink-0 text-highlight" /> : <Circle aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />}
        <span><span className="font-semibold">{step.label}</span><span className="text-muted"> · {step.done ? "done" : step.blockers.map(human).join(", ")}</span></span>
      </li>)}</ul>
      {extra.length > 0 && <p className="mt-3 text-body-sm text-muted">Also blocking: {extra.map(human).join(", ")}.</p>}
    </>}
  </section>;
}

/** Database review: the film is chosen from the validated TMDB choices; the title and year come from that choice. */
function FilmChoices({ candidate }: { candidate: ReviewCandidate }) {
  return <fieldset className="sm:col-span-2">
    <legend className="mb-1.5 text-label-lg">Which film is this?</legend>
    <ul className="grid gap-3 sm:grid-cols-2">{candidate.choices.map((movie) => <li key={movie.tmdb_id}>
      <label className="flex min-h-11 cursor-pointer gap-4 rounded-lg border border-border bg-canvas-subtle/80 p-3 transition-colors hover:border-highlight/40 has-checked:border-highlight has-checked:bg-accent/12 has-focus-visible:shadow-focus">
        <input type="radio" name="tmdbId" value={movie.tmdb_id} required defaultChecked={candidate.tmdbId === movie.tmdb_id} className="mt-1 size-5 shrink-0 accent-accent" />
        <PosterImage path={movie.poster_path} title={movie.title} sizes="64px" className="w-16 shrink-0 self-start rounded-default" />
        <span className="min-w-0">
          <span className="block break-words text-body-md font-semibold">{movie.title} ({movie.release_date?.slice(0, 4) ?? "year unknown"})</span>
          {movie.original_title && <span className="block break-words text-body-sm text-muted">{movie.original_title}</span>}
          <span className="mt-1 line-clamp-3 block text-body-sm text-muted">{movie.overview ?? "No description."}</span>
          <span className="mt-1 block text-body-sm text-muted">TMDB {movie.tmdb_id}</span>
        </span>
      </label>
    </li>)}</ul>
  </fieldset>;
}

/**
 * `capabilities` (database review): what the signed-in account may do, so only usable controls are offered.
 * Null: the database does not have the dashboard commands yet. The database checks every action again.
 */
export function ReviewDetail({ candidate, vjs, action, error, notice, mode = "fixture", capabilities = null }: { candidate: ReviewCandidate; vjs: readonly ReviewVj[]; action: Action; error?: string; notice?: string; mode?: ReviewUiMode; capabilities?: ReviewCapabilities | null }) {
  const candidateId = <><input type="hidden" name="id" value={candidate.id} /><input type="hidden" name="revision" value={candidate.revision} /></>;
  const database = mode === "database";
  const open = reviewOpen(candidate);
  const working = candidate.status === "detected" || candidate.status === "inspecting" || candidate.status === "publishing";
  // A failed inspection is the next step itself, so its action sits with the explanation, not among the secondary actions.
  const urgent = database && (inspectionExhausted(candidate) || candidate.status === "failed");
  // The decision the candidate is waiting for: approval when the database reports no gate, publication when this revision is approved.
  const decision = !database ? null : candidate.status === "awaiting_review" && !candidate.gates?.length ? "approve" as const
    : candidate.status === "approved" && candidate.approval?.revision === candidate.revision ? "publish" as const : null;
  const allowed = decision === "approve" ? capabilities?.review : decision === "publish" ? capabilities?.publish : false;
  const evidence = candidate.evidence;
  const vjSelect = <Field id="vj" label={database ? "VJ" : "Existing VJ"}>{(props) => <select {...props} name="vjId" required defaultValue={candidate.vjId ?? ""}><option value="">Select active VJ</option>{vjs.filter((vj) => vj.isActive).map((vj) => <option key={vj.id} value={vj.id}>{vj.name}</option>)}</select>}</Field>;
  return <div className="space-y-6">
    <Link className={buttonClass("ghost")} href="/admin/discovery">Back to review queue</Link>
    <Message error={error} notice={notice} />
    <div className="grid gap-6 md:grid-cols-3">
      {/* A thumbnail on phones, so the next step is on the first screen. */}
      <div className="w-32 md:w-auto"><PosterImage path={candidate.snapshot?.poster_path ?? null} title={candidate.title ?? "Review candidate"} sizes="(min-width: 768px) 30vw, 128px" /></div>
      <section className="min-w-0 space-y-4 md:col-span-2">
        <div className="relative isolate overflow-hidden rounded-lg border border-border p-6"><BackdropImage path={candidate.snapshot?.backdrop_path ?? null} sizes="(min-width: 768px) 60vw, 90vw" /><div className="relative space-y-2"><h1 className="break-words text-headline-md">{candidate.title ?? candidate.event.media.name ?? "Review candidate"}</h1><p>{human(candidate.status)} · revision {candidate.revision}</p><p>{candidate.snapshot?.overview ?? "Metadata unavailable"}</p></div></div>
        <NextStep candidate={candidate} database={database}>
          {decision && <div className="mt-4">
            {allowed ? <form action={action}>{candidateId}<button name="command" value={decision} className={buttonClass()}>{decision === "approve" ? "Approve" : "Publish to the site"}</button></form>
              : <p className="text-body-sm text-muted">{capabilities === null ? "The Approve and Publish buttons are not switched on yet: the database is waiting for an update."
                : decision === "approve" ? "Approving needs the review permission, which your account does not have." : "Publishing needs the publish permission, which your account does not have."}</p>}
          </div>}
          {(urgent || working) && <div className="mt-4 flex flex-wrap gap-3">
            {urgent && <form action={action}>{candidateId}<button name="command" value="retry" className={buttonClass()}>Reinspect now</button></form>}
            {working && <Link prefetch={false} href={`/admin/discovery/${candidate.id}`} className={buttonClass("secondary")}>Refresh</Link>}
          </div>}
        </NextStep>
        <dl className="grid grid-cols-1 gap-2 break-words text-body-md sm:grid-cols-2">
          <dt className="text-muted">Telegram reference</dt><dd>Channel {candidate.event.channelId}, message {candidate.event.messageId}</dd>
          <dt className="text-muted">Filename</dt><dd>{candidate.event.media.name ?? "Unknown"}</dd>
          <dt className="text-muted">Media size</dt><dd>{size(candidate.event.media.size)}</dd>
          <dt className="text-muted">Read from the post</dt><dd>{candidate.title ?? "No title"} · {candidate.year ?? "no year"} · {candidate.vjText ? `VJ ${candidate.vjText}` : "no VJ"}</dd>
          <dt className="text-muted">Catalogue match</dt><dd>{candidate.movieId ? `Movie ${candidate.movieId}` : "New or unresolved"} · {human(candidate.relation)}</dd>
          <dt className="text-muted">TMDB identity</dt><dd>{candidate.tmdbId ?? "Unresolved"} · {human(candidate.identity)}</dd>
          <dt className="text-muted">Readiness</dt><dd>{readiness(candidate)}</dd>
          <dt className="text-muted">Container / gateway / browser</dt><dd>{[evidence?.container, evidence?.gateway, evidence?.browser].map((value) => value ? "Verified" : "Unknown").join(" / ")}</dd>
          {evidence?.mediaClass && <><dt className="text-muted">Media policy</dt><dd>{human(evidence.mediaClass)} · video {evidence.video ?? "unknown"} · audio {evidence.audio ?? "unknown"}{evidence.reasons?.length ? ` · ${evidence.reasons.map(human).join(", ")}` : ""}</dd></>}
          <dt className="text-muted">Verification reference</dt><dd>{evidence?.reference ?? "No verification evidence"}</dd>
          <dt className="text-muted">Rights</dt><dd>{candidate.rights?.reference ?? "No clearance; publication blocked"}</dd>
          {candidate.publication && <><dt className="text-muted">Published</dt><dd><Link className="underline underline-offset-4" href={`/movies/${candidate.publication.movieSlug}`}>{candidate.publication.movieSlug}</Link> · version {candidate.publication.versionId}</dd></>}
        </dl>
        <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-label-lg">Caption and validation warnings</summary><p className="mt-3 whitespace-pre-wrap break-all">{candidate.event.media.caption ?? "No caption"}</p><ul className="mt-3 list-inside list-disc">{candidate.warnings.map((warning) => <li key={warning}>{human(warning)}</li>)}</ul>{candidate.error && <p>{human(candidate.error)}</p>}</details>
      </section>
    </div>
    {database && <Gates gates={candidate.gates ?? []} />}
    {open && database && candidate.choices.length === 0 && <section className="rounded-lg border border-border bg-surface p-5" aria-labelledby="nofilm-heading">
      <h2 id="nofilm-heading" className="text-headline-sm">No film found for this title</h2>
      <p className="mt-2 text-body-md">TMDB returned nothing usable for “{candidate.title ?? "this post"}”. Fix the post in Telegram and it is read again by itself:</p>
      <ul className="mt-3 list-inside list-disc space-y-1 text-body-md">
        <li>Edit the caption and add a line <code className="break-all">tmdb:movie:NUMBER</code>, using the number from the film’s TMDB address.</li>
        <li>Or post the file again named <code className="break-all">Title Year VJ Name.mp4</code>, spelled as TMDB lists it.</li>
      </ul>
    </section>}
    {open && database && candidate.choices.length > 0 && <form action={action} className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
      {candidateId}<input type="hidden" name="command" value="correct" />
      <FilmChoices candidate={candidate} />
      {vjSelect}
      <button className={buttonClass("primary", "self-end")}>Confirm film and VJ</button>
    </form>}
    {open && !database && <form action={action} className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
      {candidateId}<input type="hidden" name="command" value="correct" />
      <Field id="title" label="Review title">{(props) => <input {...props} name="title" required maxLength={300} defaultValue={candidate.title ?? ""} />}</Field>
      <Field id="year" label="Release year">{(props) => <input {...props} name="year" type="number" required min={1900} max={2100} defaultValue={candidate.year ?? ""} />}</Field>
      <Field id="tmdb" label="Confirm movie identity">{(props) => <select {...props} name="tmdbId" required defaultValue={candidate.tmdbId ?? ""}><option value="">Select validated metadata</option>{candidate.choices.map((movie) => <option key={movie.tmdb_id} value={movie.tmdb_id}>{movie.title} ({movie.release_date?.slice(0, 4) ?? "Unknown year"}) · {movie.tmdb_id}</option>)}</select>}</Field>
      {vjSelect}
      <button className={buttonClass()}>Confirm reviewed identity</button>
    </form>}
    {open && database && !capabilities?.rights && <p className="rounded-lg border border-border p-5 text-body-md text-muted">Recording rights clearance needs the rights permission, which your account does not have.</p>}
    {open && (!database || capabilities?.rights) && <form action={action} className="grid gap-4 rounded-lg border border-border p-5 sm:grid-cols-2">
      {candidateId}<input type="hidden" name="command" value="rights" />
      {database
        ? <Field id="rights" label="Rights clearance reference" hint="Contract or licence reference for this document. Recorded with your account for this revision only; not a URL.">{(props) => <input {...props} name="reference" required maxLength={200} />}</Field>
        : <Field id="rights" label="Synthetic rights review reference" hint="Records only a local fixture decision. Real streaming rights require the approved owner workflow.">{(props) => <input {...props} name="reference" required maxLength={200} />}</Field>}
      <button className={buttonClass("secondary", "self-end")}>{database ? "Record rights clearance" : "Record fixture rights decision"}</button>
    </form>}
    {(open || (database && candidate.publication)) && <form action={action} className="flex flex-wrap gap-3">{candidateId}
      {!database && open && <button name="command" value="approve" className={buttonClass()}>Approve local review</button>}
      {open && <button name="command" value="reject" className={buttonClass("secondary")}>Reject candidate</button>}
      {canReinspect(candidate, database) && !urgent && <button name="command" value="retry" className={buttonClass("secondary")}>{database ? "Reinspect" : "Reinspect fixture"}</button>}
      {database
        ? candidate.publication && <button name="command" value="refresh" className={buttonClass("secondary")}>Refresh public pages</button>
        : open && <button name="command" value="prepare" className={buttonClass("secondary")} disabled={candidate.status !== "approved"}>Prepare existing owner publication script</button>}
    </form>}
    <p className="text-body-sm text-muted">{database
      ? "Publication creates or links the movie, this VJ version and this exact Telegram document in one transaction, only when every gate passes at the approved revision, and only for an account with the separate publish permission."
      : "Production publication is disabled. New direct-channel media needs the separately approved publication extension. A script is an artifact for review; it does not execute."}</p>
    <section className="rounded-lg border border-border p-5"><h2 className="text-headline-sm">Audit history</h2><ol className="mt-4 space-y-2 break-words text-body-sm">{candidate.audit.map((entry, index) => <li key={index}>{entry.at} · {human(entry.action)} · revision {entry.revision} · {entry.actor}</li>)}</ol></section>
  </div>;
}
