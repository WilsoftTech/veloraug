import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Play } from "lucide-react";
import { buttonClass } from "@/components/button";
import { BackdropImage, PosterImage } from "@/components/media-image";
import { MovieSection } from "@/components/movie-section";
import { PersonCard } from "@/components/person-card";
import { Rating } from "@/components/rating";
import { SectionHeader } from "@/components/section-header";
import { TrailerPlayer } from "@/components/trailer-player";
import { WatchlistButton } from "@/components/watchlist-button";
import { getMediaDetail } from "@/lib/tmdb/media";
import { formatRuntime, mediaTypeLabel, mediaWatchlistItem, parseMediaRoute, summarize } from "@/lib/utils";

async function loadDetail(mediaType: string, rawId: string) {
  const route = parseMediaRoute(mediaType, rawId);
  return route ? getMediaDetail(route.mediaType, route.id) : null;
}

export async function generateMetadata({ params }: PageProps<"/[mediaType]/[id]">): Promise<Metadata> {
  const { mediaType, id } = await params;
  let detail;
  try {
    detail = await loadDetail(mediaType, id);
  } catch (error) {
    // Without this, a TMDB outage leaves the error page with no <title> at all.
    console.error(`Could not load metadata for ${mediaType}/${id}`, error);
    return { title: "Title unavailable", robots: { index: false } };
  }
  if (!detail) return { title: "Title not found" };

  const description = summarize(detail.overview);
  return {
    title: detail.title,
    description,
    alternates: { canonical: `/${detail.mediaType}/${detail.id}` },
    openGraph: {
      type: detail.mediaType === "movie" ? "video.movie" : "video.tv_show",
      title: detail.title,
      description,
      images: detail.backdropPath ? [`https://image.tmdb.org/t/p/w780${detail.backdropPath}`] : undefined,
    },
  };
}

export default async function MediaDetailPage({ params }: PageProps<"/[mediaType]/[id]">) {
  const { mediaType, id } = await params;
  const detail = await loadDetail(mediaType, id);
  // The HTTP status is already 200 by now: the loading boundaries above this page
  // stream the shell before TMDB has answered. Next.js marks the response `noindex`
  // instead, and generateMetadata gives it a stable title. Removing the skeletons
  // (or awaiting TMDB in a layout) would be the only way to get a 404 status.
  if (!detail) notFound();

  const facts = [
    detail.releaseYear,
    mediaTypeLabel(detail.mediaType),
    detail.seasons ? `${detail.seasons} ${detail.seasons === 1 ? "season" : "seasons"}` : null,
    detail.mediaType === "movie" && detail.runtimeMinutes ? formatRuntime(detail.runtimeMinutes) : null,
  ].filter(Boolean);

  return (
    <article>
      <div className="relative">
        <div aria-hidden className="absolute inset-x-0 top-0 h-[26rem] sm:h-[34rem] lg:h-[38rem]">
          <BackdropImage path={detail.backdropPath} sizes="100vw" preload />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/20" />
          <div className="absolute inset-0 hidden bg-gradient-to-r from-background/70 to-transparent md:block" />
        </div>

        <div className="page-container relative pt-44 sm:pt-60 lg:pt-56">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:gap-8">
            <PosterImage
              path={detail.posterPath}
              title={detail.title}
              alt={`${detail.title} poster`}
              sizes="(min-width: 1024px) 224px, 176px"
              className="hidden w-44 shrink-0 shadow-float ring-1 ring-border md:block lg:w-56"
            />
            <div className="min-w-0 max-w-3xl">
              <h1 className="text-balance text-headline-md md:text-headline-lg">
                {detail.title}
              </h1>
              {detail.tagline && <p className="mt-2 text-body-md italic text-muted">{detail.tagline}</p>}

              <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-md text-foreground/80">
                <span>{facts.join(" · ")}</span>
                {detail.rating !== null && <span aria-hidden>·</span>}
                <Rating value={detail.rating} />
              </p>

              {detail.genres.length > 0 && (
                <ul aria-label="Genres" className="mt-4 flex flex-wrap gap-2">
                  {detail.genres.map((genre) => (
                    <li key={genre} className="rounded-full border border-highlight/30 bg-accent/12 px-3 py-1 text-label-tag uppercase text-highlight">
                      {genre}
                    </li>
                  ))}
                </ul>
              )}

              {detail.overview && (
                <p className="mt-5 max-w-2xl text-body-md text-foreground/80 md:text-body-lg">{detail.overview}</p>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                {detail.trailerKey && (
                  <a href="#trailer" className={buttonClass("primary")}>
                    <Play aria-hidden className="size-4 fill-current" />
                    Watch Trailer
                  </a>
                )}
                <WatchlistButton item={mediaWatchlistItem(detail)} variant={detail.trailerKey ? "secondary" : "primary"} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="page-container mt-14 space-y-12 sm:space-y-16">
        {detail.trailerKey && (
          <section id="trailer" aria-labelledby="trailer-heading" className="scroll-mt-20 max-w-4xl">
            <SectionHeader id="trailer-heading" title="Trailer" />
            <TrailerPlayer videoKey={detail.trailerKey} title={detail.title} backdropPath={detail.backdropPath} />
          </section>
        )}

        {detail.cast.length > 0 && (
          <section>
            <SectionHeader id="cast-heading" title="Cast" />
            {/* Cast cards are not links, so the scroller itself must be focusable for keyboard users to scroll it. */}
            <div
              role="region"
              aria-labelledby="cast-heading"
              tabIndex={0}
              className="page-bleed no-scrollbar relative overflow-x-auto pb-1 focus-visible:outline-offset-[-2px]"
            >
              <ul className="flex gap-4 md:gap-6">
                {detail.cast.map((person) => (
                  <li key={person.id} className="w-24 shrink-0 sm:w-28">
                    <PersonCard person={person} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        <MovieSection title="More like this" items={detail.similar.slice(0, 16)} />
      </div>
    </article>
  );
}
