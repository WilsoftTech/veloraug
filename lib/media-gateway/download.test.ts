import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DOWNLOAD_ENV_NAMES, DOWNLOAD_LIMITS, DOWNLOAD_MAX_DURATION_MS, DOWNLOAD_MAX_FILE_BYTES, downloadHeaders, downloadLimitsFromEnv, type DownloadLimits } from "@/lib/media-gateway/download";
import { GatewayError } from "@/lib/media-gateway/errors";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { createLogger } from "@/lib/media-gateway/log";
import type { MediaLocator } from "@/lib/media-gateway/ports";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { FakeReader, FakeResolver, expectedBytes, publishedLocator } from "@/lib/media-gateway/test-fakes";
import { signMediaToken, type MediaOperation } from "@/lib/media-gateway/token";
import { TELEGRAM_MAX_FILE_BYTES } from "@/lib/ingestion/telegram";
import { issueDownloadCapability } from "@/lib/playback/stream-capability";

const SECRET = new Uint8Array(32).fill(6);
const SUBJECT = "00000000-0000-4000-8000-000000000051";
const SIZE = 2 * 1024 * 1024 + 333;
const locator: MediaLocator = { ...publishedLocator, fileSize: SIZE, fileName: "Film é (2026).MKV" };
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class DownloadResolver extends FakeResolver {
  downloadCalls = 0;
  userAllowed = true;
  available = true;
  current = { ...locator };
  failDownload: GatewayError | null = null;
  async resolveDownload(_version: number, subject: string) {
    this.downloadCalls++;
    if (this.failDownload) throw this.failDownload;
    return this.userAllowed && this.available && subject === SUBJECT && _version === 1 ? { ...this.current } : null;
  }
}

