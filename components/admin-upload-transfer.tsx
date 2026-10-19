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
  const [phase,setPhase] = useState<"idle" | "checking" | "uploading" | "finishing" | "queued">("idle");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(),[]);
  async function transfer() {
    if (!file || controller.current || phase === "queued") return;
    if (file.name !== fileName || file.size !== sizeBytes) { setError("Reselect the same file name and size to continue this upload."); return; }
    setRunning(true); setError(""); setSpeed(0); setPhase("checking");
    const abort = new AbortController(); controller.current = abort;
    try {
      if(storage==="r2") {
        await uploadR2FromBrowser(file,`/api/admin/uploads/${id}/transfer`,{signal:abort.signal,parallelism,progress:(bytes,rate)=>{setOffset(bytes);setSpeed(rate);setPhase(bytes === sizeBytes ? "finishing" : "uploading");}});
        setPhase("queued");
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
      let current = manifest.offset; setOffset(current); setPhase("uploading");
      const startedAt = performance.now(); const initial = current;
      while (current < sizeBytes) {
        const end = Math.min(current+CHUNK_BYTES,sizeBytes);
        const response = await fetch(url,{ method: "PATCH",headers: { ...auth,"Content-Type": "application/octet-stream","Upload-Offset": String(current) },body: file.slice(current,end),signal: abort.signal });
        if (!response.ok) throw new Error("Transfer interrupted. Resume to read the committed progress and retry.");
        const receipt = await response.json() as { offset: number };
        if (receipt.offset !== end) throw new Error("Upload progress is inconsistent.");
        current = end; setOffset(current); setSpeed((current-initial)/Math.max(1,(performance.now()-startedAt)/1000));
      }
      setPhase("finishing");
      const complete = await fetch(`/api/admin/uploads/${id}/transfer`,{ method: "POST",headers: { "Upload-Command": "verify" },signal: abort.signal });
      if (!complete.ok) throw new Error("File transfer completed, but verification could not be queued. Resume to retry.");
      setPhase("queued");
      router.refresh();
    } catch (failure) {
      setPhase("idle");
      setError(abort.signal.aborted ? "Paused. Completed chunks are retained." : failure instanceof Error ? failure.message : "Transfer interrupted. Resume to retry.");
    } finally { controller.current = null; setRunning(false); }
  }
  const remaining = running && speed > 0 && offset < sizeBytes ? Math.ceil((sizeBytes-offset)/speed) : null;
  const message = phase === "checking" ? "Checking previously completed parts…" : phase === "uploading" ? "Transferring your movie…" : phase === "finishing" ? "Confirming transfer and queuing verification…" : phase === "queued" ? "Transfer complete. Verification is queued; the movie is still private." : "Select the original file to start or resume.";
  return <section aria-label="File transfer" className="mt-6 max-w-xl rounded-lg border border-border bg-surface p-4">
    <h2 className="text-headline-sm">Transfer the original file</h2>
    <p className="mb-4 mt-2 break-all text-body-sm text-muted">{fileName} · {(sizeBytes/1_000_000).toFixed(1)} MB</p>
    <Field id="resume-upload-file" label="Select the file to upload or resume" hint="Completed parts are retained. After a refresh, reselect the same original file to resume.">{(props) => <input {...props} type="file" accept="video/*,.mkv,.m4v,.ts,.m2ts" className={`${props.className} h-auto min-h-11 min-w-0 py-2 file:mr-3 file:rounded-sm file:border-0 file:bg-surface-elevated file:px-3 file:py-1 file:text-foreground`} disabled={running || phase === "queued"} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); }} />}</Field>
    <progress className="mt-4 w-full" value={offset} max={sizeBytes} aria-label="File transfer progress" />
    <p className="mt-2 text-body-sm text-muted">{Math.floor(offset/sizeBytes*100)}% · {(offset/1_000_000).toFixed(1)} / {(sizeBytes/1_000_000).toFixed(1)} MB{running && speed > 0 ? ` · ${(speed/1_000_000).toFixed(1)} MB/s` : ""}{remaining !== null ? ` · about ${Math.ceil(remaining/60)} min remaining` : ""}</p>
    <p role="status" className="mt-3 text-body-sm">{message}</p>
    {error && <p role="status" className="mt-3 text-body-sm">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={!file || running || phase === "queued"} onClick={() => void transfer()} className={buttonClass("primary", "w-full sm:w-auto")}>{phase === "queued" ? "Verification queued" : running ? "Transfer in progress…" : offset ? "Resume transfer" : "Start or resume transfer"}</button>{running && <button type="button" onClick={() => controller.current?.abort()} className={buttonClass("secondary", "w-full sm:w-auto")}>Pause</button>}{phase === "queued" && <button type="button" onClick={() => router.refresh()} className={buttonClass("secondary")}>Refresh processing status</button>}</div>
  </section>;
}
