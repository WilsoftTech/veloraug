"use client";
import { useEffect,useRef,useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/form-field";
import { buttonClass } from "@/components/button";
import { uploadR2FromBrowser } from "@/lib/uploader/r2-browser";

const CHUNK_BYTES = 8 * 1024 * 1024;
export function AdminUploadTransfer({ id,fileName,sizeBytes,storage="disk",parallelism=3 }: { id: string; fileName: string; sizeBytes: number;storage?: "disk"|"r2";parallelism?: number }) {
  const router = useRouter();
  const [file,setFile] = useState<File | null>(null);
  const [running,setRunning] = useState(false);
  const [offset,setOffset] = useState(0);
  const [speed,setSpeed] = useState(0);
  const [error,setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(),[]);
  async function transfer() {
    if (!file || running) return;
    if (file.name !== fileName || file.size !== sizeBytes) { setError("Reselect the same file name and size to continue this upload."); return; }
    setRunning(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    try {
      if(storage==="r2") {
        await uploadR2FromBrowser(file,`/api/admin/uploads/${id}/transfer`,{signal:abort.signal,parallelism,progress:(bytes,rate)=>{setOffset(bytes);setSpeed(rate);}});
        router.refresh(); return;
      }
      const credentials = await fetch(`/api/admin/uploads/${id}/transfer`,{ method: "POST",signal: abort.signal });
      if (!credentials.ok) throw new Error("Upload service unavailable or access refused.");
      const { url,token } = await credentials.json() as { url: string; token: string };
      const auth = { Authorization: `Bearer ${token}` };
      const status = await fetch(url,{ headers: auth,signal: abort.signal });
      if (!status.ok) throw new Error("Could not read resumable upload progress.");
      const manifest = await status.json() as { offset: number; size: number; chunks: { offset: number; size: number; sha256: string }[] };
      if (manifest.size !== sizeBytes || !Number.isSafeInteger(manifest.offset) || manifest.offset < 0 || manifest.offset > sizeBytes || !Array.isArray(manifest.chunks)) throw new Error("Upload progress is inconsistent.");
      let checked = 0;
      // Reselecting a same-size but changed file must not mix two sources.
      for (const chunk of manifest.chunks) {
        if (abort.signal.aborted) throw new DOMException("Paused","AbortError");
        if (chunk.offset !== checked || chunk.size !== Math.min(CHUNK_BYTES,sizeBytes-checked)) throw new Error("Upload progress is inconsistent.");
        const bytes = await file.slice(chunk.offset,chunk.offset+chunk.size).arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256",bytes);
        const hex = Array.from(new Uint8Array(digest),(value) => value.toString(16).padStart(2,"0")).join("");
        if (hex !== chunk.sha256) throw new Error("This file differs from the previous upload. Create a new draft.");
        checked += chunk.size;
      }
      if (checked !== manifest.offset) throw new Error("Upload progress is inconsistent.");
      let current = manifest.offset; setOffset(current);
      const startedAt = performance.now(); const initial = current;
      while (current < sizeBytes) {
        const end = Math.min(current+CHUNK_BYTES,sizeBytes);
        const response = await fetch(url,{ method: "PATCH",headers: { ...auth,"Content-Type": "application/octet-stream","Upload-Offset": String(current) },body: file.slice(current,end),signal: abort.signal });
        if (!response.ok) throw new Error("Transfer interrupted. Resume to read the committed progress and retry.");
        const receipt = await response.json() as { offset: number };
        if (receipt.offset !== end) throw new Error("Upload progress is inconsistent.");
        current = end; setOffset(current); setSpeed((current-initial)/Math.max(1,(performance.now()-startedAt)/1000));
      }
      const complete = await fetch(`/api/admin/uploads/${id}/transfer`,{ method: "POST",headers: { "Upload-Command": "verify" },signal: abort.signal });
      if (!complete.ok) throw new Error("File transfer completed, but verification could not be queued. Resume to retry.");
      router.refresh();
    } catch (failure) {
      setError(abort.signal.aborted ? "Paused. Completed chunks are retained." : failure instanceof Error ? failure.message : "Transfer interrupted. Resume to retry.");
    } finally { controller.current = null; setRunning(false); }
  }
  const remaining = speed > 0 ? Math.ceil((sizeBytes-offset)/speed) : null;
  return <section aria-label="File transfer" className="mt-6 max-w-xl rounded-lg border border-border bg-surface p-4">
    <Field id="resume-upload-file" label="Select the file to upload or resume" hint={storage==="r2" ? "Completed parts remain in private R2 staging. Reselect the original file after a refresh." : "Previously completed chunks are kept on the staging service."}>{(props) => <input {...props} type="file" accept="video/*,.mkv,.m4v,.ts,.m2ts" disabled={running} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />}</Field>
    <progress className="mt-4 w-full" value={offset} max={sizeBytes} aria-label="File transfer progress" />
    <p className="mt-2 text-body-sm text-muted" aria-live="polite">{Math.floor(offset/sizeBytes*100)}% · {(offset/1_000_000).toFixed(1)} / {(sizeBytes/1_000_000).toFixed(1)} MB{speed > 0 ? ` · ${(speed/1_000_000).toFixed(1)} MB/s` : ""}{remaining !== null ? ` · about ${Math.ceil(remaining/60)} min remaining` : ""}</p>
    {error && <p role="status" className="mt-3 text-body-sm">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={!file || running} onClick={() => void transfer()} className={buttonClass()}>{offset ? "Resume transfer" : "Start or resume transfer"}</button>{running && <button type="button" onClick={() => controller.current?.abort()} className={buttonClass("secondary")}>Pause</button>}</div>
  </section>;
}
