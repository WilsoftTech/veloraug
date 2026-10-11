import "server-only";
import { createHash,randomUUID } from "node:crypto";
import { mkdir,open,stat,statfs,unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { r2StateSchema,validateR2Head,type R2State } from "@/lib/uploader/r2-control";
import { expectedPartSize,type R2Storage } from "@/lib/uploader/r2";
import { verifiedUploadPath, existingVerifiedUploadPath, removeVerifiedUpload } from "@/lib/uploader/disk-transfer";
import { fingerprintFile,hashFile } from "@/lib/uploader/scan";
import { inspectAdminUpload } from "@/lib/uploader/admin-inspection";
import { mediaSchema,newJournalEntry,type Journal } from "@/lib/uploader/journal";
import { createRpcIngestionStore,type RpcTransport } from "@/lib/uploader/store";
import { isRealTelegramUploadAuthorized,uploadEntry,resumeEntry,type UploaderDeps,type StepResult } from "@/lib/uploader/upload";
import { buildUploadCaption } from "@/lib/ingestion/telegram";
import { isFingerprint } from "@/lib/ingestion/fingerprint";
import { errorCode } from "@/lib/discovery/service";

export const r2WorkerClaimSchema=r2StateSchema.extend({token:z.uuid(),operation:z.enum(["verify","inspect","telegram","recover","publish","cleanup"]),file_key:z.uuid().nullable(),fingerprint:z.string().nullable(),inspection:z.unknown().nullable(),vjs:z.array(z.object({id:z.number().int().positive(),slug:z.string(),name:z.string(),active:z.boolean()}))});
export type R2WorkerClaim=z.infer<typeof r2WorkerClaimSchema>;
export interface R2WorkerPorts {
  claim(token:string,operations:string[]):Promise<unknown>;
  finish(id:string,token:string,operation:string,result:Record<string,unknown>):Promise<string>;
  ingest(id:string,token:string,fn:string,args:Record<string,unknown>):Promise<unknown>;
}
export interface R2WorkerOptions {root:string;storage:R2Storage;ports:R2WorkerPorts;journal:Journal;uploader:Omit<UploaderDeps,"store"|"journal">;channelId:number;signal:AbortSignal;operations:string[]}

/** Full-file and per-part integrity, streamed to bounded private cloud disk. */
export async function downloadR2Verified(root:string,state:R2State,storage:R2Storage,key:string=randomUUID(),signal?:AbortSignal,legacyCache=false) {
  const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(60*60*1000)]);
  const head=await storage.head(state.reference); validateR2Head(state,head);
  if(state.parts.length!==Math.ceil(state.session.size_bytes/(8*1024*1024)) || state.parts.some((part,index)=>part.number!==index+1 || !part.etag || part.size!==expectedPartSize(state.session.size_bytes,part.number))) throw new Error("r2_upload_incomplete");
  await mkdir(root,{recursive:true,mode:0o700});
  const disk=await statfs(root);
  if(Number(disk.bavail)*Number(disk.bsize)<state.session.size_bytes+2*1024**3) throw new Error("upload_disk_full");
  const path=verifiedUploadPath(root,state.session.id,key,legacyCache ? undefined : state.session.file_name); const partial=`${path}.partial`;
  if(!legacyCache) await mkdir(join(root,`${state.session.id}.${key}`),{recursive:true,mode:0o700});
  const file=await open(partial,"wx",0o600); const hash=createHash("sha256"); let partHash=createHash("sha256");
  let total=0,partIndex=0,partBytes=0,complete=false;
  try {
    for await(const bytes of await storage.read(state.reference)) {
      deadline.throwIfAborted();
      if(bytes.byteLength>state.session.size_bytes-total) throw new Error("r2_size_mismatch");
      hash.update(bytes);
      let offset=0;
      while(offset<bytes.byteLength) {
        const part=state.parts[partIndex]; if(!part) throw new Error("r2_size_mismatch");
        const take=Math.min(bytes.byteLength-offset,part.size-partBytes); partHash.update(bytes.subarray(offset,offset+take));
        partBytes+=take;offset+=take;
        if(partBytes===part.size) { if(partHash.digest("hex")!==part.sha256) throw new Error("upload_source_checksum_mismatch"); partIndex++;partBytes=0;partHash=createHash("sha256"); }
      }
      let written=0;
      while(written<bytes.byteLength) { const reply=await file.write(bytes,written,bytes.byteLength-written,total+written); if(!reply.bytesWritten) throw new Error("upload_disk_write_failed"); written+=reply.bytesWritten; }
      total+=bytes.byteLength;
    }
    if(total!==state.session.size_bytes || partIndex!==state.parts.length) throw new Error("r2_size_mismatch");
    await file.sync();complete=true;
  } finally {await file.close();if(!complete) await removeVerifiedUpload(partial,root);}
  const {rename}=await import("node:fs/promises"); await rename(partial,path);
  return {path,key,sha256:hash.digest("hex"),size:total};
}
async function sourcePath(claim:R2WorkerClaim,options:R2WorkerOptions,preferredPath?:string):Promise<string> {
  if(!claim.file_key || !claim.session.verified_sha256) throw new Error("upload_verification_missing");
  const path=preferredPath ?? await existingVerifiedUploadPath(options.root,claim.session.id,claim.file_key,claim.session.file_name);
  let present=false; try {present=(await stat(path)).isFile();} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
  if(!present) {
    try{const partial=await stat(`${path}.partial`);if(partial.mtimeMs>Date.now()-3*60*60*1000)throw new Error("upload_local_recovery_wait");await unlink(`${path}.partial`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const result=await downloadR2Verified(options.root,claim,options.storage,claim.file_key,options.signal,path===verifiedUploadPath(options.root,claim.session.id,claim.file_key)); if(result.sha256!==claim.session.verified_sha256) throw new Error("upload_source_checksum_mismatch");
  }
  if(await hashFile(path,claim.session.size_bytes)!==claim.session.verified_sha256) throw new Error("upload_source_checksum_mismatch");
  return path;
}
async function telegramJob(claim:R2WorkerClaim,options:R2WorkerOptions):Promise<void> {
  if(!isRealTelegramUploadAuthorized()) throw new Error("telegram_uploads_not_authorized");
  if(!claim.fingerprint || !isFingerprint(claim.fingerprint) || !claim.file_key || claim.session.metadata.kind!=="movie") throw new Error("upload_identity_invalid");
  const fingerprint=claim.fingerprint;
  const rpc:RpcTransport=async(fn,args)=>{try{return{data:await options.ports.ingest(claim.session.id,claim.token,fn,args),error:null};}catch(error){return{data:null,error:{message:errorCode(error)}};}};
  const store=createRpcIngestionStore(rpc);
  let entry=await options.journal.get(fingerprint);
  if(!entry) {
    const inspection=claim.inspection as {classification?:unknown;media?:unknown;tools?:unknown} | null;
    const path=claim.operation==="recover" ? await existingVerifiedUploadPath(options.root,claim.session.id,claim.file_key!,claim.session.file_name) : await sourcePath(claim,options);
    entry={...newJournalEntry({fingerprint,kind:"movie",intendedChannelId:options.channelId,fileName:claim.session.file_name,relativePath:claim.session.id,absolutePath:path,sizeBytes:claim.session.size_bytes,modifiedAtMs:0,discoveryKey:fingerprint.slice(4)},new Date()),plan:{action:"upload",stopReasons:[]},media:mediaSchema.parse({role:"source",inspectedAt:claim.session.updated_at,tools:inspection?.tools,inspection:inspection?.media,classification:inspection?.classification,rendition:null,derivedFrom:null,normalizationFailure:null})};
    await options.journal.put(entry);
  }
  if(entry.intendedChannelId!==options.channelId || entry.sizeBytes!==claim.session.size_bytes || entry.fingerprint!==fingerprint || ![verifiedUploadPath(options.root,claim.session.id,claim.file_key,claim.session.file_name),verifiedUploadPath(options.root,claim.session.id,claim.file_key)].includes(entry.absolutePath)) throw new Error("upload_journal_conflict");
  const deps:UploaderDeps={...options.uploader,journal:options.journal,store};
  let step:StepResult;
  if(claim.operation==="telegram") {
    await sourcePath(claim,options,entry.absolutePath);
    const caption=buildUploadCaption({kind:"movie",title:claim.session.metadata.snapshot?.title ?? claim.session.metadata.title,year:claim.session.metadata.year,vjName:null,season:null,episode:null,fingerprint});
    const result=await uploadEntry(entry,caption,deps);
    step=result.result==="resume"?await resumeEntry((await options.journal.get(fingerprint))!,deps):result;
  } else step=await resumeEntry(entry,deps);
  const status=await store.getUploadStatus(fingerprint,"movie");
  if(status.status!=="uploaded" || status.record.fileSizeBytes!==claim.session.size_bytes || status.record.sourceFingerprint!==fingerprint) throw Object.assign(new Error(status.status==="uploading" || status.status==="uncertain" ? "telegram_outcome_uncertain" : "code" in step?step.code:"telegram_transfer_pending"),{retryable:step.result==="failed" && step.retryable});
  const stage=await options.ports.finish(claim.session.id,claim.token,claim.operation,{outcome:"stored"});
  if(stage!=="telegram_stored") throw new Error("upload_storage_not_persisted");
}
async function cleanupJob(claim:R2WorkerClaim,options:R2WorkerOptions) {
  // An expired/cancelled upload may still have unexpired part URLs. Abort the
  // MPU first. Only cloud-owned keys from this fenced claim are accessible.
  if(claim.reference.upload_id) await options.storage.abort(claim.reference);
  for(const orphan of await options.storage.abandoned()) if(orphan.key===claim.reference.key) await options.storage.abort({...claim.reference,upload_id:orphan.uploadId});
  await options.storage.remove(claim.reference);
  if(await options.storage.head(claim.reference)) throw new Error("r2_cleanup_not_confirmed");
  if(claim.file_key) { const path=await existingVerifiedUploadPath(options.root,claim.session.id,claim.file_key,claim.session.file_name);try{await removeVerifiedUpload(path,options.root);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;} }
  const stage=await options.ports.finish(claim.session.id,claim.token,"cleanup",{outcome:"cleaned"});
  if(!["telegram_stored","published","cancelled"].includes(stage)) throw new Error("r2_cleanup_not_confirmed");
}
/** Durable claim -> operation -> persistent readback. No HTTP movie receiver. */
export async function processR2Job(options:R2WorkerOptions):Promise<boolean> {
  if(options.signal.aborted) return false;
  const raw=await options.ports.claim(randomUUID(),options.operations);if(raw===null) return false;
  const claim=r2WorkerClaimSchema.parse(raw); const id=claim.session.id;
  try {
    if(claim.operation==="verify") {
      const result=await downloadR2Verified(options.root,claim,options.storage,undefined,options.signal);
      const fingerprint=await fingerprintFile(result.path,result.size);
      const stage=await options.ports.finish(id,claim.token,"verify",{outcome:"verified",sha256:result.sha256,size:result.size,file_key:result.key,fingerprint});
      if(stage!=="uploaded") throw new Error("upload_verification_not_persisted");
    } else if(claim.operation==="inspect") {
      await sourcePath(claim,options);
      await inspectAdminUpload(options.root,{claim:async()=>({manifest:{session:claim.session,chunks:[]},token:claim.token,operation:"inspect",verified_file_key:claim.file_key,vjs:claim.vjs}),finish:(id,token,result)=>options.ports.finish(id,token,"inspect",result)});
      // This is a disposable cloud cache. The verified private R2 object and
      // immutable hashes remain available throughout review and retries.
      if(claim.file_key)try{await removeVerifiedUpload(await existingVerifiedUploadPath(options.root,id,claim.file_key,claim.session.file_name),options.root);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    } else if(claim.operation==="telegram" || claim.operation==="recover") await telegramJob(claim,options);
    else if(claim.operation==="cleanup") await cleanupJob(claim,options);
    else {
      if(await options.ports.finish(id,claim.token,"publish",{outcome:"publish"})!=="published") throw new Error("upload_publication_not_persisted");
    }
  } catch(error) {
    const code=errorCode(error);
    try{await options.ports.finish(id,claim.token,claim.operation,{outcome:"failed",code,retryable:(error as {retryable?:unknown})?.retryable===true});}
    catch{console.warn(JSON.stringify({event:"r2_job_reconciliation_required",operation:claim.operation,code}));}
  }
  return true;
}
