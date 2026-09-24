import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { SectionHeader } from "@/components/section-header";
import { TitleHero } from "@/components/title-hero";
import { VjList } from "@/components/vj-list";
import { WatchlistButton } from "@/components/watchlist-button";
import { getSeries } from "@/lib/catalogue";
import { TITLE_NOT_FOUND_METADATA, titleMetadata } from "@/lib/title-metadata";
import { formatRuntime, parseSlug, titleWatchlistItem } from "@/lib/utils";
import type { Season } from "@/types/catalogue";

// Catalogue reads go through fetch; without this a prerender would freeze the catalogue at build time.
export const revalidate = 300;

const loadSeries = cache(async (rawSlug: string) => {
  const slug = parseSlug(rawSlug);
  return slug ? getSeries(slug) : null;
});

export async function generateMetadata({ params }: PageProps<"/series/[slug]">): Promise<Metadata> {
  const series = await loadSeries((await params).slug);
  return series ? titleMetadata(series) : TITLE_NOT_FOUND_METADATA;
}

function seasonLabel(season: Season) {
  return season.title ?? (season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`);
}

function SeasonSection({ season }: { season: Season }) {
  const headingId = `season-${season.id}`;
  return (
    <section aria-labelledby={headingId}>
      <SectionHeader id={headingId} title={seasonLabel(season)} />
      <ol className="rounded-lg border border-border bg-surface px-4 backdrop-blur-md md:px-6">
        {season.episodes.map((episode) => (
          <li key={episode.id} className="border-b border-border py-4 last:border-b-0">
            <p className="text-body-md font-semibold sm:text-body-lg">
              <span className="text-muted">E{episode.episodeNumber}</span>
              {episode.title && <span> · {episode.title}</span>}
            </p>
            {episode.runtimeMinutes && <p className="mt-1 text-body-sm text-muted">{formatRuntime(episode.runtimeMinutes)}</p>}
            {episode.overview && <p className="mt-2 line-clamp-3 text-body-md text-foreground/80">{episode.overview}</p>}
            <div className="mt-2">
              <VjList vjs={episode.versions.map((version) => version.vj)} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A published series with its available seasons and episodes only. Drafts,
 * unavailable titles and unknown slugs all resolve to the same not-found page.
 */
export default async function SeriesDetailPage({ params }: PageProps<"/series/[slug]">) {
  const series = await loadSeries((await params).slug);
  if (!series) notFound();

  const episodeCount = series.seasons.reduce((total, season) => total + season.episodes.length, 0);
  const facts = [
    series.releaseYear ? String(series.releaseYear) : null,
    "Series",
    `${series.seasons.length} ${series.seasons.length === 1 ? "season" : "seasons"}`,
    `${episodeCount} ${episodeCount === 1 ? "episode" : "episodes"}`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <article>
      <TitleHero title={series} facts={facts} actions={<WatchlistButton item={titleWatchlistItem(series)} variant="primary" />} />
      <div className="page-container mt-14 max-w-4xl space-y-12">
        {series.seasons.map((season) => (
          <SeasonSection key={season.id} season={season} />
        ))}
      </div>
    </article>
  );
}
