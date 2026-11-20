import { AdminCatalogue } from "@/components/admin-catalogue";
import { EmptyState } from "@/components/empty-state";
import { parseAdminCatalogueFilters } from "@/lib/browse";
import { listMovies, listVjs } from "@/lib/catalogue";
import { DiscoveryStoreError, type AdminMovie, type AdminMoviePage } from "@/lib/discovery/database";
import { resultMessage } from "@/lib/discovery/guidance";
import { databaseReviewClient, requireReviewAdmin, reviewMode } from "@/lib/discovery/runtime";
import { addVjAction, movieAction } from "./actions";

/** Before the dashboard commands are deployed: the published catalogue as visitors get it, read-only. */
async function publishedOnly(): Promise<AdminMovie[]> {
  return (await listMovies({ limit: 50 })).items.map((movie) => ({
    id: movie.id, slug: movie.slug, title: movie.title, overview: null, release_year: movie.releaseYear, poster_path: movie.posterPath,
    publication_status: "published", is_featured: false, published_at: null,
    versions: movie.vjs.map((vj) => ({ id: vj.id, vj: vj.name, availability_status: "ready", rights_status: "cleared" })),
  }));
}

export const dynamic = "force-dynamic";
export default async function AdminCataloguePage({ searchParams }: { searchParams: Promise<{ result?: string; q?: string | string[]; status?: string | string[]; page?: string | string[]; cursor?: string | string[] }> }) {
  await requireReviewAdmin();
  if (reviewMode() !== "database") return <EmptyState as="h1" title="Catalogue" description="The catalogue is managed in database review mode. The offline fixture has none." />;
  const client = await databaseReviewClient();
  const params = await searchParams;
  let cataloguePage: AdminMoviePage | null;
  let managed: AdminMovie[] | null;
  try {
    cataloguePage = await client.moviePage(parseAdminCatalogueFilters(params));
    managed = cataloguePage ? cataloguePage.items : await client.movies();
  } catch (failure) {
    // A refusal (an account with no review permission) is a message, not an error page.
    console.warn(JSON.stringify({ event: "admin_catalogue_unavailable", code: failure instanceof DiscoveryStoreError ? failure.code : "store_error" }));
    return <EmptyState as="h1" title="Catalogue unavailable" description="This account cannot view the catalogue controls, or the database is unavailable. Try again shortly." />;
  }
  const [capabilities, vjs] = await Promise.all([client.capabilities(), listVjs()]);
  const message = resultMessage(params.result);
  return <AdminCatalogue query={params} cataloguePage={cataloguePage ?? undefined} movies={managed ?? await publishedOnly()} vjs={vjs} canManage={managed !== null && capabilities?.publish === true} movieAction={movieAction} addVjAction={addVjAction}
    error={message.error} notice={message.notice ?? (managed === null ? "Catalogue controls are not switched on yet: the database is waiting for an update. This is the published list only." : cataloguePage === null ? "Full-catalogue search is waiting for a database update. Filters currently cover only the latest loaded movies." : undefined)} />;
}
