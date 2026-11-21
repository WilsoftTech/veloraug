"use client";

import { useActionState } from "react";
import { Field } from "@/components/form-field";
import { buttonClass } from "@/components/button";
import { POSTER_MAX_BYTES } from "@/lib/artwork";
import type { MetadataFormState } from "@/lib/movie-metadata";
import type { SeriesChoice } from "@/lib/series-review";

/** Hand-entered series details and poster, for a series TMDB has no record of. */
export function SeriesMetadataForm({ action, series, postersEnabled }: {
  action: (state: MetadataFormState, data: FormData) => Promise<MetadataFormState>;
  /** The series being edited; omitted to add a new one. */
  series?: SeriesChoice;
  postersEnabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const prefix = `series-${series?.id ?? "new"}-`;
  const initial = series?.metadata;
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2" aria-label={series ? `Edit ${initial?.title}` : "Add a series"}>
      <input type="hidden" name="seriesId" value={series?.id ?? ""} />
      {series && <input type="hidden" name="updatedAt" value={series.updated_at} />}
      {state.error && <p role="alert" className="rounded-lg border border-destructive p-3 sm:col-span-2">{state.error}</p>}
      {state.notice && <p role="status" className="rounded-lg border border-highlight/40 p-3 sm:col-span-2">{state.notice}</p>}
      <Field id={prefix + "title"} label="Series title">
        {(props) => <input {...props} name="title" required minLength={1} maxLength={300} defaultValue={initial?.title ?? ""} disabled={pending} />}
      </Field>
      <Field id={prefix + "original"} label="Original title (optional)">
        {(props) => <input {...props} name="originalTitle" maxLength={300} defaultValue={initial?.original_title ?? ""} disabled={pending} />}
      </Field>
      <Field id={prefix + "aired"} label="First aired">
        {(props) => <input {...props} type="date" name="firstAirDate" required min="1870-01-01" max="2199-12-31" defaultValue={initial?.first_air_date ?? ""} disabled={pending} />}
      </Field>
      <Field id={prefix + "genres"} label="Genres (optional)" hint="Separate genres with commas, for example Action, Drama.">
        {(props) => <input {...props} name="genres" maxLength={1600} defaultValue={initial?.genres.join(", ") ?? ""} disabled={pending} />}
      </Field>
      <div className="sm:col-span-2">
        <Field id={prefix + "overview"} label="Description (optional)">
          {(props) => <textarea {...props} name="overview" rows={4} maxLength={10000} defaultValue={initial?.overview ?? ""} disabled={pending} />}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field id={prefix + "poster"} label="Poster from your device (optional)"
          hint={postersEnabled ? `JPEG, PNG or WebP, up to ${POSTER_MAX_BYTES / 1024 / 1024} MB. Leave empty to keep the current poster.` : "Poster uploads are unavailable until the poster storage is configured. Details can still be saved."}>
          {(props) => <input {...props} type="file" name="poster" accept="image/jpeg,image/png,image/webp" disabled={pending || !postersEnabled} />}
        </Field>
      </div>
      <button className={buttonClass("primary", "sm:col-span-2 sm:justify-self-start")} disabled={pending} aria-disabled={pending}>
        {pending ? "Saving..." : series ? "Save series details" : "Add series"}
      </button>
    </form>
  );
}
