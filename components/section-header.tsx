import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface SectionHeaderProps {
  title: string;
  id?: string;
  /** Adds a "See all" link when provided. */
  href?: string;
}

export function SectionHeader({ title, id, href }: SectionHeaderProps) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <h2 id={id} className="border-l-4 border-accent pl-3 text-headline-sm font-bold uppercase tracking-wide">
        {title}
      </h2>
      {href && (
        <Link
          href={href}
          className="-my-2 inline-flex min-h-11 shrink-0 items-center gap-1 text-label-lg text-highlight transition-colors hover:text-foreground"
        >
          See all
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}
