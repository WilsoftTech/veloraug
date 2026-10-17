import type { StreamCapability } from "@/lib/playback/stream-capability";
import type { MediaProfile } from "@/lib/playback/compatibility";

/**
 * Browser-side playback logic for the movie player (E3), kept free of React and
 * Next.js so it can be tested directly and reused by a future native client.
 *
 * A capability is requested only when the viewer presses Play, never on page
 * load. It comes from the E2 issuer (POST /api/media/stream-token), which is the
 * only authority: this module just asks and reacts. Renewal is the same request
 * again, so the session, entitlement and catalogue are re-checked each time; an
 * earlier capability is never sent anywhere except to the gateway it names.
 */

export type PlayerFailure =
  | "auth_required"
  | "not_entitled"
  | "unavailable"
  | "unsupported"
  | "unsupported_container"
  | "unsupported_video"
  | "unsupported_audio"
  | "missing_video"
  | "missing_audio"
  | "slow_metadata"
  | "playback_error"
  | "network"
  | "temporarily_unavailable";

/**
 * A capability as the player holds it: the issuer's reply plus its expiry on
 * this device's clock. `expiresAt` is server time; a device clock that is ahead
 * or behind would otherwise make every capability look expired (a renewal loop)
 * or fresh for too long. The offset comes from the reply's Date header.
 */
export type PlayerCapability = StreamCapability & { expiresAtMs: number };

export type CapabilityResult = { ok: true; capability: PlayerCapability } | { ok: false; failure: PlayerFailure };

export type PlayerStatus = "idle" | "requesting" | "loading" | "playing" | "paused" | "buffering" | "error";

export interface PlayerState {
  status: PlayerStatus;
  failure: PlayerFailure | null;
  capability: PlayerCapability | null;
}

export type PlayerEvent =
  | { type: "play_requested" }
  | { type: "capability_granted"; capability: PlayerCapability }
  | { type: "capability_denied"; failure: PlayerFailure }
  | { type: "renewed"; capability: PlayerCapability }
  | { type: "media_ready" }
  | { type: "media_playing" }
  | { type: "media_paused" }
  | { type: "media_waiting" }
  | { type: "media_failed"; failure: PlayerFailure }
  | { type: "closed" };

export const INITIAL_PLAYER_STATE: PlayerState = { status: "idle", failure: null, capability: null };

/** What a viewer is told. Never a raw gateway, Telegram or database message. */
export const PLAYER_FAILURE_MESSAGES: Record<PlayerFailure, string> = {
  auth_required: "Sign in to watch this movie.",
  not_entitled: "Your account can't watch this movie.",
  unavailable: "This movie isn't available to watch right now.",
  unsupported: "This movie can't be played in this browser.",
  unsupported_container: "This browser player cannot play this container. Download the original file.",
  unsupported_video: "This browser could not decode the video codec. Download to use a compatible player.",
  unsupported_audio: "The audio codec may be unsupported. Download to use a compatible player.",
  missing_video: "The browser loaded media without a decoded picture. Download to use a compatible player.",
  missing_audio: "The browser reports no decoded audio. Sound may be missing; try a compatible player with the download.",
  slow_metadata: "Movie metadata is taking too long to load. Retry playback or download the original file.",
  playback_error: "Playback failed. Try again.",
  network: "Playback was interrupted. Check your connection and try again.",
  temporarily_unavailable: "Playback is temporarily unavailable. Try again in a moment.",
};

/** The same failures for a viewer who is offered no download (the server's switch is off, or they are signed out). */
const WITHOUT_DOWNLOAD: Partial<Record<PlayerFailure, string>> = {
  unsupported_container: "This browser player cannot play this container.",
  unsupported_video: "This browser could not decode the video codec.",
  unsupported_audio: "The audio codec may be unsupported.",
  missing_video: "The browser loaded media without a decoded picture.",
  missing_audio: "The browser reports no decoded audio. Sound may be missing.",
  slow_metadata: "Movie metadata is taking too long to load. Retry playback.",
};
/** What to tell the viewer. Downloading is suggested only when a Download control is on the page. */
export const playerFailureMessage = (failure: PlayerFailure, downloadOffered: boolean): string =>
  (downloadOffered ? undefined : WITHOUT_DOWNLOAD[failure]) ?? PLAYER_FAILURE_MESSAGES[failure];

export function playerReducer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    case "play_requested":
      return state.status === "requesting" ? state : { status: "requesting", failure: null, capability: null };
    case "capability_granted":
      return state.status === "requesting" ? { status: "loading", failure: null, capability: event.capability } : state;
    case "capability_denied":
      // A denial ends playback, including a renewal refused mid-film.
      return state.status === "idle" ? state : { status: "error", failure: event.failure, capability: null };
    case "renewed":
      return state.capability ? { ...state, capability: event.capability } : state;
    case "media_ready":
      return state.status === "loading" ? { ...state, status: "paused" } : state;
    case "media_playing":
      return state.capability ? { ...state, status: "playing" } : state;
    case "media_paused":
      return state.capability ? { ...state, status: "paused" } : state;
    case "media_waiting":
      return state.capability && state.status !== "loading" ? { ...state, status: "buffering" } : state;
    case "media_failed":
      return state.capability ? { status: "error", failure: event.failure, capability: null } : state;
    case "closed":
      return INITIAL_PLAYER_STATE;
  }
}

const ENDPOINT = "/api/media/stream-token";

