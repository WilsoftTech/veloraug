import { Suspense } from "react";
import { Hero } from "@/components/hero";
import { MovieSection } from "@/components/movie-section";
import { HeroSkeleton, SectionSkeleton } from "@/components/skeletons";
import { getMovies, getShows, getTrending } from "@/lib/tmdb/media";
import type { MediaPage } from "@/types/media";

const ROW_LIMIT = 16;

async function CatalogSection({ title, href, load }: { title: string; href: string; load: () => Promise<MediaPage> }) {
  const { items } = await load();
  return <MovieSection title={title} href={href} items={items.slice(0, ROW_LIMIT)} />;
}

// Each row streams in on its own, so a slow list never blocks the hero.
function Catalog(props: Parameters<typeof CatalogSection>[0]) {
  return (
    <Suspense fallback={<SectionSkeleton />}>
      <CatalogSection {...props} />
    </Suspense>
  );
}

export default function HomePage() {
  return (
    <>
      <h1 className="sr-only">Velora UG — discover movies and series</h1>
      <Suspense fallback={<HeroSkeleton />}>
        <Hero />
      </Suspense>

      <div className="page-container space-y-12 pt-10 sm:space-y-16 sm:pt-14">
        <Catalog title="Trending Now" href="/trending" load={() => getTrending()} />
        <Catalog title="Popular Movies" href="/movies" load={() => getMovies("popular")} />
        <Catalog title="Popular TV Shows" href="/tv" load={() => getShows("popular")} />
        <Catalog title="Top Rated" href="/movies?list=top_rated" load={() => getMovies("top_rated")} />
      </div>
    </>
  );
}
