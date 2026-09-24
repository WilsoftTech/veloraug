import type { Metadata } from "next";
import { summarize, titleHref } from "@/lib/utils";
import type { MovieDetail, SeriesDetail } from "@/types/catalogue";

/** Absolute CDN URL for a catalogue record's stored TMDB artwork path (Open Graph needs a full URL). */
function artworkUrl(path: string | null, width: 500 | 780) {
  return path ? `https://image.tmdb.org/t/p/w${width}${path}` : undefined;
}

/** Detail-page metadata, derived only from the published catalogue record. */
export function titleMetadata(title: MovieDetail | SeriesDetail): Metadata {
  const description = summarize(title.overview ?? "");
  const image = artworkUrl(title.backdropPath, 780) ?? artworkUrl(title.posterPath, 500);
  return {
    title: title.title,
    description,
    alternates: { canonical: titleHref(title.kind, title.slug) },
    openGraph: {
      type: title.kind === "movie" ? "video.movie" : "video.tv_show",
      title: title.title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

/** For a missing or non-public slug: the same answer either way, and never indexed. */
export const TITLE_NOT_FOUND_METADATA: Metadata = { title: "Title not found", robots: { index: false } };
