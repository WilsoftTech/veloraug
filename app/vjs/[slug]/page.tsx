import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { MovieSection } from "@/components/movie-section";
import { browseHref } from "@/lib/browse";
import { getVj, listMovies, listSeries } from "@/lib/catalogue";
import { parseSlug, summarize } from "@/lib/utils";

// Catalogue reads go through fetch; without this a prerender would freeze the catalogue at build time.
export const revalidate = 300;

const ROW_LIMIT = 16;

const loadVj = cache(async (rawSlug: string) => {
  const slug = parseSlug(rawSlug);
  return slug ? getVj(slug) : null;
});

export async function generateMetadata({ params }: PageProps<"/vjs/[slug]">): Promise<Metadata> {
  const vj = await loadVj((await params).slug);
  if (!vj) return { title: "VJ not found", robots: { index: false } };
  return {
    title: vj.name,
    description: summarize(vj.description ?? "") ?? `Movies and series translated by ${vj.name} on Velora UG.`,
    alternates: { canonical: `/vjs/${vj.slug}` },
  };
}

/** One active VJ and the published titles available from them. Inactive or unknown VJs are not found. */
export default async function VjPage({ params }: PageProps<"/vjs/[slug]">) {
  const vj = await loadVj((await params).slug);
  if (!vj) notFound();

  const [movies, series] = await Promise.all([
    listMovies({ vjSlug: vj.slug, limit: ROW_LIMIT }),
    listSeries({ vjSlug: vj.slug, limit: ROW_LIMIT }),
  ]);

  return (
    <div className="page-container space-y-12 py-6 sm:space-y-16 sm:py-8">
      <header className="max-w-3xl">
        <p className="text-label-md uppercase text-muted">VJ</p>
        <h1 className="mt-1 text-headline-md md:text-headline-lg">{vj.name}</h1>
        {vj.description && <p className="mt-3 text-body-md text-foreground/80 md:text-body-lg">{vj.description}</p>}
      </header>

      {movies.items.length === 0 && series.items.length === 0 ? (
        <EmptyState icon={<Clapperboard className="size-6" />} title={`No titles from ${vj.name} yet`} description="Check back soon.">
          <Link href="/vjs" className="text-label-lg text-highlight">
            All VJs
          </Link>
        </EmptyState>
      ) : (
        <>
          <MovieSection title="Movies" href={movies.nextCursor ? browseHref("movie", { vj: vj.slug }) : undefined} items={movies.items} />
          <MovieSection title="Series" href={series.nextCursor ? browseHref("series", { vj: vj.slug }) : undefined} items={series.items} />
        </>
      )}
    </div>
  );
}
