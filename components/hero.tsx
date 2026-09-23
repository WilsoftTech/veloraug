import Link from "next/link";
import { Play } from "lucide-react";
import { buttonClass } from "@/components/button";
import { HeroCarousel } from "@/components/hero-carousel";
import { BackdropImage } from "@/components/media-image";
import { Rating } from "@/components/rating";
import { WatchlistButton } from "@/components/watchlist-button";
import { getTrending } from "@/lib/tmdb/media";
import { mediaHref, mediaWatchlistItem } from "@/lib/utils";
import type { Media } from "@/types/media";

const SLIDE_COUNT = 5;

function HeroSlide({ item, first }: { item: Media; first: boolean }) {
  return (
    <div className="relative h-[26rem] sm:h-[30rem] lg:h-[36rem]">
      <BackdropImage path={item.backdropPath} sizes="100vw" preload={first} />
      {/* The fade keeps text legible over any artwork. Phones stack the copy over most of the hero, so they need
          a denser scrim (WCAG AA against a pure-white backdrop); the side fade only matters once copy sits left. */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-background via-background/75 via-60% to-background/45 md:via-background/50 md:via-50% md:to-background/10" />
      <div aria-hidden className="absolute inset-0 hidden bg-gradient-to-r from-background/80 via-background/20 to-transparent md:block" />

      <div className="page-container relative flex h-full flex-col justify-end pb-12 md:pb-16">
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-highlight/30 bg-accent/12 px-3 py-1 text-label-tag uppercase text-highlight">
          <span aria-hidden className="size-1.5 rounded-full bg-highlight shadow-[0_0_8px_var(--highlight)]" />
          Featured
        </p>
        <h2 className="mt-4 max-w-2xl text-balance text-display-hero-mobile md:text-display-hero">
          {item.title}
        </h2>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-md text-foreground/80">
          {item.releaseYear && <span>{item.releaseYear}</span>}
          {item.genres.length > 0 && <span aria-hidden>·</span>}
          {item.genres.length > 0 && <span>{item.genres.slice(0, 2).join(" · ")}</span>}
          {item.rating !== null && <span aria-hidden>·</span>}
          <Rating value={item.rating} />
        </p>
        <p className="mt-3 line-clamp-3 max-w-xl text-body-md text-foreground/80 md:text-body-lg">{item.overview}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={mediaHref(item)} className={buttonClass("primary")}>
            <Play aria-hidden className="size-4 fill-current" />
            View Details
          </Link>
          <WatchlistButton item={mediaWatchlistItem(item)} />
        </div>
      </div>
    </div>
  );
}

export async function Hero() {
  const { items } = await getTrending();
  const withBackdrop = items.filter((item) => item.backdropPath);
  const featured = (withBackdrop.length > 0 ? withBackdrop : items).slice(0, SLIDE_COUNT);
  if (featured.length === 0) return null;

  return (
    <HeroCarousel label="Featured titles">
      {featured.map((item, index) => (
        <HeroSlide key={`${item.mediaType}-${item.id}`} item={item} first={index === 0} />
      ))}
    </HeroCarousel>
  );
}
