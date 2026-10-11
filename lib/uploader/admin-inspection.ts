import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assembleDiskUpload,diskManifestSchema,verifiedUploadPath } from "@/lib/uploader/disk-transfer";
import { fingerprintFile,hashFile } from "@/lib/uploader/scan";
import { probeMedia,resolveMediaTools,validatePlayback } from "@/lib/uploader/media-tools";
import { classifyMedia } from "@/lib/ingestion/media";
import { parseFilename } from "@/lib/ingestion/parser";
import { decideMatch } from "@/lib/ingestion/match";
import { resolveVj } from "@/lib/ingestion/vj";
import { fetchMovieSnapshot,searchTmdbForIngestion } from "@/lib/tmdb/ingestion-search";
import { errorCode } from "@/lib/discovery/service";
import { evaluationPayload } from "@/lib/uploader/store";

export const uploadInspectionClaimSchema = z.strictObject({ manifest: diskManifestSchema,token: z.uuid(),operation: z.enum(["verify","inspect"]),verified_file_key: z.uuid().nullable(),
  vjs: z.array(z.strictObject({ id: z.number().int().positive(),slug: z.string(),name: z.string(),active: z.boolean() })).max(1000).default([]),
});
export interface UploadInspectionPorts {
  claim(token: string): Promise<unknown>;
  finish(id: string,token: string,result: Record<string,unknown>): Promise<string>;
}
/** No Telegram call, review decision or catalogue write is reachable here. */
export async function inspectAdminUpload(root: string,ports: UploadInspectionPorts): Promise<boolean> {
  const raw = await ports.claim(randomUUID());
  if (raw === null) return false;
  const claim = uploadInspectionClaimSchema.parse(raw);
  const session = claim.manifest.session;
  try {
    if (claim.operation === "verify") {
      const assembled = await assembleDiskUpload(root,claim.manifest);
      const fingerprint = await fingerprintFile(assembled.path,session.size_bytes);
      const stage = await ports.finish(session.id,claim.token,{ outcome: "verified",sha256: assembled.sha256,fingerprint,file_key: assembled.key });
      if (stage!=="uploaded") throw new Error("upload_verification_not_persisted");
    } else {
      if (!claim.verified_file_key || !session.verified_sha256) throw new Error("upload_verification_missing");
      const path = verifiedUploadPath(root,session.id,claim.verified_file_key);
      if (await hashFile(path,session.size_bytes)!==session.verified_sha256) throw new Error("upload_chunk_corrupt");
      const tools = await resolveMediaTools();
      if (!tools.ok) throw new Error("upload_media_tools_missing");
      const probe = await probeMedia(tools.tools.ffprobe,path);
      if (!probe.ok) throw new Error(probe.code);
      const classification = classifyMedia(probe.inspection);
      if(session.storage==="r2" && classification.class==="canonical") await validatePlayback(tools.tools.ffmpeg,path);
      const parsed = parseFilename(session.file_name);
      const vj = resolveVj(parsed.vjText,claim.vjs.map(({ active,...record }) => ({ ...record,isActive: active })));
      const query = { kind: session.metadata.kind,title: session.metadata.title || parsed.title || "",year: session.metadata.year ?? parsed.year };
      let choices: Awaited<ReturnType<typeof searchTmdbForIngestion>>;
      try { choices = query.title && query.kind==="movie" ? await searchTmdbForIngestion(query) : []; }
      catch { throw new Error("inspection_provider_failed"); }
      choices=choices.slice(0,20);
      const decision = decideMatch(query,choices);
      const snapshots = (await Promise.all(choices.slice(0,20).filter((choice) => choice.mediaType==="movie").map((choice) => fetchMovieSnapshot(choice.tmdbId)))).filter((snapshot) => snapshot!==null);
      const stage = await ports.finish(session.id,claim.token,{ outcome: "inspected",inspection: {
        choices: snapshots,parsed,query,classification,media: probe.inspection,vj,decoded:session.storage==="r2" && classification.class==="canonical",
        evaluation: evaluationPayload({ kind: {status: "confirmed",kind: query.kind},title: query.title,year: query.year,vjText: parsed.vjText,vj,season: session.metadata.season ?? parsed.season,episode: session.metadata.episode ?? parsed.episode,match: decision }),
        proposed_vj_id: vj.status==="resolved" ? vj.vjId : null,
        proposed_tmdb_id: decision.outcome==="matched" && decision.confidence==="high" ? decision.best.candidate.tmdbId : null,
        tools: { ffprobe: tools.tools.ffprobe.version,ffmpeg: tools.tools.ffmpeg.version },
      } });
      if (stage!=="metadata_review") throw new Error("upload_inspection_not_persisted");
    }
  } catch (failure) {
    // A lost finish reply might already have committed. The fenced finish then
    // refuses this second result instead of overwriting success. Retain bytes.
    try { await ports.finish(session.id,claim.token,{ outcome: "failed",code: errorCode(failure) }); }
    catch { console.warn(JSON.stringify({ event: "upload_inspection_reconciliation_required" })); }
  }
  return true;
}
