"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { Play, X } from "lucide-react";
import { buttonClass } from "@/components/button";
import {
  INITIAL_PLAYER_STATE,
  MIN_RENEWAL_INTERVAL_MS,
  PLAYER_FAILURE_MESSAGES,
  defaultVersion,
  detachMediaSource,
  failureFromMediaError,
  needsRenewal,
  playerReducer,
  renewalDelayMs,
  requestStreamCapability,
  type PlayableVersion,
} from "@/lib/playback/player";

interface MoviePlayerProps {
  /** Playable catalogue versions (one per VJ). Ids and labels only: no media details. */
  versions: PlayableVersion[];
  /** Where a signed-out viewer goes to sign in (the existing sign-in page, returning here). */
  signInHref: string;
}

const STATUS_TEXT: Partial<Record<string, string>> = {
  requesting: "Getting the movie ready…",
  loading: "Loading…",
  buffering: "Buffering…",
};


/**
 * Plays a movie version from the media gateway in a native <video> (E3).
 * Nothing is requested until Play: the E2 issuer then decides, and the video
 * streams byte ranges straight from the gateway. Capabilities last 10 minutes,
 * so the player renews shortly before expiry while playing, and on resume or
 * after a network error, by swapping the source at the same position.
 */
export function MoviePlayer({ versions, signInHref }: MoviePlayerProps) {
  const [versionId, setVersionId] = useState(() => defaultVersion(versions)?.id ?? null);
  const [state, dispatch] = useReducer(playerReducer, INITIAL_PLAYER_STATE);
  const videoRef = useRef<HTMLVideoElement>(null);
  const attachedUrl = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const renewing = useRef(false);
  const recovered = useRef(false);
  const lastRenewal = useRef(0);

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = null;
    renewing.current = false;
    attachedUrl.current = null;
    if (videoRef.current) detachMediaSource(videoRef.current);
  }, []);

  const start = useCallback(async () => {
    if (versionId === null) return;
    stop();
    recovered.current = false;
    lastRenewal.current = 0;
    dispatch({ type: "play_requested" });
    const controller = new AbortController();
    request.current = controller;
    const result = await requestStreamCapability(versionId, fetch, controller.signal);
    if (controller.signal.aborted) return;
    dispatch(result.ok ? { type: "capability_granted", capability: result.capability } : { type: "capability_denied", failure: result.failure });
  }, [stop, versionId]);

  /** Asks the issuer again (session, entitlement and catalogue are re-checked there). */
  const renew = useCallback(async () => {
    if (renewing.current || versionId === null || Date.now() - lastRenewal.current < MIN_RENEWAL_INTERVAL_MS) return;
    renewing.current = true;
    lastRenewal.current = Date.now();
    const controller = new AbortController();
    request.current = controller;
    const result = await requestStreamCapability(versionId, fetch, controller.signal);
    if (controller.signal.aborted) return;
    renewing.current = false;
    if (result.ok) dispatch({ type: "renewed", capability: result.capability });
    else {
      stop();
      dispatch({ type: "capability_denied", failure: result.failure });
    }
  }, [stop, versionId]);

  const close = useCallback(() => {
    stop();
    dispatch({ type: "closed" });
  }, [stop]);

  // Attach the first source, or swap to a renewed one at the same position.
  useEffect(() => {
    const video = videoRef.current;
    const capability = state.capability;
    if (!video || !capability || attachedUrl.current === capability.streamUrl) return;
    const first = attachedUrl.current === null;
    attachedUrl.current = capability.streamUrl;
    if (first) {
      video.src = capability.streamUrl;
      video.play().catch(() => {
        // Autoplay refused: the native controls stay available.
      });
      return;
    }
    const position = video.currentTime;
    const resume = !video.paused || recovered.current;
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = position;
        if (resume) video.play().catch(() => {});
      },
      { once: true },
    );
    video.src = capability.streamUrl;
  }, [state.capability]);

  // Renew shortly before expiry while playing. A paused player renews when it resumes.
  useEffect(() => {
    if (!state.capability) return;
    const timer = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) void renew();
    }, renewalDelayMs(state.capability, Date.now()));
    return () => clearTimeout(timer);
  }, [state.capability, renew]);

  // Leaving the page stops loading and any pending request.
  useEffect(() => stop, [stop]);

  const onPlay = () => {
    if (state.capability && needsRenewal(state.capability, Date.now())) void renew();
  };

  const onError = () => {
    const failure = failureFromMediaError(videoRef.current?.error?.code);
    if (!failure || !state.capability) return;
    // A network failure may be an expired capability: renew once and resume.
    if (failure === "network" && !recovered.current && Date.now() - lastRenewal.current >= MIN_RENEWAL_INTERVAL_MS) {
      recovered.current = true;
      void renew();
      return;
    }
    stop();
    dispatch({ type: "media_failed", failure });
  };

  if (versionId === null) return null;
  const open = state.capability !== null;
  const busy = state.status === "requesting";
  const statusText = STATUS_TEXT[state.status];

  return (
    <>
      {!open && (
        <button type="button" onClick={() => void start()} disabled={busy} className={buttonClass("primary")}>
          <Play aria-hidden className="size-4" />
          {busy ? "Starting…" : "Play"}
        </button>
      )}
      {versions.length > 1 && (
        <label className="inline-flex min-h-11 items-center gap-2 text-body-md text-foreground/80">
          <span>VJ</span>
          <select
            value={versionId}
            onChange={(event) => {
              close();
              setVersionId(Number(event.target.value));
            }}
            className="min-h-11 rounded-default border border-border bg-surface px-3 text-body-md text-foreground"
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="order-last w-full">
        {open && (
          <div className="flex flex-col gap-3">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              className="aspect-video w-full rounded-default bg-surface"
              onLoadedData={() => dispatch({ type: "media_ready" })}
              onPlaying={() => {
                recovered.current = false;
                dispatch({ type: "media_playing" });
              }}
              onPause={() => dispatch({ type: "media_paused" })}
              onWaiting={() => dispatch({ type: "media_waiting" })}
              onPlay={onPlay}
              onError={onError}
            />
            <button type="button" onClick={close} className={buttonClass("secondary", "self-start")}>
              <X aria-hidden className="size-4" />
              Close player
            </button>
          </div>
        )}
        {statusText && (
          <p role="status" className="mt-3 text-body-md text-foreground/80">
            {statusText}
          </p>
        )}
        {state.status === "error" && state.failure && (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-default border border-destructive/40 px-4 py-3 text-body-md">
            <span className="text-destructive">{PLAYER_FAILURE_MESSAGES[state.failure]}</span>
            {state.failure === "auth_required" && (
              <Link href={signInHref} className={buttonClass("secondary")}>
                Sign in
              </Link>
            )}
          </div>
        )}
      </div>
    </>
  );
}
