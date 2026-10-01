import { describe, expect, it } from "vitest";
import {
  classifyMedia,
  createPacketDigest,
  inspectionFromProbe,
  MEDIA_POLICY_VERSION,
  packetListArguments,
  readMp4Layout,
  remuxArguments,
  unreadableMedia,
  verifyRemux,
  type MediaInspection,
  type Mp4Layout,
  type PacketDigest,
} from "@/lib/ingestion/media";

/** ffprobe -show_format -show_streams -print_format json, trimmed to what the policy reads. */
const h264 = { index: 0, codec_type: "video", codec_name: "h264", codec_tag_string: "avc1", profile: "High", level: 40, width: 1920, height: 1080, pix_fmt: "yuv420p", field_order: "progressive", r_frame_rate: "24/1", time_base: "1/12288", start_time: "0.000000", duration: "5208.291667" };
const mp3 = { index: 1, codec_type: "audio", codec_name: "mp3", codec_tag_string: "mp4a", sample_rate: "44100", channels: 2, channel_layout: "stereo", bit_rate: "128000", time_base: "1/44100", start_time: "0.000000" };
const aac = { ...mp3, codec_name: "aac", profile: "LC", sample_rate: "48000" };
const mp4Format = (size = 1_000_000) => ({ format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "5208.293719", size: String(size), tags: { major_brand: "isom" } });
const mkvFormat = (size = 1_000_000) => ({ format_name: "matroska,webm", duration: "5208.293000", size: String(size) });
const FAST: Mp4Layout = { boxes: ["ftyp", "moov", "free", "mdat"], fastStart: true, fragmented: false, complete: true };
const SLOW: Mp4Layout = { boxes: ["ftyp", "free", "mdat", "moov"], fastStart: false, fragmented: false, complete: true };

const inspect = (streams: object[], format: object = mp4Format(), layout: Mp4Layout | null = FAST, size = 1_000_000) => inspectionFromProbe({ streams, format }, size, layout);
const classOf = (inspection: MediaInspection) => classifyMedia(inspection);

