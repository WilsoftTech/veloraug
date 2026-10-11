import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { z } from "zod";
import { diskManifestSchema, storeDiskChunk } from "@/lib/uploader/disk-transfer";
import { errorCode } from "@/lib/discovery/service";
import { inspectAdminUpload } from "@/lib/uploader/admin-inspection";

/** Local staging endpoint. It never polls Telegram or approves/publishes media. */
const config = z.object({
  VELORA_UPLOAD_DATABASE_URL: z.string().url(),
  VELORA_UPLOAD_STAGING_DIR: z.string().refine(isAbsolute),
  VELORA_UPLOAD_WEB_ORIGIN: z.string().url(),
  VELORA_UPLOAD_PORT: z.coerce.number().int().min(1024).max(65535).default(8791),
  VELORA_UPLOAD_INSPECTION_ENABLED: z.enum(["true","false"]).default("false"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
}).parse(process.env);
const origin = new URL(config.VELORA_UPLOAD_WEB_ORIGIN);
if (origin.origin !== config.VELORA_UPLOAD_WEB_ORIGIN || (origin.protocol !== "https:" && !["localhost","127.0.0.1","[::1]"].includes(origin.hostname))) throw new Error("upload_web_origin_invalid");
const databaseUrl = new URL(config.VELORA_UPLOAD_DATABASE_URL);
if (!/^velora_upload_worker(?:\.[a-z0-9]{10,40})?$/.test(decodeURIComponent(databaseUrl.username)) || !databaseUrl.password) throw new Error("upload_database_identity_invalid");
if (!["localhost","127.0.0.1","[::1]"].includes(databaseUrl.hostname) && databaseUrl.searchParams.get("sslmode")!=="verify-full") throw new Error("upload_database_tls_required");
const sql = postgres(config.VELORA_UPLOAD_DATABASE_URL,{ max: 4,prepare: false,connect_timeout: 5,onnotice: () => {},
  types: { safeBigint: { to: 20,from: [20],serialize: String,parse: (value: string) => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error("upload_integer_invalid"); return n; } } },
});
const identity = await sql`select current_user as role,r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication
  or pg_catalog.pg_has_role(current_user,'postgres','MEMBER') or pg_catalog.pg_has_role(current_user,'service_role','MEMBER') as elevated
  from pg_catalog.pg_roles r where r.rolname=current_user`;
