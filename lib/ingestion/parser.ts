import { unifySeparators, vjKey } from "@/lib/ingestion/normalize";
import type { CatalogueKind } from "@/types/catalogue";
import type { KindDecision, ParseConfidence, ParsedFilename, ParseIssue, ParseIssueCode } from "@/types/ingestion";

/**
 * Filename parser: a file name or path in, suggestions out. Pure: no Next.js,
 * Supabase, Telegram, TMDB or file-system access. It never invents a value it
 * cannot read; what it cannot read becomes an issue. Parsed VJ text is not a
 * VJ identity (see vj.ts).
 */

export const SUPPORTED_EXTENSIONS: readonly string[] = ["mp4", "mkv", "avi", "mov", "m4v", "webm"];

/** Release/encoding tokens that are never part of a title or VJ name. */
const NOISE = /^(?:\d{3,4}p|4k|uhd|x26[45]|h26[45]|hevc|avc|aac\d*|ac3|dts|web|webdl|web-dl|webrip|bluray|blu-ray|brrip|bdrip|hdrip|dvdrip|hdtv|hdcam|camrip|luganda|translated)$/i;

const BOUNDARY = "-";
/** A VJ name longer than this is not trusted as one name. */
const MAX_VJ_WORDS = 3;

const BLOCKING: Record<ParseIssueCode, boolean> = {
  unsupported_extension: true,
  empty_title: true,
  missing_vj: true,
  multiple_vjs: true,
  vj_boundary_uncertain: false,
  missing_season: true,
  missing_episode: true,
  multi_episode: true,
  multiple_episode_markers: true,
  multiple_years: false,
};

/** Episode markers, most specific first. Each match is replaced by a boundary. */
const EPISODE_MARKERS: { pattern: RegExp; read: (m: RegExpExecArray) => { season: number | null; episode: number | null; multi?: boolean } }[] = [
  { pattern: /\bS(\d{1,2}) ?E(\d{1,4})(?: ?-? ?E\d{1,4})+\b/gi, read: (m) => ({ season: +m[1], episode: +m[2], multi: true }) },
  { pattern: /\bS(\d{1,2}) ?E(\d{1,4})\b/gi, read: (m) => ({ season: +m[1], episode: +m[2] }) },
  { pattern: /\bSeason ?(\d{1,2}) ?-? ?Episode ?(\d{1,4})\b/gi, read: (m) => ({ season: +m[1], episode: +m[2] }) },
  { pattern: /\b(\d{1,2})x(\d{2,3})\b/gi, read: (m) => ({ season: +m[1], episode: +m[2] }) },
  { pattern: /\b(?:S|Season ?)(\d{1,2})\b/gi, read: (m) => ({ season: +m[1], episode: null }) },
  { pattern: /\b(?:E|Ep|Episode ?)(\d{1,4})\b/gi, read: (m) => ({ season: null, episode: +m[1] }) },
];

export interface ParseOptions {
  /** Latest year read as a release year. Default: next calendar year (UTC). */
  maxYear?: number;
}

function splitName(input: string) {
  const fileName = input.split(/[\\/]/).pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const hasExtension = /^[a-z0-9]{2,4}$/.test(extension) && !/^\d+$/.test(extension);
  return { fileName, extension: hasExtension ? extension : "", stem: hasExtension ? fileName.slice(0, dot) : fileName };
}

