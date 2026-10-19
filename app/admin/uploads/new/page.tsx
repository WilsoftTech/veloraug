import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminUploadForm } from "@/components/admin-upload-form";
import { ADMIN_UPLOAD_MAX_BYTES } from "@/lib/uploader/admin-upload";
import { MOVIE_UPLOAD_EXTENSIONS } from "@/lib/ingestion/original-media";
import { requireReviewAdmin } from "@/lib/discovery/runtime";
import { createUploadAction } from "../actions";

export default async function NewUploadPage() {
  await requireReviewAdmin();
  if (process.env.VELORA_ADMIN_UPLOADS_ENABLED !== "true") notFound();
  return <section aria-labelledby="new-upload-title">
    <Link href="/admin/uploads" className="text-label-md text-muted">Back to uploads</Link>
    <h1 id="new-upload-title" className="mt-4 text-headline-lg">Upload a movie</h1>
    <p className="mt-2 text-body-md text-muted">Original MP4 and MKV files are preserved. Create a private draft, verify the file, and review its metadata and rights before Telegram storage and publication.</p>
    <div className="mt-6 grid gap-6 lg:grid-cols-3 lg:gap-8">
      <div className="min-w-0 lg:col-span-2"><AdminUploadForm maxBytes={ADMIN_UPLOAD_MAX_BYTES} extensions={MOVIE_UPLOAD_EXTENSIONS} action={createUploadAction} /></div>
      <aside aria-labelledby="upload-steps-title" className="h-fit rounded-lg border border-border bg-surface p-5 lg:mt-6">
        <h2 id="upload-steps-title" className="text-headline-sm">What happens next</h2>
        <ol className="mt-5 space-y-5 text-body-sm">
          <li><p className="text-label-lg">1. Create a private draft</p><p className="mt-1 text-muted">Select one original MP4 or MKV movie.</p></li>
          <li><p className="text-label-lg">2. Transfer and verify</p><p className="mt-1 text-muted">Resumable transfer keeps completed parts. File checks run before metadata review.</p></li>
          <li><p className="text-label-lg">3. Review the movie</p><p className="mt-1 text-muted">Confirm the film, VJ, and source. Distribution rights and publication each need their own approval.</p></li>
        </ol>
        <p className="mt-5 border-t border-border pt-4 text-body-sm text-muted">Your draft stays private. Creating or transferring a file does not publish it.</p>
      </aside>
    </div>
  </section>;
}
