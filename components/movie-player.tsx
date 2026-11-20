"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Download, Play, RotateCcw, X } from "lucide-react";
import { buttonClass } from "@/components/button";
import { useSession } from "@/lib/session";
import { browserSignals, mediaCompatibility, unsupportedFailure } from "@/lib/playback/compatibility";
import { DOWNLOAD_GUIDANCE, DOWNLOAD_MESSAGES, launchBrowserDownload, prepareDownload, type DownloadFailure } from "@/lib/playback/download";
import {
  PROGRESS_SAVE_INTERVAL_MS,
  fetchVersionProgress,
  formatPlaybackTime,
  isCompletedPosition,
  isResumable,
  progressFromMedia,
  resumeVersion,
  saveVersionProgress,
  shouldSaveProgress,
  type VersionProgress,
} from "@/lib/playback/progress";
import {
  INITIAL_PLAYER_STATE,
  MIN_RENEWAL_INTERVAL_MS,
  playerFailureMessage,
  classifyMediaError,
  defaultVersion,
  detachMediaSource,
  diagnoseMediaFailure,
  isAutoplayRefusal,
  needsRenewal,
  playerReducer,
  renewalDelayMs,
  requestStreamCapability,
  type PlayableVersion,
  type PlayerFailure,
} from "@/lib/playback/player";

interface MoviePlayerProps {
  /** Published catalogue versions and optional safe codec facts; no private media location. */
  versions: PlayableVersion[];
  /** Where a signed-out viewer goes to sign in (the existing sign-in page, returning here). */
  signInHref: string;
  /** The server's download switch. Off, no Download control is shown. The server refuses downloads whatever this says. */
  downloads: boolean;
  /**
   * "episode": the versions are episode versions. Streaming and renewal work the same way; progress
   * is not saved (it covers movie versions only), downloads are never offered, and the
   * compatibility notes appear only once the episode is playing, so a season list stays compact.
   */
  target?: "episode";
}

const STATUS_TEXT: Partial<Record<string, string>> = {
  requesting: "Getting the movie ready…",
  loading: "Loading…",
  buffering: "Buffering…",
};
const subscribeBrowser = () => () => {};
const browserAgent = () => navigator.userAgent;
const serverAgent = () => null;


/**
 * Plays a movie version from the media gateway in a native <video> (E3).
 * Nothing is requested until Play: the E2 issuer then decides, and the video
 * streams byte ranges straight from the gateway. Capabilities last 10 minutes,
 * so the player renews shortly before expiry while playing, and on resume or
 * after a network error, by swapping the source at the same position.
 */
