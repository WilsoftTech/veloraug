import { Suspense } from "react";
import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Hero } from "@/components/hero";
import { MovieSection } from "@/components/movie-section";
import { SectionHeader } from "@/components/section-header";
import { HeroSkeleton, SectionSkeleton } from "@/components/skeletons";
import { listMovies, listSeries, listVjs } from "@/lib/catalogue";

const ROW_LIMIT = 16;

// Catalogue reads go through fetch; without this a prerender would freeze the catalogue at build time.
export const revalidate = 300;

/**
 * Home rows, all from the published catalogue in one parallel round trip. An
 * empty catalogue shows an empty state: nothing is borrowed from TMDB or sample data.
 */
async function CatalogueRows() {
  const [movies, series, vjs] = await Promise.all([
    listMovies({ limit: ROW_LIMIT }),
    listSeries({ limit: ROW_LIMIT }),
    listVjs(),
  ]);

  if (movies.items.length === 0 && series.items.length === 0) {
    return (
      <EmptyState
        icon={<Clapperboard className="size-6" />}
        title="The catalogue is coming soon"
        description="VJ-translated movies and series will appear here as they are published."
      />
    );
  }

  return (
    <>
      <MovieSection title="Latest Movies" href="/movies" items={movies.items} />
      <MovieSection title="Latest Series" href="/series" items={series.items} />
      {vjs.length > 0 && (
        <section aria-labelledby="home-vjs">
          <SectionHeader id="home-vjs" title="VJs" href="/vjs" />
          <ul className="flex flex-wrap gap-2">
            {vjs.map((vj) => (
              <li key={vj.id}>
                <Link
                  href={`/vjs/${vj.slug}`}
                  className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-4 text-label-lg transition-colors hover:border-highlight/40 hover:text-highlight"
                >
                  {vj.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function HomePage() {
  return (
    <>
      <h1 className="sr-only">Velora UG — VJ-translated movies and series</h1>
      <Suspense fallback={<HeroSkeleton />}>
        <Hero />
      </Suspense>

      <div className="page-container space-y-12 pt-10 sm:space-y-16 sm:pt-14">
        <Suspense fallback={<SectionSkeleton />}>
          <CatalogueRows />
        </Suspense>
      </div>
    </>
  );
}
