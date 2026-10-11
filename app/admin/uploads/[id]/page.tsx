import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { buttonClass } from "@/components/button";
import { AdminUploadTransfer } from "@/components/admin-upload-transfer";
import { canEditUpload } from "@/lib/uploader/admin-upload";
import { cancelUploadAction, refreshUploadPagesAction, retryUploadAction, saveUploadAction,reviewUploadAction } from "../actions";
import { uploadClient } from "@/lib/uploader/admin-runtime";

export default async function UploadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  if (process.env.VELORA_ADMIN_UPLOADS_ENABLED !== "true") notFound();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const session = await (await uploadClient()).get(id);
  const { result } = await searchParams;
  const flow=session.pipeline;
  const statuses=[
    ["Upload",session.bytes_received===session.size_bytes?"Completed":session.stage==="failed"?"Failed":["draft","cancelled"].includes(session.stage)?session.stage:session.stage==="uploading"?"Uploading / paused":"Pending"],
    ["Media",flow?.media_verified?"Verified":session.inspection || session.stage==="failed"?"Failed":session.stage==="inspecting"?"Verifying":"Awaiting verification"],
    ["Telegram",flow?.stored?"Stored":["upload_failed","blocked"].includes(flow?.telegram_status??"")?"Failed":session.stage==="telegram_uncertain"?"Reconciling uncertain transfer":session.stage==="telegram_uploading"?"Transferring":"Pending transfer"],
    ["Rights",flow?.rights_rejected?"Rejected":flow?.rights_cleared?"Cleared":flow?.rights_expires_at?"Expired / revoked":session.stage==="awaiting_rights"?"Under review":"Awaiting clearance"],
    ["Publication",session.stage==="published" && flow?.approved?"Published":flow?.approved?"Ready":"Blocked"],
  ];
  return <section aria-labelledby="upload-title">
    <Link href="/admin/uploads" className="text-label-md text-muted">Back to uploads</Link>
    <h1 id="upload-title" className="mt-4 break-all text-headline-lg">{session.metadata.title || session.file_name}</h1>
    <p className="mt-2 text-body-md text-muted">{session.stage.replaceAll("_"," ")} · {(session.size_bytes / 1_000_000).toFixed(1)} MB</p>
    {session.storage==="r2" && <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">{statuses.map(([label,status])=><div key={label} className="rounded-lg border border-border p-3"><dt className="text-label-md">{label}</dt><dd className="mt-1 text-body-sm text-muted">{status}</dd></div>)}</dl>}
    {result && <p role="status" className="mt-4 text-body-sm">{result === "blocked" ? "The change was blocked. Refresh and check your permissions and current status." : result === "cancelled" ? "Upload cancelled. Staging cleanup is pending." : result==="retrying" ? "Processing retry queued." : result==="refreshed" ? "Public catalogue pages were refreshed." : "Draft saved."}</p>}
    {session.error_code && <p role="alert" className="mt-4 text-body-sm text-destructive">{session.error_code.replaceAll("_"," ")}</p>}
    {["draft","uploading"].includes(session.stage) && <AdminUploadTransfer id={id} fileName={session.file_name} sizeBytes={session.size_bytes} storage={session.storage} parallelism={Number(process.env.VELORA_UPLOAD_PARALLEL_PARTS ?? 3)} />}
    {session.inspection && <p className="mt-4 text-body-sm text-muted">Media inspection: {session.inspection.classification.class.replaceAll("_"," ")}{session.inspection.classification.reasons.length ? ` (${session.inspection.classification.reasons.join(", ")})` : ""}</p>}
    {session.stage==="failed" && session.retryable && <form action={retryUploadAction} className="mt-4"><input type="hidden" name="id" value={id} /><input type="hidden" name="revision" value={session.revision} /><button className={buttonClass("secondary")}>Retry processing</button></form>}
    <form action={saveUploadAction} className="mt-6 max-w-xl space-y-5">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="revision" value={session.revision} />
      <fieldset disabled={!canEditUpload(session.stage)} className="space-y-5">
        <Field id="upload-kind" label="Media type">{(props) => <select {...props} name="kind" defaultValue={session.metadata.kind}><option value="movie">Movie</option><option value="series">TV episode (draft only)</option></select>}</Field>
        <Field id="upload-label" label="Title">{(props) => <input {...props} name="title" maxLength={300} defaultValue={session.metadata.title} />}</Field>
        <Field id="upload-year" label="Release year">{(props) => <input {...props} type="number" name="year" min={1870} max={2199} defaultValue={session.metadata.year ?? ""} />}</Field>
        {session.inspection && <Field id="upload-tmdb" label="Confirm TMDB match" hint="Suggestions are not approvals. Choose the correct film explicitly.">{(props) => <select {...props} name="tmdbId" defaultValue={session.metadata.snapshot?.tmdb_id ?? ""}><option value="">Not confirmed</option>{session.inspection!.choices.map((movie) => <option key={movie.tmdb_id} value={movie.tmdb_id}>{movie.title} ({movie.release_date?.slice(0,4) ?? "year unknown"})</option>)}</select>}</Field>}
        <Field id="upload-vj" label="VJ ID" hint={session.inspection?.proposed_vj_id ? `Detected VJ ID ${session.inspection.proposed_vj_id}. Confirm an existing active catalogue VJ.` : "Use an existing active catalogue VJ. Inspection never guesses an ambiguous VJ."}>{(props) => <input {...props} type="number" name="vjId" min={1} defaultValue={session.metadata.vjId ?? ""} />}</Field>
        <Field id="upload-provenance" label="Source and provenance" hint="Record where the file came from. This does not grant rights clearance.">{(props) => <textarea {...props} name="provenance" maxLength={2000} defaultValue={session.metadata.provenance} className={`${props.className} min-h-28 py-3`} />}</Field>
        <button className={buttonClass()}>Save draft</button>
      </fieldset>
    </form>
    {session.storage==="r2" && <section aria-label="Review and approval" className="mt-6 max-w-xl space-y-4">
      <p className="text-body-sm text-muted">Identity confirmation, verified playable media, distribution rights, and publication permission are checked independently. Uploading never grants rights.</p>
      {(["metadata_review","awaiting_rights","awaiting_approval","telegram_stored","published"].includes(session.stage) || (session.stage==="failed" && flow?.stored)) && <form action={reviewUploadAction} className="space-y-4">
        <input type="hidden" name="id" value={id}/><input type="hidden" name="revision" value={session.revision}/>
        {session.stage==="metadata_review" && <div className="flex flex-wrap gap-3"><button name="action" value="submit" className={buttonClass()}>Submit for rights review</button><button name="action" value="reinspect" className={buttonClass("secondary")}>Inspect updated identity</button></div>}
        {(["awaiting_rights","awaiting_approval","telegram_stored","published"].includes(session.stage) || (session.stage==="failed" && flow?.stored)) && <>
          <Field id="rights-reference" label="Distribution rights evidence reference" hint="Use an internal licence or contract reference. Rights capability is required.">{props=><input {...props} name="reference" maxLength={200} defaultValue={flow?.rights_reference??""}/>}</Field>
          <Field id="rights-expiry" label="Rights expiration (UTC)" hint="ISO 8601 time, for example 2027-01-01T00:00:00Z; at most one year ahead.">{props=><input {...props} name="expiresAt" defaultValue={flow?.rights_expires_at??""}/>}</Field>
          <div className="flex flex-wrap gap-3"><button name="action" value="clear_rights" className={buttonClass("secondary")}>Record rights clearance</button>{flow?.rights_expires_at && <button name="action" value="revoke_rights" className={buttonClass("secondary")}>Revoke clearance</button>}{session.stage==="awaiting_approval" && <button name="action" value="approve" className={buttonClass()}>Approve transfer and publication</button>}</div>
          {["awaiting_rights","awaiting_approval"].includes(session.stage) && <button name="action" value="reject_rights" className={buttonClass("secondary")}>Reject distribution rights</button>}
        </>}
      </form>}
      {flow && <p className="text-body-sm text-muted">Temporary storage: {flow.cleanup_state==="cleaned"?"cleaned up":"retained"}{flow.cleanup_error?` — cleanup retry: ${flow.cleanup_error.replaceAll("_"," ")}`:""}. {flow.publication_slug && flow.approved && <Link href={`/movies/${flow.publication_slug}`} className="underline">View published movie</Link>}</p>}
      {session.stage==="published" && flow?.approved && flow.publication_slug && <form action={refreshUploadPagesAction}><input type="hidden" name="id" value={id} /><button className={buttonClass("secondary")}>Refresh public pages</button></form>}
      {!!flow?.audit.length && <details className="text-body-sm"><summary className="cursor-pointer py-3">Inspect operation history</summary><ol className="space-y-2">{flow.audit.map((entry,index)=><li key={index}>{entry.action.replaceAll("_"," ")} · revision {entry.revision} · {entry.at}</li>)}</ol></details>}
      <Link href={`/admin/uploads/${id}`} className="inline-block py-3 text-body-sm underline">Refresh processing status</Link>
    </section>}
    {!["published","cancelled","telegram_uploading","telegram_uncertain","telegram_stored","publishing","inspecting"].includes(session.stage) && <form action={cancelUploadAction} className="mt-6"><input type="hidden" name="id" value={id} /><input type="hidden" name="revision" value={session.revision} /><button className={buttonClass("secondary")}>Cancel upload</button></form>}
  </section>;
}
