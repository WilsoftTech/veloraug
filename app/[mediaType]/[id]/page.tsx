import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { findTitles } from "@/lib/catalogue";
import { parseMediaRoute, titleHref } from "@/lib/utils";

export const metadata: Metadata = { title: "Title not found", robots: { index: false } };

/**
 * Pre-B5 detail URLs (`/movie/:tmdbId`, `/tv/:tmdbId`). They never render a
 * TMDB title: a TMDB id matched to a published catalogue title redirects to its
 * Velora page, and anything else (unmatched, draft or unknown) is not found.
 * No TMDB request is made.
 */
export default async function LegacyTitlePage({ params }: PageProps<"/[mediaType]/[id]">) {
  const { mediaType, id } = await params;
  const route = parseMediaRoute(mediaType, id);
  if (!route) notFound();

  const kind = route.mediaType === "movie" ? "movie" : "series";
  const [title] = await findTitles(kind, "tmdb_id", [route.id]);
  if (!title) notFound();
  permanentRedirect(titleHref(title.kind, title.slug));
}
