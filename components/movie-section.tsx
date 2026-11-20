import { useId } from "react";
import { MovieCard } from "@/components/movie-card";
import { SectionHeader } from "@/components/section-header";
import type { TitleSummary } from "@/types/catalogue";

interface MovieSectionProps {
  title: string;
  items: TitleSummary[];
  href?: string;
  /** Watched share (0–1) per card, keyed `${kind}-${id}` (Continue Watching). */
  progress?: Record<string, number>;
}

/** A titled, horizontally scrolling row of poster cards. */
export function MovieSection({ title, items, href, progress }: MovieSectionProps) {
  const headingId = useId();
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={headingId}>
      <SectionHeader id={headingId} title={title} href={href} />
      <ul className="page-bleed no-scrollbar relative flex snap-x snap-proximity gap-3 overflow-x-auto pb-2 md:gap-4">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="w-36 shrink-0 snap-start sm:w-44 lg:w-48">
            <MovieCard item={item} progress={progress?.[`${item.kind}-${item.id}`]} />
          </li>
        ))}
      </ul>
    </section>
  );
}
