export type DownloadFailure = "auth_required" | "not_entitled" | "unavailable" | "expired" | "network" | "temporarily_unavailable" | "disabled";
export const DOWNLOAD_MESSAGES: Record<DownloadFailure, string> = {
  auth_required: "Sign in again to download or continue this movie.",
  not_entitled: "Download access has been revoked or is not included for this account.",
  unavailable: "This movie is no longer available to download.",
  expired: "The download link expired before it could be used. Resume/Retry Download requests fresh authorization.",
  network: "Could not reach the download service. Check your connection, then use Resume/Retry Download.",
  temporarily_unavailable: "Download is temporarily unavailable. Try again in a moment.",
  disabled: "Downloads are switched off at the moment.",
};
// The gateway lets a transfer that started inside the link's ten minutes run on, up to four hours
// (lib/media-gateway/download.ts). Only starting or resuming needs a link that has not expired.
export const DOWNLOAD_GUIDANCE = "Downloads use the browser's download manager. A download that has started keeps running, for up to 4 hours. A link can start or resume a download for 10 minutes; after that, use Resume/Retry Download for a fresh authorized link. Your browser may restart instead of resuming the partial file; check its download manager. This page cannot track completion.";
type DownloadResult = { ok: true; url: string; format: "MP4" | "MKV" } | { ok: false; failure: DownloadFailure };

/** Every invocation authenticates again. Only a one-byte Range readiness probe is fetched by JavaScript. */
export async function prepareDownload(movieVersionId: number, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch, signal?: AbortSignal, timeoutMs = 15_000): Promise<DownloadResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchImpl("/api/media/download-token", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieVersionId }), credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (response.status === 401) return { ok: false, failure: "auth_required" };
      if (response.status === 403) return { ok: false, failure: "not_entitled" };
      if (response.status === 404) return { ok: false, failure: "unavailable" };
      if (response.status === 503) {
        // The issuer's download switch is off (server-side; the page only reports it).
        const refusal: unknown = await response.json().catch(() => null);
        return { ok: false, failure: refusal && typeof refusal === "object" && (refusal as Record<string, unknown>).error === "downloads_disabled" ? "disabled" : "temporarily_unavailable" };
      }
      if (response.status !== 200) return { ok: false, failure: "temporarily_unavailable" };
      let body: unknown;
      try { body = await response.json(); } catch { return { ok: false, failure: "temporarily_unavailable" }; }
      if (!body || typeof body !== "object") return { ok: false, failure: "temporarily_unavailable" };
      const { downloadUrl, expiresAt } = body as Record<string, unknown>;
      if (typeof downloadUrl !== "string" || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return { ok: false, failure: "temporarily_unavailable" };
      let url: URL;
      try { url = new URL(downloadUrl); } catch { return { ok: false, failure: "temporarily_unavailable" }; }
      if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash || url.pathname !== `/v1/movie-versions/${movieVersionId}/download`) return { ok: false, failure: "temporarily_unavailable" };
      const serverNow = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(serverNow) && Date.parse(expiresAt) <= serverNow) {
        if (!attempt) continue;
        return { ok: false, failure: "expired" };
      }
      const probe = await fetchImpl(url.href, { headers: { Range: "bytes=0-0" }, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
      // Never buffer the media body, including a server that ignores Range.
      await probe.body?.cancel();
      if (probe.status === 401) {
        if (!attempt) continue; // One fresh authentication/entitlement check; no capability exchange.
        return { ok: false, failure: "expired" };
      }
      if (probe.status === 403) return { ok: false, failure: "not_entitled" };
      if (probe.status === 404) return { ok: false, failure: "unavailable" };
      const mime = probe.headers.get("content-type");
      if (probe.status !== 206 || !/^bytes 0-0\/[1-9]\d*$/.test(probe.headers.get("content-range") ?? "") || probe.headers.get("content-length") !== "1" || !["video/mp4", "video/x-matroska"].includes(mime ?? "")) return { ok: false, failure: "temporarily_unavailable" };
      return { ok: true, url: url.href, format: mime === "video/mp4" ? "MP4" : "MKV" };
    }
    return { ok: false, failure: "expired" };
  } catch {
    return { ok: false, failure: "network" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Temporary navigation only. The gateway's Content-Disposition owns the original filename. */
export function launchBrowserDownload(url: string, doc: Document = document) {
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.referrerPolicy = "no-referrer";
  // No download filename override: cross-origin download is managed by the gateway headers.
  doc.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
