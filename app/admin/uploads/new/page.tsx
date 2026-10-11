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
    <AdminUploadForm maxBytes={ADMIN_UPLOAD_MAX_BYTES} extensions={MOVIE_UPLOAD_EXTENSIONS} action={createUploadAction} />
  </section>;
}
