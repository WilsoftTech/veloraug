import { audioStreams, playableVideo, type MediaClassification, type MediaInspection } from "@/lib/ingestion/media";

export const ORIGINAL_MEDIA_POLICY_VERSION = 3;
export const MOVIE_UPLOAD_EXTENSIONS: readonly string[] = ["mp4", "mkv"];

/** Metadata and bounded readability never prove every packet of a movie intact. */
export function assessOriginalMedia(inspection: MediaInspection, fileName?: string) {
  const formats = inspection.formatName.split(",");
  const container = inspection.layout && formats.includes("mp4") ? "mp4" : formats.includes("matroska") ? "mkv" : null;
  const video = playableVideo(inspection);
  const audio = audioStreams(inspection);
  const reasons: string[] = [];
  if (container === "mkv" && inspection.matroskaDocType !== undefined && inspection.matroskaDocType !== "matroska") reasons.push("container_not_matroska");
  if (fileName && container !== fileName.split(".").pop()?.toLowerCase()) reasons.push("container_extension_mismatch");
  if (container === "mp4" && (!inspection.majorBrand || inspection.majorBrand === "qt" || inspection.majorBrand === "qt  ")) reasons.push("mp4_brand_unconfirmed");
  if (!container) reasons.push("container_not_mp4_or_mkv");
  if (container === "mp4" && (!inspection.layout?.complete || !inspection.layout.boxes.includes("moov") || !inspection.layout.boxes.includes("mdat"))) reasons.push("mp4_layout_incomplete");
  if (inspection.probeSizeBytes !== null && inspection.probeSizeBytes !== inspection.sizeBytes) reasons.push("size_mismatch");
  if (!inspection.durationSeconds || inspection.durationSeconds <= 0) reasons.push("duration_unknown");
  if (!video.length || video.some((track) => !track.codec || (track.width ?? 0) <= 0 || (track.height ?? 0) <= 0)) reasons.push("video_metadata_incomplete");
  if (video.length > 1) reasons.push("multiple_video_streams");
  if (!audio.length || audio.some((track) => !track.codec || (track.channels ?? 0) <= 0 || (track.sampleRate ?? 0) <= 0)) reasons.push("audio_metadata_incomplete");
  if (inspection.streams.some((track) => !track.codec)) reasons.push("track_codec_unknown");
  const warnings: string[] = [];
  if (container === "mp4" && !inspection.layout?.fastStart) warnings.push("mp4_startup_tail_required");
  if (inspection.layout?.fragmented) warnings.push("fragmented_mp4_not_tested");
  if (video.length > 1) warnings.push("multiple_video_tracks_not_tested");
  if (audio.some((track) => track.codec === "ac3")) warnings.push("ac3_audio_silent_in_tested_browsers");
  if (video.some((track) => track.codec === "hevc")) warnings.push("hevc_device_decoder_required");
  if (container === "mkv") warnings.push("firefox_mkv_streaming_unreliable");
  if (audio.length > 1) warnings.push("audio_track_switching_not_available");
  if (inspection.streams.some((track) => track.type === "subtitle")) warnings.push("embedded_subtitles_not_displayed");
  const common = video.length === 1 && video[0].codec === "h264" && ["High", "Main", "Baseline", "Constrained Baseline"].includes(video[0].profile ?? "") && video[0].pixelFormat === "yuv420p" && (video[0].level ?? 999) <= 51 && audio.every((track) => ["aac", "mp3"].includes(track.codec ?? "") && track.channels! <= 2 && (track.codec !== "aac" || track.profile === "LC"));
  // These are observations for synthetic fixtures on one Windows machine, not per-file browser tests.
  const compatibility = {
    evidence: "docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11",
    basis: "tested_fixture_combinations" as const,
    perFile: "prediction" as const,
    chromium: audio.some((track) => track.codec === "ac3") && video[0]?.codec === "h264" ? "tested_video_only_silent_audio" : common ? "tested_combination" : "device_dependent_or_untested",
    firefox: container === "mkv" ? "streaming_unreliable" : audio.some((track) => track.codec === "ac3") && video[0]?.codec === "h264" ? "tested_video_only_silent_audio" : common ? "tested_combination" : "device_dependent_or_untested",
    safari: "real_device_not_tested",
    ios: "real_device_not_tested",
    android: "real_device_not_tested",
  };
  return {
    accepted: reasons.length === 0, container, reasons, warnings,
    integrity: reasons.length ? "incomplete" : "metadata_consistent",
    streaming: reasons.length ? "unverified" : warnings.includes("fragmented_mp4_not_tested") ? "untested" : container === "mp4" && !inspection.layout?.fastStart ? "potentially_playable_startup_warning" : "potentially_playable",
    compatibility,
    download: "not_implemented_authorization_required",
    tracks: inspection.streams,
  };
}

export function classifyOriginalMovie(inspection: MediaInspection, fileName?: string): MediaClassification {
  const assessment = assessOriginalMedia(inspection, fileName);
  return { class: assessment.accepted ? "original" : "manual_review", reasons: assessment.reasons, policyVersion: ORIGINAL_MEDIA_POLICY_VERSION };
}
