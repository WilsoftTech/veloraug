import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { TitleHero } from "@/components/title-hero";
import { WatchlistButton } from "@/components/watchlist-button";
import { getMovie } from "@/lib/catalogue";
import { TITLE_NOT_FOUND_METADATA, titleMetadata } from "@/lib/title-metadata";
import { formatRuntime, parseSlug, titleWatchlistItem } from "@/lib/utils";

// Catalogue reads go through fetch; without this a prerender would freeze the catalogue at build time.
export const revalidate = 300;

// One catalogue read shared by generateMetadata and the page.
const loadMovie = cache(async (rawSlug: string) => {
  const slug = parseSlug(rawSlug);
  return slug ? getMovie(slug) : null;
});

export async function generateMetadata({ params }: PageProps<"/movies/[slug]">): Promise<Metadata> {
  const movie = await loadMovie((await params).slug);
  return movie ? titleMetadata(movie) : TITLE_NOT_FOUND_METADATA;
}

/**
 * A published movie. Drafts, blocked or unready titles and unknown slugs all
 * resolve to the same not-found page: the anon read policies return nothing.
 */
export default async function MoviePage({ params }: PageProps<"/movies/[slug]">) {
  const movie = await loadMovie((await params).slug);
  if (!movie) notFound();

  const facts = [
    movie.releaseYear ? String(movie.releaseYear) : null,
    "Movie",
    movie.runtimeMinutes ? formatRuntime(movie.runtimeMinutes) : null,
  ].filter((fact): fact is string => fact !== null);

  return (
    <article>
      <TitleHero title={movie} facts={facts} actions={<WatchlistButton item={titleWatchlistItem(movie)} variant="primary" />} />
    </article>
  );
}
