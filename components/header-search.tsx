"use client";

import { usePathname } from "next/navigation";
import { Search } from "lucide-react";

/**
 * Desktop header search. A plain GET form, so it works before hydration and
 * hands off to the live search page on submit. Hidden on that page, which has
 * its own input.
 */
export function HeaderSearch() {
  const pathname = usePathname();
  if (pathname === "/search") return null;

  return (
    <form action="/search" role="search" className="relative hidden lg:block">
      <label htmlFor="header-search" className="sr-only">
        Search movies and shows
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input
        id="header-search"
        name="q"
        type="search"
        autoComplete="off"
        placeholder="Search movies, shows…"
        className="h-11 w-40 rounded-default border border-border bg-surface pl-10 pr-3 text-body-sm text-foreground placeholder:text-muted transition-colors focus:border-highlight focus:shadow-focus focus-visible:outline-none 2xl:w-56"
      />
    </form>
  );
}
