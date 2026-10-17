/** Run with node --import ./scripts/ingest/register.mjs scripts/checkpoint4-validation.mts.
 * Disposable tmpfs PostgreSQL only; no operational configuration is read.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { up, down, psql, testDb } from "./isolated-db.mjs";
import { verifyChannelMedia } from "@/lib/discovery/media-verification";
import { probeMedia, headProbe, resolveMediaTools } from "@/lib/uploader/media-tools";
import { assessOriginalMedia } from "@/lib/ingestion/original-media";

const base="20261011192618_original_media_evidence.sql";
const admin="20261011192619_admin_original_media_evidence.sql";
const downloads="20261011200813_original_media_download_resolver.sql";
// Checkpoint 10: the verification contract. Applied last in the alternate order, as in the repository's.
const verification="20261014090000_original_media_verification.sql";
const adminVerification="20261014090001_admin_original_media_verification.sql";
const pending=["20261011083200_admin_upload_sessions.sql","20261011084309_admin_upload_disk_chunks.sql",
  "20261011085220_admin_upload_inspection.sql","20261011093300_admin_upload_r2_staging.sql",
  "20261011094004_admin_upload_r2_worker.sql","20261011095632_admin_upload_r2_visibility.sql"];
const quote=(value: string)=>`'${value.replaceAll("'","''")}'`;
function sql(statement: string) {
  const result=psql(statement);
  assert.equal(result.code,0,result.err);
  return result.out.trim();
}
function apply(name: string) { sql(readFileSync(`supabase/migrations/${name}`,"utf8")); }
function suite(name: string) {
  const result=psql(readFileSync(`supabase/tests/database/${name}`,"utf8"));
  assert.equal(result.code,0,result.err);
  assert.doesNotMatch(result.out,/^not ok/m,result.out);
  assert.match(result.out,/^1\.\.[1-9][0-9]*$/m);
  console.log(`${name}: supported 17-migration baseline passed`);
}
const snapshotSql=`select jsonb_build_object(
  'movies',(select jsonb_agg(to_jsonb(x) order by id) from public.movies x),
  'versions',(select jsonb_agg(to_jsonb(x) order by id) from public.movie_versions x),
  'documents',(select jsonb_agg(to_jsonb(x) order by id) from private.telegram_media x),
  'evidence',(select jsonb_agg(to_jsonb(x)-array['assessment','integrity_status','streaming_status','browser_profile','download_status','tracks','warnings','content_sha256'] order by id) from private.media_evidence x));`;
const schemaSql=`select jsonb_build_object(
  'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),p.prosecdef,p.proconfig,(select jsonb_agg(a::text order by a::text) from unnest(p.proacl) a),pg_get_userbyid(p.proowner)) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public','catalogue_access','catalogue_review','media_gateway')),
  'columns',(select jsonb_agg(to_jsonb(x) order by table_schema,table_name,ordinal_position) from information_schema.columns x where table_schema in ('private','public')),
  'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid)) order by n.nspname,c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('private','public')),
  'tables',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relacl::text,pg_get_userbyid(c.relowner)) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('private','public') and c.relkind in ('r','S')));`;

try {
  // Hosted-equivalent migration set from the recorded audit, not a live claim.
  assert.equal(readdirSync("supabase/migrations").filter(n=>n.endsWith(".sql")).length,28);
  up({rest:false,seed:true,excludeMigrations:[...pending,base,admin,downloads,verification,adminVerification]});
  sql(`insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,file_size_bytes,mime_type,telegram_date)
    values('movie',-1009990004444,1,'synthetic-only','synthetic-cp4', 'document',1000,'video/mp4',now());
    insert into private.media_evidence(telegram_media_id,media_identity,method,policy_version,media_class,reasons,container,video_codec,audio_codec,accessible,gateway_compatible,playback_ready,bytes_read)
    select id,private.channel_media_identity(chat_id,message_id,file_unique_id,file_size_bytes),'bounded_mtproto_v1',2,'unverified',array['probe_failed'],null,null,null,false,true,false,16 from private.telegram_media where file_unique_id='synthetic-cp4';
    insert into private.media_evidence(telegram_media_id,media_identity,method,policy_version,media_class,reasons,container,video_codec,audio_codec,accessible,gateway_compatible,playback_ready,bytes_read)
    select id,private.channel_media_identity(chat_id,message_id,file_unique_id,file_size_bytes),'bounded_mtproto_v1',2,'canonical','{}','mp4','h264','aac',true,true,true,1000 from private.telegram_media where file_unique_id='synthetic-cp4';`);
  const before=sql(snapshotSql);
  const aclSql="select jsonb_build_array(prosecdef,proconfig,(select jsonb_agg(a::text order by a::text) from unnest(proacl) a),pg_get_userbyid(proowner)) from pg_proc where oid='public.discovery_complete(text,uuid,integer,jsonb)'::regprocedure";
  const acl=sql(aclSql);
  apply(base);
  assert.equal(sql(snapshotSql),before,"baseline data changed");
  assert.equal(sql(aclSql),acl,"discovery completion owner/security/ACL changed");
  assert.equal(sql("select string_agg(verified::text,',' order by id) from private.media_evidence"),"false,true");
  suite("018_original_media_evidence.test.sql");
  console.log("17 + channel migration: data, historical failure/verification, published fixtures and completion ACL preserved");
  for(const name of pending) apply(name);
  apply(admin);
  apply(downloads);
  apply(verification);
  apply(adminVerification);
  assert.equal(sql(snapshotSql),before,"pending/admin migration changed existing data");
  const alternate=sql(schemaSql);
  console.log("17 + channel + six pending + admin + additive download resolver: accepted");

  // Same final state as normal repository order; no dependency on undeployed SQL.
  // Default loopback host connection authenticates with the synthetic password.
  // Container-local trusted authentication breaks the legacy dblink lock tests.
  up({rest:false});
  const repository=sql(schemaSql);
  if(repository!==alternate) {
    writeFileSync(".velora-ingest/checkpoint4-alternate-schema.json",alternate);
    writeFileSync(".velora-ingest/checkpoint4-repository-schema.json",repository);
    throw new Error("migration orders disagree; synthetic schema snapshots saved in .velora-ingest");
  }
  assert.ok(testDb(),"pgTAP regressions failed");
  console.log("repository order equals hosted-equivalent alternate order (definitions, ACLs, owners, RLS, columns, constraints)");

  const tools=await resolveMediaTools();
  assert.ok(tools.ok,"explicit local media tools required for real-fixture contract gate");
  const names=["mp4-h264-aac-faststart.mp4","mp4-h264-aac-moov-at-end.mp4","mkv-h264-aac.mkv",
    "mkv-h264-aac-two-audio.mkv","mkv-h264-aac-subtitles.mkv","mkv-hevc-aac.mkv","mkv-h264-ac3.mkv"];
  for(const name of names) {
    const path=`tests/browser/fixtures/${name}`;
    const bytes=readFileSync(path);
    const local=await probeMedia(tools.tools.ffprobe,path);
    assert.ok(local.ok,name);
    const assessment=assessOriginalMedia(local.inspection,name);
    assert.equal(sql(`select private.original_media_assessment_valid(${quote(JSON.stringify(assessment))}::jsonb)`),"t",name);
    const identity=`tg1-${"a".repeat(64)}`;
    const bounded=await verifyChannelMedia({identity,sizeBytes:bytes.length},{
      read:async(offset,length)=>bytes.subarray(offset,offset+length),probe:headProbe(tools.tools.ffprobe),gatewayCompatible:true});
    assert.equal(sql(`select private.original_media_assessment_valid(${quote(JSON.stringify(bounded.assessment))}::jsonb)`),"t",name);
    assert.deepEqual(readFileSync(path),bytes,"fixture bytes changed");
    console.log(`${name}: local and bounded producer/SQL contract passed; original bytes unchanged`);
  }
} finally { down(); }
