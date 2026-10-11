import "server-only";
import { getAuthedClient } from "@/lib/auth";
import { requireReviewAdmin,reviewMode } from "@/lib/discovery/runtime";
import type { DiscoveryRpc } from "@/lib/discovery/database";
import { createUploadClient } from "./admin-upload";

/** Shared route/page authorization, deliberately outside Server Action exports. */
export async function uploadClient() {
  await requireReviewAdmin();
  if (process.env.VELORA_ADMIN_UPLOADS_ENABLED !== "true" || reviewMode() !== "database") throw new Error("admin_uploads_disabled");
  const authed = await getAuthedClient();
  if (!authed) throw new Error("upload_not_authorized");
  const supabase = authed.supabase as unknown as { rpc: DiscoveryRpc };
  return createUploadClient((name,args) => supabase.rpc(name,args));
}
