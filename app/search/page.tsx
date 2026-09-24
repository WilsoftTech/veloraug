import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Mic, SearchX, TriangleAlert, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { MovieList, MovieListItem } from "@/components/movie-list-item";
import { RecentSearches } from "@/components/recent-searches";
import { RetryButton } from "@/components/retry-button";
import { SearchInput } from "@/components/search-input";
import { SearchRecorder } from "@/components/search-recorder";
import { ListSkeleton } from "@/components/skeletons";
import { TabLinks } from "@/components/tab-links";
import { searchCatalogue, trendingSearches } from "@/lib/catalogue";
import { SEARCH_SCOPE_LABELS, firstParam, normalizeSearchQuery, parseSearchScope, searchHref, titleHref } from "@/lib/utils";
import type { CatalogueSearchResult } from "@/types/catalogue";
import type { SearchScope } from "@/types/media";

export const metadata: Metadata = { title: "Search" };

const SCOPES: SearchScope[] = ["all", "movie", "tv"];

const TRENDING_SEARCH_COUNT = 6;

/** Searches the published catalogue only. There is no TMDB fallback: no match is a real "no results". */
async function SearchResults({ query, scope }: { query: string; scope: SearchScope }) {
  let result: CatalogueSearchResult;
  try {
    result = await searchCatalogue(query, scope);
  } catch (error) {
    // Handled here rather than by the route error boundary so the input stays usable.
    console.error(`Search failed for "${query}"`, error);
    return (
      <EmptyState
        icon={<TriangleAlert className="size-6" />}
        title="Something went wrong"
        description="We couldn't load results right now. Please try again."
      >
        <RetryButton />
      </EmptyState>
    );
  }

  const { titles, vjs } = result;
  // Reached only when the search succeeded, so a failed search is never recorded.
  const recorder = <SearchRecorder query={query} scope={scope} resultCount={titles.length + vjs.length} />;

  if (titles.length === 0 && vjs.length === 0) {
    return (
      <>
        {recorder}
        <EmptyState
          icon={<SearchX className="size-6" />}
          title={`No results for “${query}”`}
          description="Check the spelling or try a different title or VJ."
        />
      </>
    );
  }

  return (
    <>
      {recorder}
      {vjs.length > 0 && (
        <section aria-labelledby="vj-results" className="mb-6">
          <h2 id="vj-results" className="mb-2 text-label-md uppercase text-muted">
            VJs
          </h2>
          <ul className="flex flex-wrap gap-2">
            {vjs.map((vj) => (
              <li key={vj.id}>
                <Link
                  href={`/vjs/${vj.slug}`}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-label-lg transition-colors hover:border-highlight/40 hover:text-highlight"
                >
                  <Mic aria-hidden className="size-4 text-muted" />
                  {vj.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {titles.length > 0 && (
        <section aria-label="Titles">
          <MovieList>
            {titles.map((title) => (
              <MovieListItem
                key={`${title.kind}-${title.id}`}
                item={title}
                href={titleHref(title.kind, title.slug)}
                typeLabel={title.kind === "movie" ? "Movie" : "Series"}
              />
            ))}
          </MovieList>
        </section>
      )}
    </>
  );
}

/** Popular recent Velora searches (Phase 3 analytics). Optional: search works without them. */
async function TrendingSearches() {
  let queries: string[];
  try {
    queries = await trendingSearches(TRENDING_SEARCH_COUNT);
  } catch (error) {
    console.error("Could not load trending searches", error);
    return null;
  }
  if (queries.length === 0) return null;

  return (
    <section aria-labelledby="trending-searches">
      <h2 id="trending-searches" className="mb-1 text-label-md uppercase text-muted">
        Trending searches
      </h2>
      <ul>
        {queries.map((query) => (
          <li key={query}>
            <Link
              href={searchHref(query)}
              replace
              className="flex min-h-12 items-center gap-3 border-b border-border text-body-md transition-colors hover:text-highlight"
            >
              <TrendingUp aria-hidden className="size-4 text-muted" />
              {query}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const params = await searchParams;
  const query = normalizeSearchQuery(firstParam(params.q));
  const scope = parseSearchScope(params.type);

  return (
    <div className="page-container max-w-3xl py-6 sm:py-8">
      <h1 className="mb-4 text-headline-md md:text-headline-lg">Search</h1>
      <SearchInput query={query} scope={scope} />

      <div className="mt-6">
        {query ? (
          <>
            <TabLinks
              label="Result type"
              tabs={SCOPES.map((value) => ({
                label: SEARCH_SCOPE_LABELS[value],
                active: value === scope,
                href: searchHref(query, value),
              }))}
            />
            <div className="mt-2">
              <Suspense key={`${scope}:${query}`} fallback={<ListSkeleton />}>
                <SearchResults query={query} scope={scope} />
              </Suspense>
            </div>
          </>
        ) : (
          <>
            <Link
              href="/vjs"
              className="mb-2 inline-flex min-h-11 items-center gap-2 text-label-lg text-highlight transition-colors hover:text-foreground"
            >
              <Mic aria-hidden className="size-4" />
              Browse by VJ
            </Link>
            <Suspense>
              <TrendingSearches />
            </Suspense>
            {/* After the suggestions, so it appears without moving anything already on screen. */}
            <RecentSearches />
          </>
        )}
      </div>
    </div>
  );
}
