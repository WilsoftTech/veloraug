import type { Metadata } from "next";
import { CatalogueBrowse } from "@/components/catalogue-browse";
import { browseHref, hasBrowseFilters, parseBrowseFilters } from "@/lib/browse";

export async function generateMetadata({ searchParams }: PageProps<"/series">): Promise<Metadata> {
  const filters = parseBrowseFilters(await searchParams);
  return {
    title: "Series",
    description: "VJ-translated series on Velora UG.",
    alternates: { canonical: browseHref("series") },
    robots: hasBrowseFilters(filters) || filters.cursor ? { index: false, follow: true } : undefined,
  };
}

export default function SeriesPage({ searchParams }: PageProps<"/series">) {
  return <CatalogueBrowse kind="series" searchParams={searchParams} />;
}