if (identity.length !== 1 || identity[0].role !== "velora_upload_worker" || identity[0].elevated) throw new Error("upload_database_identity_invalid");
const ports = {
  async manifest(id: string,owner: string) {
    const rows = await sql`select public.admin_upload_worker_manifest(${id}::uuid,${owner}::uuid) as result`;
    return diskManifestSchema.parse(rows[0]?.result);
  },
  async commit(input: { id: string; owner: string; offset: number; size: number; key: string; sha256: string }) {
    const rows = await sql`select public.admin_upload_worker_chunk(${input.id}::uuid,${input.owner}::uuid,${input.offset}::bigint,${input.size}::integer,${input.key}::uuid,${input.sha256}::text) as result`;
    return z.number().int().nonnegative().parse(rows[0]?.result);
  },
};
let active = 0;
let stopping = false;
const server = createServer(async (request,response) => {
  const send = (status: number,body: unknown) => { if (!response.headersSent) response.writeHead(status,{ "content-type": "application/json","cache-control": "no-store" }); response.end(JSON.stringify(body)); };
  if (request.headers.origin !== config.VELORA_UPLOAD_WEB_ORIGIN) { send(403,{ error: "upload_origin_refused" }); return; }
  response.setHeader("Access-Control-Allow-Origin",config.VELORA_UPLOAD_WEB_ORIGIN);
  response.setHeader("Vary","Origin");
  response.setHeader("Access-Control-Expose-Headers","Upload-Offset");
  if (request.method === "OPTIONS") {
    response.writeHead(204,{ "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS","Access-Control-Allow-Headers": "Authorization,Content-Type,Upload-Offset" }); response.end(); return;
  }
  const match = /^\/uploads\/([0-9a-f-]{36})$/.exec(request.url ?? "");
  if (!match || !z.uuid().safeParse(match[1]).success || !["GET","PATCH"].includes(request.method ?? "")) { send(404,{ error: "upload_not_found" }); return; }
  if (active >= 4) { send(429,{ error: "upload_service_busy" }); return; }
  active++;
  try {
    const bearer = /^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(request.headers.authorization ?? "")?.[1];
    if (!bearer) { send(401,{ error: "upload_not_authorized" }); return; }
    const auth = createClient(config.NEXT_PUBLIC_SUPABASE_URL,config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,{ auth: { persistSession: false,autoRefreshToken: false } });
    const { data,error } = await auth.auth.getUser(bearer);
    if (error || !data.user || data.user.is_anonymous || data.user.app_metadata.role !== "admin") { send(401,{ error: "upload_not_authorized" }); return; }
    const id = match[1]; const owner = data.user.id;
    if (request.method === "GET") {
      const manifest = await ports.manifest(id,owner);
      response.setHeader("Upload-Offset",manifest.session.bytes_received);
      // Disk keys are private. Resuming clients compare the committed hashes
      // with their reselected file before sending the remaining bytes.
      send(200,{ offset: manifest.session.bytes_received,size: manifest.session.size_bytes,
        chunks: manifest.chunks.map(({ offset,size,sha256 }) => ({ offset,size,sha256 })) });
      return;
    }
    if (request.headers["content-type"] !== "application/octet-stream") { send(415,{ error: "upload_invalid_content_type" }); return; }
    const lengthText = request.headers["content-length"];
    const offsetText = request.headers["upload-offset"];
    if (typeof lengthText !== "string" || !/^\d{1,8}$/.test(lengthText) || typeof offsetText !== "string" || !/^\d{1,10}$/.test(offsetText)) { send(400,{ error: "upload_invalid_chunk" }); return; }
    const result = await storeDiskChunk(config.VELORA_UPLOAD_STAGING_DIR,{ id,owner,offset: Number(offsetText),length: Number(lengthText),body: request },ports);
    response.setHeader("Upload-Offset",result.offset);
    send(200,result);
  } catch (error) {
    const code = errorCode(error);
    const status = code === "upload_offset_conflict" ? 409 : code === "upload_not_authorized" ? 403 : code === "upload_disk_full" ? 507 : 400;
    send(status,{ error: code });
  } finally { active--; }
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(config.VELORA_UPLOAD_PORT,"127.0.0.1",() => process.stdout.write('{"event":"upload_staging_started"}\n'));
const inspectionPorts = {
  async claim(token: string) { return (await sql`select public.admin_upload_worker_claim(${token}::uuid) as result`)[0]?.result ?? null; },
  async finish(id: string,token: string,result: Record<string,unknown>) {
    const rows = await sql`select public.admin_upload_worker_finish(${id}::uuid,${token}::uuid,${sql.json(result as postgres.JSONValue)}::jsonb) as result`;
    return z.string().parse(rows[0]?.result);
  },
};
async function inspectionLoop() {
  while (!stopping) {
    try { if (await inspectAdminUpload(config.VELORA_UPLOAD_STAGING_DIR,inspectionPorts)) continue; }
    catch (failure) { process.stderr.write(JSON.stringify({ event: "upload_inspection_waiting",code: errorCode(failure) })+"\n"); }
    await new Promise((resolve) => setTimeout(resolve,1000));
  }
}
const processing = config.VELORA_UPLOAD_INSPECTION_ENABLED==="true" ? inspectionLoop() : Promise.resolve();
const stop = () => { stopping = true; server.close(() => { void processing.then(() => sql.end({ timeout: 5 })); }); server.closeIdleConnections(); };
process.once("SIGTERM",stop); process.once("SIGINT",stop);
