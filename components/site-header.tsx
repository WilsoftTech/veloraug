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
    <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="page-container flex h-14 items-center gap-8 md:h-16">
        <Link href="/" className="inline-flex min-h-11 items-center">
          <Logo eager className="h-8 md:h-9" />
        </Link>

        <nav aria-label="Primary" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <NavLink
                  href={item.href}
                  className="relative inline-flex min-h-11 items-center px-3 text-label-lg text-muted transition-colors hover:text-foreground"
                  activeClassName="text-foreground after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:rounded-full after:bg-highlight after:shadow-[0_0_12px_rgb(56_189_248/0.6)]"
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
            className="grid size-11 place-items-center rounded-default text-foreground transition-colors hover:bg-surface-elevated md:hidden"
          >
            <Search aria-hidden className="size-5" />
          </Link>
          <AccountLink />
        </div>
      </div>
    </header>
  );
}
