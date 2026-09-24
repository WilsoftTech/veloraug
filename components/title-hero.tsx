import type { ReactNode } from "react";
import Link from "next/link";
import { BackdropImage, PosterImage } from "@/components/media-image";
import { Rating } from "@/components/rating";
import { VjList } from "@/components/vj-list";
import { browseHref } from "@/lib/browse";
import type { MovieDetail, SeriesDetail } from "@/types/catalogue";

interface TitleHeroProps {
  title: MovieDetail | SeriesDetail;
  /** Short facts shown under the title, e.g. year, "Movie", runtime. */
  facts: string[];
  /** Primary actions (My List). */
  actions: ReactNode;
}

/** Detail-page header shared by movies and series: backdrop, poster, facts, genres, VJs and overview. */
export function TitleHero({ title, facts, actions }: TitleHeroProps) {
  return (
    <div className="relative">
      <div aria-hidden className="absolute inset-x-0 top-0 h-[26rem] sm:h-[34rem] lg:h-[38rem]">
        <BackdropImage path={title.backdropPath} sizes="100vw" preload />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/20" />
        <div className="absolute inset-0 hidden bg-gradient-to-r from-background/70 to-transparent md:block" />
      </div>

      <div className="page-container relative pt-44 sm:pt-60 lg:pt-56">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:gap-8">
          <PosterImage
            path={title.posterPath}
            title={title.title}
            alt={`${title.title} poster`}
            sizes="(min-width: 1024px) 224px, 176px"
            className="hidden w-44 shrink-0 shadow-float ring-1 ring-border md:block lg:w-56"
          />
          <div className="min-w-0 max-w-3xl">
            <h1 className="text-balance text-headline-md md:text-headline-lg">{title.title}</h1>
            {title.originalTitle && title.originalTitle !== title.title && (
              <p className="mt-2 text-body-md italic text-muted">{title.originalTitle}</p>
            )}

            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-md text-foreground/80">
              <span>{facts.join(" · ")}</span>
              {title.rating !== null && <span aria-hidden>·</span>}
              <Rating value={title.rating} />
            </p>

            {title.genres.length > 0 && (
              <ul aria-label="Genres" className="mt-4 flex flex-wrap gap-2">
                {title.genres.map((genre) => (
                  <li key={genre.id}>
                    <Link
                      href={browseHref(title.kind, { genre: genre.slug })}
                      className="inline-flex min-h-8 items-center rounded-full border border-highlight/30 bg-accent/12 px-3 text-label-tag uppercase text-highlight transition-colors hover:border-highlight/60"
                    >
                      {genre.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4">
              <VjList vjs={title.vjs} />
            </div>

            {title.overview && (
              <p className="mt-5 max-w-2xl text-body-md text-foreground/80 md:text-body-lg">{title.overview}</p>
            )}

            <div className="mt-6 flex flex-wrap gap-3">{actions}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
