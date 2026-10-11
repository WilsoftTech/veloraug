/** Offline gateway + real restricted Postgres adapter, disposable tmpfs database only.
 * node --import ./scripts/ingest/register.mjs scripts/checkpoint5-validation.mts
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { up, down, psql, testDb, ISOLATED } from "./isolated-db.mjs";
import { createPgResolver } from "../services/media-gateway/pg-resolver.mts";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { signMediaToken } from "@/lib/media-gateway/token";
import type { MediaReader } from "@/lib/media-gateway/ports";

const migration="20261011200813_original_media_download_resolver.sql";
const pending=["20261011083200_admin_upload_sessions.sql","20261011084309_admin_upload_disk_chunks.sql",
  "20261011085220_admin_upload_inspection.sql","20261011093300_admin_upload_r2_staging.sql",
  "20261011094004_admin_upload_r2_worker.sql","20261011095632_admin_upload_r2_visibility.sql",
  "20261011192618_original_media_evidence.sql","20261011192619_admin_original_media_evidence.sql"];
const subject="00000000-0000-4000-8000-000000000051";
const quote=(s:string)=>`'${s.replaceAll("'","''")}'`;
const sql=(statement:string)=>{const r=psql(statement);assert.equal(r.code,0,r.err);return r.out.trim();};
const suite=()=>{const r=psql(readFileSync("supabase/tests/database/020_original_media_download.test.sql","utf8"));assert.equal(r.code,0,r.err);assert.doesNotMatch(r.out,/^not ok/m,r.out);assert.match(r.out,/^1\.\.25$/m);console.log("download boundary: 25 pgTAP assertions passed");};
const secret=new Uint8Array(32).fill(17);
const manifest=JSON.parse(readFileSync("tests/browser/fixtures/manifest.json","utf8")) as {fixtures:{id:number;file:string;sizeBytes:number;mime:string}[]};

try {
  // Prove independence from both CP4 migrations and all six pending admin migrations.
  up({rest:false,excludeMigrations:[...pending,migration]});
  const old=sql("select pg_get_functiondef('media_gateway.resolve_movie_version(bigint)'::regprocedure)||proacl::text from pg_proc where oid='media_gateway.resolve_movie_version(bigint)'::regprocedure");
  sql(readFileSync(`supabase/migrations/${migration}`,"utf8"));
  assert.equal(sql("select pg_get_functiondef('media_gateway.resolve_movie_version(bigint)'::regprocedure)||proacl::text from pg_proc where oid='media_gateway.resolve_movie_version(bigint)'::regprocedure"),old);
  suite();console.log("recorded hosted-equivalent 17 + download: stream definition/ACL unchanged, CP4/admin SQL not required");

  up({rest:false});assert.ok(testDb(),"database regression failed");
  sql(`alter role velora_media_gateway login password 'synthetic-cp5-local-only';
    insert into auth.users(id,is_anonymous) values('${subject}',false);
    insert into private.telegram_channels(bot_type,chat_id) values('movie',-1007776665555);
    insert into public.vjs(slug,name,is_active) values('cp5-local-vj','Synthetic VJ',true);`);
  const resolver=createPgResolver(`postgres://velora_media_gateway:synthetic-cp5-local-only@127.0.0.1:${ISOLATED.dbPort}/postgres`);
  assert.equal(await resolver.check(),"reachable");
  const versions=new Map<number,{file:string;sizeBytes:number;mime:string}>();
  for(const fixture of manifest.fixtures) {
    sql(`insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,mime_type,file_size_bytes,file_name,telegram_date)
      values('movie',-1007776665555,${fixture.id},'synthetic-id-${fixture.id}','synthetic-unique-${fixture.id}','document',${quote(fixture.mime)},${fixture.sizeBytes},${quote(fixture.file)},now());
      insert into public.movies(slug,title,publication_status,published_at) values('cp5-fixture-${fixture.id}','Synthetic local fixture','published',now());
      insert into public.movie_versions(movie_id,vj_id,availability_status,rights_status,available_at,telegram_media_id)
      select m.id,v.id,'ready','cleared',now(),t.id from public.movies m,public.vjs v,private.telegram_media t
      where m.slug='cp5-fixture-${fixture.id}' and v.slug='cp5-local-vj' and t.file_unique_id='synthetic-unique-${fixture.id}';`);
    const version=Number(sql(`select mv.id from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.slug='cp5-fixture-${fixture.id}'`));
    versions.set(version,fixture);
  }
  let reads=0,maxBuffer=0;
  const reader:MediaReader={readiness:()=>({ready:true,state:"synthetic_only"}),async readPart(locator,offset,limit,signal){
    assert.ok(!signal.aborted);assert.ok(limit<=1024*1024);reads++;maxBuffer=Math.max(maxBuffer,limit);
    const fixture=versions.get(locator.movieVersionId)!;const file=await open(`tests/browser/fixtures/${fixture.file}`,"r");
    try {const bytes=Buffer.alloc(limit);const result=await file.read(bytes,0,limit,offset);return {bytes:bytes.subarray(0,result.bytesRead),rpcCount:1};}
    finally {await file.close();}
  }};
  const gateway=createMediaGateway({tokenSecret:secret,limits:DEFAULT_LIMITS,resolver,reader,logger:{info(){},warn(){},error(){}}});
  const server=createServer(gateway.handle);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url=(version:number)=>`${origin}/v1/movie-versions/${version}/download?token=${signMediaToken(secret,{op:"download",movieVersionId:version,subject,ttlSeconds:600,nowSeconds:Math.floor(Date.now()/1000)})}`;
  try {
    for(const [version,fixture] of versions) {
      const response=await fetch(url(version));assert.equal(response.status,200);
      assert.equal(response.headers.get("content-type"),fixture.mime);assert.equal(Number(response.headers.get("content-length")),fixture.sizeBytes);
      assert.ok(response.headers.get("content-disposition")?.includes(`filename*=UTF-8''${fixture.file}`));
      const hash=createHash("sha256");for await(const bytes of response.body! as unknown as AsyncIterable<Uint8Array>)hash.update(bytes);
      const original=createHash("sha256");for await(const bytes of createReadStream(`tests/browser/fixtures/${fixture.file}`))original.update(bytes);
      assert.equal(hash.digest("hex"),original.digest("hex"));console.log(`${fixture.file}: original SHA-256, MIME, extension and filename passed through real restricted DB adapter + gateway`);
    }
    const version=versions.keys().next().value!;const before=reads;
    sql(`update auth.users set banned_until=now()+interval '1 day' where id='${subject}'`);
    assert.equal((await fetch(url(version))).status,404);assert.equal(reads,before);
    sql(`update auth.users set banned_until=null where id='${subject}';update public.movies set publication_status='draft' where slug like 'cp5-fixture-%'`);
    assert.equal((await fetch(url(version))).status,404);assert.equal(reads,before);
    assert.equal(await resolver.resolveDownload!(version,"malformed-subject",new AbortController().signal),null);
    const originalDefinition=sql("select pg_get_functiondef('media_gateway.resolve_movie_download(bigint,uuid)'::regprocedure)");
    // Disposable test double only: exercise cancellation of a genuinely running SQL query.
    sql(`create or replace function media_gateway.resolve_movie_download(p_movie_version_id bigint,p_subject uuid)
      returns table(chat_id bigint,message_id bigint,file_unique_id text,file_size_bytes bigint,mime_type text,file_name text)
      language plpgsql stable security definer set search_path='' as $$begin perform pg_catalog.pg_sleep(10);return;end$$`);
    const controller=new AbortController();const started=Date.now();const timer=setTimeout(()=>controller.abort(),100);
    try {await assert.rejects(resolver.resolveDownload!(version,subject,controller.signal));assert.ok(Date.now()-started<1500,"SQL cancellation must not wait for statement timeout");}
    finally {clearTimeout(timer);sql(originalDefinition);}
    console.log("real Postgres query cancellation passed before statement timeout; original RPC restored in disposable DB");
    console.log(`restricted adapter revocation/unpublished denials: no media reads; ${manifest.fixtures.length} original fixtures passed; max read buffer ${maxBuffer}`);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await resolver.close();}
} finally {down();}
