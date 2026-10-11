import "server-only";
import { z } from "zod";
import { uploadClient } from "@/lib/uploader/admin-runtime";
import { createR2Storage } from "@/lib/uploader/r2";
import { completeR2Upload,resumeR2Upload,signR2Part,r2StateSchema,type R2State,type R2ControlPorts } from "@/lib/uploader/r2-control";
import { errorCode } from "@/lib/discovery/service";

const inputSchema=z.discriminatedUnion("command",[
  z.strictObject({ command: z.literal("status") }),
  z.strictObject({ command: z.literal("complete") }),
  z.strictObject({ command: z.literal("sign"),number: z.number().int().min(1).max(239),sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
async function readControl(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]!=="application/json" || !request.body) throw new Error("upload_invalid_input");
  const reader=request.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
  try { for (;;) { const { value,done }=await reader.read(); if (done) break; size+=value.byteLength; if (size>4096) { await reader.cancel(); throw new Error("upload_control_too_large"); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size); let offset=0; for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return inputSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
const browserState=(state: R2State) => ({ complete: ["complete","cleaning","cleaned"].includes(state.state),size: state.session.size_bytes,
  parts: state.parts,bytes: state.parts.filter((part)=>part.etag!==null).reduce((sum,part)=>sum+part.size,0) });

export async function r2UploadResponse(request: Request,id: string): Promise<Response> {
  const headers={ "Cache-Control":"no-store" };
  try {
    const client=await uploadClient();
    const input=await readControl(request);
    const storage=createR2Storage();
    const ports: R2ControlPorts={ command: async (id,command,data={})=>r2StateSchema.parse(await client.r2(id,command,data)) };
    if (input.command==="sign") return Response.json(await signR2Part(id,input.number,input.sha256,ports,storage),{headers});
    const state=input.command==="complete" ? await completeR2Upload(id,ports,storage) : await resumeR2Upload(id,ports,storage);
    return Response.json(browserState(state),{headers});
  } catch(error) {
    const code=errorCode(error);
    const status=["upload_not_authorized","review_not_authorized","admin_uploads_disabled"].includes(code)?403:code==="upload_control_too_large"?413:code==="r2_initialization_busy" || code==="r2_signing_rate_limited" ? 429 : code==="r2_storage_unavailable" ? 503 : 400;
    return Response.json({error:code},{status,headers});
  }
}
