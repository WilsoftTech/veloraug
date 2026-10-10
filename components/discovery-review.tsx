import Link from "next/link";
import { buttonClass } from "@/components/button";
import { Field } from "@/components/form-field";
import { EmptyState } from "@/components/empty-state";
import { PosterImage, BackdropImage } from "@/components/media-image";
import { reviewStates, type ReviewCandidate, type ReviewVj } from "@/lib/discovery/model";

/** fixture: the E3.8 offline inbox. database: E3.8A review against Supabase (decisions are real). */
export type ReviewUiMode = "fixture" | "database";

const human = (text: string) => text.replaceAll("_", " ");
const size = (bytes: number | null) => bytes === null ? "Unknown size" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const readiness = (candidate: ReviewCandidate) => candidate.evidence?.browser && candidate.evidence.container && candidate.evidence.gateway && candidate.evidence.accessible ? "Verified" : "Awaiting verification";
export function ReviewQueue({ candidates, search, status, mode = "fixture", error }: { candidates: ReviewCandidate[]; search: string; status: string; mode?: ReviewUiMode; error?: string }) {
  const shown = candidates.filter((item) => (!status || item.status === status) && (item.title ?? item.event.media.name ?? "").toLowerCase().includes(search.toLowerCase()));
  const database = mode === "database";
  return <div className="space-y-6">
    <p className="text-body-md text-muted">{database ? "Movies detected in the Telegram Movies channel. Nothing is published without explicit review, rights clearance and a publish decision." : "Synthetic offline review. Production discovery and publication are disabled."}</p>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4">{error}</p>}
    <form className="grid gap-4 sm:grid-cols-3" method="get">
      <Field id="q" label="Search title">{(props) => <input {...props} name="q" defaultValue={search} maxLength={300} />}</Field>
      <Field id="status" label="Review status">{(props) => <select {...props} name="status" defaultValue={status}><option value="">All statuses</option>{reviewStates.map((state) => <option key={state} value={state}>{human(state)}</option>)}</select>}</Field>
      <button className={buttonClass("secondary", "self-end")} type="submit">Filter queue</button>
    </form>
    {!shown.length ? <EmptyState title="No review candidates" description={database ? "No detected movie matches these filters." : "Run the explicit synthetic replay, or change these filters."} /> : <ul className="grid gap-4 md:grid-cols-2">
      {shown.map((item) => <li key={item.id} className="min-w-0 rounded-lg border border-border bg-surface p-5">
        <h2 className="break-words text-headline-sm"><Link className="underline decoration-highlight/40 underline-offset-4" href={`/admin/discovery/${item.id}`}>{item.title ?? item.event.media.name ?? "Untitled document"}</Link></h2>
        <p className="mt-2 text-body-md">{item.year ?? "Year unresolved"} · {item.vjText ?? "VJ unresolved"} · {size(item.event.media.size)}</p>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-body-sm">
          <dt className="text-muted">Detected</dt><dd>{new Date(item.firstSeen).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
          <dt className="text-muted">Source</dt><dd>{database ? "Movies channel" : "Movies fixture channel"}</dd>
          <dt className="text-muted">Identity</dt><dd>{human(item.identity)}</dd>
          <dt className="text-muted">Media</dt><dd>{readiness(item)}</dd>
          <dt className="text-muted">Rights</dt><dd>{item.rights ? (database ? "Clearance recorded" : "Fixture clearance recorded") : "Awaiting clearance"}</dd>
          <dt className="text-muted">Status</dt><dd>{human(item.status)}</dd>
        </dl>
      </li>)}
    </ul>}
  </div>;
}
export function ReviewDetail({ candidate, vjs, action, error, mode = "fixture", ownerCommand = null }: { candidate: ReviewCandidate; vjs: readonly ReviewVj[]; action: (data: FormData) => Promise<void>; error?: string; mode?: ReviewUiMode; ownerCommand?: { kind: "approve" | "publish"; sql: string } | null }) {
  const candidateId = <><input type="hidden" name="id" value={candidate.id} /><input type="hidden" name="revision" value={candidate.revision} /></>;
  const closed = ["published", "publishing", "duplicate", "rejected", "blocked", "inspecting"].includes(candidate.status);
  const database = mode === "database";
  const evidence = candidate.evidence;
  return <div className="space-y-6">
    <Link className={buttonClass("ghost")} href="/admin/discovery">Back to review queue</Link>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4">{error}</p>}
    <div className="grid gap-6 md:grid-cols-3">
      <div><PosterImage path={candidate.snapshot?.poster_path ?? null} title={candidate.title ?? "Review candidate"} sizes="(min-width: 768px) 30vw, 90vw" /></div>
      <section className="min-w-0 space-y-4 md:col-span-2">
        <div className="relative isolate overflow-hidden rounded-lg border border-border p-6"><BackdropImage path={candidate.snapshot?.backdrop_path ?? null} sizes="(min-width: 768px) 60vw, 90vw" /><div className="relative space-y-2"><h1 className="break-words text-headline-md">{candidate.title ?? candidate.event.media.name ?? "Review candidate"}</h1><p>{human(candidate.status)} · revision {candidate.revision}</p><p>{candidate.snapshot?.overview ?? "Metadata unavailable"}</p></div></div>
        <dl className="grid grid-cols-1 gap-2 break-words text-body-md sm:grid-cols-2">
          <dt className="text-muted">Telegram reference</dt><dd>Channel {candidate.event.channelId}, message {candidate.event.messageId}</dd>
          <dt className="text-muted">Filename</dt><dd>{candidate.event.media.name ?? "Unknown"}</dd>
          <dt className="text-muted">Media size</dt><dd>{size(candidate.event.media.size)}</dd>
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
    {database && <section className="rounded-lg border border-border p-5" aria-labelledby="gates-heading"><h2 id="gates-heading" className="text-headline-sm">Publication gates</h2>
      {candidate.gates?.length ? <ul className="mt-3 list-inside list-disc text-body-md">{candidate.gates.map((gate) => <li key={gate}>{human(gate)}</li>)}</ul> : <p className="mt-3 text-body-md">Every mandatory gate passes.</p>}</section>}
    <form action={action} className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
      {candidateId}<input type="hidden" name="command" value="correct" />
      <Field id="title" label="Review title">{(props) => <input {...props} name="title" required maxLength={300} defaultValue={candidate.title ?? ""} disabled={closed} />}</Field>
      <Field id="year" label="Release year">{(props) => <input {...props} name="year" type="number" required min={1900} max={2100} defaultValue={candidate.year ?? ""} disabled={closed} />}</Field>
      <Field id="tmdb" label="Confirm movie identity">{(props) => <select {...props} name="tmdbId" required defaultValue={candidate.tmdbId ?? ""} disabled={closed}><option value="">Select validated metadata</option>{candidate.choices.map((movie) => <option key={movie.tmdb_id} value={movie.tmdb_id}>{movie.title} ({movie.release_date?.slice(0, 4) ?? "Unknown year"}) · {movie.tmdb_id}</option>)}</select>}</Field>
      <Field id="vj" label="Existing VJ">{(props) => <select {...props} name="vjId" required defaultValue={candidate.vjId ?? ""} disabled={closed}><option value="">Select active VJ</option>{vjs.filter((vj) => vj.isActive).map((vj) => <option key={vj.id} value={vj.id}>{vj.name}</option>)}</select>}</Field>
      <button className={buttonClass()} disabled={closed}>Confirm reviewed identity</button>
    </form>
    <form action={action} className="grid gap-4 rounded-lg border border-border p-5 sm:grid-cols-2">
      {candidateId}<input type="hidden" name="command" value="rights" />
      {database
        ? <Field id="rights" label="Rights clearance reference" hint="Contract or licence reference for this document. Recorded with your account for this revision only; not a URL.">{(props) => <input {...props} name="reference" required maxLength={200} disabled={closed} />}</Field>
        : <Field id="rights" label="Synthetic rights review reference" hint="Records only a local fixture decision. Real streaming rights require the approved owner workflow.">{(props) => <input {...props} name="reference" required maxLength={200} disabled={closed} />}</Field>}
      <button className={buttonClass("secondary", "self-end")} disabled={closed}>{database ? "Record rights clearance" : "Record fixture rights decision"}</button>
    </form>
    {database && ownerCommand && <section className="rounded-lg border border-border p-5" aria-labelledby="owner-command-heading">
      <h2 id="owner-command-heading" className="text-headline-sm">{ownerCommand.kind === "approve" ? "Approval command" : "Publication command"}</h2>
      <p className="mt-2 text-body-sm text-muted">Approval and publication are never available in the browser. Run this through psql as velora_review_service (or the owner). It names your account; the database checks your permission and every gate again.</p>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border p-3 text-body-sm"><code>{ownerCommand.sql}</code></pre>
    </section>}
    <form action={action} className="flex flex-wrap gap-3">{candidateId}
      {!database && <button name="command" value="approve" className={buttonClass()} disabled={closed}>Approve local review</button>}
      <button name="command" value="reject" className={buttonClass("secondary")} disabled={closed}>Reject candidate</button>
      <button name="command" value="retry" className={buttonClass("secondary")} disabled={closed}>{database ? "Reinspect" : "Reinspect fixture"}</button>
      {database
        ? candidate.publication && <button name="command" value="refresh" className={buttonClass("secondary")}>Refresh public pages</button>
        : <button name="command" value="prepare" className={buttonClass("secondary")} disabled={candidate.status !== "approved"}>Prepare existing owner publication script</button>}
    </form>
    <p className="text-body-sm text-muted">{database
      ? "Publication creates or links the movie, this VJ version and this exact Telegram document in one transaction, only when every gate passes at the approved revision, and only for an account with the separate publish permission."
      : "Production publication is disabled. New direct-channel media needs the separately approved publication extension. A script is an artifact for review; it does not execute."}</p>
    <section className="rounded-lg border border-border p-5"><h2 className="text-headline-sm">Audit history</h2><ol className="mt-4 space-y-2 break-words text-body-sm">{candidate.audit.map((entry, index) => <li key={index}>{entry.at} · {human(entry.action)} · revision {entry.revision} · {entry.actor}</li>)}</ol></section>
  </div>;
}
