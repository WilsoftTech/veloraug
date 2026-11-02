import Link from "next/link";
import { Search } from "lucide-react";
import { AccountLink } from "@/components/account-link";
import { HeaderSearch } from "@/components/header-search";
import { Logo } from "@/components/logo";
import { NavLink } from "@/components/nav-link";

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/movies", label: "Movies" },
  { href: "/series", label: "Series" },
  { href: "/vjs", label: "VJs" },
  { href: "/my-list", label: "My List" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
      <div className="page-container flex min-h-16 items-center gap-4 lg:min-h-20 lg:gap-6">
        <Link href="/" className="inline-flex min-h-11 items-center">
          <span className="flex flex-col items-start">
            <Logo eager className="h-7 md:h-8" />
            <span className="pl-1.5 text-[0.5625rem] font-semibold uppercase tracking-widest text-muted">Ugandan VJ translations</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <NavLink
                  href={item.href}
                  className="relative inline-flex min-h-11 items-center whitespace-nowrap rounded-default px-3 text-label-lg transition-colors hover:bg-surface hover:text-foreground"
                  activeClassName="bg-surface-elevated text-highlight"
                  inactiveClassName="text-muted"
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center">
          <HeaderSearch />
          <Link
            href="/search"
            aria-label="Search"
            className="grid size-11 place-items-center rounded-default text-foreground transition-colors hover:bg-surface-elevated lg:hidden"
          >
            <Search aria-hidden className="size-5" />
          </Link>
          <AccountLink />
        </div>
      </div>
    </header>
  );
}
