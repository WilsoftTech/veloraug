import { describe,it,expect,vi,afterEach } from "vitest";
import { createHash,randomUUID } from "node:crypto";
import { mkdtemp,readFile,readdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeR2Upload,resumeR2Upload,signR2Part,type R2ControlPorts,type R2State } from "./r2-control";
import { createR2Storage,expectedPartSize,validateR2Parts,R2_PART_BYTES,type R2Storage } from "./r2";
import { downloadR2Verified,processR2Job,type R2WorkerOptions } from "./r2-worker";
import { emptyUploadMetadata } from "./admin-upload";
import { uploadR2FromBrowser } from "./r2-browser";
import { validatePlayback,type Runner } from "./media-tools";
import { openJournal,newJournalEntry } from "./journal";
import { canonicalInspection,sourceMedia } from "./test-media";
import { verifiedUploadPath } from "./disk-transfer";
import type { SourceFingerprint } from "@/types/ingestion";

const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
afterEach(()=>vi.unstubAllEnvs());
function fixture(bytes=Buffer.from("abc")):R2State {
  const id=randomUUID();return{session:{id,source:"admin_upload",owner_id:randomUUID(),storage:"r2",file_name:"movie.mp4",size_bytes:bytes.length,stage:"uploading",revision:1,metadata:emptyUploadMetadata,verified_sha256:null,bytes_received:bytes.length,error_code:null,retryable:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString()},reference:{id,bucket:"velora-uploads-staging",key:`admin-uploads/${randomUUID()}/${randomUUID()}/media`,upload_id:"mpu",etag:null,size:bytes.length},state:"open",init_token:null,init_until:null,parts:[{number:1,size:bytes.length,etag:"opaque-etag",sha256:sha(bytes)}]};
}
function storage(state:R2State,bytes=Buffer.from("abc")):R2Storage {
  return{create:vi.fn(async()=>"mpu"),sign:vi.fn(async()=>"https://r2.example/part"),list:vi.fn(async()=>state.parts.map(p=>({number:p.number,size:p.size,etag:p.etag!}))),complete:vi.fn(async()=>{}),head:vi.fn(async()=>({size:state.reference.size,etag:"opaque-final-2",uploadId:state.session.id,expectedSize:String(state.reference.size)})),read:vi.fn(async()=> (async function*(){yield bytes.subarray(0,1);yield bytes.subarray(1);})()),abort:vi.fn(async()=>{}),remove:vi.fn(async()=>{}),abandoned:vi.fn(async()=>[]),inventory:vi.fn(async()=>[])};
}
function controls(state:R2State):R2ControlPorts {
  return{command:vi.fn(async(_id,command,input={})=>{
    if(command==="begin"){state.init_token=String(input.token);state.init_until=new Date().toISOString();}
    if(command==="attach")state.reference.upload_id=String(input.upload_id);
    if(command==="complete_requested")state.state="completing";
    if(command==="completed"){state.state="complete";state.reference.etag=String(input.etag);}
    return structuredClone(state);
  })};
}
describe("R2 control and integrity",()=>{
  it("uses canonical compliant chunks and the decimal maximum",()=>{
    expect(expectedPartSize(2_000_000_000,239)).toBe(2_000_000_000-238*R2_PART_BYTES);
    expect(()=>expectedPartSize(2_000_000_001,1)).toThrow();
    expect(()=>validateR2Parts(R2_PART_BYTES+1,[{number:1,size:R2_PART_BYTES-1,etag:"opaque"},{number:2,size:2,etag:"opaque"}])).toThrow();
    expect(()=>createR2Storage({R2_ACCOUNT_ID:"a".repeat(32),R2_ACCESS_KEY_ID:"x".repeat(16),R2_SECRET_ACCESS_KEY:"y".repeat(16),R2_BUCKET_NAME:"velora-uploads-staging",R2_ENDPOINT:"https://attacker.example"})).toThrow("r2_configuration_invalid");
  });
  it("completes once and accepts opaque multipart ETags",async()=>{
    const state=fixture(),sdk=storage(state),db=controls(state);
    expect((await completeR2Upload(state.session.id,db,sdk)).state).toBe("complete");
    await completeR2Upload(state.session.id,db,sdk);expect(sdk.complete).toHaveBeenCalledTimes(1);
  });
  it("reconciles a lost provider completion response",async()=>{
    const state=fixture(),sdk=storage(state);sdk.complete=vi.fn(async()=>{throw new Error("r2_storage_unavailable");});
    expect((await completeR2Upload(state.session.id,controls(state),sdk)).state).toBe("complete");
  });
  it("recovers a lost DB acknowledgement using HEAD without issuing completion twice",async()=>{
    const state=fixture();state.state="completing";const sdk=storage(state);
    expect((await resumeR2Upload(state.session.id,controls(state),sdk)).state).toBe("complete");expect(sdk.complete).not.toHaveBeenCalled();expect(sdk.list).not.toHaveBeenCalled();
  });
  it("refuses a foreign object and incomplete provider part list",async()=>{
    const state=fixture(),sdk=storage(state);state.state="completing";
    sdk.head=vi.fn(async()=>({size:3,etag:"other",uploadId:randomUUID(),expectedSize:"3"}));
    await expect(completeR2Upload(state.session.id,controls(state),sdk)).rejects.toThrow("r2_object_mismatch");
    state.state="open";sdk.list=vi.fn(async()=>[]);await expect(completeR2Upload(state.session.id,controls(state),sdk)).rejects.toThrow("r2_upload_incomplete");
  });
  it("reserves immutable source integrity before issuing a signed URL",async()=>{
    const state=fixture(),db=controls(state),sdk=storage(state);await signR2Part(state.session.id,1,state.parts[0].sha256,db,sdk);
    expect(db.command).toHaveBeenCalledWith(state.session.id,"reserve_part",{number:1,sha256:state.parts[0].sha256});expect(sdk.sign).toHaveBeenCalledWith(state.reference,1,3);
  });
  it("preserves the original MKV name in R2 disk staging and supports historical cache paths explicitly",async()=>{
    const state=fixture();state.state="complete";state.reference.etag="opaque-final-2";state.session.file_name="Original VJ Junior.MKV";
    const bytes=Buffer.from("abc"),dir=await mkdtemp(join(tmpdir(),"velora-r2-name-"));
    try {
      const original=await downloadR2Verified(dir,state,storage(state,bytes));
      expect(original.path.endsWith("Original VJ Junior.MKV")).toBe(true);
      expect(await readFile(original.path)).toEqual(bytes);
      const historical=await downloadR2Verified(dir,state,storage(state,bytes),randomUUID(),undefined,true);
      expect(historical.path.endsWith(".verified.mp4")).toBe(true);
      expect(await readFile(historical.path)).toEqual(bytes);
      expect(original.sha256).toBe(historical.sha256);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it.each(["valid","corrupt","truncated","overflow"])("streams %s content with whole-file and part integrity",async(mode)=>{
    const state=fixture();state.state="complete";state.reference.etag="opaque-final-2";
    const bytes=Buffer.from(mode==="corrupt"?"abd":mode==="truncated"?"ab":mode==="overflow"?"abcd":"abc");
    const dir=await mkdtemp(join(tmpdir(),"velora-r2-test-"));
    try{
      if(mode==="valid"){const result=await downloadR2Verified(dir,state,storage(state,bytes));expect(result.sha256).toBe(sha(bytes));expect(await readFile(result.path)).toEqual(bytes);}
      else {await expect(downloadR2Verified(dir,state,storage(state,bytes))).rejects.toThrow();expect(await readdir(dir)).toEqual([]);}
    } finally{await rm(dir,{recursive:true,force:true});}
  });
  it("rejects a corrupted decode and bounds full decode time",async()=>{
    const run=vi.fn<Runner>(async()=>({code:1,stdout:"",stderrTail:"invalid packet",timedOut:false}));
    await expect(validatePlayback({path:"ffmpeg",version:"test",source:"path"},"private-file",run)).rejects.toThrow("upload_media_corrupt");
    expect(run.mock.calls[0][1]).toContain("-xerror");expect(run.mock.calls[0][2].timeoutMs).toBe(3600000);
  });
});

describe("R2 worker persistent recovery",()=>{
  async function worker(operation:"cleanup"|"recover"="cleanup") {
    const state=fixture();state.state="complete";state.reference.etag="opaque-final-2";state.session.stage=operation==="recover"?"telegram_uncertain":"telegram_stored";
    const root=await mkdtemp(join(tmpdir(),"velora-r2-job-")),journal=await openJournal(join(root,"journal"));
    const key=randomUUID(),fingerprint=`sf1-${"d".repeat(64)}` as SourceFingerprint;
    const entry=newJournalEntry({fingerprint,kind:"movie",intendedChannelId:-1001111111111,fileName:"movie.mp4",relativePath:state.session.id,absolutePath:verifiedUploadPath(root,state.session.id,key),sizeBytes:3,modifiedAtMs:0,discoveryKey:"d".repeat(64)},new Date());entry.media=sourceMedia(canonicalInspection(3));await journal.put(entry);
    const claim={...state,token:randomUUID(),operation,file_key:key,fingerprint,inspection:null,vjs:[]};
    const sdk=storage(state);sdk.head=vi.fn(async()=>null);
    const unavailable=vi.fn(async()=>{throw new Error("must_not_send");});
    const options:R2WorkerOptions={root,storage:sdk,journal,signal:new AbortController().signal,operations:[operation],channelId:-1001111111111,
      ports:{claim:vi.fn(async()=>claim),finish:vi.fn(async()=>"telegram_stored"),ingest:vi.fn(async()=>[{upload_state:"uploaded",upload_attempt_count:1,upload_failure_code:null,needs_review:false,chat_id:-1001111111111,message_id:11,file_id:"receipt",file_unique_id:"unique",media_kind:"document",file_name:"movie.mp4",mime_type:"video/mp4",caption:`velora-src:${fingerprint}`,file_size_bytes:3,duration_seconds:null,width:null,height:null,telegram_date:new Date().toISOString(),upload_started_at:null,upload_age_seconds:null,upload_floor_message_id:10}])},
      uploader:{telegram:{preflight:unavailable,sendDocument:unavailable,checkRecoveryAccess:unavailable,postRecoveryMarker:unavailable,probeChannelMessage:unavailable},fingerprintSource:unavailable,channelHighWater:async()=>10,now:()=>new Date(),sleep:async()=>{}}};
    return{options,sdk,claim,fingerprint,root};
  }
  it("cleans only the claimed database-owned key and confirms deletion",async()=>{
    const {options,sdk,claim,root}=await worker();try{expect(await processR2Job(options)).toBe(true);expect(sdk.remove).toHaveBeenCalledWith(claim.reference);expect(options.ports.finish).toHaveBeenCalledWith(claim.session.id,claim.token,"cleanup",{outcome:"cleaned"});}finally{await rm(root,{recursive:true,force:true});}
  });
  it("cleanup failures remain retryable without a false cleaned acknowledgement",async()=>{
    const {options,sdk,root}=await worker();sdk.remove=vi.fn(async()=>{throw new Error("r2_storage_unavailable");});try{await processR2Job(options);expect(options.ports.finish).toHaveBeenCalledWith(expect.any(String),expect.any(String),"cleanup",expect.objectContaining({outcome:"failed",code:"r2_storage_unavailable"}));expect(options.ports.finish).not.toHaveBeenCalledWith(expect.anything(),expect.anything(),"cleanup",{outcome:"cleaned"});}finally{await rm(root,{recursive:true,force:true});}
  });
  it("a crash after DB receipt recording recovers without downloading or sending again",async()=>{
    vi.stubEnv("REAL_TELEGRAM_UPLOADS_AUTHORIZED","true");const {options,sdk,root,fingerprint}=await worker("recover");try{await processR2Job(options);expect(options.uploader.telegram.sendDocument).not.toHaveBeenCalled();expect(sdk.read).not.toHaveBeenCalled();expect((await options.journal.get(fingerprint))?.telegram?.messageId).toBe(11);expect(options.ports.finish).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),"recover",{outcome:"stored"});}finally{await rm(root,{recursive:true,force:true});}
  });
  it("lost storage-state acknowledgement retains the Telegram journal and R2 source",async()=>{
    vi.stubEnv("REAL_TELEGRAM_UPLOADS_AUTHORIZED","true");const {options,sdk,root,fingerprint}=await worker("recover");options.ports.finish=vi.fn(async()=>{throw new Error("store_unavailable");});const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    try{await processR2Job(options);expect((await options.journal.get(fingerprint))?.telegram?.fileId).toBe("receipt");expect(sdk.remove).not.toHaveBeenCalled();expect(options.uploader.telegram.sendDocument).not.toHaveBeenCalled();}finally{warn.mockRestore();await rm(root,{recursive:true,force:true});}
  });
});

describe("browser R2 recovery",()=>{
  function browser(bytes:Uint8Array,existing:boolean,failPut=false){
    const file=new File([bytes as BlobPart],"movie.mp4");const digest=sha(bytes);let stored=existing,puts=0,signs=0,completed=false;
    const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      if(init?.method==="PUT"){puts++;if(failPut && puts===1)return new Response(null,{status:403});stored=true;return new Response(null,{status:200});}
      const request=JSON.parse(String(init?.body));
      if(request.command==="sign"){signs++;return Response.json({url:`https://r2.example/part?attempt=${signs}`,size:bytes.length});}
      if(request.command==="complete")completed=true;
      return Response.json({complete:completed,size:bytes.length,bytes:stored?bytes.length:0,parts:existing||stored?[{number:1,size:bytes.length,sha256:digest,etag:stored?"opaque":null}]:[]});
    });
    return{file,fetch,digest:async(buffer:ArrayBuffer)=>new Uint8Array(Buffer.from(sha(new Uint8Array(buffer)),"hex")).buffer,sleep:vi.fn(async()=>{}),now:()=>1000,counts:()=>({puts,signs,completed})};
  }
  it("uploads directly and refreshes expired signed URLs on retry",async()=>{
    const ports=browser(Buffer.from("abc"),false,true);await uploadR2FromBrowser(ports.file,"/control",{signal:new AbortController().signal,parallelism:3,progress:vi.fn()},ports);
    expect(ports.counts()).toEqual({puts:2,signs:2,completed:true});expect(ports.fetch.mock.calls.filter(call=>call[1]?.method==="PUT").every(call=>call[1]?.credentials==="omit")).toBe(true);
  });
  it("refresh recovery skips already uploaded parts",async()=>{
    const ports=browser(Buffer.from("abc"),true);await uploadR2FromBrowser(ports.file,"/control",{signal:new AbortController().signal,parallelism:2,progress:vi.fn()},ports);expect(ports.counts().puts).toBe(0);expect(ports.counts().completed).toBe(true);
  });
  it("rejects a same-size reselected file with different bytes",async()=>{
    const ports=browser(Buffer.from("abc"),true);await expect(uploadR2FromBrowser(new File(["abd"],"movie.mp4"),"/control",{signal:new AbortController().signal,parallelism:2,progress:vi.fn()},ports)).rejects.toThrow("different file");expect(ports.counts().puts).toBe(0);
  });
  it("pause aborts before issuing a part upload",async()=>{
    const ports=browser(Buffer.from("abc"),false),controller=new AbortController();controller.abort();await expect(uploadR2FromBrowser(ports.file,"/control",{signal:controller.signal,parallelism:2,progress:vi.fn()},ports)).rejects.toThrow();expect(ports.counts().puts).toBe(0);
  });
  it("retains successful parallel parts across an interrupted batch and browser restart",async()=>{
    const file=new File([new Uint8Array(2*R2_PART_BYTES+1)],"movie.mp4");
    const parts=new Map<number,{number:number;size:number;sha256:string;etag:string|null}>();
    const puts=new Map<number,number>();let broken=true,complete=false,active=0,peak=0;
    const ports={now:()=>1000,sleep:async()=>{},digest:async(bytes:ArrayBuffer)=>new Uint8Array(Buffer.from(sha(new Uint8Array(bytes)),"hex")).buffer,
      fetch:async(url:RequestInfo|URL,init?:RequestInit)=>{
        if(init?.method==="PUT"){
          const number=Number(new URL(String(url)).pathname.slice(1));puts.set(number,(puts.get(number)??0)+1);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
          if(broken && number===2)return new Response(null,{status:503});parts.get(number)!.etag=`opaque-${number}`;return new Response(null,{status:200});
        }
        const input=JSON.parse(String(init?.body));
        if(input.command==="sign"){
          const size=expectedPartSize(file.size,input.number);const known=parts.get(input.number);if(known && known.sha256!==input.sha256)throw new Error("source_changed");
          if(!known)parts.set(input.number,{number:input.number,size,sha256:input.sha256,etag:null});
          return Response.json({url:`https://r2.example/${input.number}`,size});
        }
        if(input.command==="complete")complete=true;
        return Response.json({complete,size:file.size,bytes:[...parts.values()].filter(p=>p.etag).reduce((sum,p)=>sum+p.size,0),parts:[...parts.values()].sort((a,b)=>a.number-b.number)});
      }};
    const options={signal:new AbortController().signal,parallelism:2,progress:vi.fn()};
    await expect(uploadR2FromBrowser(file,"/control",options,ports)).rejects.toThrow();expect(parts.get(1)?.etag).toBe("opaque-1");expect(complete).toBe(false);
    broken=false;await uploadR2FromBrowser(file,"/control",options,ports);
    expect(puts.get(1)).toBe(1);expect(parts.size).toBe(3);expect(peak).toBe(2);expect(complete).toBe(true);
  });
});
