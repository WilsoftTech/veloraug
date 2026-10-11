"use client";

import { useActionState, useState } from "react";
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
  const [state, submit, pending] = useActionState(action, { error: "" });
  function select(picked: File | undefined) {
    if (!picked) return;
    if (!picked.size || picked.size > maxBytes) { setFile(null); setError("Choose a nonempty video no larger than 2 GB."); return; }
    if (!extensions.includes(picked.name.split(".").pop()?.toLowerCase() ?? "") || /[\\/\x00-\x1f\x7f]/.test(picked.name)) { setFile(null); setError("Choose a supported video container with a plain filename."); return; }
    setFile(picked); setError("");
  }
  return (
    <form action={submit} className="mt-6 max-w-xl space-y-5">
      <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); select(event.dataTransfer.files[0]); }} className="rounded-lg border border-dashed border-border bg-surface p-6">
        <Field id="upload-file" label="Movie file" hint="Choose a video or drop it here. Maximum 2 GB." errors={error ? [error] : undefined}>
          {(props) => <input {...props} type="file" accept={extensions.map((extension) => `.${extension}`).join(",")} onChange={(event) => select(event.target.files?.[0])} />}
        </Field>
        {file && <p className="mt-3 break-all text-body-sm">{file.name} · {(file.size / 1_000_000).toFixed(1)} MB</p>}
      </div>
      {/* The file input has no name: only file facts reach the Server Action. */}
      <input type="hidden" name="fileName" value={file?.name ?? ""} />
      <input type="hidden" name="sizeBytes" value={file?.size ?? 0} />
      {state.error && <p role="alert" className="text-body-sm text-destructive">{state.error}</p>}
      <button className={buttonClass()} disabled={!file || pending}>{pending ? "Creating draft…" : "Create upload draft"}</button>
    </form>
  );
}
