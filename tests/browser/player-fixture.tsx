import { createRoot } from "react-dom/client";
import { MoviePlayer } from "@/components/movie-player";
import "@/app/globals.css";
import type { PlayableVersion } from "@/lib/playback/player";

declare global {
  interface Window { fixtureVersions: PlayableVersion[]; fixtureSignedIn: boolean }
}

// Test-only CSR host. Vite substitutes session and Next navigation, not player/transfer logic.
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-5xl p-4">
    <h1 className="mb-4 text-heading-lg">Synthetic movie</h1>
    <div className="flex flex-wrap items-center gap-3">
      <MoviePlayer versions={window.fixtureVersions} signInHref="/sign-in?next=%2Ffixture" />
    </div>
  </main>,
);