export function parseFilename(input: string, options: ParseOptions = {}): ParsedFilename {
  const maxYear = options.maxYear ?? new Date().getUTCFullYear() + 1;
  const { fileName, extension, stem } = splitName(input);
  const issues = new Set<ParseIssueCode>();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) issues.add("unsupported_extension");

  let text = unifySeparators(stem.replace(/[[\](){}]/g, " "))
    .split(" ")
    .filter((token) => !NOISE.test(token))
    .join(" ");
  const normalizedName = text;

  // Episode markers.
  let season: number | null = null;
  let episode: number | null = null;
  let markers = 0;
  for (const { pattern, read } of EPISODE_MARKERS) {
    text = text.replace(pattern, (...args) => {
      const found = read(args as unknown as RegExpExecArray);
      markers += 1;
      if (found.multi) issues.add("multi_episode");
      if (markers === 1) ({ season, episode } = found);
      return ` ${BOUNDARY} `;
    });
  }
  const inferredKind = markers > 0 ? "series" : "movie";
  if (markers > 1) issues.add("multiple_episode_markers");
  if (markers > 0 && season === null) issues.add("missing_season");
  if (markers > 0 && episode === null) issues.add("missing_episode");

  const tokens = text.replace(/\bVJ-(?=\S)/gi, "VJ ").split(" ").filter(Boolean);
  const isYear = (token: string) => /^(?:19|20)\d{2}$/.test(token) && +token <= maxYear;
  const isWord = (token: string) => token !== BOUNDARY;

  // VJ: the words after "VJ" up to a boundary, a year or the end.
  const vjNames: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== "vj") continue;
    let end = i + 1;
    while (end < tokens.length && isWord(tokens[end]) && !isYear(tokens[end]) && tokens[end].toLowerCase() !== "vj") end++;
    let name = tokens.slice(i + 1, end);
    const titleWordsElsewhere = tokens.some((t, j) => (j < i || j >= end) && isWord(t) && t.toLowerCase() !== "vj" && !isYear(t));
    // "VJ Junior John Wick": no boundary, so only the first word is trusted.
    if (name.length > MAX_VJ_WORDS || (name.length > 1 && !titleWordsElsewhere)) {
      issues.add("vj_boundary_uncertain");
      name = name.slice(0, 1);
      end = i + 2;
    }
    if (name.length > 0) vjNames.push(name.join(" "));
    const start = i > 0 && tokens[i - 1].toLowerCase() === "by" ? i - 1 : i;
    tokens.splice(start, end - start, BOUNDARY);
    i = start;
  }
  const vjKeys = new Set(vjNames.map(vjKey));
  if (vjNames.length === 0) issues.add("missing_vj");
  if (vjKeys.size > 1) issues.add("multiple_vjs");

  // Year: the last year-like token, unless it is the only title word ("1917").
  let year: number | null = null;
  const yearIndexes = tokens.flatMap((token, i) => (isYear(token) ? [i] : []));
  const words = tokens.filter(isWord).length;
  if (yearIndexes.length > 0 && words > 1) {
    const at = yearIndexes[yearIndexes.length - 1];
    year = +tokens[at];
    tokens[at] = BOUNDARY;
    if (yearIndexes.length > 1) issues.add("multiple_years");
  }

  // Title: every remaining segment, in order. Nothing is dropped, so leftover
  // words make a TMDB mismatch (review) rather than a wrong match.
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (isWord(token)) segments[segments.length - 1].push(token);
    else segments.push([]);
  }
  const title =
    segments
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.join(" "))
      .join(" - ") || null;
  if (!title) issues.add("empty_title");

  const issueList: ParseIssue[] = [...issues].map((code) => ({ code, blocking: BLOCKING[code] }));
  const confidence: ParseConfidence = issueList.some((issue) => issue.blocking) ? "low" : issueList.length > 0 ? "medium" : "high";

  return {
    fileName,
    extension,
    normalizedName,
    inferredKind,
    title,
    vjText: vjNames[0] ?? null,
    year,
    season,
    episode,
    issues: issueList,
    confidence,
  };
}

/**
 * Media kind is explicit: the scan declares it (library folder, channel or CLI
 * flag). The filename only confirms it. A conflict never falls back to
 * "movie": a series file is never published as a movie because parsing or
 * matching failed.
 */
export function decideKind(declared: CatalogueKind | null, parsed: ParsedFilename): KindDecision {
  if (declared === null) return { status: "inferred", kind: parsed.inferredKind };
  // A declared series without markers is still a series; its missing
  // season/episode blocks approval (see approvalBlockers).
  if (declared === "movie" && parsed.inferredKind === "series") {
    return { status: "conflict", declared, inferred: parsed.inferredKind };
  }
  return { status: "confirmed", kind: declared };
}
