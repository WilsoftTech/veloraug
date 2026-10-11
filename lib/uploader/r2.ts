import "server-only";
import { S3Client,CreateMultipartUploadCommand,UploadPartCommand,ListPartsCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,HeadObjectCommand,GetObjectCommand,DeleteObjectCommand,ListMultipartUploadsCommand,ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

export const R2_PART_BYTES = 8 * 1024 * 1024;
export const R2_URL_SECONDS = 300;
export const r2PartSchema = z.strictObject({ number: z.number().int().min(1).max(239),size: z.number().int().positive().max(R2_PART_BYTES),etag: z.string().min(1).max(200) });
export type R2Part = z.infer<typeof r2PartSchema>;
export const r2ReferenceSchema = z.object({ id: z.uuid(),bucket: z.literal("velora-uploads-staging"),key: z.string().regex(/^admin-uploads\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/media$/),upload_id: z.string().min(1).max(2048).nullable(),etag: z.string().max(200).nullable(),size: z.number().int().positive().max(2_000_000_000) });
export type R2Reference = z.infer<typeof r2ReferenceSchema>;
export interface R2Head { size: number; etag: string; uploadId: string | null; expectedSize: string | null }
export interface R2Storage {
  create(ref: R2Reference): Promise<string>;
  sign(ref: R2Reference,part: number,size: number): Promise<string>;
  list(ref: R2Reference): Promise<R2Part[]>;
  complete(ref: R2Reference,parts: R2Part[]): Promise<void>;
  head(ref: R2Reference): Promise<R2Head | null>;
  read(ref: R2Reference): Promise<AsyncIterable<Uint8Array>>;
  abort(ref: R2Reference): Promise<void>;
  remove(ref: R2Reference): Promise<void>;
  abandoned(): Promise<{ key: string; uploadId: string; initiated: Date }[]>;
  inventory(): Promise<{ key: string; size: number }[]>;
}
export function expectedPartSize(size: number,number: number): number {
  if (!Number.isSafeInteger(size) || size<1 || size>2_000_000_000 || !Number.isInteger(number) || number<1 || number>Math.ceil(size/R2_PART_BYTES)) throw new Error("r2_part_invalid");
  return Math.min(R2_PART_BYTES,size-(number-1)*R2_PART_BYTES);
}
export function validateR2Parts(size: number,parts: R2Part[]): void {
  if (parts.length!==Math.ceil(size/R2_PART_BYTES)) throw new Error("r2_upload_incomplete");
  parts.forEach((part,index) => { r2PartSchema.parse(part); if (part.number!==index+1 || part.size!==expectedPartSize(size,part.number)) throw new Error("r2_upload_incomplete"); });
}
const missing = (error: unknown) => ["NotFound","NoSuchKey","NoSuchUpload"].includes((error as { name?: string })?.name ?? "");

/** Credentials and SDK stay on the server. Callers supply only database-owned references. */
export function createR2Storage(env: Readonly<Record<string,string|undefined>> = process.env): R2Storage {
  const config = z.object({ R2_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),R2_ACCESS_KEY_ID: z.string().min(16),R2_SECRET_ACCESS_KEY: z.string().min(16),R2_BUCKET_NAME: z.literal("velora-uploads-staging"),R2_ENDPOINT: z.string().url() }).safeParse(env);
  if (!config.success) throw new Error("r2_configuration_invalid");
  const endpoint = new URL(config.data.R2_ENDPOINT);
  if (endpoint.protocol!=="https:" || ![`${config.data.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,`${config.data.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,`${config.data.R2_ACCOUNT_ID}.fedramp.r2.cloudflarestorage.com`].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname!=="/") throw new Error("r2_configuration_invalid");
  const client = new S3Client({ region: "auto",endpoint: endpoint.origin,credentials: { accessKeyId: config.data.R2_ACCESS_KEY_ID,secretAccessKey: config.data.R2_SECRET_ACCESS_KEY },maxAttempts: 3,requestHandler:{connectionTimeout:5000,requestTimeout:15000,throwOnRequestTimeout:true,socketTimeout:30000},requestChecksumCalculation: "WHEN_REQUIRED",responseChecksumValidation: "WHEN_REQUIRED" });
  const target = (raw: R2Reference) => { const ref=r2ReferenceSchema.parse(raw); return { Bucket: ref.bucket,Key: ref.key }; };
  const multipart = (ref: R2Reference) => { if (!ref.upload_id) throw new Error("r2_multipart_missing"); return { ...target(ref),UploadId: ref.upload_id }; };
  async function safe<T>(operation: () => Promise<T>): Promise<T> { try { return await operation(); } catch (error) { if (missing(error)) throw new Error("r2_object_missing"); throw new Error("r2_storage_unavailable"); } }
  return {
    async create(ref) { return safe(async () => { const reply=await client.send(new CreateMultipartUploadCommand({ ...target(ref),ContentType: "application/octet-stream",CacheControl: "private, no-store",Metadata: { "velora-upload": ref.id,"velora-size": String(ref.size) } })); if (!reply.UploadId) throw new Error("r2_bad_reply"); return reply.UploadId; }); },
    async sign(ref,part,size) { if (size!==expectedPartSize(ref.size,part)) throw new Error("r2_part_invalid"); return safe(() => getSignedUrl(client,new UploadPartCommand({ ...multipart(ref),PartNumber: part,ContentLength: size }),{ expiresIn: R2_URL_SECONDS })); },
    async list(ref) { return safe(async () => { const reply=await client.send(new ListPartsCommand({ ...multipart(ref),MaxParts: 1000 })); if (reply.IsTruncated) throw new Error("r2_parts_overflow"); return (reply.Parts ?? []).map((part) => r2PartSchema.parse({ number: part.PartNumber,size: part.Size,etag: part.ETag })).sort((a,b) => a.number-b.number); }); },
    async complete(ref,parts) { validateR2Parts(ref.size,parts); await safe(() => client.send(new CompleteMultipartUploadCommand({ ...multipart(ref),MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.number,ETag: part.etag })) } }))); },
    async head(ref) { try { const reply=await client.send(new HeadObjectCommand(target(ref))); if (!reply.ETag || !Number.isSafeInteger(reply.ContentLength)) throw new Error("r2_bad_reply"); return { size: reply.ContentLength!,etag: reply.ETag,uploadId: reply.Metadata?.["velora-upload"] ?? null,expectedSize: reply.Metadata?.["velora-size"] ?? null }; } catch(error) { if (missing(error)) return null; throw new Error("r2_storage_unavailable"); } },
    async read(ref) { return safe(async () => { if (!ref.etag) throw new Error("r2_etag_missing"); const reply=await client.send(new GetObjectCommand({ ...target(ref),IfMatch: ref.etag })); if (!reply.Body || !(Symbol.asyncIterator in reply.Body)) throw new Error("r2_bad_reply"); return reply.Body as AsyncIterable<Uint8Array>; }); },
    async abort(ref) { try { await client.send(new AbortMultipartUploadCommand(multipart(ref))); } catch(error) { if (!missing(error)) throw new Error("r2_storage_unavailable"); } },
    async remove(ref) { await safe(() => client.send(new DeleteObjectCommand(target(ref)))); },
    async abandoned() { return safe(async () => { const reply=await client.send(new ListMultipartUploadsCommand({ Bucket: config.data.R2_BUCKET_NAME,Prefix: "admin-uploads/",MaxUploads: 1000 })); if (reply.IsTruncated) throw new Error("r2_orphan_scan_truncated"); return (reply.Uploads ?? []).flatMap((upload) => upload.Key && upload.UploadId && upload.Initiated ? [{ key: upload.Key,uploadId: upload.UploadId,initiated: upload.Initiated }] : []); }); },
    async inventory() { return safe(async () => { const reply=await client.send(new ListObjectsV2Command({Bucket:config.data.R2_BUCKET_NAME,Prefix:"admin-uploads/",MaxKeys:1000}));if(reply.IsTruncated)throw new Error("r2_orphan_scan_truncated");return (reply.Contents??[]).map(item=>z.object({key:z.string().min(1),size:z.number().int().nonnegative()}).parse({key:item.Key,size:item.Size})); }); },
  };
}
