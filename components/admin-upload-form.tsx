"use client";

import { useActionState, useRef, useState } from "react";
import { FileVideo, Upload } from "lucide-react";
import { Field } from "@/components/form-field";
import { buttonClass } from "@/components/button";

interface Props {
  maxBytes: number;
  extensions: readonly string[];
  action: (previous: { error: string }, data: FormData) => Promise<{ error: string }>;
}
export function AdminUploadForm({ maxBytes, extensions, action }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [requestId,setRequestId] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const [state, submit, pending] = useActionState(action, { error: "" });
  const limit = `${(maxBytes / 1_000_000_000).toLocaleString()} GB`;
  function select(files: FileList) {
    if (pending) return;
    if (!files.length) { setFile(null); setRequestId(""); setError(""); return; }
    const picked = files[0];
    setFile(null);
    if (files.length !== 1) { setError("Choose one movie at a time."); return; }
    setRequestId(crypto.randomUUID());
    if (!picked.size || picked.size > maxBytes) { setError(`Choose a nonempty video no larger than ${limit}.`); return; }
    if (!extensions.includes(picked.name.split(".").pop()?.toLowerCase() ?? "") || /[\\/\x00-\x1f\x7f]/.test(picked.name)) { setFile(null); setError("Choose a supported video container with a plain filename."); return; }
    setFile(picked); setError("");
  }
  return (
    <form action={submit} aria-busy={pending} className="mt-6 space-y-5">
      <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); select(event.dataTransfer.files); }} className="rounded-lg border border-dashed border-highlight/50 bg-surface p-5 sm:p-8">
        <Upload aria-hidden="true" className="mb-4 size-8 text-highlight" />
        <h2 className="text-headline-sm">Choose your original movie</h2>
        <p className="mb-5 mt-2 text-body-sm text-muted">Drop one file here, or use the file picker below.</p>
        <Field id="upload-file" label="Movie file" hint={`${extensions.map((extension) => extension.toUpperCase()).join(" or ")} · Maximum ${limit}. Your original file is preserved.`} errors={error ? [error] : undefined}>
          {(props) => <input {...props} ref={picker} disabled={pending} type="file" accept={extensions.map((extension) => `.${extension}`).join(",")} className={`${props.className} h-auto min-h-11 min-w-0 py-2 file:mr-3 file:rounded-sm file:border-0 file:bg-surface-elevated file:px-3 file:py-1 file:text-foreground`} onChange={(event) => { if (event.target.files) select(event.target.files); }} />}
        </Field>
        <div aria-live="polite" className="mt-4">
          {error && <p className="sr-only" role="alert">{error}</p>}
          {file && <div className="flex min-w-0 items-start gap-3 rounded-default border border-border bg-canvas-subtle p-4">
            <FileVideo aria-hidden="true" className="mt-1 size-5 shrink-0 text-highlight" />
            <div className="min-w-0 flex-1"><p className="break-all text-label-lg">{file.name}</p><p className="mt-1 text-body-sm text-muted">{(file.size / 1_000_000).toFixed(1)} MB · Ready to create a draft</p></div>
          </div>}
        </div>
        {file && <button type="button" disabled={pending} className={buttonClass("ghost", "mt-2 px-0")} onClick={() => { setFile(null); setRequestId(""); setError(""); if (picker.current) picker.current.value = ""; }}>Remove selected file</button>}
      </div>
      {/* The file input has no name: only file facts reach the Server Action. */}
      <input type="hidden" name="fileName" value={file?.name ?? ""} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="sizeBytes" value={file?.size ?? 0} />
      {state.error && <p role="alert" className="text-body-sm text-destructive">{state.error}</p>}
      <p className="text-body-sm text-muted">Creating a draft saves the filename and size. You’ll select the same file on the next screen to start the resumable transfer.</p>
      <button className={buttonClass("primary", "w-full sm:w-auto")} disabled={!file || pending}>{pending ? "Creating draft…" : "Create upload draft"}</button>
    </form>
  );
}
