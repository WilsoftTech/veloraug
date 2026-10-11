// Generates the browser playback fixtures (tests/browser). Run:
//   npm run test:browser:fixtures
//
// Every fixture is synthetic: FFmpeg's own test pattern and a sine tone, so
// there is no third-party content and no rights question. They are a few
// hundred kilobytes each and are committed, so the browser suite needs no
// FFmpeg. This script is the only place FFmpeg encodes anything in this
// repository; it never touches a movie, and nothing in the product calls it.
//
// FFmpeg comes from VELORA_FFMPEG_PATH / VELORA_FFPROBE_PATH (the same
// variables the ingestion tools use), otherwise from PATH. Nothing is downloaded.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.VELORA_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.VELORA_FFPROBE_PATH || "ffprobe";

const SECONDS = 12;
const VIDEO_IN = ["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=12:duration=${SECONDS}`];
const tone = (hz, rate = 48000) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=${rate}:duration=${SECONDS}`];
// One keyframe a second, so a seek lands quickly on a decodable frame.
const H264 = ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-level", "3.0", "-pix_fmt", "yuv420p", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-b:v", "110k"];
const HEVC = ["-c:v", "libx265", "-preset", "medium", "-pix_fmt", "yuv420p", "-x265-params", "keyint=12:min-keyint=12:scenecut=0:log-level=error", "-b:v", "110k"];
const AAC = ["-c:a", "aac", "-b:a", "48k", "-ac", "2"];
const MP3 = ["-c:a", "libmp3lame", "-b:a", "64k", "-ac", "2"];
const AC3 = ["-c:a", "ac3", "-b:a", "96k", "-ac", "2"];
const MP4 = ["-f", "mp4"];
const FAST = ["-movflags", "+faststart", ...MP4];
const MKV = ["-f", "matroska"];
const AV = ["-map", "0:v:0", "-map", "1:a:0"];
const TWO_AUDIO = ["-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-metadata:s:a:0", "language=lug", "-metadata:s:a:1", "language=eng", "-disposition:a:0", "default", "-disposition:a:1", "0"];
const SUBS = ["-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0", "-metadata:s:s:0", "language=eng"];

const CODECS = { h264: "avc1.64001E", hevc: "hvc1.1.6.L93.B0", aac: "mp4a.40.2", mp3: "mp4a.6B", ac3: "ac-3" };
const MIME = { mp4: "video/mp4", mkv: "video/x-matroska" };

/**
 * `id` is the movie-version id the test gateway serves the file under.
 * `inputs`: extra inputs after the video (input 0). `subtitles` adds the SRT file as the last input.
 */
const FIXTURES = [
  { id: 1, file: "mp4-h264-aac-faststart.mp4", inputs: [tone(440)], args: [...AV, ...H264, ...AAC, ...FAST] },
  { id: 2, file: "mp4-h264-aac-moov-at-end.mp4", inputs: [tone(440)], args: [...AV, ...H264, ...AAC, ...MP4] },
  { id: 3, file: "mp4-h264-mp3-faststart.mp4", inputs: [tone(440, 44100)], args: [...AV, ...H264, ...MP3, ...FAST] },
  { id: 4, file: "mkv-h264-aac.mkv", inputs: [tone(440)], args: [...AV, ...H264, ...AAC, ...MKV] },
  { id: 5, file: "mkv-h264-mp3.mkv", inputs: [tone(440, 44100)], args: [...AV, ...H264, ...MP3, ...MKV] },
  { id: 6, file: "mkv-hevc-aac.mkv", inputs: [tone(440)], args: [...AV, ...HEVC, ...AAC, ...MKV] },
  { id: 7, file: "mp4-hevc-aac-faststart.mp4", inputs: [tone(440)], args: [...AV, ...HEVC, "-tag:v", "hvc1", ...AAC, ...FAST] },
  { id: 8, file: "mp4-h264-aac-two-audio.mp4", inputs: [tone(440), tone(880)], args: [...TWO_AUDIO, ...H264, ...AAC, ...FAST] },
  { id: 9, file: "mkv-h264-aac-two-audio.mkv", inputs: [tone(440), tone(880)], args: [...TWO_AUDIO, ...H264, ...AAC, ...MKV] },
  { id: 10, file: "mp4-h264-aac-subtitles.mp4", inputs: [tone(440)], subtitles: true, args: [...SUBS, ...H264, ...AAC, "-c:s", "mov_text", ...FAST] },
  { id: 11, file: "mkv-h264-aac-subtitles.mkv", inputs: [tone(440)], subtitles: true, args: [...SUBS, ...H264, ...AAC, "-c:s", "srt", ...MKV] },
  { id: 12, file: "mp4-h264-ac3-faststart.mp4", inputs: [tone(440)], args: [...AV, ...H264, ...AC3, ...FAST] },
  { id: 13, file: "mkv-h264-ac3.mkv", inputs: [tone(440)], args: [...AV, ...H264, ...AC3, ...MKV] },
];

function run(file, args, capture = false) {
  const result = spawnSync(file, args, { shell: false, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} failed: ${result.error?.message ?? result.stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
  }
  return capture ? result.stdout : "";
}

/** Top-level ISO-BMFF boxes: fast start means moov precedes mdat. Null for a file that is not MP4. */
function mp4FastStart(bytes) {
  const boxes = [];
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (boxes.length === 0 && type !== "ftyp") return null;
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size === 0) size = bytes.length - offset;
    if (size < 8) break;
    boxes.push(type);
    offset += size;
  }
  return boxes.includes("moov") && boxes.includes("mdat") ? boxes.indexOf("moov") < boxes.indexOf("mdat") : null;
}

/**
 * `--large <dir>`: four files of about 55 MB for tests/browser/startup.spec.ts, written to a
 * directory outside Git. One encode; the other three are the same streams in another layout.
 */
const large = process.argv.indexOf("--large");
if (large !== -1) {
  const dir = process.argv[large + 1];
  if (!dir) throw new Error("--large needs a directory");
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "large-mp4-index-at-end.mp4");
  const quiet = ["-hide_banner", "-nostdin", "-v", "error", "-y"];
  run(ffmpeg, [...quiet, "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=90", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=90",
    "-vf", "noise=alls=30:allf=t", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", "48", "-b:v", "5M", "-maxrate", "5M", "-bufsize", "10M",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-f", "mp4", source]);
  run(ffmpeg, [...quiet, "-i", source, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", join(dir, "large-mp4-faststart.mp4")]);
  run(ffmpeg, [...quiet, "-i", source, "-c", "copy", "-f", "matroska", join(dir, "large-mkv-cues-at-end.mkv")]);
  run(ffmpeg, [...quiet, "-i", source, "-c", "copy", "-reserve_index_space", "200k", "-f", "matroska", join(dir, "large-mkv-cues-at-front.mkv")]);
  console.log(`large fixtures written to ${dir}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "velora-fixtures-"));
