"use client";

import { useEffect, useState } from "react";
import { MovieSection } from "@/components/movie-section";
import { fetchContinueWatching, progressFraction, type ContinueWatchingItem } from "@/lib/playback/progress";
import { useSession } from "@/lib/session";

/**
 * The signed-in viewer's unfinished movies (E5), most recent first. A client
 * island, so the home page stays one cached render for everyone: guests never
 * make the request, and nothing is shown until there is something to resume.
 */
export function ContinueWatching() {
  const session = useSession();
  const [items, setItems] = useState<ContinueWatchingItem[]>([]);

  useEffect(() => {
    if (session !== "signed-in") return;
    const controller = new AbortController();
    void fetchContinueWatching(fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setItems(result ?? []);
    });
    return () => controller.abort();
  }, [session]);

  if (session !== "signed-in" || items.length === 0) return null;
  const progress: Record<string, number> = {};
  for (const item of items) {
    const fraction = progressFraction(item.positionSeconds, item.durationSeconds);
    if (fraction !== null) progress[`${item.title.kind}-${item.title.id}`] = fraction;
  }
  return <MovieSection title="Continue Watching" items={items.map((item) => item.title)} progress={progress} />;
}
