import { Bookmark, Clapperboard, House, Search, Tv } from "lucide-react";
import { NavLink } from "@/components/nav-link";

const TABS = [
  { href: "/", label: "Home", icon: House },
  { href: "/movies", label: "Movies", icon: Clapperboard },
  { href: "/series", label: "Series", icon: Tv },
  { href: "/search", label: "Search", icon: Search },
  { href: "/my-list", label: "My List", icon: Bookmark },
];

/** Phone-only tab bar; mirrors the native bottom tabs the Expo app will use. */
export function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      <ul className="grid grid-cols-5">
        {TABS.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <NavLink
              href={href}
              className="relative flex min-h-14 flex-col items-center justify-center gap-1 text-label-md text-muted transition-colors"
              activeClassName="text-highlight before:absolute before:inset-x-6 before:top-0 before:h-0.5 before:rounded-full before:bg-highlight"
            >
              <Icon aria-hidden className="size-5" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
