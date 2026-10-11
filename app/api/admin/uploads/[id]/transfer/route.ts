import { z } from "zod";
import { getAuthedClient } from "@/lib/auth";
import { parseGatewayOrigin } from "@/lib/playback/stream-capability";
import { uploadClient } from "@/lib/uploader/admin-runtime";

/** Control and credentials only; movie bytes go directly to the disk service. */
export async function POST(request: Request,{ params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "no-store" };
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "upload_origin_refused" },{ status: 403,headers });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "upload_not_found" },{ status: 404,headers });
  try {
    const origin = parseGatewayOrigin(process.env.VELORA_UPLOAD_PUBLIC_ORIGIN,process.env.NODE_ENV === "production");
    if (!origin) return Response.json({ error: "upload_service_unconfigured" },{ status: 503,headers });
    const client = await uploadClient();
    const session = await client.get(id);
    if (request.headers.get("Upload-Command") === "verify") {
      await client.control(id,session.revision,"verify");
      return Response.json({ stage: "verifying" },{ headers });
    }
    if (session.stage === "draft") await client.control(id,session.revision,"start");
    else if (session.stage !== "uploading") return Response.json({ error: "upload_illegal_transition" },{ status: 409,headers });
    const authed = await getAuthedClient();
    if (!authed) return Response.json({ error: "upload_not_authorized" },{ status: 403,headers });
    const { data,error } = await authed.supabase.auth.getSession();
    if (error || !data.session) return Response.json({ error: "upload_not_authorized" },{ status: 403,headers });
    // This is the signed-in user's access token, not a storage/service secret.
    // The storage endpoint checks it with Auth and rechecks database capability.
    return Response.json({ url: `${origin}/uploads/${id}`,token: data.session.access_token },{ headers });
  } catch { return Response.json({ error: "upload_request_refused" },{ status: 403,headers }); }
}
