import { describe, expect, it } from "vitest";
import { browserIdentity, browserSignals, mediaCompatibility, parseMediaProfile, readMediaProfile, unsupportedFailure, type BrowserSignals, type MediaProfile } from "./compatibility";

const MP4: MediaProfile = { container: "mp4", videoCodec: "h264", audioCodec: "aac", startupWarning: false };
const WIN: BrowserSignals = { engine: "chromium", platform: "windows", container: "", video: "", audio: "" };
describe("compatibility evidence versus prediction", () => {
  it.each(["mp4", "mkv"] as const)("uses Windows %s fixture evidence despite negative MIME hints, without verifying the movie", (container) => {
    expect(mediaCompatibility({ ...MP4, container }, WIN)).toMatchObject({ kind: "tested-combination", blocked: false });
    expect(mediaCompatibility({ ...MP4, container }, WIN).message).toContain("file and device have not been tested");
  });
  it("allows non-fast-start MP4 with a startup warning", () => {
    const result = mediaCompatibility({ ...MP4, startupWarning: true }, WIN);
    expect(result.blocked).toBe(false); expect(result.warnings.join()).toContain("does not mean the file is defective");
  });
  it.each(["aac", "mp3"])("never promotes Firefox MKV/%s to reliable streaming", (audioCodec) => {
    const result = mediaCompatibility({ ...MP4, container: "mkv", audioCodec }, { ...WIN, engine: "firefox" });
    expect(result.kind).toBe("browser-dependent"); expect(result.warnings.join()).toContain("whole file");
    if (audioCodec === "mp3") expect(result.warnings.join()).toContain("without audio");
  });
  it("distinguishes expected mobile behavior from Windows testing", () => {
    expect(mediaCompatibility(MP4, { ...WIN, platform: "android", container: "probably", video: "probably", audio: "probably" }).kind).toBe("expected");
  });
  it.each(["ios", "other"] as const)("makes no Safari/iOS claim on %s", (platform) => {
    expect(mediaCompatibility(MP4, { ...WIN, engine: "webkit", platform }).kind).toBe("unknown");
  });
  it("keeps HEVC device dependent and AC-3 audio warning separate", () => {
    expect(mediaCompatibility({ ...MP4, videoCodec: "hevc" }, WIN)).toMatchObject({ kind: "browser-dependent", blocked: false });
    expect(mediaCompatibility({ ...MP4, audioCodec: "ac3" }, WIN).warnings.join()).toContain("silently");
  });
  it("blocks only the known unsupported player container and retains default-track/subtitle caveats", () => {
    const result = mediaCompatibility({ ...MP4, container: "other" }, WIN);
    expect(result).toMatchObject({ kind: "unsupported", blocked: true, failure: "unsupported_container" });
    expect(result.warnings.join()).toContain("default track"); expect(result.warnings.join()).toContain("subtitles");
  });
  it("uses unknown for absent/incomplete metadata, never an inspection verification", () => {
    expect(mediaCompatibility(null, WIN).kind).toBe("unknown");
    expect(mediaCompatibility({ ...MP4, audioCodec: null }, WIN).kind).toBe("unknown");
  });
  it("keeps MIME signals advisory and identifies browser/platform including touch iPad", () => {
    expect(browserIdentity("Mozilla Windows Chrome/154")).toEqual({ engine: "chromium", platform: "windows" });
    expect(browserIdentity("Mozilla Windows Firefox/157").engine).toBe("firefox");
    expect(browserIdentity("Mozilla Macintosh AppleWebKit/605", 5)).toEqual({ engine: "webkit", platform: "ios" });
    const signals = browserSignals(MP4, { canPlayType: () => "probably" }, "Mozilla Android Chrome/154");
    expect(signals).toMatchObject({ engine: "chromium", platform: "android", video: "probably" });
  });
  it("classifies codec failures only when a gateway byte probe confirms availability", () => {
    expect(unsupportedFailure({ ...MP4, videoCodec: "hevc" })).toBe("unsupported_video");
    expect(unsupportedFailure({ ...MP4, audioCodec: "ac3" })).toBe("unsupported_audio");
    expect(unsupportedFailure(MP4)).toBe("unsupported");
  });
});
describe("optional safe public media projection", () => {
  it("whitelists facts and drops all raw/private fields", () => {
    expect(parseMediaProfile({ container: "mkv", video_codec: "h264", audio_codec: "aac", streaming_status: "potentially_playable_startup_warning", chat_id: "secret", tracks: [{ title: "secret" }], verified: true })).toEqual({ ...MP4, container: "mkv", startupWarning: true });
    expect(parseMediaProfile({ container: "mkv", video_codec: "private-value", audio_codec: null })).toMatchObject({ videoCodec: "unknown", audioCodec: null });
  });
  it.each([null, [], {}, "secret"])("tolerates absent/malformed projection %j", (value) => expect(parseMediaProfile(value)).toBeNull());
  it("does not break movie pages on missing RPC, legacy schema, or outage", async () => {
    expect(await readMediaProfile(async () => ({ data: null, error: { code: "PGRST202" } }))).toBeNull();
    expect(await readMediaProfile(async () => { throw new Error("offline"); })).toBeNull();
    expect(await readMediaProfile(async () => ({ data: { container: "mp4", video_codec: "h264", audio_codec: "aac" }, error: null }))).toEqual(MP4);
  });
});
