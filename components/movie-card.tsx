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

const ROW_POSTER_SIZES = "(min-width: 1024px) 176px, (min-width: 640px) 160px, 128px";

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
        className="ring-1 ring-inset ring-border transition duration-200 group-hover:-translate-y-0.5 group-hover:shadow-card-glow group-hover:ring-highlight/40"
      />
      <p className="mt-2.5 truncate text-body-md font-semibold">{item.title}</p>
      <p className="mt-0.5 flex items-center gap-2 text-body-sm text-muted">
        {item.releaseYear && <span>{item.releaseYear}</span>}
        <Rating value={item.rating} />
      </p>
      {/* After the title in reading order; drawn over the poster's top-left corner. */}
      {firstVj && (
        <span className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full border border-highlight/30 bg-background/85 px-2 py-0.5 text-label-tag uppercase text-highlight backdrop-blur-sm transition duration-200 group-hover:-translate-y-0.5">
          <span aria-hidden className="truncate">{firstVj.name}</span>
          {otherVjs.length > 0 && <span aria-hidden className="shrink-0">+{otherVjs.length}</span>}
          <span className="sr-only">Available from {item.vjs.map((vj) => vj.name).join(", ")}</span>
        </span>
      )}
    </Link>
  );
}
