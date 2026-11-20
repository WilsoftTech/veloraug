import "server-only";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createR2Client } from "@/lib/uploader/r2";
import { POSTER_MAX_BYTES, POSTER_WIDTHS, POSTER_PATH } from "@/lib/artwork";
function configuration(env: Readonly<Record<string,string|undefined>>) {
  const bucket = env.R2_POSTER_BUCKET_NAME;
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || bucket === env.R2_BUCKET_NAME) throw new Error("poster_storage_not_configured");
  return { client: createR2Client(env), bucket };
}
export function postersConfigured(env: Readonly<Record<string,string|undefined>> = process.env): boolean {
  try { configuration(env); return true; } catch { return false; }
}
/** Decode, strip metadata, bound pixels, then encode every stored variant as actual WebP. */
export async function encodePoster(bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > POSTER_MAX_BYTES) throw new Error("poster_file_too_large");
  const image = sharp(bytes, { failOn: "warning", limitInputPixels: 24_000_000, animated: false });
  const info = await image.metadata();
  if (!info.width || !info.height || info.width < 120 || info.height < 120 || (info.pages ?? 1) > 1 || !["jpeg","png","webp"].includes(info.format ?? "")) throw new Error("poster_image_invalid");
  const variants = [];
  for (const width of POSTER_WIDTHS) {
    const data = await image.clone().rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer();
    variants.push({ width, data });
  }
  return variants;
}
export async function storePoster(file: File, env: Readonly<Record<string,string|undefined>> = process.env): Promise<string> {
  const {client,bucket} = configuration(env);
  if (!["image/jpeg","image/png","image/webp"].includes(file.type) || !file.size || file.size > POSTER_MAX_BYTES) throw new Error("poster_image_invalid");
  const variants = await encodePoster(new Uint8Array(await file.arrayBuffer()));
  const id = randomUUID();
  try {
    for (const variant of variants) await client.send(new PutObjectCommand({ Bucket: bucket, Key: `posters/${id}/${variant.width}.webp`, Body: variant.data, ContentType: "image/webp", CacheControl: "public, max-age=31536000, immutable" }));
  } catch { throw new Error("poster_upload_failed"); }
  return `/posters/${id}.webp`;
}
export async function removePoster(path: string, env: Readonly<Record<string,string|undefined>> = process.env) {
  const match = POSTER_PATH.exec(path); if (!match) throw new Error("poster_path_invalid");
  const {client,bucket} = configuration(env);
  await Promise.all(POSTER_WIDTHS.map(width => client.send(new DeleteObjectCommand({Bucket:bucket,Key:`posters/${match[1]}/${width}.webp`}))));
}
export async function readPoster(id: string, width: number, env: Readonly<Record<string,string|undefined>> = process.env) {
  if (!POSTER_PATH.test(`/posters/${id}.webp`) || !POSTER_WIDTHS.some(size => size === width)) throw new Error("poster_path_invalid");
  const {client,bucket} = configuration(env);
  try {
    const result = await client.send(new GetObjectCommand({ Bucket:bucket, Key:`posters/${id}/${width}.webp` }));
    if (!result.Body || result.ContentType !== "image/webp" || !result.ContentLength || result.ContentLength > POSTER_MAX_BYTES) throw new Error("poster_object_invalid");
    return { bytes:new Uint8Array(await result.Body.transformToByteArray()), etag:result.ETag };
  } catch (error) { if (["NoSuchKey","NotFound"].includes((error as {name?:string}).name ?? "")) return null; throw new Error("poster_storage_unavailable"); }
}
