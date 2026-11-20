import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireReviewAdmin,databaseReviewClient } from "@/lib/discovery/runtime";
import { postersConfigured } from "@/lib/artwork-storage";
import { MovieMetadataForm } from "@/components/movie-metadata-form";
import { EmptyState } from "@/components/empty-state";
import { PosterImage } from "@/components/media-image";
import { saveMovieMetadata } from "../../actions";
export const dynamic = "force-dynamic";
export default async function EditMovie({params}:{params:Promise<{id:string}>}) {
 await requireReviewAdmin(); const parsed = z.coerce.number().int().positive().safeParse((await params).id); if (!parsed.success) notFound();
 const client = await databaseReviewClient();const capabilities = await client.capabilities();
 if (!capabilities?.publish) return <EmptyState as="h1" title="Movie editing unavailable" description="Your account needs the publish permission to edit catalogue metadata."/>;
 let movie;
 try { movie = await client.movieMetadata(parsed.data); } catch { return <EmptyState as="h1" title="Movie editing unavailable" description="The manual metadata database update is not available, or the movie could not be loaded."/>; }
 if (!movie) notFound();
 return <div className="space-y-6"><Link className="underline" href="/admin/catalogue">Back to Catalogue</Link><h1 className="text-headline-md">Edit {movie.metadata.title}</h1><div className="w-32"><PosterImage path={movie.metadata.poster_path} title={movie.metadata.title} sizes="128px"/></div><MovieMetadataForm target="catalogue" id={String(movie.id)} updatedAt={movie.updated_at} initial={movie.metadata} action={saveMovieMetadata} postersEnabled={postersConfigured()}/></div>;
}
