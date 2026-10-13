import { otherGates, reasonText, steps } from "@/lib/discovery/guidance";
import type { ReviewCandidate } from "@/lib/discovery/model";

/**
 * What the admin shows about a file's inspection (Policy 3: integrity, streaming
 * readiness, browser compatibility and download availability are separate
 * facts). Presentation only. A fact the database did not report is shown as
 * missing, a check that did not run as not inspected, and neither is ever read
 * as verified. Nothing here grants, approves or publishes.
 */

/** verified: the database says so. failed: the file was refused. pending: recorded, not proof. missing: not reported. */
export type MediaTone = "verified" | "pending" | "warning" | "failed" | "missing";
export interface MediaStatus { label: string; value: string; tone: MediaTone; detail: string }

/** One file's inspection, from a channel candidate or an admin upload. */
export interface MediaFacts {
  fileName: string | null;
  /** False: no inspection evidence is recorded for this file. */
  inspected: boolean;
  policyVersion: number | null;
  checkedAt: string | null;
  container: string | null;
  video: string | null;
  audio: string | null;
  reasons: readonly string[];
  /** The single verdict of the earlier MP4 policies (1 and 2). Null: not reported. */
  passed: boolean | null;
  /** The separate Policy 3 facts. Undefined: this database does not report them. */
  policy3?: {
    integrity: string; streaming: string; browsers: Readonly<Record<string, string>> | null;
    audioTracks: number | null; subtitleTracks: number | null; warnings: readonly string[];
  };
}
/** The server's download setting and whether this version is published. Never a client-side decision. */
export interface DownloadContext { enabled: boolean; published: boolean }
export interface MediaReport {
  /** Which evidence the page is reading, in one sentence. */
  basis: string;
  statuses: MediaStatus[];
  details: { label: string; value: string }[];
  reasons: string[];
  warnings: string[];
  browsers: { name: string; value: string }[];
}

const human = (code: string) => code.replaceAll("_", " ");
const UNREPORTED = "Not reported";
const NEEDS_UPDATE = "Not reported by this source. On Supabase the separate facts arrive with the Policy 3 update (migration 20261011192618).";
const BOUNDED = "A bounded check of the index and samples. It is not proof that the whole file is intact.";

/** The check could not read the file. That says nothing about the file itself. */
const UNREAD = /^media_read_|^(media_unreadable|probe_timeout|moov_over_budget|no_evidence)$/;
const refused = (reasons: readonly string[]) => reasons.some((reason) => !UNREAD.test(reason));

const WARNINGS: Record<string, string> = {
  mp4_startup_tail_required: "The MP4 keeps its index at the end, so playback needs one extra request before it starts.",
  fragmented_mp4_not_tested: "Fragmented MP4 has not been tested in the player.",
  multiple_video_tracks_not_tested: "More than one video track; only one has been tested.",
  ac3_audio_silent_in_tested_browsers: "AC-3 audio was silent in every browser tested.",
  hevc_device_decoder_required: "HEVC video plays only where the device has a hardware decoder.",
  firefox_mkv_streaming_unreliable: "Firefox does not stream MKV reliably.",
  audio_track_switching_not_available: "More than one audio track; the player plays only the default one.",
  embedded_subtitles_not_displayed: "Embedded subtitles are not shown by the player.",
};
const BROWSER_NAMES: Record<string, string> = { chromium: "Chrome and Edge", firefox: "Firefox", safari: "Safari (macOS)", ios: "iPhone and iPad", android: "Android" };
const BROWSER_VALUES: Record<string, string> = {
  tested_combination: "Tested combination",
  tested_video_only_silent_audio: "Picture only, audio silent",
  device_dependent_or_untested: "Device-dependent or untested",
  streaming_unreliable: "Streaming unreliable",
  real_device_not_tested: "Not tested on a real device",
};

