import { useId } from "react";
import { MovieCard } from "@/components/movie-card";
import { SectionHeader } from "@/components/section-header";
import type { TitleSummary } from "@/types/catalogue";

interface MovieSectionProps {
  title: string;
  items: TitleSummary[];
  href?: string;
}

/** A titled, horizontally scrolling row of poster cards. */
export function MovieSection({ title, items, href }: MovieSectionProps) {
  const headingId = useId();
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={headingId}>
      <SectionHeader id={headingId} title={title} href={href} />
      <ul className="page-bleed no-scrollbar relative flex snap-x snap-proximity gap-4 overflow-x-auto pb-1 md:gap-6">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="w-32 shrink-0 snap-start sm:w-40 lg:w-44">
            <MovieCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}
