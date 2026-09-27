import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MovieCard } from "@/components/movie-card";
import type { TitleSummary, VjSummary } from "@/types/catalogue";

const vj = (id: number, name: string): VjSummary => ({ id, slug: `vj-${id}`, name, badgeVariant: "blue" });
const movie = (vjs: VjSummary[]): TitleSummary => ({
  kind: "movie", id: 1, slug: "a-movie-2026", title: "A Movie", posterPath: null, releaseYear: 2026, rating: null, tmdbId: null, vjs,
});
const render = (item: TitleSummary) => renderToStaticMarkup(<MovieCard item={item} />);
const visible = (html: string) => html.replace(/<span class="sr-only">.*?<\/span>/g, "").replace(/<[^>]+>/g, " ");

describe("MovieCard VJ badge", () => {
  it("shows the title's VJ from catalogue data, after the title in reading order", () => {
    const html = render(movie([vj(1, "VJ Ice P")]));
    expect(visible(html)).toContain("VJ Ice P");
    expect(html).toContain('<span class="sr-only">Available from VJ Ice P</span>');
    expect(html.indexOf("A Movie</p>")).toBeLessThan(html.indexOf("VJ Ice P"));
  });

  it("names the first VJ and counts the rest, while screen readers hear every VJ", () => {
    const html = render(movie([vj(1, "VJ Ice P"), vj(2, "VJ Junior"), vj(3, "VJ Emmy")]));
    expect(visible(html)).toContain("VJ Ice P");
    expect(visible(html)).toContain("+2");
    expect(visible(html)).not.toContain("VJ Junior");
    expect(html).toContain("Available from VJ Ice P, VJ Junior, VJ Emmy");
  });

  it("renders no badge for a title without VJs", () => {
    const html = render(movie([]));
    expect(html).not.toContain("Available from");
    expect(html).not.toContain("rounded-full");
  });
});
