import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { uploadSessionSchema } from "@/lib/uploader/admin-upload";
import { expectedPartSize,r2ReferenceSchema,validateR2Parts,type R2Storage,type R2Head } from "@/lib/uploader/r2";

export const r2StateSchema = z.object({ session: uploadSessionSchema,reference: r2ReferenceSchema,state: z.enum(["pending","open","completing","complete","cleaning","cleaned"]),init_token: z.uuid().nullable(),init_until: z.string().nullable(),parts: z.array(z.strictObject({ number: z.number().int().min(1).max(239),size: z.number().int().positive().max(8*1024*1024),sha256: z.string().regex(/^[a-f0-9]{64}$/),etag: z.string().max(200).nullable() })).max(239) });
export type R2State = z.infer<typeof r2StateSchema>;
export type R2Command = "state" | "begin" | "attach" | "reserve_part" | "observe" | "complete_requested" | "completed";
export interface R2ControlPorts { command(id: string,command: R2Command,input?: Record<string,unknown>): Promise<R2State> }
export function validateR2Head(state: R2State,head: R2Head | null): asserts head is R2Head {
  if (!head || head.size!==state.reference.size || head.uploadId!==state.session.id || head.expectedSize!==String(state.reference.size) || (state.reference.etag && head.etag!==state.reference.etag)) throw new Error("r2_object_mismatch");
}
/** Reconcile an uncertain CompleteMultipartUpload before considering any retry. */
export async function completeR2Upload(id: string,ports: R2ControlPorts,storage: R2Storage): Promise<R2State> {
  let state=await ports.command(id,"state");
  if (["complete","cleaning","cleaned"].includes(state.state)) return state;
  if (state.state==="completing") {
    const head=await storage.head(state.reference);
    if (head) { validateR2Head(state,head); return ports.command(id,"completed",{ etag: head.etag }); }
  }
  const parts=await storage.list(state.reference);
  validateR2Parts(state.reference.size,parts);
  state=await ports.command(id,"observe",{ parts });
  state=await ports.command(id,"complete_requested");
  try { await storage.complete(state.reference,parts); }
  catch (error) {
    // R2 may have accepted completion even if its response disappeared.
    const head=await storage.head(state.reference);
    if (!head) throw error;
    validateR2Head(state,head);
    return ports.command(id,"completed",{ etag: head.etag });
  }
  const head=await storage.head(state.reference);
  validateR2Head(state,head);
  return ports.command(id,"completed",{ etag: head.etag });
}
export async function resumeR2Upload(id: string,ports: R2ControlPorts,storage: R2Storage): Promise<R2State> {
  let state=await ports.command(id,"state");
  if (state.state==="completing") return completeR2Upload(id,ports,storage);
  if (["complete","cleaning","cleaned"].includes(state.state)) return state;
  if (!state.reference.upload_id) {
    const token=randomUUID();
    state=await ports.command(id,"begin",{ token });
    if (!state.reference.upload_id) {
      const uploadId=await storage.create(state.reference);
      // A lost DB acknowledgement retains the MPU; an orphan reconciliation
      // checks its database-owned key before aborting it later.
      state=await ports.command(id,"attach",{ token,upload_id: uploadId });
    }
  }
  return ports.command(id,"observe",{ parts: await storage.list(state.reference) });
}
export async function signR2Part(id: string,number: number,sha256: string,ports: R2ControlPorts,storage: R2Storage) {
  const state=await ports.command(id,"reserve_part",{ number,sha256 });
  const size=expectedPartSize(state.reference.size,number);
  return { url: await storage.sign(state.reference,number,size),expiresIn: 300,number,size };
}
