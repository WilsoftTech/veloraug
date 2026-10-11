import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { buttonClass } from "@/components/button";
import { AdminUploadTransfer } from "@/components/admin-upload-transfer";
import { canEditUpload } from "@/lib/uploader/admin-upload";
import { cancelUploadAction, retryUploadAction, saveUploadAction } from "../actions";
import { uploadClient } from "@/lib/uploader/admin-runtime";

export default async function UploadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  if (process.env.VELORA_ADMIN_UPLOADS_ENABLED !== "true") notFound();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const session = await (await uploadClient()).get(id);
  const { result } = await searchParams;
  return <section aria-labelledby="upload-title">
    <Link href="/admin/uploads" className="text-label-md text-muted">Back to uploads</Link>
    <h1 id="upload-title" className="mt-4 break-all text-headline-lg">{session.metadata.title || session.file_name}</h1>
    <p className="mt-2 text-body-md text-muted">{session.stage.replaceAll("_"," ")} · {(session.size_bytes / 1_000_000).toFixed(1)} MB</p>
    {result && <p role="status" className="mt-4 text-body-sm">{result === "blocked" ? "The change was blocked. Refresh and check your permissions and current status." : result === "cancelled" ? "Upload cancelled. Staging cleanup is pending." : result==="retrying" ? "Processing retry queued." : "Draft saved."}</p>}
    {session.error_code && <p role="alert" className="mt-4 text-body-sm text-destructive">{session.error_code.replaceAll("_"," ")}</p>}
    {["draft","uploading"].includes(session.stage) && <AdminUploadTransfer id={id} fileName={session.file_name} sizeBytes={session.size_bytes} />}
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
    {!["published","cancelled","telegram_uploading","telegram_uncertain","telegram_stored","publishing","inspecting"].includes(session.stage) && <form action={cancelUploadAction} className="mt-6"><input type="hidden" name="id" value={id} /><input type="hidden" name="revision" value={session.revision} /><button className={buttonClass("secondary")}>Cancel upload</button></form>}
  </section>;
}
