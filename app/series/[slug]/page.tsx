import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { EpisodePicker } from "@/components/episode-picker";
import { MoviePlayer } from "@/components/movie-player";
import { SectionHeader } from "@/components/section-header";
import { TitleHero } from "@/components/title-hero";
import { VjList } from "@/components/vj-list";
import { WatchlistButton } from "@/components/watchlist-button";
import { getSeries } from "@/lib/catalogue";
import { downloadsEnabled } from "@/lib/playback/stream-capability";
import { episodeLabel, seasonLabel, selectEpisode } from "@/lib/series-selection";
import { TITLE_NOT_FOUND_METADATA, titleMetadata } from "@/lib/title-metadata";
import { formatRuntime, parseSlug, titleWatchlistItem } from "@/lib/utils";

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

/**
 * A published series with its available seasons and episodes only. Drafts,
 * unavailable titles and unknown slugs all resolve to the same not-found page.
 * `?season=&episode=` selects the episode shown; an address naming something
 * that is not published is sent to the episode actually shown.
 */
export default async function SeriesDetailPage({ params, searchParams }: PageProps<"/series/[slug]">) {
  const series = await loadSeries((await params).slug);
  if (!series) notFound();
  const { season: seasonParam, episode: episodeParam } = await searchParams;
  const selection = selectEpisode(series.slug, series.seasons, { season: seasonParam, episode: episodeParam });
  if (selection?.corrected) redirect(selection.href);

  const episodeCount = series.seasons.reduce((total, season) => total + season.episodes.length, 0);
  const facts = [
    series.releaseYear ? String(series.releaseYear) : null,
    "Series",
    `${series.seasons.length} ${series.seasons.length === 1 ? "season" : "seasons"}`,
    `${episodeCount} ${episodeCount === 1 ? "episode" : "episodes"}`,
  ].filter((fact): fact is string => fact !== null);

  const seriesHref = `/series/${series.slug}`;
  const episode = selection?.episode ?? null;
  const signInHref = `/sign-in?next=${encodeURIComponent(selection ? selection.href : seriesHref)}`;

  return (
    <article>
      <TitleHero title={series} facts={facts} actions={<WatchlistButton item={titleWatchlistItem(series)} variant="primary" />} />
      {selection && (
        <section aria-labelledby="series-episodes" className="page-container mt-14 max-w-4xl">
          <SectionHeader id="series-episodes" title="Episodes" />
          <div className="rounded-lg border border-border bg-surface p-4 backdrop-blur-md md:p-6">
            <EpisodePicker
              action={seriesHref}
              seasons={series.seasons.map((season) => ({ value: season.seasonNumber, label: seasonLabel(season) }))}
              episodes={selection.season.episodes.map((item) => ({ value: item.episodeNumber, label: episodeLabel(item) }))}
              season={selection.season.seasonNumber}
              episode={episode?.episodeNumber ?? null}
            />
            {episode && (
              <div className="mt-6 border-t border-border pt-6">
                <h3 className="text-body-lg font-semibold">
                  <span className="text-muted">{seasonLabel(selection.season)} · E{episode.episodeNumber}</span>
                  {episode.title && <span> · {episode.title}</span>}
                </h3>
                {episode.runtimeMinutes && <p className="mt-1 text-body-sm text-muted">{formatRuntime(episode.runtimeMinutes)}</p>}
                {episode.overview && <p className="mt-2 text-body-md text-foreground/80">{episode.overview}</p>}
                <div className="mt-3">
                  <VjList vjs={episode.versions.map((version) => version.vj)} />
                </div>
                {episode.versions.length > 0 && (
                  // Keyed by episode: choosing another episode starts from a closed player.
                  // Versions come from the published catalogue (ids and VJ names only).
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <MoviePlayer
                      key={episode.id}
                      target="episode"
                      versions={episode.versions.map((version) => ({ id: version.id, label: version.title ? `${version.title} · ${version.vj.name}` : version.vj.name }))}
                      signInHref={signInHref}
                      downloads={downloadsEnabled()}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </article>
  );
}
