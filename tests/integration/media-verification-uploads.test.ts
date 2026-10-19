import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { databasePersistence, type DiscoveryRpc } from "@/lib/discovery/database";
import { channelVerificationPort } from "@/lib/discovery/media-verification";
import { runMediaVerification } from "@/lib/discovery/auto-verify";
import { resolveMediaTools, headProbe, spoolDocument, probeMedia, decodeStreams } from "@/lib/uploader/media-tools";
import { ISOLATED_REST, isolatedJwt, isolatedSql } from "./isolated-env";

describe.skipIf(process.env.VELORA_E38_ISOLATED_TESTS !== "true")("automatic verification after upload (isolated)", () => {
  it("fully decodes new MP4/MKV files before any identity review, handles reader outages, and repeats nothing", async () => {
    const tools = await resolveMediaTools();
    if (!tools.ok) throw new Error("real_media_tools_required");
    const channel=-1005656565656;
    const previous=isolatedSql("select coalesce((select chat_id::text from private.telegram_channels where bot_type='movie'),'')");
    const work=mkdtempSync(join(tmpdir(),"velora-upload-verification-"));
    const counts=()=>isolatedSql("select (select count(*) from private.channel_reviews)||','||(select count(*) from private.rights_clearances)||','||(select count(*) from public.movie_versions)");
    const before=counts();
    const mp4=readFileSync("tests/browser/fixtures/mp4-h264-aac-faststart.mp4");
    const mkv=readFileSync("tests/browser/fixtures/mkv-h264-aac.mkv");
    isolatedSql(`insert into private.telegram_channels(bot_type,chat_id) values('movie',${channel}) on conflict(bot_type) do update set chat_id=excluded.chat_id;
      grant velora_discovery_worker to authenticator;`);
    const client=createClient(ISOLATED_REST,isolatedJwt({role:"velora_discovery_worker"}),{auth:{persistSession:false,autoRefreshToken:false}});
    const rpc:DiscoveryRpc=(fn,args)=>client.rpc(fn,args) as unknown as ReturnType<DiscoveryRpc>;
    const persistence=databasePersistence(rpc,{channelId:channel});
    let reads=0;
    const media=channelVerificationPort((doc)=>async(offset,length)=>{
      reads++;
      if(doc.messageId===3)throw Object.assign(new Error("private transport text"),{name:"GatewayError",code:"flood_wait"});
      const bytes=doc.messageId===2?mkv:mp4;
      return bytes.subarray(offset,offset+length);
    },{
      probe:headProbe(tools.tools.ffprobe),gatewayCompatible:true,
      spool:(read,size,handle)=>spoolDocument(work,read,size,handle),
      inspect:async(path)=>{const probe=await probeMedia(tools.tools.ffprobe,path);return probe.ok?probe.inspection:null;},
      decoder:(path)=>({decode:(streams,window)=>decodeStreams(tools.tools.ffmpeg,path,streams,window)}),
      tools:{ffmpeg:tools.tools.ffmpeg.version,ffprobe:tools.tools.ffprobe.version},now:()=>new Date(),
    });
    const upload=(message:number,bytes:Buffer,ext:string)=>isolatedSql(`insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,file_name,mime_type,file_size_bytes,telegram_date)
      values('movie',${channel},${message},'synthetic-upload-${message}','AgADuploadE2E${message}','document','Unreviewed.${ext}',
        '${ext==="mkv"?"video/x-matroska":"video/mp4"}',${bytes.length},now())`);
    const run=()=>runMediaVerification({next:()=>persistence.verifyMediaNext(media,()=>new Date(),600,60),async sleep(){},log(){}},
      {signal:new AbortController().signal,intervalMs:30000,once:true});
    try {
      upload(1,mp4,"mp4");upload(2,mkv,"mkv");upload(3,mp4,"mp4");
      expect(await run()).toEqual({passes:1,verified:2,notVerified:0,failed:1,errors:0});
      expect(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id=ev.telegram_media_id
        where m.chat_id=${channel} and ev.scope='whole_file' and ev.integrity_status='verified' and ev.streaming_status='verified'`)).toBe("2");
      expect(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id=ev.telegram_media_id
        where m.chat_id=${channel} and m.message_id=3`)).toBe("0");
      const readBefore=reads;
      expect(await run()).toEqual({passes:1,verified:0,notVerified:0,failed:0,errors:0});
      expect(reads).toBe(readBefore);
      // A new upload becomes due after the worker was idle, with no operator action.
      upload(4,mp4,"mp4");
      expect(await run()).toMatchObject({verified:1,errors:0});
      expect(counts()).toBe(before);
    } finally {
      if(previous)isolatedSql(`update private.telegram_channels set chat_id=${previous} where bot_type='movie'`);
      else isolatedSql(`delete from private.telegram_channels where bot_type='movie' and chat_id=${channel}`);
      isolatedSql("revoke velora_discovery_worker from authenticator");
      rmSync(work,{recursive:true,force:true});
    }
  });
});
