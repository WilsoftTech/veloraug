import type { ReactNode } from "react";
import Link from "next/link";
import { PosterImage } from "@/components/media-image";
import { Rating } from "@/components/rating";
import type { TitleSummary } from "@/types/catalogue";

/** Saved-title grid, retaining a separate touch target for each item's action. */
export function MovieList({ children }: { children: ReactNode }) {
  return <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 md:gap-x-6 lg:grid-cols-5 xl:grid-cols-6">{children}</ul>;
}

interface MovieListItemProps {
  item: Pick<TitleSummary, "title" | "posterPath" | "releaseYear" | "rating">;
  /** Where the row opens; null renders it as plain text (a title that is no longer available). */
  href: string | null;
  /** What kind of title this is: "Movie" or "Series". */
  typeLabel: string;
  /** Trailing control (e.g. remove). Rendered outside the link so it stays a valid, separate target. */
  action?: ReactNode;
}

/** Compact row form of a title, used by search results and My List. */
export function MovieListItem({ item, href, typeLabel, action }: MovieListItemProps) {
  const body = (
    <>
      <PosterImage path={item.posterPath} title={item.title} sizes="(min-width: 1280px) 15vw, (min-width: 1024px) 19vw, (min-width: 768px) 24vw, (min-width: 640px) 32vw, 48vw" className="rounded-md ring-1 ring-border" />
      <div className="mt-2 min-w-0">
        <p className="truncate text-label-lg">{item.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-body-sm text-muted">
          {item.releaseYear && <span>{item.releaseYear}</span>}
          {item.releaseYear && <span aria-hidden>·</span>}
          <span>{typeLabel}</span>
          {item.rating !== null && <span aria-hidden>·</span>}
          <Rating value={item.rating} />
        </p>
      </div>
    </>
  );
  const rowClass = "block min-w-0 transition-colors hover:text-highlight";

  return (
    <li className="relative min-w-0">
      {href ? (
        <Link href={href} className={rowClass}>
          {body}
        </Link>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {action && <div className="absolute right-2 top-2 rounded-default border border-border bg-background/95">{action}</div>}
    </li>
  );
}
