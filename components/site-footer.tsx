import Image from "next/image";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ThemeControl } from "@/components/theme-control";

/**
 * TMDB's API terms (themoviedb.org/api-terms-of-use) require the TMDB logo to
 * identify our use of their data, less prominent than our own mark, plus this
 * exact notice placed prominently. Keep the wording and the logo unmodified.
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border bg-canvas-subtle sm:mt-24">
      <div className="page-container flex flex-col gap-6 pt-10 pb-24 text-muted lg:pb-8">
        <div className="grid gap-8 text-body-md sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr] lg:gap-16">
          <div className="flex max-w-xl flex-col items-start gap-4 sm:col-span-2 lg:col-span-1">
            <Logo className="h-8" />
            <p className="text-body-lg font-semibold text-foreground">Your World of Entertainment.</p>
            <p className="text-body-sm leading-6">Discover VJ-translated movies and series, explore your favourite VJs, and keep the titles you love in My List. Find your next watch on Velora UG.</p>
          </div>
          <nav aria-label="Browse">
            <h2 className="mb-3 text-label-md uppercase tracking-widest text-foreground">Browse</h2>
            <ul className="space-y-1 text-body-sm">
              <li><Link href="/" className="inline-flex min-h-11 items-center hover:text-highlight">Home</Link></li>
              <li><Link href="/movies" className="inline-flex min-h-11 items-center hover:text-highlight">Movies catalogue</Link></li>
              <li><Link href="/series" className="inline-flex min-h-11 items-center hover:text-highlight">TV shows & series</Link></li>
              <li><Link href="/vjs" className="inline-flex min-h-11 items-center hover:text-highlight">VJs directory</Link></li>
            </ul>
          </nav>
          <nav aria-label="Your Velora">
            <h2 className="mb-3 text-label-md uppercase tracking-widest text-foreground">Your Velora</h2>
            <ul className="space-y-1 text-body-sm">
              <li><Link href="/my-list" className="inline-flex min-h-11 items-center hover:text-highlight">My List</Link></li>
              <li><Link href="/search" className="inline-flex min-h-11 items-center hover:text-highlight">Search titles & VJs</Link></li>
            </ul>
            <div className="mt-4"><ThemeControl /></div>
          </nav>
        </div>

        <p className="border-t border-border pt-6 text-body-sm">© 2026 Wilsoft Technologies. All rights reserved.</p>
        <div className="flex flex-col gap-1 border-t border-border pt-4 sm:flex-row sm:items-center sm:gap-4">
          <a
            href="https://www.themoviedb.org"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 shrink-0 items-center"
          >
            <Image src="/images/tmdb-logo.svg" alt="TMDB" width={92} height={12} unoptimized className="h-3 w-auto" />
          </a>
          <p className="text-body-sm">
            This website uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
          </p>
        </div>
      </div>
    </footer>
  );
}
