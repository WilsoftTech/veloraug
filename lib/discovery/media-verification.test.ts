import { describe, expect, it, vi } from "vitest";
import { verifyChannelMedia, VERIFICATION_METHOD } from "./media-verification";
import { AAC_LC, H264_HIGH, HEVC, probeOf, virtualMp4 } from "./synthetic-media";
import { MEDIA_POLICY_VERSION } from "@/lib/ingestion/media";

const identity = `tg1-${"a".repeat(64)}`;
const ports = (file: ReturnType<typeof virtualMp4>, probe: (head: Uint8Array) => Promise<unknown> = async (head) => probeOf(undefined, head.length)) =>
  ({ read: file.read, probe: vi.fn(probe), gatewayCompatible: true });

describe("bounded channel media verification (E3.8A)", () => {
  it("verifies a canonical fast-start MP4 from a bounded index, sample and tail", async () => {
    const file = virtualMp4();
    const port = ports(file);
    const evidence = await verifyChannelMedia({ identity, sizeBytes: file.size }, port);
    expect(evidence).toEqual({ identity, method: VERIFICATION_METHOD, policy_version: MEDIA_POLICY_VERSION, media_class: "canonical", reasons: [],
      container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: true, bytes_read: evidence.bytes_read });
    // A ~1 GB document costs under 80 KiB: index, 64 KiB sample, headers and tail.
    expect(evidence.bytes_read).toBeLessThan(80 * 1024);
    expect(file.reads.every((read) => read.offset < file.head.length || read.offset >= file.size - 4096)).toBe(true);
    expect((port.probe.mock.calls[0][0] as Uint8Array).length).toBe(24 + 2048 + 64 * 1024);
  });

  it("never records more than a bounded, playback-policy claim", async () => {
    const file = virtualMp4();
    const evidence = await verifyChannelMedia({ identity, sizeBytes: file.size }, { ...ports(file), gatewayCompatible: false });
    expect(evidence.media_class).toBe("canonical");
    expect(evidence.playback_ready).toBe(false); // not read through the gateway's reader: not playback-ready
    expect(evidence).not.toHaveProperty("full_integrity");
  });

  it("records unsupported codecs as such (HEVC is never playback-ready)", async () => {
    const file = virtualMp4();
    const evidence = await verifyChannelMedia({ identity, sizeBytes: file.size }, ports(file, async (head) => probeOf([HEVC, AAC_LC], head.length)));
    expect(evidence).toMatchObject({ media_class: "video_transcode_required", video_codec: "hevc", playback_ready: false });
    expect(evidence.reasons).toContain("video_codec_hevc");
  });

  it("refuses a non-fast-start file without probing it", async () => {
    const file = virtualMp4({ fastStart: false });
    const port = ports(file);
    expect(await verifyChannelMedia({ identity, sizeBytes: file.size }, port)).toMatchObject({ media_class: "unverified", reasons: ["mp4_not_fast_start"], playback_ready: false });
    expect(port.probe).not.toHaveBeenCalled();
  });

  it("refuses a container whose boxes do not cover the size Telegram reports", async () => {
    const file = virtualMp4();
    expect(await verifyChannelMedia({ identity, sizeBytes: file.size + 100 }, ports(file))).toMatchObject({ media_class: "unverified", reasons: ["mp4_layout_incomplete"] });
  });

  it("refuses a document that cannot be read to its end", async () => {
    const short = virtualMp4({ truncateTo: 100_000 });
    expect(await verifyChannelMedia({ identity, sizeBytes: short.size }, ports(short))).toMatchObject({ media_class: "unverified", reasons: ["media_unreadable"], accessible: false });
    const failing = virtualMp4({ failFrom: 500_000_000 });
    expect(await verifyChannelMedia({ identity, sizeBytes: failing.size }, ports(failing))).toMatchObject({ media_class: "unverified", reasons: ["media_unreadable"] });
  });

  it("refuses an index larger than the budget instead of reading it", async () => {
    const file = virtualMp4({ moovBytes: 64 * 1024 });
    const port = ports(file);
    expect(await verifyChannelMedia({ identity, sizeBytes: file.size }, port, { maxHeadBytes: 32 * 1024, tailBytes: 4096 })).toMatchObject({ reasons: ["moov_over_budget"] });
    expect(port.probe).not.toHaveBeenCalled();
  });

  it("refuses non-MP4 and unprobeable documents", async () => {
    const mkv = { size: 10_000, read: async (offset: number, length: number) => new Uint8Array(Math.min(length, 10_000 - offset)).fill(0x1a) };
    expect(await verifyChannelMedia({ identity, sizeBytes: mkv.size }, { read: mkv.read, probe: async () => ({}), gatewayCompatible: true })).toMatchObject({ reasons: ["container_not_mp4"] });
    const file = virtualMp4();
    expect(await verifyChannelMedia({ identity, sizeBytes: file.size }, ports(file, async () => { throw new Error("ffprobe exited 1"); }))).toMatchObject({ reasons: ["probe_failed"], media_class: "unverified" });
    expect(await verifyChannelMedia({ identity, sizeBytes: file.size }, ports(file, async () => ({ not: "a probe" })))).toMatchObject({ reasons: ["probe_failed"] });
  });

  it("binds evidence to a well-formed identity only", async () => {
    const file = virtualMp4();
    await expect(verifyChannelMedia({ identity: "sf1-" + "a".repeat(64), sizeBytes: file.size }, ports(file))).rejects.toThrow("verification_identity_invalid");
    await expect(verifyChannelMedia({ identity, sizeBytes: 0 }, ports(file))).rejects.toThrow("verification_identity_invalid");
  });

  it("does not trust the head-only probe's size field", async () => {
    const file = virtualMp4();
    const evidence = await verifyChannelMedia({ identity, sizeBytes: file.size }, ports(file, async () => probeOf([H264_HIGH, AAC_LC], 7)));
    expect(evidence.reasons).not.toContain("size_mismatch");
    expect(evidence.media_class).toBe("canonical");
  });
});
