import { Suspense } from "react";
import Link from "next/link";
import { Clapperboard, Film, SearchX } from "lucide-react";
import { buttonClass } from "@/components/button";
import { CatalogueFilters } from "@/components/catalogue-filters";
import { EmptyState } from "@/components/empty-state";
import { MovieGrid } from "@/components/movie-grid";
import { Pagination } from "@/components/pagination";
import { GridSkeleton } from "@/components/skeletons";
import { browseHref, hasBrowseFilters, parseBrowseFilters, type BrowseFilters } from "@/lib/browse";
import { listGenres, listMovies, listSeries, listVjs } from "@/lib/catalogue";
import type { CatalogueKind } from "@/types/catalogue";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const COPY: Record<CatalogueKind, { title: string; empty: string }> = {
  movie: { title: "Movies", empty: "No movies yet" },
  series: { title: "Series", empty: "No series yet" },
};

async function BrowseResults({ kind, filters }: { kind: CatalogueKind; filters: BrowseFilters }) {
  const options = { cursor: filters.cursor ?? undefined, genreSlug: filters.genre ?? undefined, vjSlug: filters.vj ?? undefined };
  const { items, nextCursor } = await (kind === "movie" ? listMovies(options) : listSeries(options));

  if (items.length === 0) {
    if (filters.cursor) {
      return (
        <EmptyState icon={<Film className="size-6" />} title="Nothing to show here" description="This page doesn't exist.">
          <Link href={browseHref(kind, { ...filters, cursor: null })} className={buttonClass("primary")}>
            Back to first page
          </Link>
        </EmptyState>
      );
    }
    if (hasBrowseFilters(filters)) {
      return (
        <EmptyState icon={<SearchX className="size-6" />} title="No titles match these filters" description="Try a different genre or VJ.">
          <Link href={browseHref(kind)} className={buttonClass("primary")}>
            Reset filters
          </Link>
        </EmptyState>
      );
    }
    // An empty catalogue stays empty: nothing is borrowed from TMDB or sample data.
    return (
      <EmptyState
        icon={<Clapperboard className="size-6" />}
        title={COPY[kind].empty}
        description="New titles are added regularly. Check back soon."
      />
    );
  }

  return (
    <>
      <MovieGrid items={items} />
      <Pagination
        firstHref={filters.cursor ? browseHref(kind, { ...filters, cursor: null }) : null}
        nextHref={nextCursor ? browseHref(kind, { ...filters, cursor: nextCursor }) : null}
      />
    </>
  );
}

/** Shared body of /movies and /series: filters, a poster grid and keyset paging, all from the catalogue. */
export async function CatalogueBrowse({ kind, searchParams }: { kind: CatalogueKind; searchParams: SearchParams }) {
  const filters = parseBrowseFilters(await searchParams);
  const [genres, vjs] = await Promise.all([listGenres(), listVjs()]);

  return (
    <div className="page-container py-6 sm:py-8">
      <h1 className="text-headline-md md:text-headline-lg">{COPY[kind].title}</h1>
      <CatalogueFilters kind={kind} filters={filters} genres={genres} vjs={vjs} />
      <section aria-labelledby={`${kind}-results`} className="mt-6">
        <h2 id={`${kind}-results`} className="sr-only">
          Results
        </h2>
        <Suspense key={browseHref(kind, filters)} fallback={<GridSkeleton />}>
          <BrowseResults kind={kind} filters={filters} />
        </Suspense>
      </section>
    </div>
  );
}
