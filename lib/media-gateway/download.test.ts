import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DOWNLOAD_MAX_FILE_BYTES, downloadHeaders, type DownloadLimits } from "@/lib/media-gateway/download";
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
async function start(options: { reader?: FakeReader; resolver?: DownloadResolver; downloadLimits?: Partial<DownloadLimits>; limits?: Partial<typeof DEFAULT_LIMITS>; now?: () => number } = {}) {
  const reader = options.reader ?? new FakeReader();
  const resolver = options.resolver ?? new DownloadResolver();
  const logs: string[] = [];
  const gateway = createMediaGateway({ tokenSecret: SECRET, limits: { ...DEFAULT_LIMITS, ...options.limits },
    reader, resolver, logger: createLogger(line => logs.push(line)), downloadLimits: options.downloadLimits, now: options.now });
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
  it("token expiry terminates an active response and frees admission",async()=>{
    const now=Date.now();let clock=now;
    const h=await start({now:()=>clock,reader:new FakeReader({delayMs:40}),downloadLimits:{recheckMs:10}});
    // Request starts with under 100ms of remaining life according to the injected gateway clock.
    const t=h.token("download",1,SUBJECT,now,1);clock=Math.floor(now/1000)*1000+950;
    const response=await fetch(h.url(t));await expect(response.arrayBuffer()).rejects.toThrow();
    await tick(15);expect(h.gateway.activeStreams).toBe(0);
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
