"use client";

import {useActionState,useState} from "react";
import {Field} from "@/components/form-field";
import {buttonClass} from "@/components/button";
import type {ManualMovieMetadata,MetadataFormState,ManualMovieChoice} from "@/lib/movie-metadata";
import type {ReviewVj} from "@/lib/discovery/model";
import {POSTER_MAX_BYTES} from "@/lib/artwork";

export function MovieMetadataForm({action,target,id,revision,updatedAt,initial,vjs=[],vjId,existingMovies=[],postersEnabled}: {
 action:(state:MetadataFormState,data:FormData)=>Promise<MetadataFormState>; target:"review"|"catalogue"; id:string; revision?:number;updatedAt?:string;
 initial:Omit<Partial<ManualMovieMetadata>,"release_date"> & {release_date?:string|null};vjs?:readonly ReviewVj[];vjId?:number|null;existingMovies?:ManualMovieChoice[];postersEnabled:boolean;
}) {
 const[state,formAction,pending]=useActionState(action,{});
 const[existing,setExisting]=useState("");
 const prefix="metadata-"+id;
 return <form action={formAction} className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2" aria-label={target==="review"?"Manual movie details":"Edit movie details and poster"}>
  <input type="hidden" name="target" value={target}/><input type="hidden" name="id" value={id}/>
  {revision!==undefined&&<input type="hidden" name="revision" value={revision}/>}{updatedAt&&<input type="hidden" name="updatedAt" value={updatedAt}/>}
  <div className="sm:col-span-2"><h2 className="text-headline-sm">{target==="review"?"Enter movie details manually":"Movie details and poster"}</h2><p className="mt-2 text-body-sm text-muted">{target==="review"?"Use this when TMDB has no suitable record. Saving confirms your film and VJ choice. Media verification, rights clearance and publication remain separate steps.":"Update the movie details and optionally choose a replacement poster from your device."}</p></div>
  {state.error&&<p role="alert" className="rounded-lg border border-destructive p-3 sm:col-span-2">{state.error}</p>}
  {state.notice&&<p role="status" className="rounded-lg border border-highlight/40 p-3 sm:col-span-2">{state.notice}</p>}
  {target==="review"&&<>
   {existingMovies.length>0&&<div className="sm:col-span-2"><Field id={prefix+"existing"} label="Use an existing manually entered movie" hint="For another part or VJ version of the same film, reuse its existing details.">{props=><select {...props} name="existingMovieId" value={existing} onChange={e=>setExisting(e.target.value)} disabled={pending}><option value="">Enter or edit details below</option>{existingMovies.map(movie=><option key={movie.id} value={movie.id}>{movie.title} ({movie.year??"Year unknown"})</option>)}</select>}</Field></div>}
   <Field id={prefix+"vj"} label="VJ">{props=><select {...props} name="vjId" required defaultValue={vjId??""} disabled={pending}><option value="">Select active VJ</option>{vjs.filter(v=>v.isActive).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select>}</Field>
  </>}
  {!existing&&<>
   <Field id={prefix+"title"} label="Movie title">{props=><input {...props} name="title" required minLength={1} maxLength={300} defaultValue={initial.title??""} disabled={pending}/>}</Field>
   <Field id={prefix+"original"} label="Original title (optional)">{props=><input {...props} name="originalTitle" maxLength={300} defaultValue={initial.original_title??""} disabled={pending}/>}</Field>
   <Field id={prefix+"release"} label="Release date">{props=><input {...props} type="date" name="releaseDate" required min="1870-01-01" max="2199-12-31" defaultValue={initial.release_date??""} disabled={pending}/>}</Field>
   <Field id={prefix+"runtime"} label="Runtime in minutes (optional)">{props=><input {...props} type="number" inputMode="numeric" name="runtime" min={1} max={1440} defaultValue={initial.runtime_minutes??""} disabled={pending}/>}</Field>
   <div className="sm:col-span-2"><Field id={prefix+"overview"} label="Description (optional)">{props=><textarea {...props} name="overview" rows={4} maxLength={10000} defaultValue={initial.overview??""} disabled={pending}/>}</Field></div>
   <div className="sm:col-span-2"><Field id={prefix+"genres"} label="Genres (optional)" hint="Separate genres with commas, for example Action, Thriller.">{props=><input {...props} name="genres" maxLength={1600} defaultValue={initial.genres?.join(", ")??""} disabled={pending}/>}</Field></div>
   <div className="sm:col-span-2"><Field id={prefix+"poster"} label="Poster from your device (optional)" hint={postersEnabled?`JPEG, PNG or WebP, up to ${POSTER_MAX_BYTES/1024/1024} MB. Stored as WebP in Cloudflare R2. Leave empty to keep the current poster.`:"Poster uploads are unavailable until the dedicated R2 poster bucket is configured. Details can still be saved."}>{props=><input {...props} type="file" name="poster" accept="image/jpeg,image/png,image/webp" disabled={pending||!postersEnabled}/>}</Field></div>
  </>}
  <button className={buttonClass("primary","sm:col-span-2 sm:justify-self-start")} disabled={pending} aria-disabled={pending}>{pending?"Saving...":existing?"Confirm selected movie and VJ":target==="review"?"Save and confirm manual details":"Save details and poster"}</button>
 </form>;
}
