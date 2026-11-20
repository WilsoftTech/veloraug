
import {describe,it,expect,vi,beforeEach} from "vitest";
import sharp from "sharp";
import {encodePoster,storePoster,readPoster,postersConfigured} from "./artwork-storage";
import {POSTER_MAX_BYTES,POSTER_WIDTHS} from "./artwork";
import imageLoader from "./tmdb/image-loader";
import {manualMovieMetadataSchema} from "./movie-metadata";
const {send}=vi.hoisted(()=>({send:vi.fn()}));
vi.mock("@/lib/uploader/r2",()=>({createR2Client:()=>({send})}));
const env={R2_POSTER_BUCKET_NAME:"velora-posters",R2_BUCKET_NAME:"velora-uploads-staging"};
const id="11111111-1111-4111-8111-111111111111";
beforeEach(()=>{send.mockReset();});
describe("private R2 poster storage",()=>{
 it("decodes real images and stores only correctly sized WebP",async()=>{
  const input=await sharp({create:{width:900,height:1350,channels:3,background:"red"}}).jpeg().toBuffer();
  const variants=await encodePoster(input);
  expect(variants.map(v=>v.width)).toEqual([...POSTER_WIDTHS]);
  for(const variant of variants){const m=await sharp(variant.data).metadata();expect(m.format).toBe("webp");expect(m.width).toBe(Math.min(900,variant.width));expect(m.exif).toBeUndefined();}
 });
 it("rejects oversized, tiny and unreadable input",async()=>{
  await expect(encodePoster(new Uint8Array(POSTER_MAX_BYTES+1))).rejects.toThrow("poster_file_too_large");
  await expect(encodePoster(new Uint8Array([1,2,3]))).rejects.toThrow();
  await expect(encodePoster(await sharp({create:{width:10,height:10,channels:3,background:"red"}}).png().toBuffer())).rejects.toThrow("poster_image_invalid");
 });
 it("never uses the private video staging bucket",async()=>{
  expect(postersConfigured({...env,R2_POSTER_BUCKET_NAME:env.R2_BUCKET_NAME})).toBe(false);
  const bytes=await sharp({create:{width:120,height:180,channels:3,background:"blue"}}).png().toBuffer();
  send.mockResolvedValue({});
  const path=await storePoster(new File([new Uint8Array(bytes)],"poster.png",{type:"image/png"}),env);
  expect(path).toMatch(/^\/posters\/[a-f0-9-]+\.webp$/);
  expect(send).toHaveBeenCalledTimes(5);
  for(const [command] of send.mock.calls){expect(command.input.Bucket).toBe("velora-posters");expect(command.input.Key).toMatch(/^posters\/[a-f0-9-]+\/\d+\.webp$/);expect(command.input.ContentType).toBe("image/webp");expect((await sharp(command.input.Body).metadata()).format).toBe("webp");}
 });
 it("reports failed uploads and refuses non-image MIME",async()=>{
  await expect(storePoster(new File(["hi"],"fake.mp4",{type:"video/mp4"}),env)).rejects.toThrow("poster_image_invalid");
  const bytes=await sharp({create:{width:120,height:180,channels:3,background:"blue"}}).webp().toBuffer();
  send.mockRejectedValue(new Error("private provider detail"));
  await expect(storePoster(new File([new Uint8Array(bytes)],"x.webp",{type:"image/webp"}),env)).rejects.toThrow("poster_upload_failed");
 });
 it("reads fixed image keys and hides provider errors",async()=>{
  send.mockResolvedValue({ContentType:"image/webp",ContentLength:3,Body:{transformToByteArray:async()=>new Uint8Array([1,2,3])},ETag:'"abc"'});
  expect((await readPoster(id,342,env))?.etag).toBe('"abc"');
  expect(send.mock.calls[0][0].input).toEqual({Bucket:"velora-posters",Key:"posters/"+id+"/342.webp"});
  await expect(readPoster("../media",342,env)).rejects.toThrow("poster_path_invalid");
  await expect(readPoster(id,343,env)).rejects.toThrow("poster_path_invalid");
  send.mockRejectedValue({name:"NoSuchKey"});expect(await readPoster(id,342,env)).toBeNull();
  send.mockRejectedValue(new Error("secret"));await expect(readPoster(id,342,env)).rejects.toThrow("poster_storage_unavailable");
 });
 it("routes R2 artwork locally and keeps existing TMDB artwork",()=>{
  expect(imageLoader({src:"/posters/"+id+".webp",width:300})).toBe("/posters/"+id+".webp?w=342");
  expect(imageLoader({src:"/tmdb.jpg",width:300})).toBe("https://image.tmdb.org/t/p/w342/tmdb.jpg");
 });
 it("requires a valid release date without any fabricated TMDB id",()=>{
  const metadata={title:"Manual",original_title:null,overview:null,release_date:"2024-05-01",runtime_minutes:null,poster_path:"/posters/"+id+".webp",backdrop_path:null,genres:["Drama"]};
  expect(manualMovieMetadataSchema.parse(metadata).poster_path).toBe(metadata.poster_path);
  expect(manualMovieMetadataSchema.safeParse({...metadata,release_date:"2024-02-31"}).success).toBe(false);
  expect(manualMovieMetadataSchema.safeParse({...metadata,poster_path:"https://evil.example/x"}).success).toBe(false);
 });
});
