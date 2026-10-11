/** Browser-only multipart orchestration. No SDK, storage keys or permanent credentials. */
const PART_BYTES=8*1024*1024;
interface Part { number: number; size: number; sha256: string; etag: string | null }
interface Status { complete: boolean;size: number;bytes: number;parts: Part[] }
interface BrowserPorts {
  fetch(input: RequestInfo | URL,init?: RequestInit): Promise<Response>;
  digest(bytes: ArrayBuffer): Promise<ArrayBuffer>;
  sleep(ms: number,signal: AbortSignal): Promise<void>;
  now(): number;
}
const browserPorts: BrowserPorts={fetch:(...args)=>fetch(...args),digest:(bytes)=>crypto.subtle.digest("SHA-256",bytes),now:()=>performance.now(),sleep:(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted) { reject(new DOMException("Paused","AbortError")); return; }
  const abort=()=>{clearTimeout(timer);reject(new DOMException("Paused","AbortError"));};
  const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
  signal.addEventListener("abort",abort,{once:true});
})};
export async function uploadR2FromBrowser(file: File,endpoint: string,options: { signal: AbortSignal;parallelism: number;progress(bytes: number,speed: number): void },ports: BrowserPorts=browserPorts): Promise<void> {
  const {signal}=options;
  const parallel=Math.max(1,Math.min(4,Math.floor(options.parallelism)||1));
  async function call(input: object) {
    const reply=await ports.fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),signal});
    if(!reply.ok) throw new Error("Upload control failed. Resume to recover committed parts.");
    return reply.json() as Promise<unknown>;
  }
  function status(value: unknown): Status {
    const raw=value as Partial<Status> | null;
    if(!raw || typeof raw.complete!=="boolean" || raw.size!==file.size || !Number.isSafeInteger(raw.bytes) || !Array.isArray(raw.parts) || raw.parts.length>239) throw new Error("Upload progress is inconsistent.");
    const seen=new Set<number>();
    for(const part of raw.parts) {
      if(!Number.isInteger(part.number) || part.number<1 || part.number>Math.ceil(file.size/PART_BYTES) || seen.has(part.number) || part.size!==Math.min(PART_BYTES,file.size-(part.number-1)*PART_BYTES) || !/^[a-f0-9]{64}$/.test(part.sha256) || (part.etag!==null && typeof part.etag!=="string")) throw new Error("Upload progress is inconsistent.");
      seen.add(part.number);
    }
    if(raw.bytes!==raw.parts.filter((p)=>p.etag!==null).reduce((sum,p)=>sum+p.size,0)) throw new Error("Upload progress is inconsistent.");
    return raw as Status;
  }
  const initial=status(await call({command:"status"}));
  options.progress(initial.bytes,0);
  if(initial.complete) { options.progress(file.size,0); return; }
  const known=new Map(initial.parts.map((part)=>[part.number,part]));
  async function hash(number: number) {
    signal.throwIfAborted();
    const bytes=await file.slice((number-1)*PART_BYTES,number*PART_BYTES).arrayBuffer();
    return Array.from(new Uint8Array(await ports.digest(bytes)),value=>value.toString(16).padStart(2,"0")).join("");
  }
  // Compare every previously reserved hash, including parts whose PUT failed.
  for(const part of initial.parts) if(await hash(part.number)!==part.sha256) throw new Error("This is a different file. Create a new draft.");
  const pending=Array.from({length:Math.ceil(file.size/PART_BYTES)},(_,i)=>i+1).filter(number=>!known.get(number)?.etag);
  let committed=initial.bytes; const started=ports.now();
  for(let offset=0;offset<pending.length;offset+=parallel) {
    const batch=pending.slice(offset,offset+parallel);
    const outcomes=await Promise.allSettled(batch.map(async number=>{
      const sha256=known.get(number)?.sha256 ?? await hash(number);
      for(let attempt=0;attempt<4;attempt++) {
        signal.throwIfAborted();
        try {
          // Each retry obtains a fresh short-lived URL; never persist URLs.
          const signed=await call({command:"sign",number,sha256}) as {url?:unknown;size?:unknown};
          if(typeof signed.url!=="string" || !signed.url.startsWith("https://") || signed.size!==Math.min(PART_BYTES,file.size-(number-1)*PART_BYTES)) throw new Error("Invalid upload capability.");
          const response=await ports.fetch(signed.url,{method:"PUT",body:file.slice((number-1)*PART_BYTES,number*PART_BYTES),signal,credentials:"omit"});
          if(!response.ok) throw new Error("Part upload failed.");
          return;
        } catch(error) { if(signal.aborted || attempt===3) throw error; await ports.sleep(2100*2**attempt,signal); }
      }
    }));
    const current=status(await call({command:"status"}));
    committed=current.bytes;
    options.progress(committed,(committed-initial.bytes)/Math.max(1,(ports.now()-started)/1000));
    const failure=outcomes.find((outcome)=>outcome.status==="rejected");
    if(failure?.status==="rejected") throw failure.reason;
  }
  const completed=status(await call({command:"complete"}));
  if(!completed.complete) throw new Error("Upload completion is not confirmed. Resume to reconcile it.");
  options.progress(file.size,0);
}