describe("classifyMedia (E3.5 policy)", () => {
  it("canonical: fast-start ISO MP4, H.264 High, MP3 or AAC-LC, nothing else", () => {
    expect(classOf(inspect([h264, mp3]))).toEqual({ class: "canonical", reasons: [], policyVersion: MEDIA_POLICY_VERSION });
    expect(classOf(inspect([h264, aac])).class).toBe("canonical");
  });

  it("remux: the E3.1/E3.3 reference, H.264 + MP3 in Matroska", () => {
    expect(classOf(inspect([{ ...h264, codec_tag_string: "[0][0][0][0]" }, { ...mp3, codec_tag_string: "[0][0][0][0]" }], mkvFormat(), null))).toEqual({ class: "remux", reasons: ["container_matroska"], policyVersion: MEDIA_POLICY_VERSION });
  });

  it("remux: an MP4 that is not fast-start, fragmented, QuickTime-branded or avc3-tagged is repackaged, not trusted for being MP4", () => {
    expect(classOf(inspect([h264, mp3], mp4Format(), SLOW))).toMatchObject({ class: "remux", reasons: ["mp4_not_fast_start"] });
    expect(classOf(inspect([h264, mp3], mp4Format(), { ...FAST, fragmented: true }))).toMatchObject({ class: "remux", reasons: ["mp4_fragmented"] });
    expect(classOf(inspect([h264, mp3], { ...mp4Format(), tags: { major_brand: "qt  " } }))).toMatchObject({ class: "remux", reasons: ["mp4_brand_qt"] });
    expect(classOf(inspect([{ ...h264, codec_tag_string: "avc3" }, mp3]))).toMatchObject({ class: "remux", reasons: ["h264_tag_avc3"] });
    // An "MP4" whose bytes are not ISO-BMFF at all (no ftyp first) is not an MP4.
    expect(classOf(inspect([h264, mp3], mp4Format(), null))).toMatchObject({ class: "remux", reasons: ["container_mov"] });
  });

  it("audio_normalization: acceptable video with audio outside policy", () => {
    expect(classOf(inspect([h264, { ...mp3, codec_name: "ac3", channels: 6, channel_layout: "5.1(side)" }]))).toEqual({ class: "audio_normalization", reasons: ["audio_codec_ac3"], policyVersion: MEDIA_POLICY_VERSION });
    expect(classOf(inspect([h264, { ...aac, profile: "HE-AAC" }])).reasons).toEqual(["aac_profile_he_aac"]);
    expect(classOf(inspect([h264, { ...aac, channels: 6 }])).reasons).toEqual(["audio_channels_6"]);
    expect(classOf(inspect([h264, { ...mp3, sample_rate: "96000" }])).reasons).toEqual(["audio_sample_rate_96000"]);
  });

  it("video_transcode_required: any video outside H.264 8-bit 4:2:0 progressive, level 5.1, 4096x2304", () => {
    expect(classOf(inspect([{ ...h264, codec_name: "hevc", profile: "Main" }, mp3]))).toMatchObject({ class: "video_transcode_required", reasons: ["video_codec_hevc"] });
    expect(classOf(inspect([{ ...h264, codec_name: "mpeg4", profile: "Simple Profile" }, mp3])).reasons).toEqual(["video_codec_mpeg4"]);
    expect(classOf(inspect([{ ...h264, profile: "High 10", pix_fmt: "yuv420p10le" }, mp3])).reasons).toEqual(["h264_profile_high_10", "h264_pixel_format_yuv420p10le"]);
    expect(classOf(inspect([{ ...h264, level: 52 }, mp3])).reasons).toEqual(["h264_level_52"]);
    expect(classOf(inspect([{ ...h264, width: 7680, height: 4320 }, mp3])).reasons).toEqual(["video_dimensions_over_policy"]);
    expect(classOf(inspect([{ ...h264, field_order: "tt" }, mp3])).reasons).toEqual(["video_interlaced"]);
    // The audio problem is reported with it, so the operator sees everything at once.
    expect(classOf(inspect([{ ...h264, codec_name: "vp9" }, { ...mp3, codec_name: "dts" }])).reasons).toEqual(["video_codec_vp9", "audio_codec_dts"]);
  });

  it("manual_review: stream topology the policy will not guess about", () => {
    const cases: Array<[object[], string]> = [
      [[], "no_streams"],
      [[mp3], "no_video"],
      [[h264], "no_audio"],
      [[h264, { ...h264, index: 2 }, mp3], "multiple_video_streams"],
      [[h264, mp3, { ...mp3, index: 2 }], "multiple_audio_streams"],
      [[h264, mp3, { index: 2, codec_type: "subtitle", codec_name: "subrip" }], "subtitle_streams"],
      [[h264, mp3, { index: 2, codec_type: "attachment", codec_name: "ttf" }], "attachment_streams"],
      [[h264, mp3, { index: 2, codec_type: "data", codec_name: "bin_data" }], "data_streams"],
      [[h264, mp3, { index: 2, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }], "attached_picture"],
    ];
    for (const [streams, reason] of cases) {
      const result = classOf(inspect(streams));
      expect(result.class, reason).toBe("manual_review");
      expect(result.reasons, reason).toContain(reason);
    }
  });

  it("manual_review also lists the video and audio findings that are already known", () => {
    const cover = { index: 2, codec_type: "video", codec_name: "mjpeg", profile: "Baseline", pix_fmt: "yuvj420p", disposition: { attached_pic: 1 } };
    expect(classOf(inspect([{ ...h264, codec_name: "hevc", profile: "Main 10", pix_fmt: "yuv420p10le" }, mp3, cover]))).toMatchObject({ class: "manual_review", reasons: ["attached_picture", "video_codec_hevc"] });
    expect(classOf(inspect([h264, mp3, cover])).reasons).toEqual(["attached_picture"]);
  });

  it("manual_review: unknown or inconsistent duration, unknown frame rate, a probe size that is not the file's", () => {
    expect(classOf(inspect([h264, mp3], { ...mp4Format(), duration: undefined })).reasons).toEqual(["duration_unknown"]);
    expect(classOf(inspect([{ ...h264, duration: "100.0" }, mp3])).reasons).toEqual(["duration_inconsistent"]);
    expect(classOf(inspect([{ ...h264, r_frame_rate: "0/0" }, mp3])).reasons).toEqual(["frame_rate_unknown"]);
    expect(classOf(inspect([h264, mp3], mp4Format(999), FAST, 1_000_000)).reasons).toEqual(["size_mismatch"]);
  });

  it("is deterministic and never reads the extension: only streams and bytes decide", () => {
    const one = inspect([h264, mp3], mkvFormat(), null);
    expect(classifyMedia(one)).toEqual(classifyMedia(structuredClone(one)));
    // The inspection carries no file name at all.
    expect(JSON.stringify(one)).not.toMatch(/\.mkv|\.mp4/);
  });

  it("a probe failure is manual review with its code", () => {
    expect(unreadableMedia("probe_failed")).toEqual({ class: "manual_review", reasons: ["probe_failed"], policyVersion: MEDIA_POLICY_VERSION });
  });

  it("refuses output that is not a probe result", () => {
    expect(() => inspectionFromProbe({ streams: "nope" }, 1, null)).toThrow();
    expect(() => inspectionFromProbe(null, 1, null)).toThrow();
  });
});

