/**
 * Synthetic media for offline verification tests (E3.8A). A virtual MP4 of any
 * size: real ftyp/moov/mdat box headers, and zeros for the media data, which
 * the bounded verifier must never need. Plus ffprobe-shaped JSON for the
 * existing policy. No file, network or Telegram access.
 */

export const H264_HIGH = { index: 0, codec_type: "video", codec_name: "h264", codec_tag_string: "avc1", profile: "High", level: 40, width: 1920, height: 1080, pix_fmt: "yuv420p", field_order: "progressive", r_frame_rate: "24/1", time_base: "1/12288", start_time: "0.000000", duration: "5208.291667" };
export const AAC_LC = { index: 1, codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a", profile: "LC", sample_rate: "48000", channels: 2, channel_layout: "stereo", bit_rate: "128000", time_base: "1/48000", start_time: "0.000000" };
export const HEVC = { ...H264_HIGH, codec_name: "hevc", codec_tag_string: "hvc1", profile: "Main" };

/** ffprobe output for a head-only probe: the size reported is the head's, which the verifier discards. */
export function probeOf(streams: object[] = [H264_HIGH, AAC_LC], headBytes = 4096) {
  return { streams, format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "5208.293719", size: String(headBytes), tags: { major_brand: "isom" } } };
}

function box(type: string, size: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const header = new Uint8Array(8 + payload.length);
  new DataView(header.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
  header.set(payload, 8);
  return header;
}

export interface VirtualFile {
  size: number;
  /** Bytes of the boxes before mdat's payload (what a verifier may read). */
  head: Uint8Array;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Every (offset, length) read so far. */
  reads: { offset: number; length: number }[];
}

/**
 * ftyp, then moov (fast start) or mdat first (not fast start), with the media
 * data as zeros. `truncateTo` serves fewer bytes than the declared size (a
 * container that does not match Telegram's size), `failFrom` throws for reads at
 * or past that offset (an unreadable tail).
 */
export function virtualMp4(options: { size?: number; moovBytes?: number; fastStart?: boolean; truncateTo?: number; failFrom?: number } = {}): VirtualFile {
  const size = options.size ?? 1_004_462_878;
  const moovBytes = options.moovBytes ?? 2048;
  const ftyp = box("ftyp", 24, new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]));
  const moov = box("moov", moovBytes, new Uint8Array(moovBytes - 8));
  const mdatSize = size - ftyp.length - moov.length;
  const parts = options.fastStart === false
    ? [ftyp, box("mdat", mdatSize), new Uint8Array(0)]
    : [ftyp, moov, box("mdat", mdatSize)];
  const head = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { head.set(part, at); at += part.length; }
  const tailMoovAt = size - moov.length;
  const file: VirtualFile = {
    size, head, reads: [],
    async read(offset, length) {
      file.reads.push({ offset, length });
      if (options.failFrom !== undefined && offset + length > options.failFrom) throw new Error("synthetic_read_failure");
      const end = Math.min(offset + length, options.truncateTo ?? size);
      const out = new Uint8Array(Math.max(0, end - offset));
      for (let i = 0; i < out.length; i++) {
        const position = offset + i;
        if (position < head.length) out[i] = head[position];
        else if (options.fastStart === false && position >= tailMoovAt) out[i] = moov[position - tailMoovAt] ?? 0;
      }
      return out;
    },
  };
  return file;
}
