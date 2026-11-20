"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { buttonClass } from "@/components/button";
import { Field } from "@/components/form-field";

interface PickerOption {
  value: number;
  label: string;
}

interface EpisodePickerProps {
  /** The series page, e.g. /series/money-heist-2017. */
  action: string;
  seasons: PickerOption[];
  episodes: PickerOption[];
  season: number;
  episode: number | null;
}

/**
 * Season and episode dropdowns. Each choice is a navigation to `?season=&episode=`, so the
 * selection is shareable and survives refresh and back/forward. Native selects keep keyboard,
 * screen-reader and touch behaviour; without JavaScript the form submits the same query.
 */
export function EpisodePicker({ action, seasons, episodes, season, episode }: EpisodePickerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (params: Record<string, number>) => {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    startTransition(() => router.push(`${action}?${query}`, { scroll: false }));
  };

  return (
    <form action={action} method="get" aria-label="Choose an episode" aria-busy={pending} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field id="series-season" label="Season">
        {(field) => (
          // Keyed by the current selection: the viewer's choice stays shown while the page loads,
          // and the control resets to what the server selected once it has.
          <select key={`season-${season}`} name="season" defaultValue={season} onChange={(event) => go({ season: Number(event.target.value) })} {...field}>
            {seasons.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        )}
      </Field>
      <Field id="series-episode" label="Episode">
        {(field) => (
          <select key={`episode-${season}-${episode}`} name="episode" defaultValue={episode ?? undefined} disabled={episodes.length === 0}
            onChange={(event) => go({ season, episode: Number(event.target.value) })} {...field}>
            {episodes.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        )}
      </Field>
      <noscript>
        <button type="submit" className={buttonClass("secondary")}>Show episode</button>
      </noscript>
      {pending && <p role="status" className="text-body-sm text-muted sm:col-span-2">Loading episode…</p>}
    </form>
  );
}
