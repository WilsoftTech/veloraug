import Link from "next/link";
import { cn } from "@/lib/utils";

interface TabLinksProps {
  label: string;
  tabs: { label: string; href: string; active: boolean }[];
}

/** URL-driven tabs: each tab is a link, so state is shareable and needs no JS. */
export function TabLinks({ label, tabs }: TabLinksProps) {
  return (
    <nav aria-label={label} className="w-fit max-w-full rounded-default border border-border bg-surface p-1">
      {/* Scrolls sideways when the tabs outgrow a phone; pb-px keeps the active underline inside the scroll box. */}
      <ul className="flex gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <li key={tab.label}>
            <Link
              href={tab.href}
              replace
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap rounded-sm px-4 text-label-lg transition-colors",
                tab.active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted hover:bg-surface-elevated hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