export function MoviePlayer({ versions, signInHref, downloads, target }: MoviePlayerProps) {
  const episode = target === "episode";
  const [versionId, setVersionId] = useState(() => defaultVersion(versions)?.id ?? null);
  const [state, dispatch] = useReducer(playerReducer, INITIAL_PLAYER_STATE);
  const session = useSession();
  const userAgent = useSyncExternalStore(subscribeBrowser, browserAgent, serverAgent);
  const profile = versions.find((version) => version.id === versionId)?.profile ?? null;
  // Downloading is suggested only to a viewer who has the Download control below.
  const downloadOffered = downloads && !episode && session === "signed-in";
  const compatibility = useMemo(() => mediaCompatibility(profile, userAgent ? browserSignals(profile, document.createElement("video"), userAgent, navigator.maxTouchPoints) : undefined, downloadOffered), [profile, userAgent, downloadOffered]);
  const [download, setDownload] = useState<{ busy: boolean; attempted: boolean; handedOff: boolean; failure: DownloadFailure | null; format: string | null }>({ busy: false, attempted: false, handedOff: false, failure: null, format: null });
  const downloadRequest = useRef<AbortController | null>(null);
  const [audioWarning, setAudioWarning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const attachedUrl = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const renewing = useRef(false);
  const recovered = useRef(false);
  const lastRenewal = useRef(0);
  /** Metadata has loaded; this alone does not establish decoded picture or sound. */
  const metadataLoaded = useRef(false);
  /** The signed-in viewer's saved positions for these versions (null: not loaded, or progress is off). */
  const [progress, setProgress] = useState<VersionProgress[] | null>(null);
  const progressOff = useRef(episode);
  /** The viewer picked a VJ/part themselves; saved progress no longer changes the selection. */
  const versionChosen = useRef(false);
  /** The version attached to the element, and where its first source should start. */
  const playingVersion = useRef<number | null>(null);
  const startAt = useRef(0);
  const lastSaved = useRef<number | null>(null);
  const versionIds = useMemo(() => versions.map((version) => version.id), [versions]);

  // Saved progress, once per sign-in. It also preselects the version the viewer was last watching.
  useEffect(() => {
    if (session !== "signed-in" || progressOff.current) return;
    const controller = new AbortController();
    void fetchVersionProgress(versionIds, fetch, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        // Off (not deployed, signed out) stops asking; a transient failure just shows no resume point.
        if (result.reason === "unavailable") progressOff.current = true;
        return;
      }
      setProgress(result.progress);
      const resume = resumeVersion(versionIds, result.progress);
      // Only before the first Play: a late answer never switches a version that is starting or playing.
      if (resume && !versionChosen.current && playingVersion.current === null) setVersionId(resume.movieVersionId);
    });
    return () => controller.abort();
  }, [session, versionIds]);

  /**
   * Reports the element's position. "tick" saves only after a real move; "now" always does.
   * Nothing is saved while a source is being (re)attached: currentTime is 0 until metadata loads.
   */
  const saveProgress = useCallback((mode: "tick" | "now", keepalive = false) => {
    const video = videoRef.current;
    const id = playingVersion.current;
    if (!video || id === null || !metadataLoaded.current || progressOff.current || session !== "signed-in") return;
    const entry = progressFromMedia(id, video.currentTime, video.duration, video.ended);
    if (!entry || (mode === "tick" && !shouldSaveProgress(lastSaved.current, entry.positionSeconds))) return;
    // At the end the browser fires pause, then ended: one save covers both.
    if (mode === "now" && lastSaved.current === entry.positionSeconds) return;
    lastSaved.current = entry.positionSeconds;
    const saved: VersionProgress = {
      ...entry,
      completed: isCompletedPosition(entry.positionSeconds, entry.durationSeconds),
      updatedAt: new Date().toISOString(),
    };
    setProgress((previous) => [...(previous ?? []).filter((item) => item.movieVersionId !== id), saved]);
    void saveVersionProgress(entry, fetch, keepalive).then((result) => {
      if (result === "unavailable") progressOff.current = true;
    });
  }, [session]);

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = null;
    renewing.current = false;
    attachedUrl.current = null;
    metadataLoaded.current = false;
    if (videoRef.current) detachMediaSource(videoRef.current);
  }, []);

  /** Starts the selected version, at `from` seconds (a saved position) or the beginning. */
  const start = useCallback(async (from = 0) => {
    if (versionId === null) return;
    stop();
    playingVersion.current = versionId;
    startAt.current = from;
    lastSaved.current = null;
    recovered.current = false;
    setAudioWarning(false);
    lastRenewal.current = 0;
    dispatch({ type: "play_requested" });
    const controller = new AbortController();
    request.current = controller;
    const result = await requestStreamCapability(versionId, fetch, controller.signal, undefined, target);
    if (controller.signal.aborted) return;
    dispatch(result.ok ? { type: "capability_granted", capability: result.capability } : { type: "capability_denied", failure: result.failure });
  }, [stop, versionId, target]);

  /** Asks the issuer again (session, entitlement and catalogue are re-checked there). */
  const renew = useCallback(async () => {
    if (renewing.current || versionId === null || Date.now() - lastRenewal.current < MIN_RENEWAL_INTERVAL_MS) return;
    renewing.current = true;
    lastRenewal.current = Date.now();
    const controller = new AbortController();
    request.current = controller;
    const result = await requestStreamCapability(versionId, fetch, controller.signal, undefined, target);
    if (controller.signal.aborted) return;
    renewing.current = false;
    if (result.ok) dispatch({ type: "renewed", capability: result.capability });
    else {
      stop();
      dispatch({ type: "capability_denied", failure: result.failure });
    }
  }, [stop, versionId, target]);

  const close = useCallback(() => {
    saveProgress("now");
    stop();
    dispatch({ type: "closed" });
  }, [stop, saveProgress]);

  // Attach the first source, or swap to a renewed one at the same position.
  useEffect(() => {
    const video = videoRef.current;
    const capability = state.capability;
    if (!video || !capability || attachedUrl.current === capability.streamUrl) return;
    const first = attachedUrl.current === null;
    // Autoplay refused: the element is paused and waits for the viewer, with the native controls
    // available. Say so, or the loading deadline would close a player that is not loading.
    const awaitViewer = (error: unknown) => {
      if (isAutoplayRefusal(error)) dispatch({ type: "media_paused" });
    };
    attachedUrl.current = capability.streamUrl;
    metadataLoaded.current = false;
    if (first) {
      // Resume: seek once the duration is known, unless the saved point is at the very end.
      const from = startAt.current;
      if (from > 0) {
        video.addEventListener("loadedmetadata", () => {
          if (!Number.isFinite(video.duration) || from < video.duration - 5) video.currentTime = from;
        }, { once: true });
      }
      video.src = capability.streamUrl;
      video.play().catch(awaitViewer);
      return;
    }
    const position = video.currentTime;
    const resume = !video.paused || recovered.current;
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = position;
        if (resume) video.play().catch(awaitViewer);
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

  // Leaving the page keeps the position (keepalive outlives the page), then stops loading and any pending request.
  const saveOnLeave = useRef(saveProgress);
  useEffect(() => {
    saveOnLeave.current = saveProgress;
  }, [saveProgress]);
  useEffect(() => () => {
    saveOnLeave.current("now", true);
    stop();
  }, [stop]);

  // Progress: periodically while playing, and when the tab is hidden or the page goes away.
  useEffect(() => {
    if (state.status !== "playing") return;
    const timer = setInterval(() => saveProgress("tick"), PROGRESS_SAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.status, saveProgress]);
  useEffect(() => {
    const leave = () => saveProgress("now", true);
    const hidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [saveProgress]);

  const onPlay = () => {
    if (state.capability && needsRenewal(state.capability, Date.now())) void renew();
  };

  const fail = (failure: PlayerFailure) => {
    stop();
    dispatch({ type: "media_failed", failure });
  };

  /** Renews once per Play (and never within the renewal interval); false when that chance is used up. */
  const recoverOnce = () => {
    if (recovered.current || Date.now() - lastRenewal.current < MIN_RENEWAL_INTERVAL_MS) return false;
    recovered.current = true;
    void renew();
    return true;
  };

  const onError = () => {
    const kind = classifyMediaError(videoRef.current?.error?.code, metadataLoaded.current);
    const capability = state.capability;
    if (!kind || !capability) return;
    // A network failure mid-film may be an expired capability: renew once and resume.
    if (kind === "network") {
      if (!recoverOnce()) fail("network");
      return;
    }
    if (kind === "playback_error") return fail("playback_error");
    // Failed before any metadata: find out why rather than blame the browser.
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void diagnoseMediaFailure(capability.streamUrl, fetch, controller.signal).then((diagnosis) => {
      if (diagnosis === null || controller.signal.aborted) return;
      request.current = null;
      if (diagnosis !== "capability_rejected") return fail(diagnosis === "unsupported" ? unsupportedFailure(profile) : diagnosis);
      // A capability the gateway no longer accepts: one renewal, then report the service as unavailable.
      if (!recoverOnce()) fail("temporarily_unavailable");
    });
  };

  // Start the watchdog at the loading commit, even if passive effects are delayed.
  // A native element may never raise an error while waiting for metadata/data.
  useLayoutEffect(() => {
    if (state.status !== "loading" && state.status !== "buffering") return;
    const timer = setTimeout(() => {
      const failure = metadataLoaded.current ? "network" : "slow_metadata";
      stop();
      dispatch({ type: "media_failed", failure });
    }, 30_000);
    return () => clearTimeout(timer);
  }, [state.status, state.capability, stop]);

  useEffect(() => {
    if (session !== "signed-in") downloadRequest.current?.abort();
    return () => downloadRequest.current?.abort();
  }, [session]);

  const startDownload = async () => {
    if (!downloads || versionId === null || session !== "signed-in" || downloadRequest.current) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownload((previous) => ({ ...previous, busy: true, attempted: true, failure: null, handedOff: false }));
    const result = await prepareDownload(versionId, fetch, controller.signal);
    if (downloadRequest.current !== controller) return;
    downloadRequest.current = null;
    if (controller.signal.aborted) {
      setDownload((previous) => ({ ...previous, busy: false }));
      return;
    }
    if (result.ok) {
      launchBrowserDownload(result.url);
      setDownload({ busy: false, attempted: true, handedOff: true, failure: null, format: result.format });
    } else setDownload((previous) => ({ ...previous, busy: false, failure: result.failure }));
  };

  if (versionId === null) return null;
  const open = state.capability !== null;
  const busy = state.status === "requesting";
  const statusText = episode && state.status === "requesting" ? "Getting the episode ready…" : STATUS_TEXT[state.status];
  const saved = progress?.find((entry) => entry.movieVersionId === versionId);
  const resumeFrom = saved && isResumable(saved) ? saved.positionSeconds : null;

  return (
    <>
      {!open && (
        <button type="button" onClick={() => void start(resumeFrom ?? 0)} disabled={busy || compatibility.blocked} className={buttonClass("primary")}>
          <Play aria-hidden className="size-4" />
          {busy ? "Starting…" : resumeFrom !== null ? `Resume from ${formatPlaybackTime(resumeFrom)}` : "Play"}
        </button>
      )}
      {!open && !busy && resumeFrom !== null && (
        <button type="button" onClick={() => void start(0)} disabled={compatibility.blocked} className={buttonClass("secondary")}>
          <RotateCcw aria-hidden className="size-4" />
          Start over
        </button>
      )}
      {downloadOffered && (
        <button type="button" onClick={() => void startDownload()} disabled={download.busy} className={buttonClass(compatibility.blocked || state.status === "error" ? "primary" : "secondary")}>
          <Download aria-hidden className="size-4" />
          {download.busy ? "Preparing download…" : download.attempted ? "Resume/Retry Download" : "Download"}
          {(download.format || profile?.container === "mp4" || profile?.container === "mkv") && ` (${download.format ?? profile?.container?.toUpperCase()})`}
        </button>
      )}
      {versions.length > 1 && (
        <label className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 text-body-md text-foreground/80">
          <span className="shrink-0">VJ</span>
          <select
            aria-label="VJ"
            value={versionId}
            onChange={(event) => {
              versionChosen.current = true;
              close();
              downloadRequest.current?.abort();
              downloadRequest.current = null;
              setDownload({ busy: false, attempted: false, handedOff: false, failure: null, format: null });
              setAudioWarning(false);
              setVersionId(Number(event.target.value));
            }}
            className="min-h-11 min-w-0 max-w-full rounded-default border border-border bg-surface px-3 text-body-md text-foreground"
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
        {(!episode || open) && <div className="mb-3 space-y-2 text-body-md text-foreground/80" aria-label="Playback compatibility">
          {profile?.container && <p>Original format: {profile.container === "other" ? "unsupported container" : profile.container.toUpperCase()} · Video: {profile.videoCodec?.toUpperCase() ?? "unknown"} · Audio: {profile.audioCodec?.toUpperCase() ?? "unknown"}</p>}
          <p>{compatibility.message}</p>
          {compatibility.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>}
        {downloadOffered && <p className="mb-3 text-body-sm text-muted">{DOWNLOAD_GUIDANCE}</p>}
        {download.handedOff && <p role="status" className="mb-3 text-body-md">{download.format} download handed to your browser. Check its download manager for progress or interruptions.</p>}
        {download.failure && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-default border border-destructive/40 px-4 py-3 text-body-md">
          <span className="text-destructive">{DOWNLOAD_MESSAGES[download.failure]}</span>
          {download.failure === "auth_required" && <Link href={signInHref} className={buttonClass("secondary")}>Sign in</Link>}
        </div>}
        {audioWarning && <p role="status" className="mb-3 text-body-md">{playerFailureMessage("missing_audio", downloadOffered)}</p>}
        {open && (
          <div className="flex flex-col gap-3">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              className="aspect-video w-full rounded-default bg-surface"
              onLoadedMetadata={() => {
                metadataLoaded.current = true;
              }}
              onLoadedData={() => {
                const video = videoRef.current;
                if (video && video.videoWidth === 0 && video.videoHeight === 0) return fail("missing_video");
                // Only use explicit native evidence where available. No audio API does not imply silence.
                const audio = video as (HTMLVideoElement & { mozHasAudio?: boolean; audioTracks?: { length: number } }) | null;
                setAudioWarning(audio?.mozHasAudio === false || audio?.audioTracks?.length === 0);
                dispatch({ type: "media_ready" });
              }}
              onPlaying={() => {
                recovered.current = false;
                dispatch({ type: "media_playing" });
              }}
              onPause={() => {
                saveProgress("now");
                dispatch({ type: "media_paused" });
              }}
              onEnded={() => saveProgress("now")}
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
            <span className="text-destructive">{playerFailureMessage(state.failure, downloadOffered)}</span>
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
