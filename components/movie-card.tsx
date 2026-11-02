import Link from "next/link";
import { PosterImage } from "@/components/media-image";
import { Rating } from "@/components/rating";
import { cn, titleHref } from "@/lib/utils";
import type { TitleSummary } from "@/types/catalogue";

interface MovieCardProps {
  item: TitleSummary;
  /** Responsive `sizes` for the poster; defaults suit the scroll rows. */
  sizes?: string;
  /** Load the poster immediately (first row of a grid). */
  eager?: boolean;
  className?: string;
}

const ROW_POSTER_SIZES = "(min-width: 1024px) 192px, (min-width: 640px) 176px, 144px";

/** The one poster card, used by scroll rows and grids. Links to the title's Velora page. */
export function MovieCard({ item, sizes = ROW_POSTER_SIZES, eager, className }: MovieCardProps) {
  const [firstVj, ...otherVjs] = item.vjs;
  return (
    <Link href={titleHref(item.kind, item.slug)} className={cn("group relative block", className)}>
      <PosterImage
        path={item.posterPath}
        title={item.title}
        sizes={sizes}
        eager={eager}
        className="rounded-md ring-1 ring-inset ring-border transition duration-200 group-hover:shadow-card-glow group-hover:ring-highlight/60"
      />
      <p className="mt-2 truncate text-label-lg group-hover:text-highlight">{item.title}</p>
      <p className="mt-1 flex items-center gap-2 text-body-sm text-muted">
        {item.releaseYear && <span>{item.releaseYear}</span>}
        {item.releaseYear && <span aria-hidden>·</span>}
        <span>{item.kind === "movie" ? "Movie" : "Series"}</span>
      </p>
      {item.rating !== null && (
        <span className="absolute right-2 top-2 rounded-sm bg-black/85 px-1.5 py-1 text-label-tag text-white [&_svg]:size-3 [&_svg]:fill-highlight [&_svg]:text-highlight">
          <Rating value={item.rating} />
        </span>
      )}
      {/* After the title in reading order; drawn over the poster's top-left corner. */}
      {firstVj && (
        <span className="absolute left-2 top-2 flex max-w-[calc(100%-4.5rem)] items-center gap-1 rounded-sm bg-black/90 px-1.5 py-1 text-label-tag uppercase text-[#ff646c]">
          <span aria-hidden className="truncate">{firstVj.name}</span>
          {otherVjs.length > 0 && <span aria-hidden className="shrink-0">+{otherVjs.length}</span>}
          <span className="sr-only">Available from {item.vjs.map((vj) => vj.name).join(", ")}</span>
        </span>
      )}
      {item.kind === "series" && (
        <span className="pointer-events-none absolute inset-x-0 top-0 flex aspect-[2/3] items-end p-2">
          <span className="rounded-sm bg-accent px-1.5 py-1 text-label-tag uppercase text-accent-foreground">Series</span>
        </span>
      )}
    </Link>
  );
}
