"use client";

import { isPosterPath, posterWidth } from "@/lib/artwork";

// Widths TMDB serves as `/t/p/w{size}`; the CDN accepts each for posters,
// backdrops and profile photos alike.
const TMDB_WIDTHS = [92, 154, 185, 342, 500, 780, 1280];

export default function tmdbImageLoader({ src, width }: { src: string; width: number }) {
  if (isPosterPath(src)) return `${src}?w=${posterWidth(width)}`;
  const size = TMDB_WIDTHS.find((candidate) => candidate >= width) ?? TMDB_WIDTHS[TMDB_WIDTHS.length - 1];
  return `https://image.tmdb.org/t/p/w${size}${src}`;
}
