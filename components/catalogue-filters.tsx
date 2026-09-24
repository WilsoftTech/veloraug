import Link from "next/link";
import { redirect } from "next/navigation";
import { buttonClass } from "@/components/button";
import { Field } from "@/components/form-field";
import { browseHref, hasBrowseFilters, parseBrowseFilters, type BrowseFilters } from "@/lib/browse";
import type { CatalogueKind, Genre, Vj } from "@/types/catalogue";

/**
 * Apply runs on the server: the submitted values go through the same parser as
 * the URL and the browser is sent to the canonical address (empty fields
 * dropped, cursor reset). Works without JavaScript.
 */
async function applyFilters(formData: FormData) {
  "use server";
  const kind: CatalogueKind = formData.get("kind") === "series" ? "series" : "movie";
  const submitted: Record<string, string> = {};
  for (const name of ["genre", "vj"]) {
    const value = formData.get(name);
    if (typeof value === "string") submitted[name] = value;
  }
  const { genre, vj } = parseBrowseFilters(submitted);
  redirect(browseHref(kind, { genre, vj }));
}

interface CatalogueFiltersProps {
  kind: CatalogueKind;
  filters: BrowseFilters;
  genres: Genre[];
  vjs: Vj[];
}

/** Native controls only, so keyboard, screen-reader and touch behaviour come from the platform. */
export function CatalogueFilters({ kind, filters, genres, vjs }: CatalogueFiltersProps) {
  return (
    <form
      action={applyFilters}
      aria-label="Filter titles"
      className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface p-4 backdrop-blur-md sm:p-5 md:grid-cols-3"
    >
      <input type="hidden" name="kind" value={kind} />

      <Field id={`${kind}-genre`} label="Genre">
        {(field) => (
          <select name="genre" defaultValue={filters.genre ?? ""} {...field}>
            <option value="">Any genre</option>
            {genres.map(({ slug, name }) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field id={`${kind}-vj`} label="VJ">
        {(field) => (
          <select name="vj" defaultValue={filters.vj ?? ""} {...field}>
            <option value="">Any VJ</option>
            {vjs.map(({ slug, name }) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div className="col-span-2 flex flex-wrap gap-3 md:col-span-1 md:self-end">
        <button type="submit" className={buttonClass("primary", "flex-1 sm:flex-none")}>
          Apply filters
        </button>
        {hasBrowseFilters(filters) && (
          <Link href={browseHref(kind)} className={buttonClass("ghost", "border border-border")}>
            Reset
          </Link>
        )}
      </div>
    </form>
  );
}
