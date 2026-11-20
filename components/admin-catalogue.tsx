import Link from "next/link";
import { buttonClass } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/form-field";
import { Pagination } from "@/components/pagination";
import { PosterImage } from "@/components/media-image";
import { cn, titleHref } from "@/lib/utils";
import { adminCatalogueHref, parseAdminCatalogueFilters } from "@/lib/browse";
import type { AdminMovie, AdminMoviePage } from "@/lib/discovery/database";
import type { Vj } from "@/types/catalogue";

type Action = (data: FormData) => Promise<void>;

const STATE: Record<AdminMovie["publication_status"], { label: string; className: string }> = {
  published: { label: "Live", className: "border-highlight/40 bg-accent/12 text-highlight" },
  archived: { label: "Withdrawn", className: "border-destructive text-destructive" },
  draft: { label: "Draft", className: "border-border text-muted" },
};
const Badge = ({ className, children }: { className: string; children: string }) =>
  <span className={cn("rounded-full border px-3 py-1 text-label-md", className)}>{children}</span>;

/**
 * The catalogue as the admin manages it: every movie with its state, and the
 * VJs. `canManage`: the account holds the publish permission, so the controls
 * are offered; the database checks each one again. Without it the page is a
 * read-only list.
 */
export function AdminCatalogue({ movies, vjs, canManage, movieAction, addVjAction, error, notice, query = {}, cataloguePage }: { cataloguePage?: AdminMoviePage; query?: { q?: string | string[]; status?: string | string[]; page?: string | string[]; cursor?: string | string[] }; movies: AdminMovie[]; vjs: Pick<Vj, "id" | "slug" | "name">[]; canManage: boolean; movieAction: Action; addVjAction: Action; error?: string; notice?: string }) {
  const filters = parseAdminCatalogueFilters(query);
  const search = filters.q;
  const status = filters.status;
  const matching = movies.filter((movie) => (!status || movie.publication_status === status) &&
    (!search || [movie.title, movie.release_year, ...movie.versions.map((version) => version.vj)].join(" ").toLowerCase().includes(search.toLowerCase())));
  const pageSize = 20;
  const requestedPage = typeof query.page === "string" && /^[1-9]\d{0,5}$/.test(query.page) ? Number(query.page) : 1;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(matching.length / pageSize)));
  const start = (page - 1) * pageSize;
  const visible = cataloguePage ? cataloguePage.items : matching.slice(start, start + pageSize);
  const pageHref = (number: number) => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (status) params.set("status", status);
    if (number > 1) params.set("page", String(number));
    return `/admin/catalogue${params.size ? `?${params}` : ""}`;
  };
  return <div className="space-y-8">
    <div>
      <h1 className="text-headline-md">Catalogue</h1>
      <p className="mt-2 text-body-md text-muted">{cataloguePage ? "Search the full movie catalogue and manage its states." : "Loaded catalogue movies and their states."} A new movie arrives through the review queue.{canManage ? "" : " Changing a movie or adding a VJ needs the publish permission, which your account does not have."}</p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-highlight/40 bg-accent/12 p-4">{notice}</p>}
    <section aria-labelledby="movies-heading">
      <h2 id="movies-heading" className="mb-4 text-headline-sm">Movies</h2>
      <form action="/admin/catalogue" method="get" aria-label="Filter catalogue" className="mb-4 grid gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
        <Field id="catalogue-search" label={cataloguePage ? "Search movies" : "Search loaded movies"} hint="Search by title, release year or VJ.">{(props) => <input {...props} type="search" name="q" maxLength={300} defaultValue={search} />}</Field>
        <Field id="catalogue-status" label="Publication status">{(props) => <select {...props} name="status" defaultValue={status}><option value="">All states</option>{Object.entries(STATE).map(([value, state]) => <option key={value} value={value}>{state.label}</option>)}</select>}</Field>
        <div className="flex flex-wrap gap-3 sm:col-span-2"><button className={buttonClass("secondary")}>Apply filters</button>{(search || status) && <Link href="/admin/catalogue" className={buttonClass("ghost")}>Reset filters</Link>}</div>
      </form>
      <p className="mb-4 text-body-sm text-muted">{cataloguePage ? `${visible.length} ${visible.length === 1 ? "movie" : "movies"} on this page.${cataloguePage.nextCursor ? " More matches on the next page." : ""}` : <>Filters apply to {movies.length} loaded {movies.length === 1 ? "movie" : "movies"}. {matching.length > 0 ? `Showing ${start + 1} to ${start + visible.length} of ${matching.length}.` : "No matches."}</>}</p>
      {!cataloguePage && movies.length === 0 ? <EmptyState title="No movies" description="No movies have been added yet." /> : visible.length === 0 ? <EmptyState title="No matching movies" description="Try another title, year, VJ or publication status."><Link href="/admin/catalogue" className={buttonClass("secondary")}>Reset filters</Link></EmptyState> : <ul className="space-y-4">
        {visible.map((movie) => { const live = movie.publication_status === "published"; const ids = <><input type="hidden" name="id" value={movie.id} /><input type="hidden" name="slug" value={movie.slug} /></>; return <li key={movie.id} className="rounded-lg border border-border bg-surface p-4 sm:p-5">
          <div className="flex gap-4">
            <PosterImage path={movie.poster_path} title={movie.title} sizes="64px" className="w-16 shrink-0 self-start rounded-default" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 break-words text-body-lg font-semibold">{live ? <Link className="underline decoration-highlight/40 underline-offset-4" href={titleHref("movie", movie.slug)}>{movie.title}</Link> : movie.title}</h3>
                <span className="flex flex-wrap gap-2">{movie.is_featured && <Badge className="border-border text-foreground">Featured</Badge>}<Badge className={STATE[movie.publication_status].className}>{STATE[movie.publication_status].label}</Badge></span>
              </div>
              {canManage && <Link className={buttonClass("secondary", "mt-3")} href={`/admin/catalogue/${movie.id}/edit`}>Edit poster and details</Link>}
              <p className="mt-1 text-body-sm text-muted">{movie.release_year ?? "Year unknown"} · {movie.versions.length ? movie.versions.map((version) => version.vj).join(", ") : "No VJ version"}</p>
              {canManage && movie.publication_status !== "draft" && <form action={movieAction} className="mt-4 flex flex-wrap gap-3">{ids}
                {live && <button name="command" value={movie.is_featured ? "unfeature" : "feature"} className={buttonClass("secondary")}>{movie.is_featured ? "Stop featuring" : "Feature on home"}</button>}
                {live
                  ? <button name="command" value="withdraw" className={buttonClass("secondary")}>Withdraw from site</button>
                  : <button name="command" value="restore" className={buttonClass()}>Restore to site</button>}
              </form>}
              {canManage && <details className="mt-4 rounded-lg border border-border p-4">
                <summary className="cursor-pointer text-label-lg">Edit title and description</summary>
                <form action={movieAction} className="mt-4 grid gap-4">{ids}<input type="hidden" name="command" value="edit" />
                  <Field id={`title-${movie.id}`} label="Title">{(props) => <input {...props} name="title" required maxLength={300} defaultValue={movie.title} />}</Field>
                  <Field id={`overview-${movie.id}`} label="Description" hint="The page address and the film's TMDB identity do not change.">{(props) => <textarea {...props} className={cn(props.className, "h-32 py-2")} name="overview" maxLength={10000} defaultValue={movie.overview ?? ""} />}</Field>
                  <button className={buttonClass("secondary", "justify-self-start")}>Save</button>
                </form>
              </details>}
            </div>
          </div>
        </li>; })}
      </ul>}
      <Pagination firstHref={cataloguePage ? (filters.cursor ? adminCatalogueHref({ ...filters, cursor: null }) : null) : page > 1 ? pageHref(1) : null} nextHref={cataloguePage ? (cataloguePage.nextCursor ? adminCatalogueHref({ ...filters, cursor: cataloguePage.nextCursor }) : null) : start + pageSize < matching.length ? pageHref(page + 1) : null} />
    </section>
    <section aria-labelledby="vjs-heading">
      <h2 id="vjs-heading" className="mb-4 text-headline-sm">VJs</h2>
      <p className="mb-4 text-body-md text-muted">A detected movie can only be matched to a VJ listed here.</p>
      {vjs.length === 0 ? <EmptyState title="No VJs" description="No active VJ exists yet." /> : <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {vjs.map((vj) => <li key={vj.id}><Link href={`/vjs/${vj.slug}`} className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-highlight/40"><span className="block text-body-md font-semibold">{vj.name}</span><span className="block text-body-sm text-muted">{vj.slug}</span></Link></li>)}
      </ul>}
      {canManage && <form action={addVjAction} className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border p-5">
        <div className="min-w-0 flex-1 sm:max-w-sm"><Field id="vj-name" label="Add a VJ" hint="For example: Junior. It is saved as “VJ Junior”.">{(props) => <input {...props} name="name" required maxLength={100} />}</Field></div>
        <button className={buttonClass("secondary")}>Add VJ</button>
      </form>}
    </section>
  </div>;
}
