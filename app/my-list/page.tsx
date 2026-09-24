import type { Metadata } from "next";
import { TabLinks } from "@/components/tab-links";
import { WatchlistView } from "@/components/watchlist-view";
import { firstParam, parseMediaType } from "@/lib/utils";

export const metadata: Metadata = { title: "My List" };

export default async function MyListPage({ searchParams }: PageProps<"/my-list">) {
  const params = await searchParams;
  const tab = firstParam(params.tab);
  // "series" is the product name; "tv" is accepted from older links.
  const mediaType = tab === "series" ? "tv" : (parseMediaType(tab ?? "") ?? "movie");

  return (
    <div className="page-container max-w-3xl py-6 sm:py-8">
      <h1 className="text-headline-md md:text-headline-lg">My List</h1>
      <div className="mt-4 max-w-xs">
        <TabLinks
          label="My List sections"
          tabs={[
            { label: "Movies", href: "/my-list", active: mediaType === "movie" },
            { label: "Series", href: "/my-list?tab=series", active: mediaType === "tv" },
          ]}
        />
      </div>
      <div className="mt-2">
        <WatchlistView mediaType={mediaType} />
      </div>
    </div>
  );
}
