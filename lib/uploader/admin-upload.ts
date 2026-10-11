import { z } from "zod";
import { SUPPORTED_EXTENSIONS } from "@/lib/ingestion/parser";
import { movieSnapshotSchema } from "@/lib/tmdb/ingestion-search";
import { DiscoveryStoreError, storeError, type DiscoveryRpc } from "@/lib/discovery/database";

// Browser staging has its own decimal limit; the existing Telegram limit is unchanged.
export const ADMIN_UPLOAD_MAX_BYTES = 2_000_000_000;
export const adminUploadStages = ["draft", "uploading", "verifying", "uploaded", "inspecting", "metadata_review", "awaiting_rights", "awaiting_approval", "approved", "telegram_queued", "telegram_uploading", "telegram_uncertain", "telegram_stored", "publishing", "published", "failed", "cancelled"] as const;
export type AdminUploadStage = (typeof adminUploadStages)[number];

export const uploadFileSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255).refine((name) => !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name), "Choose a plain filename.")
    .refine((name) => SUPPORTED_EXTENSIONS.includes(name.split(".").pop()!.toLowerCase()), "Unsupported video container."),
  sizeBytes: z.number().int().positive().max(ADMIN_UPLOAD_MAX_BYTES),
});

// A metadata payload deliberately has no rights, approval, owner or worker fields.
export const uploadMetadataSchema = z.strictObject({
  kind: z.enum(["movie", "series"]),
  title: z.string().trim().max(300),
  year: z.number().int().min(1870).max(2199).nullable(),
  vjId: z.number().int().positive().nullable(),
  snapshot: movieSnapshotSchema.nullable(),
  season: z.number().int().min(0).max(999).nullable(),
  episode: z.number().int().min(1).max(9999).nullable(),
  provenance: z.string().trim().max(2000),
});
export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;

export const emptyUploadMetadata: UploadMetadata = { kind: "movie", title: "", year: null, vjId: null, snapshot: null, season: null, episode: null, provenance: "" };

export const uploadSessionSchema = z.object({
  id: z.uuid(), source: z.literal("admin_upload"), owner_id: z.uuid(),
  storage: z.enum(["disk","r2"]).optional(),
  file_name: z.string(), size_bytes: z.number().int().positive().max(ADMIN_UPLOAD_MAX_BYTES),
  stage: z.enum(adminUploadStages), revision: z.number().int().positive(),
  metadata: uploadMetadataSchema, verified_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  bytes_received: z.number().int().nonnegative(), error_code: z.string().nullable(),
  retryable: z.boolean(), created_at: z.string(), updated_at: z.string(), expires_at: z.string(),
  pipeline:z.object({media_verified:z.boolean(),telegram_status:z.string(),rights_cleared:z.boolean(),rights_rejected:z.boolean(),rights_expires_at:z.string().nullable(),rights_reference:z.string().nullable(),approved:z.boolean(),cleanup_state:z.string().nullable(),cleanup_error:z.string().nullable(),publication_slug:z.string().nullable(),stored:z.boolean(),audit:z.array(z.object({action:z.string(),at:z.string(),revision:z.number().int()})).max(100)}).optional(),
  inspection: z.object({ choices: z.array(movieSnapshotSchema).max(20),proposed_tmdb_id: z.number().int().positive().nullable(),proposed_vj_id: z.number().int().positive().nullable().optional(),
    classification: z.object({ class: z.string(),reasons: z.array(z.string()),policyVersion: z.number().int() }),
  }).nullable().optional(),
});
export type UploadSession = z.infer<typeof uploadSessionSchema>;

/** Presentation only. PostgreSQL and authenticated worker commands authorize mutations. */
export function canEditUpload(stage: AdminUploadStage): boolean {
  return ["draft", "uploading", "metadata_review", "awaiting_rights", "awaiting_approval", "approved"].includes(stage);
}

