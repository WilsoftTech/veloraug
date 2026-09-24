"use client";

import Link from "next/link";
import { Bookmark, X } from "lucide-react";
import { buttonClass } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { MovieList, MovieListItem } from "@/components/movie-list-item";
import { ListSkeleton } from "@/components/skeletons";
import { MUTATION_MESSAGES } from "@/components/watchlist-button";
import { mediaTypeLabel, watchlistRefKey } from "@/lib/utils";
import { useWatchlist } from "@/lib/watchlist";
import type { MediaType } from "@/types/media";
import type { WatchlistItem } from "@/types/watchlist";

const COPY: Record<MediaType, { empty: string; explore: string; href: string }> = {
  movie: { empty: "No movies saved yet", explore: "Explore Movies", href: "/movies" },
  tv: { empty: "No series saved yet", explore: "Explore Series", href: "/series" },
};

/** Two tabs: movies, and series (catalogue series plus legacy TMDB "tv" saves). */
function tabOf({ ref }: WatchlistItem): MediaType {
  if (ref.source === "tmdb") return ref.mediaType;
  return ref.kind === "movie" ? "movie" : "tv";
}

function typeLabel({ ref }: WatchlistItem) {
  if (ref.source === "tmdb") return mediaTypeLabel(ref.mediaType);
  return ref.kind === "movie" ? "Movie" : "Series";
}

export function WatchlistView({ mediaType }: { mediaType: MediaType }) {
  const { items, status, importFailed, loadError, mutationError, remove, retry } = useWatchlist();

  if (items === null && status === "error") {
    const expired = loadError === "signed-out";
    return (
      <EmptyState
        icon={<Bookmark className="size-6" />}
        title={expired ? "Your session has expired" : "We couldn't load your list"}
        description={expired ? "Sign in again to see your saved titles." : "Something went wrong on our side. Your saved titles are safe."}
      >
        {expired ? (
          <Link href="/sign-in?next=/my-list" className={buttonClass("primary")}>
            Sign in
          </Link>
        ) : (
          <button type="button" onClick={retry} className={buttonClass("primary")}>
            Try again
          </button>
        )}
      </EmptyState>
    );
  }

  // Storage and the session are only readable in the browser; avoid flashing a false empty state.
  if (items === null) return <ListSkeleton />;

  const visible = items.filter((item) => tabOf(item) === mediaType);
  const copy = COPY[mediaType];

  const notices = (
    <>
      {importFailed && (
        <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-default border border-highlight/30 bg-accent/12 px-4 py-3 text-body-md">
          <p>We couldn&apos;t add the titles you saved as a guest to your account yet. They&apos;re still on this device.</p>
          <button type="button" onClick={retry} className={buttonClass("secondary", "min-h-11")}>
            Try again
          </button>
        </div>
      )}
      {mutationError && (
        <p role="alert" className="mb-3 rounded-default border border-destructive/40 px-4 py-3 text-body-md text-destructive">
          {MUTATION_MESSAGES[mutationError.error]}
        </p>
      )}
    </>
  );

  if (visible.length === 0) {
    return (
      <>
        {notices}
        <EmptyState
          icon={<Bookmark className="size-6" />}
          title={copy.empty}
          description="Save titles you want to watch later and they'll show up here."
        >
          <Link href={copy.href} className={buttonClass("primary")}>
            {copy.explore}
          </Link>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {notices}
      <MovieList>
        {visible.map((item) => (
          <MovieListItem
            key={watchlistRefKey(item.ref)}
            item={item}
            href={item.href}
            typeLabel={typeLabel(item)}
            action={
              <button
                type="button"
                aria-label={`Remove ${item.title} from My List`}
                onClick={() => remove(item)}
                className="grid size-11 shrink-0 place-items-center rounded-default text-muted transition-colors hover:bg-surface-elevated hover:text-foreground"
              >
                <X aria-hidden className="size-5" />
              </button>
            }
          />
        ))}
      </MovieList>
    </>
  );
}
