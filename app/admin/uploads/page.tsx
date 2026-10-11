import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { uploadClient } from "@/lib/uploader/admin-runtime";

export default async function UploadsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  if (process.env.VELORA_ADMIN_UPLOADS_ENABLED !== "true") notFound();
  const query = await searchParams;
  const sessions = await (await uploadClient()).list();
  const filtered = sessions.filter((s) => (!query.status || s.stage === query.status) && (!query.q || `${s.file_name} ${s.metadata.title}`.toLowerCase().includes(query.q.toLowerCase())));
  return <section aria-labelledby="uploads-title">
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 id="uploads-title" className="text-headline-lg">Uploads</h1><Link href="/admin/uploads/new" className={buttonClass()}>New upload</Link></div>
    <p className="mt-2 text-body-md text-muted">Private drafts and processing history. Uploaded files remain unpublished until all review gates pass.</p>
    <form className="my-6 flex flex-wrap gap-3">
      <input name="q" aria-label="Search uploads" defaultValue={query.q} placeholder="Search title or filename" className="min-h-11 rounded-default border border-border bg-surface px-3" />
      <select name="status" aria-label="Upload status" defaultValue={query.status ?? ""} className="min-h-11 rounded-default border border-border bg-surface px-3"><option value="">All statuses</option>{[...new Set(sessions.map((s) => s.stage))].map((stage) => <option key={stage} value={stage}>{stage.replaceAll("_"," ")}</option>)}</select>
      <button className={buttonClass("secondary")}>Filter</button>
    </form>
    {filtered.length ? <ul className="space-y-3">{filtered.map((session) => <li key={session.id} className="rounded-lg border border-border bg-surface p-4"><Link href={`/admin/uploads/${session.id}`} className="block min-h-11"><span className="break-all text-title-md">{session.metadata.title || session.file_name}</span><span className="mt-2 block text-body-sm text-muted">{session.stage.replaceAll("_"," ")} · {(session.size_bytes / 1_000_000).toFixed(1)} MB</span></Link>{session.error_code && <p className="mt-2 text-body-sm text-destructive">{session.error_code.replaceAll("_"," ")}</p>}</li>)}</ul> : <EmptyState title="No uploads" description="Create a private upload draft to get started." />}
  </section>;
}
