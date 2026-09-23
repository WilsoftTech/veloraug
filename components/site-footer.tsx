import Image from "next/image";
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
      <div className="page-container flex flex-col gap-6 pt-8 pb-24 text-muted md:pb-8">
        <div className="flex flex-col gap-3 text-body-md sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-4">
            <Logo className="h-7" />
            <p>Your World of Entertainment.</p>
          </div>
          <ThemeControl />
          <p className="text-body-sm">© 2026 Wilsoft Technologies. All rights reserved.</p>
        </div>

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
