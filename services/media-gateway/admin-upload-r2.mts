import { createServer } from "node:http";
import { stat,readdir,unlink } from "node:fs/promises";
import { isAbsolute,join } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { createR2Storage,r2ReferenceSchema } from "@/lib/uploader/r2";
import { processR2Job,type R2WorkerPorts } from "@/lib/uploader/r2-worker";
import { openJournal } from "@/lib/uploader/journal";
import { fingerprintFile } from "@/lib/uploader/scan";
import { createLocalBotApiClient,loadLocalBotApiConfig } from "@/lib/telegram/local-bot-api";
import { longRunningFetch } from "@/lib/telegram/long-running-fetch";
import { errorCode } from "@/lib/discovery/service";
import { storeError } from "@/lib/discovery/database";

// A separate cloud process; never receives browser file bodies or consumes
// channel getUpdates. The discovery listener keeps its existing ownership.
async function main():Promise<void> {
const config=z.object({
  VELORA_R2_WORKER_ENABLED:z.literal("true"),
  VELORA_UPLOAD_DATABASE_URL:z.string().url(),
  VELORA_UPLOAD_STAGING_DIR:z.string().refine(isAbsolute),
  VELORA_UPLOAD_JOURNAL_DIR:z.string().refine(isAbsolute),
  VELORA_R2_WORKER_PORT:z.coerce.number().int().min(1024).max(65535).default(8792),
  REAL_TELEGRAM_UPLOADS_AUTHORIZED:z.enum(["true","false"]).default("false"),
}).parse(process.env);
const url=new URL(config.VELORA_UPLOAD_DATABASE_URL);
if(!/^velora_upload_worker(?:\.[a-z0-9]{10,40})?$/.test(decodeURIComponent(url.username)) || !url.password) throw new Error("upload_database_identity_invalid");
if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname) && url.searchParams.get("sslmode")!=="verify-full") throw new Error("upload_database_tls_required");
const sql=postgres(config.VELORA_UPLOAD_DATABASE_URL,{max:2,prepare:false,connect_timeout:5,onnotice:()=>{},types:{safeBigint:{to:20,from:[20],serialize:String,parse:(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new Error("upload_integer_invalid");return n;}}}});
const identity=await sql`select current_user as role,r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication
  or pg_catalog.pg_has_role(current_user,'postgres','MEMBER') or pg_catalog.pg_has_role(current_user,'service_role','MEMBER') as elevated
  from pg_catalog.pg_roles r where r.rolname=current_user`;
