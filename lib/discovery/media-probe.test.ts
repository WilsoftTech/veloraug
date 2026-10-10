import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveMediaTools, runProcess, headProbe } from "@/lib/uploader/media-tools";
import { withReadRange } from "@/lib/uploader/scan";
import { channelMediaPort } from "./media-verification";
import { detectDocument } from "./events";

const tools = await resolveMediaTools();
it.skipIf(!tools.ok)("verifies a locally generated MP4 through the real bounded ffprobe adapter", async () => {
  if (!tools.ok) return;
  const directory = await mkdtemp(join(tmpdir(), "velora-e38b-probe-"));
  try {
    const file = join(directory, "fixture.mp4");
    const result = await runProcess(tools.tools.ffmpeg.path, ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", file], { timeoutMs: 30000, maxStdoutBytes: 65536 });
    expect(result.code).toBe(0);
    const size = (await stat(file)).size;
    const event = detectDocument({ update_id: 1, channel_post: { message_id: 1, date: 1791633600, chat: { id: -1005555555555, type: "channel" }, document: { file_id: "synthetic", file_unique_id: "AgADprobe001", file_size: size, file_name: "Fixture.2025.mp4", mime_type: "video/mp4" } } }, -1005555555555).event!;
    await withReadRange(file, async (read) => {
      const verified = await channelMediaPort(() => read, headProbe(tools.tools.ffprobe))(event);
      expect(verified.verification!.reasons).toEqual([]);
      expect(verified.verification).toMatchObject({ media_class: "canonical", playback_ready: true, video_codec: "h264", audio_codec: "aac", method: "bounded_mtproto_v1" });
      expect(verified.verification!.bytes_read).toBeLessThanOrEqual(size + 4096 + 64);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