try {
  const srt = join(work, "subs.srt");
  writeFileSync(srt, [1, 2, 3].map((n) => `${n}\n00:00:0${n * 3 - 2},000 --> 00:00:0${n * 3},000\nVelora UG test subtitle ${n}\n`).join("\n"));
  const manifest = [];
  for (const fixture of FIXTURES) {
    const output = join(here, fixture.file);
    rmSync(output, { force: true });
    const inputs = [...VIDEO_IN, ...fixture.inputs.flat(), ...(fixture.subtitles ? ["-i", srt] : [])];
    run(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-n", ...inputs, ...fixture.args, "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-threads", "1", output]);
    const probe = JSON.parse(run(ffprobe, ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", output], true));
    const bytes = readFileSync(output);
    const of = (type) => probe.streams.filter((stream) => stream.codec_type === type);
    const container = fixture.file.endsWith(".mkv") ? "mkv" : "mp4";
    const video = of("video")[0].codec_name;
    const audio = of("audio").map((stream) => stream.codec_name);
    manifest.push({
      id: fixture.id,
      file: fixture.file,
      container,
      formatName: probe.format.format_name,
      video,
      audio,
      subtitles: of("subtitle").map((stream) => stream.codec_name),
      fastStart: mp4FastStart(bytes),
      durationSeconds: Number(Number(probe.format.duration).toFixed(2)),
      mime: MIME[container],
      // What a page would pass to canPlayType(): the served type with RFC 6381 codec names.
      typeWithCodecs: `${MIME[container]}; codecs="${CODECS[video]}, ${CODECS[audio[0]]}"`,
      sizeBytes: statSync(output).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    console.log(`${fixture.file}  ${statSync(output).size} bytes`);
  }
  const version = /^ffmpeg version (\S+)/.exec(run(ffmpeg, ["-hide_banner", "-version"], true))?.[1] ?? "unknown";
  writeFileSync(join(here, "manifest.json"), `${JSON.stringify({ generator: `ffmpeg ${version}`, fixtures: manifest }, null, 2)}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