// ---------------------------------------------------------------------------

/** Builds a file image from top-level boxes: [type, payload bytes, large?]. */
function boxes(...spec: Array<[string, number, boolean?]>): Uint8Array {
  const parts = spec.map(([type, payload, large]) => {
    const header = large ? 16 : 8;
    const bytes = new Uint8Array(header + payload);
    const view = new DataView(bytes.buffer);
    if (large) {
      view.setUint32(0, 1);
      view.setBigUint64(8, BigInt(header + payload));
    } else view.setUint32(0, header + payload);
    bytes.set(new TextEncoder().encode(type), 4);
    return bytes;
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const reader = (bytes: Uint8Array) => {
  const reads: number[] = [];
  return {
    reads,
    read: async (offset: number, length: number) => {
      reads.push(length);
      return bytes.subarray(offset, offset + length);
    },
  };
};

describe("readMp4Layout (fast start from box headers)", () => {
  it("fast start: moov before mdat", async () => {
    const file = boxes(["ftyp", 24], ["moov", 500], ["free", 8], ["mdat", 4000]);
    expect(await readMp4Layout(file.length, reader(file).read)).toEqual({ boxes: ["ftyp", "moov", "free", "mdat"], fastStart: true, fragmented: false, complete: true });
  });

  it("not fast start: moov after mdat; fragmented: moof", async () => {
    const slow = boxes(["ftyp", 24], ["mdat", 4000], ["moov", 500]);
    expect(await readMp4Layout(slow.length, reader(slow).read)).toMatchObject({ fastStart: false });
    const fragmented = boxes(["ftyp", 24], ["moov", 100], ["moof", 50], ["mdat", 400]);
    expect(await readMp4Layout(fragmented.length, reader(fragmented).read)).toMatchObject({ fragmented: true });
  });

  it("reads 64-bit box sizes, a size-0 last box, and only box headers", async () => {
    const file = boxes(["ftyp", 24], ["moov", 300], ["mdat", 100_000, true]);
    const r = reader(file);
    expect(await readMp4Layout(file.length, r.read)).toMatchObject({ fastStart: true, complete: true });
    expect(r.reads.every((n) => n <= 16)).toBe(true);
    const zero = boxes(["ftyp", 24], ["moov", 50], ["mdat", 64]);
    new DataView(zero.buffer).setUint32(8 + 24 + 8 + 50, 0);
    expect(await readMp4Layout(zero.length, reader(zero).read)).toMatchObject({ fastStart: true, complete: true });
  });

  it("is null for a file that is not ISO-BMFF, and incomplete for a truncated or corrupt one", async () => {
    const mkv = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await readMp4Layout(mkv.length, reader(mkv).read)).toBeNull();
    const truncated = boxes(["ftyp", 24], ["moov", 100], ["mdat", 400]).subarray(0, 200);
    expect(await readMp4Layout(truncated.length, reader(truncated).read)).toMatchObject({ complete: false });
    const garbage = boxes(["ftyp", 24], ["moov", 40]);
    new DataView(garbage.buffer).setUint32(32, 3); // a size under 8 bytes
    expect(await readMp4Layout(garbage.length, reader(garbage).read)).toMatchObject({ complete: false, fastStart: false });
  });
});

// ---------------------------------------------------------------------------

describe("Class 2 FFmpeg arguments", () => {
  const evil = "C:\\Movies\\It's a \"Test\" [2024] -c:v libx264 & del *.mkv; $(rm -rf).mkv";

  it("copy only: no codec, filter, bitrate or encoder option can appear", () => {
    const args = remuxArguments(evil, "G:\\Movies\\.velora-renditions\\sf1-0\\out.mp4.partial");
    expect(args).toEqual(["-hide_banner", "-nostdin", "-v", "error", "-n", "-i", evil, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "G:\\Movies\\.velora-renditions\\sf1-0\\out.mp4.partial"]);
    const options = args.filter((arg) => arg !== evil);
    expect(options.join(" ")).not.toMatch(/-c:[va]|-codec|-vcodec|-acodec|lib(x26|mp3|fdk)|-b:|-crf|-vf|-af|-filter|-preset|-ar |-ac /);
    // A hostile file name is exactly one argument, never parsed.
    expect(args.filter((arg) => arg.includes("libx264"))).toEqual([evil]);
  });

  it("the packet listing also copies (never decodes) the same two streams", () => {
    expect(packetListArguments("x.mkv")).toEqual(["-hide_banner", "-nostdin", "-v", "error", "-i", "x.mkv", "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "framemd5", "-"]);
  });
});

describe("packet digests and remux verification", () => {
  const listing = (tb: number, lines: Array<[number, number, string]>) => [
    "#format: frame checksums",
    "#version: 2",
    `#tb 0: 1/${tb}`,
    ...lines.map(([stream, size, md5], i) => `${stream}, ${i * tb}, ${i * tb}, ${tb}, ${size}, ${md5}`),
  ];
  const md5 = (n: number) => n.toString(16).padStart(32, "0");
  const packets: Array<[number, number, string]> = [[0, 900, md5(1)], [1, 417, md5(2)], [0, 120, md5(3)], [1, 418, md5(4)]];
  const digest = (lines: string[]) => {
    const d = createPacketDigest();
    lines.forEach((line) => d.push(line));
    return d.result();
  };

  it("ignores container time bases and interleaving: same packets, same digest", () => {
    const mkv = digest(listing(1000, packets));
    const mp4 = digest(listing(12288, [packets[0], packets[2], packets[1], packets[3]]));
    expect(mkv).toEqual(mp4);
    expect(mkv).toMatchObject({ video: { packets: 2, bytes: 1020 }, audio: { packets: 2, bytes: 835 } });
  });

  it("includes each stream's codec configuration, and ignores packet side data (as FFmpeg 9 prints it)", () => {
    const real = [
      "#format: frame checksums",
      "#extradata 0,                              46, e35ce58327e84c8a6ce05eb37db8866a",
      "0,        -83,          0,       41,     3142, 44d95de91089479d5c60e1eb219f406f",
      "1,        -25,        -25,       26,      208, fd88873b875c433f83c28a7ca2a66f13, S=1,       10, bc0f147f9fc5068d641f24be006b677b",
    ];
    const withSide = digest(real)!;
    expect(withSide).toMatchObject({ video: { packets: 1, bytes: 3142 }, audio: { packets: 1, bytes: 208 } });
    // The same payload with other side data (or none) is the same stream.
    expect(digest([real[1], real[2], "1, 0, 0, 26, 208, fd88873b875c433f83c28a7ca2a66f13"])).toEqual(withSide);
    // Different codec configuration (SPS/PPS) is not the same stream.
    expect(digest([real[1].replace("e35c", "ffff"), real[2], real[3]])!.video.sha256).not.toBe(withSide.video.sha256);
    expect(digest(["0, 0, 0, 1, 12, " + md5(1) + ", junk"])).toBeNull();
  });

  it("changes with any payload, size, order or count difference, and refuses a malformed listing", () => {
    const base = digest(listing(1000, packets))!;
    expect(digest(listing(1000, [[0, 900, md5(9)], ...packets.slice(1)]))!.video.sha256).not.toBe(base.video.sha256);
    expect(digest(listing(1000, [[0, 120, md5(3)], [1, 417, md5(2)], [0, 900, md5(1)], [1, 418, md5(4)]]))!.video.sha256).not.toBe(base.video.sha256);
    expect(digest(listing(1000, packets.slice(0, 3)))!.audio.packets).toBe(1);
    expect(digest(["0, 0, 0, 1, 12"])).toBeNull();
    expect(digest(["2, 0, 0, 1, 12, " + md5(1)])).toBeNull();
  });

  const source = inspect([{ ...h264, codec_tag_string: "[0][0][0][0]" }, { ...mp3, codec_tag_string: "[0][0][0][0]" }], mkvFormat(1_004_462_878), null, 1_004_462_878);
  const output = inspect([h264, mp3], mp4Format(1_007_441_962), FAST, 1_007_441_962);
  const same: PacketDigest = { video: { packets: 124_997, bytes: 990_000_000, sha256: "a".repeat(64) }, audio: { packets: 199_380, bytes: 83_000_000, sha256: "b".repeat(64) } };

  it("passes only for a canonical output with identical streams and packets", () => {
    expect(verifyRemux(source, output, same, structuredClone(same))).toMatchObject({ passed: true, failures: [] });
  });

  it("fails on any re-encode signal: packets, codec parameters, duration, or a non-canonical output", () => {
    const fail = (o: MediaInspection, p: PacketDigest = same) => verifyRemux(source, o, same, p).failures;
    expect(fail(output, { ...same, video: { ...same.video, sha256: "c".repeat(64) } })).toEqual(["video_packets_changed"]);
    expect(fail(output, { ...same, audio: { ...same.audio, packets: 199_379 } })).toEqual(["audio_packet_count_changed"]);
    expect(fail(inspect([{ ...h264, profile: "Main" }, mp3], mp4Format(1_007_441_962), FAST, 1_007_441_962))).toEqual(["video_profile_changed"]);
    expect(fail(inspect([h264, { ...mp3, sample_rate: "48000" }], mp4Format(1_007_441_962), FAST, 1_007_441_962))).toEqual(["audio_sampleRate_changed"]);
    expect(fail(inspect([h264, mp3], { ...mp4Format(1_007_441_962), duration: "5100" }, FAST, 1_007_441_962))).toContain("duration_changed");
    expect(fail(inspect([h264, mp3], mp4Format(1_007_441_962), SLOW, 1_007_441_962))).toEqual(["output_not_canonical:mp4_not_fast_start"]);
    expect(verifyRemux(source, output, { ...same, video: { packets: 0, bytes: 0, sha256: same.video.sha256 } }, { ...same, video: { packets: 0, bytes: 0, sha256: same.video.sha256 } }).failures).toContain("video_no_packets");
  });
});
