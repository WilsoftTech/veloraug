import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoviePlayer } from "@/components/movie-player";
import type { PlayableVersion } from "@/lib/playback/player";

const ONE = [{ id: 1, label: "VJ Ice P" }];
const TWO = [
  { id: 1, label: "VJ Ice P" },
  { id: 4, label: "VJ Junior" },
];
const session = vi.hoisted(() => ({ state: "unknown" }));
vi.mock("@/lib/session", () => ({ useSession: () => session.state }));
const render = (versions: PlayableVersion[] = ONE, downloads = true) => renderToStaticMarkup(<MoviePlayer versions={versions} signInHref="/sign-in?next=%2Fmovies%2Fon-the-hunt-2026" downloads={downloads} />);

afterEach(() => { vi.unstubAllGlobals(); session.state = "unknown"; });

describe("MoviePlayer before Play", () => {
  it("renders a Play button and no video, and requests nothing on page load", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const html = render();
    expect(html).toContain("Play");
    expect(html).not.toContain("<video");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders only catalogue ids and VJ names: no Telegram or gateway details", () => {
    const html = render(TWO);
    expect(html).not.toMatch(/token|telegram|chat|message|file_?id|access_?hash|stream\?|-100\d|127\.0\.0\.1|v1\//i);
  });

  it("offers a VJ choice only when several versions are playable", () => {
    expect(render(ONE)).not.toContain("<select");
    const html = render(TWO);
    expect(html).toContain("<select");
    expect(html).toContain('<option value="1" selected="">VJ Ice P</option>');
    expect(html).toContain('<option value="4">VJ Junior</option>');
  });

  it("renders nothing without a playable version", () => {
    expect(render([])).toBe('');
  });

  it("shows no Download control or download text while the server's switch is off, signed in or not", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const state of ["unknown", "signed-out", "signed-in"]) {
      session.state = state;
      const html = render(ONE, false);
      expect(html, state).toContain("Play");
      expect(html, state).not.toMatch(/Download|download manager/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows Download only for the signed-in UX hint, without requesting a capability", () => {
    session.state = "signed-out";
    expect(render()).not.toContain("Download");
    session.state = "signed-in";
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    expect(render()).toContain("Download");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("displays original MP4/MKV format without exposing the raw inspection", () => {
    session.state = "signed-in";
    for (const container of ["mp4", "mkv"] as const) {
      const html = render([{ ...ONE[0], profile: { container, videoCodec: "h264", audioCodec: "aac", startupWarning: false } }]);
      expect(html).toContain(`Download (${container.toUpperCase()})`);
      expect(html).toContain(`Original format: ${container.toUpperCase()}`);
    }
  });
});
