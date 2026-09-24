import Link from "next/link";
import { buttonClass } from "@/components/button";

interface PaginationProps {
  /** Link back to the first page, or null when already on it. */
  firstHref: string | null;
  /** Link to the following page, or null at the end. */
  nextHref: string | null;
}

/**
 * Keyset pagination (lib/catalogue.ts cursors): "Next" continues after the last
 * title shown, and "First page" starts over. Renders nothing for a single page.
 */
export function Pagination({ firstHref, nextHref }: PaginationProps) {
  if (!firstHref && !nextHref) return null;

  return (
    <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-4">
      {firstHref ? (
        <Link href={firstHref} className={buttonClass("secondary")}>
          First page
        </Link>
      ) : (
        <span className="min-w-24" />
      )}
      {nextHref ? (
        <Link href={nextHref} className={buttonClass("secondary")}>
          Next
        </Link>
      ) : (
        <span className="min-w-24" />
      )}
    </nav>
  );
}