let server: Server | undefined;
async function start(options: { reader?: FakeReader; resolver?: DownloadResolver; downloadLimits?: Partial<DownloadLimits>; limits?: Partial<typeof DEFAULT_LIMITS>; now?: () => number; clientIp?: (request: IncomingMessage) => string } = {}) {
  const reader = options.reader ?? new FakeReader();
  const resolver = options.resolver ?? new DownloadResolver();
  const logs: string[] = [];
  const gateway = createMediaGateway({ tokenSecret: SECRET, limits: { ...DEFAULT_LIMITS, ...options.limits },
    reader, resolver, logger: createLogger(line => logs.push(line)), downloadLimits: options.downloadLimits, now: options.now, clientIp: options.clientIp });
  server = createServer(gateway.handle);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (op: MediaOperation = "download", version = 1, subject = SUBJECT, issuedAt = Date.now(), ttlSeconds = 600) => signMediaToken(SECRET,
    { op, movieVersionId: version, subject, ttlSeconds, nowSeconds: Math.floor(issuedAt / 1000) });
  const url = (t: string | null = token(), version = 1, op = "download") => `${base}/v1/movie-versions/${version}/${op}${t ? `?token=${t}` : ""}`;
  return { base, reader, resolver, gateway, logs, token, url };
}
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});
async function get(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

describe("original-file download HTTP and integrity", () => {
  it.each([['video/mp4','Original Film.MP4'], ['video/x-matroska','Film é (2026).MKV']])("full GET preserves %s bytes and filename", async (mimeType, fileName) => {
    const h = await start(); Object.assign(h.resolver.current, { mimeType, fileName });
    const capability = issueDownloadCapability({ secret: SECRET, gatewayOrigin: h.base }, { movieVersionId: 1, subject: SUBJECT }, Date.now());
    const { response, bytes } = await get(capability.downloadUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(fileName).replace(/[()]/g,c=>`%${c.charCodeAt(0).toString(16)}`)}`);
    expect(hash(bytes)).toBe(hash(expectedBytes(0, SIZE)));
    expect(h.reader.maxInFlight).toBe(1);
    expect(h.gateway.activeStreams).toBe(0);
    expect(h.logs.join("\n")).not.toMatch(/chatId|fileUniqueId|Film|v1\./);
  });
  it.each([['bytes=11-100',11,100], ['bytes=1048576-',1048576,SIZE-1], ['bytes=-333',SIZE-333,SIZE-1], [`bytes=0-${SIZE+999}`,0,SIZE-1]])("exact range %s is never shortened to the playback limit", async (Range,first,end) => {
    const h=await start({ limits: { maxResponseBytes: 1024 } });
    const {response,bytes}=await get(h.url(),{Range});
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${first}-${end}/${SIZE}`);
    expect(response.headers.get("content-length")).toBe(String(Number(end)-Number(first)+1));
    expect(hash(bytes)).toBe(hash(expectedBytes(Number(first),Number(end)-Number(first)+1)));
  });
  it.each([`bytes=${SIZE}-`, 'bytes=-0'])("unsatisfiable %s is 416 before reads", async Range => {
    const h=await start(); const {response}=await get(h.url(),{Range});
    expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`);
    expect(h.reader.calls).toBe(0);
  });
  it.each(['bytes=2-1','bytes=0-1,3-4','pages=0-1'])("malformed range %s is rejected before reads",async Range=>{
    const h=await start();expect((await get(h.url(),{Range})).response.status).toBe(400);expect(h.reader.calls).toBe(0);
  });
  it("resumes an interrupted transfer with fresh capability and If-Range to reproduce SHA-256",async()=>{
    const h=await start({reader:new FakeReader({delayMs:10})});
    const controller=new AbortController();const first=await fetch(h.url(),{signal:controller.signal});
    const stream=first.body!.getReader(); const prefix=(await stream.read()).value!;controller.abort(); await stream.cancel().catch(()=>{});
    for(let n=0;n<40&&h.gateway.activeStreams;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(0);
    const fresh=issueDownloadCapability({secret:SECRET,gatewayOrigin:h.base},{movieVersionId:1,subject:SUBJECT},Date.now());
    const rest=await get(fresh.downloadUrl,{Range:`bytes=${prefix.length}-`,"If-Range":first.headers.get("etag")!});
    expect(rest.response.status).toBe(206);
    expect(hash(Buffer.concat([prefix,rest.bytes]))).toBe(hash(expectedBytes(0,SIZE)));
    expect(prefix.length).toBeLessThan(SIZE);
    expect(h.reader.inFlight).toBe(0);
  });
  it("mismatching If-Range restarts as a full 200 rather than mixing documents",async()=>{
    const h=await start();const r=await get(h.url(),{Range:'bytes=100-',"If-Range":'"old-document"'});
    expect(r.response.status).toBe(200);expect(r.bytes.length).toBe(SIZE);
  });
  it("keeps stream Range requirements and byte caps",async()=>{
    const h=await start({limits:{maxResponseBytes:1024}});
    expect((await get(h.url(h.token("stream"),1,"stream"))).response.status).toBe(400);
    const stream=await get(h.url(h.token("stream"),1,"stream"),{Range:'bytes=0-'});
    expect(stream.response.status).toBe(206);expect(stream.bytes.length).toBe(1024);
    expect(stream.response.headers.get("content-disposition")).toBeNull();
  });
});

describe("download security and resource safety",()=>{
  it("denies missing, tampered, expired, wrong-operation/version and overlong tokens without any external work",async()=>{
    const h=await start();
    for(const [url,status] of [[h.url(null),401],[h.url(h.token()+"bad"),401],[h.url(h.token("download",1,SUBJECT,Date.now()-700000)),401],
      [h.url(h.token("stream")),403],[h.url(h.token("download",2)),403],[h.url(h.token("download",1,SUBJECT,Date.now(),3600)),401],
      [h.url(h.token(),1,"stream"),403]] as const)expect((await get(url)).response.status).toBe(status);
    expect(h.resolver.downloadCalls+h.resolver.calls+h.reader.calls).toBe(0);
  });
  it.each(['userAllowed','available'] as const)("%s revocation denies even a valid token before Telegram",async field=>{
    const h=await start();h.resolver[field]=false;expect((await get(h.url())).response.status).toBe(404);expect(h.reader.calls).toBe(0);
  });
  it("cannot use another/unknown subject",async()=>{
    const h=await start();expect((await get(h.url(h.token("download",1,"unknown")))).response.status).toBe(404);expect(h.reader.calls).toBe(0);
  });
  it.each(['userAllowed','available'] as const)("active %s revocation cuts the connection within recheck bound",async field=>{
    const h=await start({reader:new FakeReader({delayMs:40}),downloadLimits:{recheckMs:10}});
    const response=await fetch(h.url());h.resolver[field]=false;
    await expect(response.arrayBuffer()).rejects.toThrow();
    for(let n=0;n<40&&h.gateway.activeStreams;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(0);expect(h.reader.inFlight).toBe(0);
    const reads=h.reader.calls;await tick(30);expect(h.reader.calls).toBe(reads);
  });
  it("active media replacement fails closed",async()=>{
    const h=await start({reader:new FakeReader({delayMs:40}),downloadLimits:{recheckMs:10}});
    const response=await fetch(h.url());h.resolver.current.fileUniqueId='replaced';await expect(response.arrayBuffer()).rejects.toThrow();
  });
  // Checkpoint 8 replaces "token expiry terminates an active response": a capability authorizes
  // requests that start in its lifetime, and a started transfer may outlive it.
  it("a transfer authorized before expiry continues past it, byte-identical, and frees admission; the expired capability starts nothing new",async()=>{
    const now=Date.now();let clock=now;
    const h=await start({now:()=>clock,reader:new FakeReader({delayMs:40}),downloadLimits:{recheckMs:10}});
    // The request starts with about 50 ms of capability life left on the gateway's clock.
    const t=h.token("download",1,SUBJECT,now,1);clock=Math.floor(now/1000)*1000+950;
    const response=await fetch(h.url(t));expect(response.status).toBe(200);
    clock+=3_600_000; // an hour past expiry while the body is still being sent
    const bytes=new Uint8Array(await response.arrayBuffer());
    expect(hash(bytes)).toBe(hash(expectedBytes(0,SIZE)));
    expect(h.resolver.downloadCalls).toBeGreaterThan(1); // the periodic recheck kept running past expiry
    for(let n=0;n<40&&h.gateway.activeStreams;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(0);
    const reads=h.reader.calls,checks=h.resolver.downloadCalls;
    expect((await get(h.url(t))).response.status).toBe(401);
    expect((await get(h.url(t),{Range:'bytes=100-',"If-Range":response.headers.get("etag")!})).response.status).toBe(401);
    expect(h.reader.calls).toBe(reads);expect(h.resolver.downloadCalls).toBe(checks);
  });
  it.each(['userAllowed','available'] as const)("%s revocation still ends a transfer that has outlived its capability",async field=>{
    const now=Date.now();let clock=now;
    const h=await start({now:()=>clock,reader:new FakeReader({delayMs:40}),downloadLimits:{recheckMs:10}});
    const t=h.token("download",1,SUBJECT,now,1);clock=Math.floor(now/1000)*1000+950;
    const response=await fetch(h.url(t));expect(response.status).toBe(200);
    clock+=3_600_000;h.resolver[field]=false;
    await expect(response.arrayBuffer()).rejects.toThrow();
    for(let n=0;n<40&&h.gateway.activeStreams;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(0);expect(h.reader.inFlight).toBe(0);
  });
  it("one capability serves several requests in its lifetime, and every request is authorized on arrival",async()=>{
    const h=await start();const t=h.token();
    const full=await get(h.url(t));expect(full.response.status).toBe(200);
    const etag=full.response.headers.get("etag")!;
    const part=await get(h.url(t),{Range:'bytes=1000-',"If-Range":etag});expect(part.response.status).toBe(206);
    expect(hash(Buffer.concat([full.bytes.subarray(0,1000),part.bytes]))).toBe(hash(expectedBytes(0,SIZE)));
    expect(h.resolver.downloadCalls).toBe(2); // each request resolved publication and the user afresh
    const reads=h.reader.calls;
    h.resolver.userAllowed=false; // entitlement revoked between requests
    expect((await get(h.url(t),{Range:'bytes=1000-',"If-Range":etag})).response.status).toBe(404);
    h.resolver.userAllowed=true;h.resolver.available=false; // unpublished between requests
    expect((await get(h.url(t),{Range:'bytes=1000-',"If-Range":etag})).response.status).toBe(404);
    expect(h.reader.calls).toBe(reads);
  });
  it("the download duration limit is four hours, cuts an over-long transfer mid-body and frees admission",async()=>{
    expect(DOWNLOAD_LIMITS.requestTimeoutMs).toBe(4*60*60*1000);expect(DOWNLOAD_MAX_DURATION_MS).toBe(14_400_000);
    const h=await start({reader:new FakeReader({delayMs:30}),downloadLimits:{requestTimeoutMs:150}});
    h.resolver.current.fileSize=16*1024*1024; // sixteen reads: far longer than the tightened limit
    const response=await fetch(h.url());expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    for(let n=0;n<40&&h.gateway.activeStreams;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(0);expect(h.reader.inFlight).toBe(0);
    expect(h.reader.calls).toBeLessThan(16);
  });
  it("the playback stream deadline is unchanged and independent of the download duration limit",async()=>{
    expect(DEFAULT_LIMITS.requestTimeoutMs).toBe(120_000);
    const h=await start({reader:new FakeReader({delayMs:200}),limits:{requestTimeoutMs:20}});
    expect((await get(h.url(h.token("stream"),1,"stream"),{Range:'bytes=0-1023'})).response.status).toBe(504);
    await tick(10);expect(h.gateway.activeStreams).toBe(0);
  });
  it("one download per user; stream admission remains independent; disconnect releases the slot",async()=>{
    const h=await start({reader:new FakeReader({delayMs:100})});
    const abort=new AbortController();const running=fetch(h.url(),{signal:abort.signal}).catch(()=>null);await tick(20);
    expect((await get(h.url())).response.status).toBe(429);
    expect((await get(h.url(h.token("stream"),1,"stream"),{Range:'bytes=0-1023'})).response.status).toBe(206);
    abort.abort();await running;for(let n=0;n<40&&h.gateway.activeStreams;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(0);expect((await get(h.url(),{Range:'bytes=0-10'})).response.status).toBe(206);
  });
  it.each(['request','idle','read'] as const)("%s timeout aborts reads and releases admission",async kind=>{
    const h=await start({reader:new FakeReader({delayMs:200}),downloadLimits:{requestTimeoutMs:kind==='request'?20:600000},
      limits:{idleTimeoutMs:kind==='idle'?20:30000,readTimeoutMs:kind==='read'?20:30000}});
    expect((await get(h.url())).response.status).toBe(504);await tick(10);expect(h.gateway.activeStreams).toBe(0);expect(h.reader.inFlight).toBe(0);
  });
  it.each([new GatewayError('telegram_unavailable'),new GatewayError('flood_wait',{retryAfterSeconds:12})])("safe upstream failure %s before body",async error=>{
    const h=await start({reader:new FakeReader({failWith:error})});const r=await get(h.url());
    expect(r.response.status).toBe(503);if(error.code==='flood_wait')expect(r.response.headers.get('retry-after')).toBe('12');
    expect(h.gateway.activeStreams).toBe(0);
  });
  it("mid-body Telegram failure signals truncation, never successful transformation",async()=>{
    const h=await start({reader:new FakeReader({failWith:new GatewayError('telegram_unavailable'),failOnCall:2,delayMs:5})});
    const response=await fetch(h.url());await expect(response.arrayBuffer()).rejects.toThrow();await tick(10);expect(h.gateway.activeStreams).toBe(0);
  });
  it("authorization database timeout denies before any media read",async()=>{
    const resolver=new DownloadResolver();resolver.resolveDownload=()=>new Promise(()=>{});
    const h=await start({resolver,downloadLimits:{authorizationTimeoutMs:20}});
    expect((await get(h.url())).response.status).toBe(503);expect(h.reader.calls).toBe(0);expect(h.gateway.activeStreams).toBe(0);
  });
  it("authorization database outage during transfer cuts off access",async()=>{
    const h=await start({reader:new FakeReader({delayMs:40}),downloadLimits:{recheckMs:10}});
    const response=await fetch(h.url());h.resolver.failDownload=new GatewayError('catalogue_unavailable');await expect(response.arrayBuffer()).rejects.toThrow();
  });
  it("a stalled socket cannot schedule an entire 2,000 MiB download and times out",async()=>{
    const h=await start({limits:{idleTimeoutMs:80}});h.resolver.current.fileSize=DOWNLOAD_MAX_FILE_BYTES;
    await new Promise<void>((resolve,reject)=>{
      const request=httpRequest(h.url(),response=>{response.pause();response.once('close',resolve);});
      request.once('error',reject);request.end();
      setTimeout(()=>{request.destroy();resolve();},250).unref();
    });
    await tick(20);expect(h.reader.calls).toBeLessThan(20);expect(h.reader.maxInFlight).toBe(1);
    expect(h.gateway.activeStreams).toBe(0);expect(h.reader.inFlight).toBe(0);
  });
  it("incrementally transfers 128 MiB with one bounded read and bounded downstream chunks",async()=>{
    let maxRead=0,readCalls=0;
    const reader=new FakeReader();
    reader.readPart=async(_locator,offset,limit,signal)=>{
      expect(signal.aborted).toBe(false);maxRead=Math.max(maxRead,limit);readCalls++;
      // A virtual large file: no full-file buffer exists on either side.
      const bytes=Buffer.alloc(limit,(offset/1024/1024)%256);return {bytes,rpcCount:1};
    };
    const h=await start({reader});h.resolver.current.fileSize=128*1024*1024;
    const response=await fetch(h.url());expect(response.status).toBe(200);
    const digest=createHash('sha256');let received=0,maxChunk=0;
    for await(const bytes of response.body! as unknown as AsyncIterable<Uint8Array>) {
      digest.update(bytes);received+=bytes.length;maxChunk=Math.max(maxChunk,bytes.length);
    }
    const expected=createHash('sha256');for(let i=0;i<128;i++)expected.update(Buffer.alloc(1024*1024,i));
    expect(digest.digest('hex')).toBe(expected.digest('hex'));
    expect(received).toBe(128*1024*1024);expect(readCalls).toBe(128);expect(maxRead).toBe(1024*1024);
    expect(maxChunk).toBeLessThanOrEqual(2*1024*1024);expect(h.gateway.activeStreams).toBe(0);
  });
});

describe("download slots and client identity",()=>{
  const user=(n:number)=>`00000000-0000-4000-8000-0000000000${String(n).padStart(2,"0")}`;
  const LONG=64*1024*1024; // slot tests hold transfers open, so the file must outlast the test
  // A slow reader that costs no CPU: these tests count slots, and several transfers run at once.
  const slowReader=()=>{const reader=new FakeReader();reader.readPart=(_locator,_offset,limit,signal)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>resolve({bytes:Buffer.alloc(limit),rpcCount:1}),100);
    signal.addEventListener("abort",()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});return reader;};
  const anyUser=()=>{const resolver=new DownloadResolver();resolver.resolveDownload=async()=>({...locator,fileSize:LONG});return resolver;};
  const settle=async(h:{gateway:{activeStreams:number}})=>{for(let n=0;n<60&&h.gateway.activeStreams;n++)await tick(5);};

  it("counts per-address slots by the socket peer and ignores every forwarding header",async()=>{
    const h=await start({resolver:anyUser(),reader:slowReader()});
    const aborts=[1,2,3].map(()=>new AbortController());
    const open=(i:number)=>fetch(h.url(h.token("download",1,user(i))),{signal:aborts[i-1].signal,
      headers:{"X-Forwarded-For":`203.0.113.${i}`,"X-Real-IP":`203.0.113.${i}`,Forwarded:`for=203.0.113.${i}`}});
    // Hold every open response: an unreferenced one is closed by the client's garbage collector, which frees its slot.
    const held=[await open(1),await open(2)];expect(held.map(r=>r.status)).toEqual([200,200]);
    // Three users, three claimed addresses, one real peer: the per-address limit of two holds.
    const third=await open(3);expect(third.status).toBe(429);await third.arrayBuffer();
    for(const abort of aborts)abort.abort();await settle(h);expect(h.gateway.activeStreams).toBe(0);expect(held).toHaveLength(2);
  });
  it("counts the identity the deployment supplies, and holds four slots for the whole gateway",async()=>{
    // Stands in for a deployment's trusted-proxy adapter; the gateway itself never reads a header.
    const h=await start({resolver:anyUser(),reader:slowReader(),clientIp:request=>String(request.headers["x-test-client"])});
    const aborts=[1,2,3,4,5].map(()=>new AbortController());
    const open=(i:number)=>fetch(h.url(h.token("download",1,user(i))),{signal:aborts[i-1].signal,headers:{"X-Test-Client":`client-${i}`}});
    const held:Response[]=[];for(const i of [1,2,3,4])held.push(await open(i)); // held, so the client keeps them open
    expect(held.map(r=>r.status)).toEqual([200,200,200,200]);
    const fifth=await open(5);expect(fifth.status).toBe(429);await fifth.arrayBuffer(); // gateway-wide limit
    expect(h.gateway.activeStreams).toBe(4);
    aborts[0].abort();for(let n=0;n<60&&h.gateway.activeStreams>3;n++)await tick(5);
    expect(h.gateway.activeStreams).toBe(3);
    const again=await fetch(h.url(h.token("download",1,user(5))),{headers:{"X-Test-Client":"client-5","Range":"bytes=0-10"}});
    expect(again.status).toBe(206);await again.arrayBuffer(); // the freed slot is usable at once
    for(const abort of aborts)abort.abort();await settle(h);expect(h.gateway.activeStreams).toBe(0);expect(held).toHaveLength(4);
  });
  it("one user holds one slot whatever address or capability the second request uses",async()=>{
    const h=await start({reader:slowReader(),clientIp:request=>String(request.headers["x-test-client"]??"a")});h.resolver.current.fileSize=LONG;
    const abort=new AbortController();const t=h.token();
    const first=await fetch(h.url(t),{signal:abort.signal,headers:{"X-Test-Client":"a"}});expect(first.status).toBe(200);
    for(const url of [h.url(t),h.url()]){const r=await fetch(url,{headers:{"X-Test-Client":"b"}});expect(r.status).toBe(429);await r.arrayBuffer();}
    abort.abort();await settle(h);expect(h.gateway.activeStreams).toBe(0);
  });
});

describe("download limits from the environment",()=>{
  it("keeps every default when nothing is set",()=>expect(downloadLimitsFromEnv({})).toEqual({}));
  it("accepts settings that tighten a default",()=>{
    expect(downloadLimitsFromEnv({MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS:"3600000",MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE:"2",MEDIA_GATEWAY_DOWNLOAD_MAX_PER_USER:"1",MEDIA_GATEWAY_DOWNLOAD_MAX_PER_IP:"1"}))
      .toEqual({requestTimeoutMs:3_600_000,maxActiveStreams:2,maxStreamsPerSubject:1,maxStreamsPerIp:1});
    expect(downloadLimitsFromEnv({MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS:"14400000",MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE:"4"})).toEqual({requestTimeoutMs:14_400_000,maxActiveStreams:4});
  });
  it.each([["MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS","14400001"],["MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS","59999"],["MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE","5"],
    ["MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE","0"],["MEDIA_GATEWAY_DOWNLOAD_MAX_PER_USER","2"],["MEDIA_GATEWAY_DOWNLOAD_MAX_PER_IP","3"],
    ["MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE","four"],["MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS","1e9"],["MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE","-1"]])("refuses %s=%s: a setting can never raise a limit",(name,value)=>{
    expect(()=>downloadLimitsFromEnv({[name]:value})).toThrow(name);
  });
  it("names exactly the four documented settings",()=>{
    expect([...DOWNLOAD_ENV_NAMES].sort()).toEqual(["MEDIA_GATEWAY_DOWNLOAD_MAX_ACTIVE","MEDIA_GATEWAY_DOWNLOAD_MAX_DURATION_MS","MEDIA_GATEWAY_DOWNLOAD_MAX_PER_IP","MEDIA_GATEWAY_DOWNLOAD_MAX_PER_USER"]);
  });
  it("the gateway itself refuses a limit looser than its default, however it is passed in",async()=>{
    for(const downloadLimits of [{requestTimeoutMs:14_400_001},{maxActiveStreams:5},{maxStreamsPerSubject:2},{maxStreamsPerIp:3},{maxTokenLifetimeSeconds:601}])
      await expect(start({downloadLimits})).rejects.toThrow("must tighten the default");
  });
});

describe("safe original filename headers",()=>{
  it("matches the approved ingestion size ceiling",()=>expect(DOWNLOAD_MAX_FILE_BYTES).toBe(TELEGRAM_MAX_FILE_BYTES));
  it("uses an exact UTF-8 original and a safe ASCII fallback",()=>{
    const header=downloadHeaders({...locator,fileName:'Música "film"; 100%.mkv'})['Content-Disposition'];
    expect(header).toContain("filename*=UTF-8''M%C3%BAsica%20%22film%22%3B%20100%25.mkv");expect(header).not.toMatch(/[\r\n]/);
  });
  it.each([null,'../private.mkv','C:\\secret.mkv','bad\r\nX-Test: injected.mkv','bad\u0000.mkv','bidi\u202e.mkv','wrong.mp4','\ud800.mkv','CON.mkv'])('handles historical name %s safely',fileName=>{
    const header=downloadHeaders({...locator,fileName})['Content-Disposition'];
    expect(header).toContain('velora-movie-version-1.mkv');
    expect(header).not.toContain(locator.chatId);expect(header).not.toContain(locator.fileUniqueId);
  });
  it.each([{mimeType:'video/webm'},{fileSize:DOWNLOAD_MAX_FILE_BYTES+1}])('rejects unsupported media before reads',change=>expect(()=>downloadHeaders({...locator,...change})).toThrow(GatewayError));
});
