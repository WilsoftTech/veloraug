/** Public inspection facts only. An inspection is not a browser playback test. */
export interface MediaProfile {
  container: "mp4" | "mkv" | "other" | null;
  videoCodec: string | null;
  audioCodec: string | null;
  startupWarning: boolean;
}

/** Whitelist the RPC projection; never forward raw inspection/track data to the page. */
export function parseMediaProfile(value: unknown): MediaProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const codecs = ["h264", "hevc", "aac", "mp3", "ac3", "eac3", "vp9", "av1", "opus", "vorbis"];
  const codec = (value: unknown) => typeof value === "string" ? codecs.includes(value) ? value : "unknown" : null;
  if (!("container" in row) || !("video_codec" in row) || !("audio_codec" in row)) return null;
  return {
    container: row.container === "mp4" || row.container === "mkv" ? row.container : typeof row.container === "string" ? "other" : null,
    videoCodec: codec(row.video_codec), audioCodec: codec(row.audio_codec),
    startupWarning: row.streaming_status === "potentially_playable_startup_warning",
  };
}

/** Missing Policy 3 RPC, absent evidence and transient read failures all leave playback available. */
export async function readMediaProfile(read: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<MediaProfile | null> {
  try {
    const result = await read();
    return result.error ? null : parseMediaProfile(result.data);
  } catch {
    // Optional metadata: the catalogue and the capability issuer remain authoritative.
    return null;
  }
}

export interface BrowserSignals {
  engine: "chromium" | "firefox" | "webkit" | "unknown";
  platform: "windows" | "android" | "ios" | "other";
  container: CanPlayTypeResult;
  video: CanPlayTypeResult;
  audio: CanPlayTypeResult;
}
export type CompatibilityKind = "tested-combination" | "expected" | "browser-dependent" | "unsupported" | "unknown";
export interface Compatibility {
  kind: CompatibilityKind;
  message: string;
  warnings: string[];
  blocked: boolean;
  failure?: "unsupported_container" | "unsupported_video" | "unsupported_audio";
}

export function browserIdentity(userAgent: string, touchPoints = 0): Pick<BrowserSignals, "engine" | "platform"> {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
  return {
    engine: ios ? "webkit" : /Firefox\//.test(userAgent) ? "firefox" : /Chrome\/|Chromium\/|Edg\//.test(userAgent) ? "chromium" : /AppleWebKit\//.test(userAgent) ? "webkit" : "unknown",
    platform: ios ? "ios" : /Android/.test(userAgent) ? "android" : /Windows/.test(userAgent) ? "windows" : "other",
  };
}

/** Representative MIME signals, not the file's exact codec profile/level or proof of decoding. */
export function browserSignals(profile: MediaProfile | null, media: Pick<HTMLVideoElement, "canPlayType">, userAgent: string, touchPoints = 0): BrowserSignals {
  // The safe public RPC lacks width, frame rate and bitrate: do not invent a MediaCapabilities decodingInfo configuration.
  const mime = profile?.container === "mkv" ? "video/x-matroska" : "video/mp4";
  const video = profile?.videoCodec === "h264" ? "avc1.64001E" : profile?.videoCodec === "hevc" ? "hvc1" : "";
  const audio = profile?.audioCodec === "aac" ? "mp4a.40.2" : profile?.audioCodec === "mp3" ? "mp4a.6B" : profile?.audioCodec === "ac3" ? "ac-3" : "";
  return { ...browserIdentity(userAgent, touchPoints), container: media.canPlayType(mime),
    video: video ? media.canPlayType(`${mime}; codecs="${video}"`) : "",
    audio: audio ? media.canPlayType(`${mime}; codecs="${audio}"`) : "" };
}

/** CP1 Windows fixture evidence outranks negative MIME hints (notably Chromium MKV). */
export function mediaCompatibility(profile: MediaProfile | null, signals?: BrowserSignals): Compatibility {
  const warnings = ["If this file has multiple audio tracks, only the default track is expected. Embedded subtitles may not display."];
  const result = (kind: CompatibilityKind, message: string, blocked = false, failure?: Compatibility["failure"]): Compatibility => ({ kind, message, warnings, blocked, failure });
  if (!profile?.container || !signals) return result("unknown", "Compatibility is untested for this file and browser.");
  if (profile.startupWarning) warnings.push("This MP4 stores its index at the end. Startup may take longer; this does not mean the file is defective.");
  if (profile.container === "other") return result("unsupported", "This player supports MP4 and MKV containers only.", true, "unsupported_container");
  if (profile.audioCodec === "ac3" || profile.audioCodec === "eac3") warnings.push("This audio codec may play silently. Download the original file to use a compatible player.");
  if (profile.videoCodec === "hevc") warnings.push("HEVC playback depends on the device decoder; audio may play without a picture.");
  if (signals.platform === "ios" || signals.engine === "webkit") return result("unknown", "Safari and iOS playback require real-device testing. Playwright WebKit does not establish support.");
  if (profile.container === "mkv" && signals.engine === "firefox") {
    warnings.push("Firefox MKV streaming is unreliable and may wait for the whole file before starting.");
    if (profile.audioCodec === "mp3") warnings.push("Firefox MKV/MP3 fixtures played video without audio.");
    return result("browser-dependent", "MKV playback in Firefox is browser-dependent. Download is the reliable fallback.");
  }
  if (profile.videoCodec === "hevc") return result("browser-dependent", "HEVC needs a compatible device decoder. Some tested browsers played audio without a picture.");
  if (!profile.videoCodec || !profile.audioCodec || profile.videoCodec === "unknown" || profile.audioCodec === "unknown") return result("unknown", "Codec metadata is incomplete. Playback compatibility is unknown.");
  if (profile.audioCodec === "ac3" || profile.audioCodec === "eac3") return result("browser-dependent", "Audio may be unsupported or silent in this browser.", false, "unsupported_audio");
  const common = profile.videoCodec === "h264" && ["aac", "mp3"].includes(profile.audioCodec);
  const tested = signals.platform === "windows" && (signals.engine === "chromium" || (signals.engine === "firefox" && profile.container === "mp4"));
  if (common && tested) return result("tested-combination", "This container/codec combination played in Windows fixture tests. This file and device have not been tested.");
  if (common && signals.container && signals.video && signals.audio) return result("expected", "Browser signals suggest playback may work. This device and file are untested.");
  return result("browser-dependent", "Browser signals do not confirm these codecs. Try playback or download the original file.");
}

/** Native media errors cannot identify a codec reliably; apply known facts only after a successful gateway probe. */
export function unsupportedFailure(profile: MediaProfile | null): "unsupported" | "unsupported_container" | "unsupported_video" | "unsupported_audio" {
  if (profile?.container === "other") return "unsupported_container";
  if (profile?.videoCodec === "hevc" || (profile?.videoCodec && profile.videoCodec !== "h264")) return "unsupported_video";
  if (profile?.audioCodec && !["aac", "mp3"].includes(profile.audioCodec)) return "unsupported_audio";
  return "unsupported";
}
