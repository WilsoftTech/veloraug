"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DiscoveryStoreError } from "@/lib/discovery/database";
import { emptyUploadMetadata } from "@/lib/uploader/admin-upload";
import { uploadClient } from "@/lib/uploader/admin-runtime";
import { listVjs } from "@/lib/catalogue";
import { publishedMoviePaths } from "@/lib/utils";

export async function createUploadAction(_previous: { error: string }, data: FormData): Promise<{ error: string }> {
  let id: string;
  try {
    const client=await uploadClient();
    const input={ fileName: String(data.get("fileName") ?? ""), sizeBytes: Number(data.get("sizeBytes")) };
    const session = process.env.VELORA_UPLOAD_STORAGE === "r2" ? await client.createR2(input,String(data.get("requestId") ?? ""),Number(process.env.VELORA_UPLOAD_RETENTION_DAYS??7)) : await client.create(input);
    id = session.id;
  } catch (error) {
    const code = error instanceof DiscoveryStoreError ? error.code : "upload_invalid_file";
    return { error: code === "upload_quota_exceeded" ? "Staging quota is full. Cancel and clean up an old upload before starting another." : "Could not create a draft. Check the file and your upload permission." };
  }
  revalidatePath("/admin/uploads");
  redirect(`/admin/uploads/${id}`);
}

export async function saveUploadAction(data: FormData): Promise<void> {
  const id = z.uuid().parse(data.get("id"));
  let result = "saved";
  try {
    const client = await uploadClient();
    const session = await client.get(id);
    const yearText = String(data.get("year") ?? "").trim();
    const vjText = String(data.get("vjId") ?? "").trim();
    const tmdbText = String(data.get("tmdbId") ?? "").trim();
    const snapshot = tmdbText ? session.inspection?.choices.find((choice) => choice.tmdb_id===Number(tmdbText)) : null;
    if (tmdbText && !snapshot) throw new Error("upload_identity_unavailable");
    await client.edit(id, Number(data.get("revision")), { ...emptyUploadMetadata, ...session.metadata,
      kind: z.enum(["movie","series"]).parse(data.get("kind")), title: String(data.get("title") ?? ""),
      year: yearText ? Number(yearText) : null, vjId: vjText ? Number(vjText) : null,
      provenance: String(data.get("provenance") ?? ""),
      snapshot: snapshot ?? null,
    });
  } catch { result = "blocked"; }
  revalidatePath("/admin/uploads");
  redirect(`/admin/uploads/${id}?result=${result}`);
}

export async function cancelUploadAction(data: FormData): Promise<void> {
  const id = z.uuid().parse(data.get("id"));
  let result = "cancelled";
  try { await (await uploadClient()).control(id,Number(data.get("revision")),"cancel"); }
  catch { result = "blocked"; }
  revalidatePath("/admin/uploads");
  redirect(`/admin/uploads/${id}?result=${result}`);
}

export async function retryUploadAction(data: FormData): Promise<void> {
  const id = z.uuid().parse(data.get("id"));
  let result="retrying";
  try { const client=await uploadClient();const session=await client.get(id);if(session.storage==="r2")await client.review(id,Number(data.get("revision")),"retry");else await client.control(id,Number(data.get("revision")),"retry"); }
  catch { result="blocked"; }
  revalidatePath("/admin/uploads");
  redirect(`/admin/uploads/${id}?result=${result}`);
}

export async function reviewUploadAction(data:FormData):Promise<void> {
  const id=z.uuid().parse(data.get("id"));let result="saved";
  try {
    const client=await uploadClient();
    const expires=String(data.get("expiresAt")??"");
    await client.review(id,Number(data.get("revision")),String(data.get("action")),String(data.get("reference")??"")||null,expires?new Date(expires).toISOString():null);
  } catch {result="blocked";}
  revalidatePath("/admin/uploads");redirect(`/admin/uploads/${id}?result=${result}`);
}

/**
 * Refreshes the cached public pages that list or show the movie this session
 * published (they otherwise refresh within five minutes). The slug is read back
 * from the catalogue through the owner's own session, and the VJ from the public
 * read: an unpublished, unapproved or foreign session refreshes nothing.
 */
export async function refreshUploadPagesAction(data: FormData): Promise<void> {
  const id = z.uuid().parse(data.get("id"));
  let result = "blocked";
  try {
    const session = await (await uploadClient()).get(id);
    const slug = session.stage === "published" && session.pipeline?.approved ? session.pipeline.publication_slug : null;
    if (slug) {
      const vj = (await listVjs()).find((item) => item.id === session.metadata.vjId);
      for (const path of publishedMoviePaths(slug, vj?.slug ?? null)) revalidatePath(path);
      result = "refreshed";
    }
  } catch { result = "blocked"; }
  revalidatePath("/admin/uploads");
  redirect(`/admin/uploads/${id}?result=${result}`);
}
