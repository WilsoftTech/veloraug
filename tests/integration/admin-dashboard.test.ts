import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewClient, type DiscoveryRpc } from "@/lib/discovery/database";
import { getMovie, isMovieVersionPlayable, listMovies, listVjs } from "@/lib/catalogue";
import { createUploadClient } from "@/lib/uploader/admin-upload";
import { ISOLATED_REST, isolatedJwt, isolatedSql } from "./isolated-env";

/**
 * The admin dashboard commands (migration 20261011081425) through the real
 * Data API, as each reviewer's own session. Runs after the direct-channel
 * suite and uses the film it published; the gates themselves are proven in
 * supabase/tests/database/012_admin_dashboard_actions.test.sql.
 */

const CHANNEL = -1004242424242;
const REVIEW = "00000000-0000-4000-8000-00000000e3a1";
const PUBLISH = "00000000-0000-4000-8000-00000000e3a3";
const NOBODY = "00000000-0000-4000-8000-00000000e3a4";
const SLUG = "direct-channel-film-2025";

const rpcAs = (claims: Record<string, unknown>): DiscoveryRpc => {
  const client = createClient(ISOLATED_REST, isolatedJwt(claims), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return (fn, args) => client.rpc(fn, args) as unknown as ReturnType<DiscoveryRpc>;
};
const reviewer = (sub: string) => createReviewClient(rpcAs({ role: "authenticated", sub, aud: "authenticated", is_anonymous: false }));
const anonymous = createReviewClient(rpcAs({ role: "anon" }));

describe.skipIf(process.env.VELORA_E38_ISOLATED_TESTS !== "true" || process.env.NEXT_PUBLIC_SUPABASE_URL !== ISOLATED_REST)("admin dashboard commands (isolated)", () => {
  // The published candidate's channel must be registered for a publication replay to be evaluated.
  beforeAll(() => { isolatedSql(`insert into private.telegram_channels (bot_type, chat_id, checkpoint_message_id) values ('movie', ${CHANNEL}, 1)`); });
  afterAll(() => { isolatedSql(`delete from private.telegram_channels where chat_id = ${CHANNEL}`); });

  it("tells each account its own capabilities", async () => {
    expect(await reviewer(REVIEW).capabilities()).toEqual({ review: true, rights: false, publish: false });
    expect(await reviewer(PUBLISH).capabilities()).toEqual({ review: false, rights: false, publish: true });
    expect(await reviewer(NOBODY).capabilities()).toEqual({ review: false, rights: false, publish: false });
    await expect(anonymous.capabilities()).rejects.toMatchObject({ code: "review_not_authorized" });
  });

  it("approves and publishes as the session's account, never a named one", async () => {
    const published = (await reviewer(REVIEW).list()).find((item) => item.publication?.movieSlug === SLUG)!;
    expect(published).toBeDefined();
    await expect(reviewer(REVIEW).publish(published.id, published.revision)).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(reviewer(NOBODY).approve(published.id, published.revision)).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(anonymous.publish(published.id, published.revision)).rejects.toMatchObject({ code: "review_not_authorized" });
    // A replay by the publisher is the same publication; a published candidate cannot be approved again.
    expect(await reviewer(PUBLISH).publish(published.id, published.revision)).toMatchObject({ result: "already_published", movie_slug: SLUG });
    await expect(reviewer(REVIEW).approve(published.id, published.revision)).rejects.toMatchObject({ code: "review_illegal_transition" });
    expect(isolatedSql(`select count(*) from public.movies where slug = '${SLUG}'`)).toBe("1");
  });

  it("withdraws a movie from the site and playback, and restores it", async () => {
    const movie = (await reviewer(REVIEW).movies())!.find((item) => item.slug === SLUG)!;
    expect(movie).toMatchObject({ publication_status: "published", is_featured: false });
    const versionId = movie.versions[0].id;
    await expect(reviewer(REVIEW).setMovie(movie.id, "withdraw")).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(reviewer(NOBODY).movies()).rejects.toMatchObject({ code: "review_not_authorized" });
    expect(await isMovieVersionPlayable(versionId)).toBe(true);

    await reviewer(PUBLISH).setMovie(movie.id, "withdraw");
    expect(await getMovie(SLUG)).toBeNull();
    expect((await listMovies()).items.map((item) => item.slug)).not.toContain(SLUG);
    expect(await isMovieVersionPlayable(versionId)).toBe(false);
    expect((await reviewer(REVIEW).movies())!.find((item) => item.slug === SLUG)).toMatchObject({ publication_status: "archived" });
    await expect(reviewer(PUBLISH).setMovie(movie.id, "feature")).rejects.toMatchObject({ code: "catalogue_illegal_transition" });

    await reviewer(PUBLISH).setMovie(movie.id, "restore");
    expect((await getMovie(SLUG))?.title).toBe("Direct Channel Film");
    expect(await isMovieVersionPlayable(versionId)).toBe(true);
  });

  it("edits a title without changing its address, and adds a VJ", async () => {
    const movie = (await reviewer(REVIEW).movies())!.find((item) => item.slug === SLUG)!;
    await expect(reviewer(REVIEW).editMovie(movie.id, "Renamed", null)).rejects.toMatchObject({ code: "review_not_authorized" });
    await reviewer(PUBLISH).editMovie(movie.id, "Direct Channel Film (Director's Cut)", "A new description.");
    expect(await getMovie(SLUG)).toMatchObject({ title: "Direct Channel Film (Director's Cut)", overview: "A new description." });
    await reviewer(PUBLISH).editMovie(movie.id, "Direct Channel Film", movie.overview);

    await expect(reviewer(REVIEW).addVj("Dashboard")).rejects.toMatchObject({ code: "review_not_authorized" });
    expect(await reviewer(PUBLISH).addVj("dashboard")).toMatchObject({ slug: "vj-dashboard", name: "VJ dashboard" });
    await expect(reviewer(PUBLISH).addVj("VJ Dashboard")).rejects.toMatchObject({ code: "catalogue_vj_exists" });
    expect((await listVjs()).map((vj) => vj.slug)).toContain("vj-dashboard");
    expect(isolatedSql("select string_agg(action, ',' order by id) from private.catalogue_admin_audit")).toBe("movie_withdraw,movie_restore,movie_edited,movie_edited,vj_added");
  });
});

describe.skipIf(process.env.VELORA_E38_ISOLATED_TESTS !== "true" || process.env.NEXT_PUBLIC_SUPABASE_URL !== ISOLATED_REST)("R2 upload Data API (isolated)", () => {
  const owner = "00000000-0000-4000-8000-00000000e3b1";
  const other = "00000000-0000-4000-8000-00000000e3b2";
  const request = "00000000-0000-4000-8000-00000000e3b3";
  const token = "00000000-0000-4000-8000-00000000e3b4";
  const client = (sub: string) => createUploadClient(rpcAs({role:"authenticated",sub,aud:"authenticated",is_anonymous:false}));
  let id: string;
  beforeAll(() => {
    isolatedSql(`insert into auth.users(id,raw_app_meta_data,is_anonymous) values ('${owner}','{"role":"admin"}',false),('${other}','{"role":"admin"}',false);
      insert into private.catalogue_reviewers(user_id,can_review) values ('${owner}',true),('${other}',true);`);
  });
  afterAll(() => { isolatedSql(`delete from private.catalogue_reviewers where user_id in ('${owner}','${other}')`); });
  it("creates a typed private session idempotently through PostgREST", async () => {
    const file={fileName:"fixture.mp4",sizeBytes:3};
    const session=await client(owner).createR2(file,request,7);
    id=session.id;
    expect(session).toMatchObject({storage:"r2",stage:"draft",owner_id:owner,verified_sha256:null});
    expect((await client(owner).createR2(file,request,7)).id).toBe(id);
    await expect(client(owner).createR2({...file,fileName:"changed.mp4"},request,7)).rejects.toMatchObject({code:"upload_request_conflict"});
  });
  it("recovers durable multipart progress without granting verification or rights", async () => {
    await client(owner).r2(id,"begin",{token});
    await client(owner).r2(id,"attach",{token,upload_id:"synthetic-multipart"});
    await client(owner).r2(id,"reserve_part",{number:1,sha256:"a".repeat(64)});
    await client(owner).r2(id,"observe",{parts:[{number:1,size:3,etag:"opaque"}]});
    const session=await client(owner).get(id);
    expect(session).toMatchObject({storage:"r2",bytes_received:3,verified_sha256:null,pipeline:{media_verified:false,rights_cleared:false,approved:false,stored:false}});
    await client(owner).r2(id,"complete_requested");
    await client(owner).r2(id,"completed",{etag:"opaque-final"});
    expect((await client(owner).get(id)).stage).toBe("verifying");
  });
  it("refuses cross-owner and anonymous operations", async () => {
    await expect(client(other).get(id)).rejects.toMatchObject({code:"upload_not_found"});
    await expect(client(other).r2(id,"state")).rejects.toMatchObject({code:"upload_not_found"});
    await expect(createUploadClient(rpcAs({role:"anon"})).get(id)).rejects.toThrow();
  });
  it("keeps worker completion inaccessible to browser sessions", async () => {
    const reply=await rpcAs({role:"authenticated",sub:owner,aud:"authenticated",is_anonymous:false})("admin_upload_r2_worker_finish",{p_id:id,p_token:token,p_operation:"verify",p_result:{}});
    expect(reply.error).toBeTruthy();
    expect((await client(owner).get(id)).verified_sha256).toBeNull();
  });
});