if(identity.length!==1 || identity[0].role!=="velora_upload_worker" || identity[0].elevated) throw new Error("upload_database_identity_invalid");
const ports:R2WorkerPorts={
  async claim(token,operations){return (await sql`select public.admin_upload_r2_worker_claim(${token}::uuid,${operations}::text[]) as result`.catch(error=>{throw storeError(error);}))[0]?.result ?? null;},
  async finish(id,token,operation,result){return z.string().parse((await sql`select public.admin_upload_r2_worker_finish(${id}::uuid,${token}::uuid,${operation}::text,${sql.json(result as postgres.JSONValue)}::jsonb) as result`.catch(error=>{throw storeError(error);}))[0]?.result);},
  async ingest(id,token,fn,args){return (await sql`select public.admin_upload_r2_worker_ingest(${id}::uuid,${token}::uuid,${fn}::text,${sql.json(args as postgres.JSONValue)}::jsonb) as result`.catch(error=>{throw storeError(error);}))[0]?.result;},
};
const journal=await openJournal(config.VELORA_UPLOAD_JOURNAL_DIR);
const telegramConfig=loadLocalBotApiConfig(process.env);
// Verification/cleanup can run before authorizing Telegram rollout. No
// transfer or publication jobs are claimed until the real-send gate is on.
if(config.REAL_TELEGRAM_UPLOADS_AUTHORIZED==="true" && !telegramConfig.ok) throw new Error("telegram_configuration_invalid");
const offlineFetch=(async()=>{throw new Error("telegram_uploads_not_authorized");}) as typeof fetch;
const fallback={baseUrl:"http://127.0.0.1:8081",bots:{movie:{token:"",channelId:0,local:null},series:{token:"",channelId:0,local:null}},reconcileChatId:null,pathMap:null};
const telegram=createLocalBotApiClient(telegramConfig.ok?telegramConfig.config:fallback,{fetch:telegramConfig.ok?fetch:offlineFetch,mediaFetch:telegramConfig.ok?longRunningFetch:offlineFetch,stat:async(path)=>{const facts=await stat(path);return{isFile:facts.isFile(),size:facts.size};},uploadTimeoutMs:4*60*60*1000,requestTimeoutMs:60_000});
const operations=config.REAL_TELEGRAM_UPLOADS_AUTHORIZED==="true"?["verify","inspect","recover","telegram","publish","cleanup"]:["verify","inspect","cleanup"];
const controller=new AbortController();
let stopping=false,active=false,activeSince=0,lastSuccess=Date.now(),lastError:string|null=null;
const health=createServer((req,res)=>{if(req.url!=="/health"){res.writeHead(404).end();return;}const healthy=!stopping && (active?Date.now()-activeSince<6*60*60*1000:Date.now()-lastSuccess<120_000);res.writeHead(healthy?200:503,{"content-type":"application/json"});res.end(JSON.stringify({healthy,active,lastError}));});
health.listen(config.VELORA_R2_WORKER_PORT,"127.0.0.1");
const storage=createR2Storage();
async function housekeeping() {
  const command=async(name:string,input:Record<string,unknown>={})=>(await sql`select public.admin_upload_r2_housekeeping(${name}::text,${sql.json(input as postgres.JSONValue)}::jsonb) as result`)[0]?.result;
  const metrics=await command("metrics");process.stdout.write(JSON.stringify({event:"r2_worker_metrics",metrics})+"\n");
  const objects=await storage.inventory();let untrackedObjects=0;
  for(const object of objects)if(await command("object_tracked",{key:object.key,size:object.size})!==true)untrackedObjects++;
  // Inventory is diagnostic only: unknown or unexpected completed objects
  // must be retained for manual review, never deleted by age or guessed ownership.
  process.stdout.write(JSON.stringify({event:"r2_object_inventory",objects:objects.length,bytes:objects.reduce((total,object)=>total+object.size,0),untrackedObjects})+"\n");
  for(const orphan of await storage.abandoned()) {
    const ref=await command("orphan_multipart",{key:orphan.key,uploadId:orphan.uploadId,initiated:orphan.initiated.toISOString()});
    if(ref)await storage.abort(r2ReferenceSchema.parse(ref));
    else if(orphan.initiated.getTime()<Date.now()-86400_000)process.stderr.write('{"event":"r2_orphan_retained_for_review"}\n');
  }
  const files=await readdir(config.VELORA_UPLOAD_STAGING_DIR).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return[];throw error;});
  for(const name of files) {
    const match=/^([a-f0-9-]{36})\.([a-f0-9-]{36})\.verified\.mp4(?:\.partial)?$/.exec(name);
    if(!match || !z.uuid().safeParse(match[1]).success || !z.uuid().safeParse(match[2]).success)continue;
    const path=join(config.VELORA_UPLOAD_STAGING_DIR,name);const facts=await stat(path);
    if(facts.isFile() && facts.mtimeMs<Date.now()-86400_000 && await command("orphan_local",{id:match[1],key:match[2]})===true)await unlink(path);
  }
}
let maintenanceAt=0;
process.stdout.write('{"event":"r2_worker_started"}\n');
const stop=()=>{stopping=true;health.close();};
process.once("SIGTERM",stop);process.once("SIGINT",stop);
try {
  while(!stopping){
    let processed=false;
    if(Date.now()-maintenanceAt>3600_000){maintenanceAt=Date.now();try{await housekeeping();}catch(error){process.stderr.write(JSON.stringify({event:"r2_maintenance_retry",code:errorCode(error)})+"\n");}}
    try {active=true;activeSince=Date.now();processed=await processR2Job({root:config.VELORA_UPLOAD_STAGING_DIR,storage,ports,journal,channelId:telegramConfig.ok?telegramConfig.config.bots.movie.channelId:0,signal:controller.signal,operations,
      uploader:{telegram,fingerprintSource:fingerprintFile,async channelHighWater(kind){return Math.max(0,...(await journal.list()).filter(e=>e.kind===kind && e.telegram).map(e=>e.telegram!.messageId));},now:()=>new Date(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))}});lastSuccess=Date.now();lastError=null;}
    catch(error){lastError=errorCode(error);process.stderr.write(JSON.stringify({event:"r2_worker_waiting",code:lastError})+"\n");}
    finally{active=false;}
    if(!processed && !stopping)await new Promise(resolve=>setTimeout(resolve,2000));
  }
} finally {controller.abort();await sql.end({timeout:5});health.close();}
}
void main().catch(error=>{process.stderr.write(JSON.stringify({event:"r2_worker_startup_refused",code:errorCode(error)})+"\n",()=>process.exit(1));});