export type UploadActor = "owner" | "worker" | "reviewer" | "rights" | "publisher";
export const uploadTransitions: Readonly<Partial<Record<AdminUploadStage, Readonly<Partial<Record<AdminUploadStage, UploadActor>>>>>> = {
  draft: { uploading: "owner", cancelled: "owner" },
  uploading: { verifying: "owner", cancelled: "owner" },
  verifying: { uploaded: "worker", failed: "worker", cancelled: "owner" },
  uploaded: { inspecting: "worker", cancelled: "owner" },
  inspecting: { metadata_review: "worker", failed: "worker" },
  metadata_review: { awaiting_rights: "reviewer", cancelled: "owner" },
  awaiting_rights: { awaiting_approval: "rights", metadata_review: "owner", cancelled: "owner" },
  awaiting_approval: { approved: "reviewer", metadata_review: "owner", cancelled: "owner" },
  approved: { telegram_queued: "worker", metadata_review: "owner", cancelled: "owner" },
  telegram_queued: { telegram_uploading: "worker", cancelled: "owner" },
  telegram_uploading: { telegram_stored: "worker", telegram_uncertain: "worker", failed: "worker" },
  // Cancellation/retry cannot pretend an ambiguous transfer never happened.
  telegram_uncertain: { telegram_stored: "worker", failed: "worker" },
  telegram_stored: { publishing: "publisher" },
  publishing: { published: "publisher", telegram_stored: "publisher" },
};
export function allowsUploadTransition(from: AdminUploadStage, to: AdminUploadStage, actor: UploadActor): boolean {
  return uploadTransitions[from]?.[to] === actor;
}

export function uploadReviewBlockers(metadata: UploadMetadata): string[] {
  const blockers: string[] = [];
  // Tables and parsers support series; publication/playback do not yet support this path.
  if (metadata.kind !== "movie") blockers.push("episode_publication_not_supported");
  if (!metadata.snapshot) blockers.push("identity_unconfirmed");
  if (!metadata.vjId) blockers.push("vj_unresolved");
  if (!metadata.provenance) blockers.push("provenance_required");
  return blockers;
}
import "server-only";

/** Same own-session RPC transport and sanitized errors as catalogue review. */
export function createUploadClient(rpc: DiscoveryRpc) {
  async function call(name: string, args: Record<string, unknown>) {
    let reply: Awaited<ReturnType<DiscoveryRpc>>;
    try { reply = await rpc(name, args); }
    catch { throw new DiscoveryStoreError("store_unavailable"); }
    if (reply.error) throw storeError(reply.error);
    return reply.data;
  }
  return {
    async create(input: z.infer<typeof uploadFileSchema>) {
      const file = uploadFileSchema.parse(input);
      return uploadSessionSchema.parse(await call("admin_upload_create", { p_file_name: file.fileName, p_size_bytes: file.sizeBytes }));
    },
    async createR2(input: z.infer<typeof uploadFileSchema>,requestId: string,retentionDays=7) {
      const file=uploadFileSchema.parse(input);
      return uploadSessionSchema.parse(await call("admin_upload_r2_create",{ p_file_name: file.fileName,p_size_bytes: file.sizeBytes,p_request_id: z.uuid().parse(requestId),p_retention_days:z.number().int().min(1).max(30).parse(retentionDays) }));
    },
    async r2(id: string,command: string,input: Record<string,unknown> = {}) {
      return call("admin_upload_r2_command",{ p_id: z.uuid().parse(id),p_command: command,p_input: input });
    },
    async review(id:string,revision:number,action:string,reference:string|null=null,expiresAt:string|null=null) {
      return uploadSessionSchema.parse(await call("admin_upload_r2_review",{p_id:z.uuid().parse(id),p_revision:z.number().int().positive().parse(revision),p_action:z.enum(["submit","reinspect","clear_rights","reject_rights","revoke_rights","approve","retry"]).parse(action),p_reference:reference,p_expires_at:expiresAt}));
    },
    async list() { return z.array(uploadSessionSchema).max(200).parse(await call("admin_upload_list", { p_limit: 200 })); },
    async get(id: string) { return uploadSessionSchema.parse(await call("admin_upload_get", { p_id: z.uuid().parse(id) })); },
    async edit(id: string, revision: number, metadata: UploadMetadata) {
      return uploadSessionSchema.parse(await call("admin_upload_edit", { p_id: z.uuid().parse(id), p_revision: z.number().int().positive().parse(revision), p_metadata: uploadMetadataSchema.parse(metadata) }));
    },
    async control(id: string, revision: number, action: "start" | "verify" | "cancel" | "retry") {
      return uploadSessionSchema.parse(await call("admin_upload_control", { p_id: z.uuid().parse(id), p_revision: z.number().int().positive().parse(revision), p_action: z.enum(["start", "verify", "cancel","retry"]).parse(action) }));
    },
  };
}
