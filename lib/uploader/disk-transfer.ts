import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rmdir, stat, statfs, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { uploadSessionSchema, uploadFileSchema } from "@/lib/uploader/admin-upload";

export const DISK_CHUNK_BYTES = 8 * 1024 * 1024;
export const diskManifestSchema = z.strictObject({ session: uploadSessionSchema, chunks: z.array(z.strictObject({
  offset: z.number().int().nonnegative(), size: z.number().int().positive().max(DISK_CHUNK_BYTES), key: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
})).max(2000) });
export type DiskManifest = z.infer<typeof diskManifestSchema>;

/** Storage keys come from this service, never filenames, URLs or browser metadata. */
export function diskChunkPath(root: string, key: string): string {
  if (!isAbsolute(root)) throw new Error("upload_staging_root_invalid");
  return join(root,`${z.uuid().parse(key)}.chunk`);
}

export interface DiskChunkPorts {
  manifest(id: string, owner: string): Promise<DiskManifest>;
  commit(input: { id: string; owner: string; offset: number; size: number; key: string; sha256: string }): Promise<number>;
}

/**
 * Bounded streaming into an immutable chunk. fsync+rename precedes database
 * commit. A lost DB reply retains the chunk for manifest reconciliation; it
 * must not be deleted on an ambiguous commit result.
 */
export async function storeDiskChunk(root: string, input: { id: string; owner: string; offset: number; length: number; body: AsyncIterable<Uint8Array> }, ports: DiskChunkPorts) {
  const manifest = await ports.manifest(input.id,input.owner);
  const { session } = manifest;
  if (session.stage !== "uploading" || Date.parse(session.expires_at) <= Date.now()) throw new Error("upload_illegal_transition");
  if (!Number.isSafeInteger(input.offset) || input.offset !== session.bytes_received) throw new Error("upload_offset_conflict");
  if (!Number.isSafeInteger(input.length) || input.length !== Math.min(DISK_CHUNK_BYTES,session.size_bytes-input.offset) || input.length <= 0) throw new Error("upload_invalid_chunk");
  await mkdir(root,{ recursive: true, mode: 0o700 });
  const disk = await statfs(root);
  // Keep room for assembly/normalization and other processes; never trust a DB
  // reservation as proof of physical capacity.
  if (Number(disk.bavail) * Number(disk.bsize) < input.length + 2 * 1024 ** 3) throw new Error("upload_disk_full");
  const key = randomUUID();
  const path = diskChunkPath(root,key);
  const partial = `${path}.partial`;
  const file = await open(partial,"wx",0o600);
  let received = 0;
  let completed = false;
  const hash = createHash("sha256");
  try {
    for await (const chunk of input.body) {
      if (chunk.byteLength > input.length - received) throw new Error("upload_chunk_overflow");
      hash.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await file.write(chunk,written,chunk.byteLength-written,received+written);
        if (!result.bytesWritten) throw new Error("upload_disk_write_failed");
        written += result.bytesWritten;
      }
      received += chunk.byteLength;
    }
    if (received !== input.length) throw new Error("upload_chunk_incomplete");
    await file.sync();
    completed = true;
  } finally {
    await file.close();
    if (!completed) await unlink(partial);
  }
  await rename(partial,path);
  const sha256 = hash.digest("hex");
  const offset = await ports.commit({ id: input.id,owner: input.owner,offset: input.offset,size: received,key,sha256 });
  if (offset !== input.offset + received) throw new Error("upload_commit_inconsistent");
  return { offset,sha256 };
}

/** Assemble only the persisted contiguous manifest and rehash every chunk. */
export function verifiedUploadPath(root: string,id: string,key: string,fileName?: string): string {
  if (!isAbsolute(root)) throw new Error("upload_staging_root_invalid");
  const prefix = `${z.uuid().parse(id)}.${z.uuid().parse(key)}`;
  if (fileName === undefined) return join(root,`${prefix}.verified.mp4`); // historical cache
  const name = uploadFileSchema.shape.fileName.parse(fileName);
  if (name !== fileName || /[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("upload_filename_invalid");
  return join(root,prefix,name);
}
export async function assembleDiskUpload(root: string, manifest: DiskManifest): Promise<{ path: string; sha256: string; key: string }> {
  const parsed = diskManifestSchema.parse(manifest);
  if (parsed.session.bytes_received !== parsed.session.size_bytes) throw new Error("upload_incomplete");
  const disk = await statfs(root);
  if (Number(disk.bavail) * Number(disk.bsize) < parsed.session.size_bytes + 2 * 1024 ** 3) throw new Error("upload_disk_full");
  const key = randomUUID();
  const output = verifiedUploadPath(root,parsed.session.id,key,parsed.session.file_name);
  await mkdir(join(root,`${parsed.session.id}.${key}`),{ recursive: true, mode: 0o700 });
  const file = await open(output,"wx",0o600);
  const hash = createHash("sha256");
  let offset = 0;
  let completed = false;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (const chunk of parsed.chunks) {
      if (chunk.offset !== offset) throw new Error("upload_manifest_gap");
      const sourcePath = diskChunkPath(root,chunk.key);
      if ((await stat(sourcePath)).size !== chunk.size) throw new Error("upload_chunk_corrupt");
      const source = await open(sourcePath,"r");
      const chunkHash = createHash("sha256");
      let position = 0;
      try {
        while (position < chunk.size) {
          const { bytesRead } = await source.read(buffer,0,Math.min(buffer.length,chunk.size-position),position);
          if (!bytesRead) throw new Error("upload_chunk_corrupt");
          const bytes = buffer.subarray(0,bytesRead);
          hash.update(bytes); chunkHash.update(bytes);
          let written = 0;
          while (written < bytesRead) {
            const result = await file.write(bytes,written,bytesRead-written,offset+position+written);
            if (!result.bytesWritten) throw new Error("upload_disk_write_failed");
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
      } finally { await source.close(); }
      if (chunkHash.digest("hex") !== chunk.sha256) throw new Error("upload_chunk_corrupt");
      offset += chunk.size;
    }
    if (offset !== parsed.session.size_bytes) throw new Error("upload_manifest_gap");
    await file.sync(); completed = true;
    return { path: output,sha256: hash.digest("hex"),key };
  } finally { await file.close(); if (!completed) await removeVerifiedUpload(output,root); }
}

/** Resolve a historical cache without renaming or replacing its bytes. */
export async function existingVerifiedUploadPath(root: string, id: string, key: string, fileName: string): Promise<string> {
  const path = verifiedUploadPath(root, id, key, fileName);
  try { await stat(path); return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const historical = verifiedUploadPath(root, id, key);
  try { await stat(historical); return historical; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path;
}

export async function removeVerifiedUpload(path: string, root: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (dirname(path) !== root) {
    try { await rmdir(dirname(path)); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
}