const BROWSERS = Object.keys(BROWSER_NAMES);
/** The recorded per-browser predictions, keeping only the known browsers and text values. */
export function browserProfile(profile: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> | null {
  if (!profile) return null;
  return Object.fromEntries(BROWSERS.flatMap((name) => { const value = profile[name]; return typeof value === "string" ? [[name, value.slice(0, 60)]] : []; }));
}

function integrity(facts: MediaFacts): Omit<MediaStatus, "label"> {
  if (!facts.inspected) return { value: "Not inspected", tone: "missing", detail: "No inspection evidence is recorded for this file." };
  const status = facts.policy3?.integrity;
  if (status === undefined) return { value: UNREPORTED, tone: "missing", detail: NEEDS_UPDATE };
  if (status === "verified") return { value: "Verified", tone: "verified", detail: "The database records verified integrity for this file." };
  if (status === "metadata_consistent") return { value: "Metadata consistent, not verified", tone: "pending", detail: BOUNDED };
  if (status === "incomplete") return refused(facts.reasons)
    ? { value: "Failed", tone: "failed", detail: "The file was refused. See the reasons below." }
    : { value: "Inspection incomplete", tone: "pending", detail: "The check could not read enough of the file. This is not a verdict on the file." };
  if (status === "legacy_unassessed") return { value: "Not assessed", tone: "missing", detail: `Inspected under policy ${facts.policyVersion ?? "1 or 2"}, which did not assess integrity separately.` };
  return { value: `Unrecognised: ${human(status)}`, tone: "missing", detail: "This page does not know this status and does not treat it as verified." };
}

function streaming(facts: MediaFacts): Omit<MediaStatus, "label"> {
  if (!facts.inspected) return { value: "Not inspected", tone: "missing", detail: "No inspection evidence is recorded for this file." };
  const status = facts.policy3?.streaming;
  // The earlier policies gave one verdict: a fast-start MP4 the player can stream, or not.
  if (status === undefined || status === "legacy_unassessed") {
    if (facts.passed === true) return { value: "Verified by the earlier MP4 policy", tone: "verified", detail: `Policy ${facts.policyVersion ?? "1 or 2"}: a fast-start MP4, checked in bounded reads.` };
    if (facts.passed === false) return refused(facts.reasons)
      ? { value: "Failed", tone: "failed", detail: `Refused by policy ${facts.policyVersion ?? "1 or 2"}. See the reasons below.` }
      : { value: "Inspection incomplete", tone: "pending", detail: "The check could not read enough of the file. This is not a verdict on the file." };
    return { value: UNREPORTED, tone: "missing", detail: NEEDS_UPDATE };
  }
  if (status === "verified") return { value: "Verified", tone: "verified", detail: "The database records verified streaming for this file." };
  if (status === "potentially_playable") return { value: "Potentially playable, not verified", tone: "pending", detail: "The layout allows streaming. No playback of this file has been verified." };
  if (status === "potentially_playable_startup_warning") return { value: "Potentially playable, slow start, not verified", tone: "pending", detail: "The index is at the end of the file. No playback of this file has been verified." };
  if (status === "untested") return { value: "Untested layout, not verified", tone: "pending", detail: "This layout has not been tested in the player." };
  if (status === "unverified") return refused(facts.reasons)
    ? { value: "Failed", tone: "failed", detail: "The file was refused. See the reasons below." }
    : { value: "Not verified", tone: "pending", detail: "The check did not get far enough to assess streaming." };
  return { value: `Unrecognised: ${human(status)}`, tone: "missing", detail: "This page does not know this status and does not treat it as verified." };
}

const NOT_BLOCKING = "A prediction from the container and codecs, not a test of this file. It does not block publication.";
function browsers(facts: MediaFacts): Omit<MediaStatus, "label"> {
  if (!facts.inspected) return { value: "Not inspected", tone: "missing", detail: "No inspection evidence is recorded for this file." };
  if (!facts.policy3) return { value: UNREPORTED, tone: "missing", detail: NEEDS_UPDATE };
  const profile = facts.policy3.browsers;
  if (!profile) return { value: "Unknown", tone: "missing", detail: "The inspection did not get far enough to predict browser support." };
  const desktop = [profile.chromium, profile.firefox];
  if (desktop.some((value) => value === undefined || !(value in BROWSER_VALUES))) return { value: "Unknown", tone: "missing", detail: "The recorded profile is incomplete or not recognised." };
  if (desktop.some((value) => value === "streaming_unreliable" || value === "tested_video_only_silent_audio")) return { value: "Limited in some browsers", tone: "warning", detail: NOT_BLOCKING };
  if (desktop.some((value) => value === "device_dependent_or_untested")) return { value: "Browser-dependent", tone: "warning", detail: NOT_BLOCKING };
  return { value: "Tested combination on desktop", tone: "pending", detail: `${NOT_BLOCKING} Safari, iPhone and Android are not tested.` };
}

function download(facts: MediaFacts, context: DownloadContext): Omit<MediaStatus, "label"> {
  if (!context.enabled) return { value: "Switched off", tone: "missing", detail: "Downloads are off on this server (MEDIA_GATEWAY_DOWNLOADS_ENABLED). No download link is issued for any movie." };
  if (!context.published) return { value: "Not available until published", tone: "missing", detail: "Only a published version can be downloaded." };
  if (facts.inspected && facts.container !== null && facts.container !== "mp4" && facts.container !== "mkv") return { value: "Not available", tone: "missing", detail: "Only MP4 and MKV originals are served as downloads." };
  return { value: "Switched on", tone: "pending", detail: "Signed-in viewers may download the original file; every request is authorized again. This page cannot confirm that the gateway is running with its download resolver." };
}

/** `download`: omit where the page has no server setting to show (the offline fixture). */
export function mediaReport(facts: MediaFacts, context?: DownloadContext): MediaReport {
  const policy3 = facts.policy3;
  const count = (value: number | null | undefined) => (value === null || value === undefined ? UNREPORTED : String(value));
  return {
    basis: !facts.inspected ? "No inspection evidence is recorded for this file."
      : facts.policyVersion === 3 ? "Policy 3: the original file, inspected in bounded reads. Metadata and potential playability are recorded; they are not verification."
      : facts.policyVersion === null ? "Inspection evidence with no recorded policy version."
      : `Policy ${facts.policyVersion}: the earlier fast-start MP4 check, in bounded reads.`,
    statuses: [
      { label: "Media integrity", ...integrity(facts) },
      { label: "Streaming readiness", ...streaming(facts) },
      { label: "Browser compatibility", ...browsers(facts) },
      ...(context ? [{ label: "Download availability", ...download(facts, context) }] : []),
    ],
    details: [
      { label: "Original container", value: facts.container === "mp4" || facts.container === "mkv" ? facts.container.toUpperCase() : facts.container ? human(facts.container) : UNREPORTED },
      { label: "Original filename", value: facts.fileName ?? UNREPORTED },
      { label: "Video codec", value: facts.video ?? UNREPORTED },
      { label: "Audio codec", value: facts.audio ?? UNREPORTED },
      { label: "Audio tracks", value: count(policy3?.audioTracks) },
      { label: "Subtitle tracks", value: count(policy3?.subtitleTracks) },
      { label: "Inspection policy", value: facts.policyVersion === null ? UNREPORTED : `Version ${facts.policyVersion}` },
      { label: "Inspected", value: facts.checkedAt ? `${facts.checkedAt.slice(0, 16).replace("T", " ")} UTC` : facts.inspected ? UNREPORTED : "Never" },
    ],
    reasons: facts.reasons.map(reasonText),
    warnings: (policy3?.warnings ?? []).map((code) => WARNINGS[code] ?? `${human(code)}.`),
    browsers: Object.entries(policy3?.browsers ?? {}).map(([name, value]) => ({ name: BROWSER_NAMES[name] ?? human(name), value: BROWSER_VALUES[value] ?? `Unrecognised: ${human(value)}` })),
  };
}

/** A channel candidate's inspection. The offline fixture carries no codecs, policy or Policy 3 facts. */
export function candidateMedia(candidate: ReviewCandidate): MediaFacts {
  const evidence = candidate.evidence;
  return {
    fileName: candidate.event.media.name, inspected: evidence !== null, policyVersion: evidence?.policyVersion ?? null, checkedAt: evidence?.checkedAt ?? null,
    container: evidence?.containerName ?? null, video: evidence?.video ?? null, audio: evidence?.audio ?? null,
    reasons: evidence?.reasons ?? [], policy3: evidence?.facts,
    // The offline fixture records four booleans in place of the database's verdict.
    passed: evidence ? evidence.passed ?? (evidence.browser && evidence.container && evidence.gateway && evidence.accessible) : null,
  };
}

export interface Requirement { label: string; done: boolean; detail: string }
/**
 * The six things a channel candidate needs before it is on the site, and any
 * other gate the database reports. The gates are the database's own; this only
 * lays them out. Integrity and streaming are the two halves of the one media
 * gate: each is done only when the database reports it verified, and never
 * because a value is missing. Browser compatibility is not a requirement.
 */
export function publicationRequirements(candidate: ReviewCandidate): { requirements: Requirement[]; also: string[] } {
  const gates = candidate.gates ?? [];
  const [film, vj, media, rights] = steps(gates);
  const facts = candidateMedia(candidate);
  const [integrityStatus, streamingStatus] = mediaReport(facts).statuses;
  const policy3 = facts.policy3 !== undefined && facts.policyVersion === 3;
  // Under the earlier policies one verdict covers both, and the database's gate has the last word.
  const legacyPass = !policy3 && media.done && facts.passed === true;
  const integrityDone = policy3 ? integrityStatus.tone === "verified" : legacyPass;
  const streamingDone = policy3 ? streamingStatus.tone === "verified" : legacyPass;
  const approved = candidate.status === "published" || candidate.approval?.revision === candidate.revision;
  const blocked = (step: { blockers: string[] }) => step.blockers.map(human).join(", ");
  return {
    requirements: [
      { label: "Media integrity verified", done: integrityDone, detail: integrityDone ? (policy3 ? "verified" : "accepted under the earlier MP4 policy") : integrityStatus.value.toLowerCase() },
      { label: "Streaming readiness verified", done: streamingDone, detail: streamingDone ? (policy3 ? "verified" : "passed the earlier MP4 policy") : streamingStatus.value.toLowerCase() },
      { label: "Film identity confirmed", done: film.done, detail: film.done ? "done" : blocked(film) },
      { label: "VJ identity confirmed", done: vj.done, detail: vj.done ? "done" : blocked(vj) },
      { label: "Rights clearance approved", done: rights.done, detail: rights.done ? "done" : blocked(rights) },
      { label: "Final publication approval granted", done: approved, detail: approved ? (candidate.status === "published" ? "published" : `approved at revision ${candidate.revision}`)
        : candidate.approval ? `approved at revision ${candidate.approval.revision}, which is not the current one` : "not approved" },
    ],
    // The media gate is still the database's: if it stays closed although both halves read verified, say so.
    also: [...(!media.done && integrityDone && streamingDone ? media.blockers : []), ...otherGates(gates)],
  };
}