function isCapability(value: unknown): value is StreamCapability {
  if (typeof value !== "object" || value === null) return false;
  const { streamUrl, expiresAt } = value as Record<string, unknown>;
  if (typeof streamUrl !== "string" || typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return false;
  try {
    const url = new URL(streamUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Asks the E2 issuer for a stream capability. Never throws; every outcome is a result. */
export async function requestStreamCapability(
  movieVersionId: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<CapabilityResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 15_000);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movieVersionId }),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, failure: "network" };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 200) {
      if (!isCapability(body)) return { ok: false, failure: "temporarily_unavailable" };
      const serverNow = Date.parse(response.headers.get("date") ?? "");
      const skew = Number.isNaN(serverNow) ? 0 : now() - serverNow;
      return { ok: true, capability: { streamUrl: body.streamUrl, expiresAt: body.expiresAt, expiresAtMs: Date.parse(body.expiresAt) + skew } };
    }
    const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>).error : undefined;
    if (response.status === 401) return { ok: false, failure: "auth_required" };
    if (response.status === 403 && error === "not_entitled") return { ok: false, failure: "not_entitled" };
    if (response.status === 404) return { ok: false, failure: "unavailable" };
    return { ok: false, failure: "temporarily_unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Renew this long before expiry: enough for a slow request and the source swap. */
export const RENEW_BEFORE_EXPIRY_MS = 90_000;
const MIN_RENEWAL_DELAY_MS = 5_000;

/** Never renew more often than this, whatever the clocks say: a guard against renewal loops. */
export const MIN_RENEWAL_INTERVAL_MS = 30_000;

/** Milliseconds from now until the capability should be renewed. */
export function renewalDelayMs(capability: PlayerCapability, nowMs: number): number {
  return Math.max(MIN_RENEWAL_DELAY_MS, capability.expiresAtMs - RENEW_BEFORE_EXPIRY_MS - nowMs);
}

/** Whether a capability is expired or about to be, so the next play must renew first. */
export function needsRenewal(capability: PlayerCapability, nowMs: number): boolean {
  return capability.expiresAtMs - nowMs <= RENEW_BEFORE_EXPIRY_MS;
}

/**
 * What a media element error means on its own (E3.4).
 *
 * Before metadata has loaded from the current source, the element cannot tell a
 * gateway that is down, an HTTP error status and a file it cannot decode apart:
 * Chrome and Firefox report MediaError 4 (source not supported) for all of
 * them. So such an error is diagnosed (`diagnoseMediaFailure`), never read as
 * "unsupported". After metadata, decoding still needs observation: 2 (network)
 * may be an expired capability, which the component renews once; anything else
 * is a playback error. 1 (aborted) is ignored.
 */
export type MediaErrorClass = "diagnose" | "network" | "playback_error";

export function classifyMediaError(code: number | undefined, metadataLoaded: boolean): MediaErrorClass | null {
  if (code === 1) return null;
  if (!metadataLoaded) return "diagnose";
  return code === 2 ? "network" : "playback_error";
}

/** The gateway refused the capability itself (expired or not accepted): worth one renewal. */
export type MediaDiagnosis = PlayerFailure | "capability_rejected";

/** Each diagnostic request gives up after this long. */
export const DIAGNOSIS_TIMEOUT_MS = 5_000;

/**
 * Works out why a source failed before its metadata loaded, with at most two
 * requests straight to the media gateway (never through Next.js):
 *
 * 1. The stream URL itself, for two bytes. When the gateway allows this site's
 *    origin (MEDIA_GATEWAY_ALLOWED_ORIGINS), its status is readable: 206 means
 *    the gateway serves the file and this browser cannot play it, which is the
 *    only case reported as "unsupported".
 * 2. If that is unreadable, the gateway's /healthz in no-cors mode: it fails
 *    only when the gateway cannot be reached at all. It sends no capability
 *    and causes no catalogue or Telegram work.
 *
 * Whatever cannot be established is reported as a plain playback error, never
 * as a browser problem. Returns null if `signal` aborts (the player closed).
 */
export async function diagnoseMediaFailure(
  streamUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  timeoutMs: number = DIAGNOSIS_TIMEOUT_MS,
): Promise<MediaDiagnosis | null> {
  // One controller per request, aborted by the caller or the timeout (no AbortSignal.any: older Safari lacks it).
  const probe = async (url: string, init: RequestInit) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
      void response.body?.cancel().catch(() => {});
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

  try {
    const { status } = await probe(streamUrl, { headers: { Range: "bytes=0-1" } });
    if (status === 206 || status === 200) return "unsupported";
    if (status === 401) return "capability_rejected";
    if (status === 404) return "unavailable";
    if (status === 429 || status >= 500) return "temporarily_unavailable";
    return "playback_error";
  } catch {
    // Unreachable, timed out, or a response this origin may not read (no CORS).
  }
  if (signal?.aborted) return null;
  try {
    await probe(new URL("/healthz", streamUrl).href, { mode: "no-cors" });
  } catch {
    return signal?.aborted ? null : "temporarily_unavailable";
  }
  return signal?.aborted ? null : "playback_error";
}

/** A published version with optional public container/codec facts; no private locator. */
export interface PlayableVersion {
  id: number;
  label: string;
  profile?: MediaProfile | null;
}

/** The version played by default: the first one, in the catalogue's (VJ name) order. */
export function defaultVersion(versions: readonly PlayableVersion[]): PlayableVersion | null {
  return versions[0] ?? null;
}

/**
 * Whether a rejected play() promise means the browser refused the automatic
 * start (NotAllowedError). The element then stays paused and waits for the
 * viewer's own press: that is neither loading nor a failed movie. Other
 * rejections (an aborted load, an unsupported source) are not refusals.
 */
export function isAutoplayRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NotAllowedError";
}

/**
 * Stops all loading on a media element: pausing, dropping the source and
 * reloading aborts its in-flight range requests, so the browser closes its
 * gateway connections and the gateway stops scheduling reads.
 */
export function detachMediaSource(video: Pick<HTMLMediaElement, "pause" | "removeAttribute" | "load">) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}
