import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoviePlayer } from "@/components/movie-player";

const ONE = [{ id: 1, label: "VJ Ice P" }];
const TWO = [
  { id: 1, label: "VJ Ice P" },
  { id: 4, label: "VJ Junior" },
];
const render = (versions = ONE) => renderToStaticMarkup(<MoviePlayer versions={versions} signInHref="/sign-in?next=%2Fmovies%2Fon-the-hunt-2026" />);

afterEach(() => vi.unstubAllGlobals());

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
});
