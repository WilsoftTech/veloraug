import { readPoster } from "@/lib/artwork-storage";
import { POSTER_PATH, POSTER_WIDTHS } from "@/lib/artwork";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  const {file} = await params; const match = POSTER_PATH.exec("/posters/" + file);
  const raw = new URL(request.url).searchParams.get("w") ?? "1200";
  const width = /^\d{3,4}$/.test(raw) ? Number(raw) : 0;
  if (!match || !POSTER_WIDTHS.some(size => size === width)) return new Response(null,{status:404});
  try {
    const image = await readPoster(match[1],width); if (!image) return new Response(null,{status:404});
    const headers = { "Content-Type":"image/webp", "Cache-Control":"public, max-age=31536000, immutable", "X-Content-Type-Options":"nosniff", ...(image.etag ? {ETag:image.etag} : {}) };
    if (image.etag && request.headers.get("if-none-match") === image.etag) return new Response(null,{status:304,headers});
    return new Response(image.bytes,{headers});
  } catch { return new Response(null,{status:503,headers:{"Cache-Control":"no-store"}}); }
}
