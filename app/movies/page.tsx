import type { Metadata } from "next";
import { CatalogueBrowse } from "@/components/catalogue-browse";
import { browseHref, hasBrowseFilters, parseBrowseFilters } from "@/lib/browse";

export async function generateMetadata({ searchParams }: PageProps<"/movies">): Promise<Metadata> {
  const filters = parseBrowseFilters(await searchParams);
  return {
    title: "Movies",
    description: "VJ-translated movies on Velora UG.",
    alternates: { canonical: browseHref("movie") },
    // Filtered and paged views are their own URLs; only the plain list is worth indexing.
    robots: hasBrowseFilters(filters) || filters.cursor ? { index: false, follow: true } : undefined,
  };
}

export default function MoviesPage({ searchParams }: PageProps<"/movies">) {
  return <CatalogueBrowse kind="movie" searchParams={searchParams} />;
}
