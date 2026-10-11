import { createHash,randomUUID } from "node:crypto";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach,describe,expect,it,vi } from "vitest";
import { assembleDiskUpload,diskChunkPath,storeDiskChunk,type DiskManifest } from "./disk-transfer";
import { emptyUploadMetadata } from "./admin-upload";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir,{ recursive: true,force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(),"velora-upload-")); dirs.push(root);
  const manifest: DiskManifest = { session: { id: randomUUID(),owner_id: randomUUID(),source: "admin_upload",file_name: "movie.mp4",size_bytes: 3,stage: "uploading",revision: 1,metadata: emptyUploadMetadata,verified_sha256: null,bytes_received: 0,error_code: null,retryable: false,created_at: new Date().toISOString(),updated_at: new Date().toISOString(),expires_at: new Date(Date.now()+3600000).toISOString() },chunks: [] };
  const ports = { manifest: vi.fn(async () => structuredClone(manifest)),commit: vi.fn(async (input: { offset: number; size: number; key: string; sha256: string }) => {
    manifest.chunks.push({ offset: input.offset,size: input.size,key: input.key,sha256: input.sha256 }); manifest.session.bytes_received = input.offset+input.size; return manifest.session.bytes_received;
  }) };
  async function* body() { yield Buffer.from("abc"); }
  const input = { id: manifest.session.id,owner: manifest.session.owner_id,offset: 0,length: 3,body: body() };
  return { root,manifest,ports,input };
}
describe("durable disk staging", () => {
  it("commits only fsynced complete chunks and reconstructs their full checksum", async () => {
    const { root,manifest,ports,input } = await setup();
    const result = await storeDiskChunk(root,input,ports);
    expect(result.offset).toBe(3);
    expect(result.sha256).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(await readFile(diskChunkPath(root,manifest.chunks[0].key),"utf8")).toBe("abc");
    const assembled = await assembleDiskUpload(root,manifest);
    expect(await readFile(assembled.path,"utf8")).toBe("abc");
    expect(assembled.sha256).toBe(result.sha256);
  });
  it("does not advance the database offset for an interrupted or oversized body", async () => {
    const { root,ports,input } = await setup();
    async function* short() { yield Buffer.from("a"); }
    await expect(storeDiskChunk(root,{ ...input,body: short() },ports)).rejects.toThrow("upload_chunk_incomplete");
    async function* oversized() { yield Buffer.from("abcd"); }
    await expect(storeDiskChunk(root,{ ...input,body: oversized() },ports)).rejects.toThrow("upload_chunk_overflow");
    expect(ports.commit).not.toHaveBeenCalled();
  });
  it("retains a complete chunk after an ambiguous database reply", async () => {
    const { root,manifest,ports,input } = await setup();
    const commit = ports.commit.getMockImplementation()!;
    ports.commit.mockImplementation(async (value) => { await commit(value); throw new Error("lost reply"); });
    await expect(storeDiskChunk(root,input,ports)).rejects.toThrow("lost reply");
    expect(await readFile(diskChunkPath(root,manifest.chunks[0].key),"utf8")).toBe("abc");
    expect((await ports.manifest()).session.bytes_received).toBe(3);
  });
  it("rejects gaps, changed bytes, foreign offsets and unsafe storage keys", async () => {
    const { root,manifest,ports,input } = await setup();
    await expect(storeDiskChunk(root,{ ...input,offset: 1 },ports)).rejects.toThrow("upload_offset_conflict");
    await storeDiskChunk(root,input,ports);
    manifest.chunks[0].offset = 1;
    await expect(assembleDiskUpload(root,manifest)).rejects.toThrow("upload_manifest_gap");
    manifest.chunks[0].offset = 0;
    await writeFile(diskChunkPath(root,manifest.chunks[0].key),"bad");
    await expect(assembleDiskUpload(root,manifest)).rejects.toThrow("upload_chunk_corrupt");
    expect(() => diskChunkPath(root,"../movie.mp4")).toThrow();
  });
});
