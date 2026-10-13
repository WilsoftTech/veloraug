/** Download continuation against the real restricted Postgres adapter, disposable tmpfs database only.
 * node --import ./scripts/ingest/register.mjs scripts/checkpoint8-validation.mts
 *
 * The unit tests prove continuation and revocation with a fake resolver, where
 * unpublishing and rights withdrawal are one flag. Here the gateway core runs
 * with the real resolver and real SQL, so each revocation is a real row change.
 * The media is the committed synthetic fixtures, read from disk. A fixture is one
 * read, so a transfer is held open by delaying that read: what is shown is the
 * recheck ending an admitted transfer, not a cut in the middle of a body (that is
 * lib/media-gateway/download.test.ts).
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { up, down, psql, ISOLATED } from "./isolated-db.mjs";
import { createPgResolver } from "../services/media-gateway/pg-resolver.mts";
import { createMediaGateway } from "@/lib/media-gateway/server";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { signMediaToken } from "@/lib/media-gateway/token";
import type { CatalogueMediaResolver, MediaReader } from "@/lib/media-gateway/ports";

const subject = "00000000-0000-4000-8000-000000000081";
const secret = new Uint8Array(32).fill(23);
const READ_DELAY_MS = 1_500;
const RECHECK_MS = 200;
const sql = (statement: string) => { const r = psql(statement); assert.equal(r.code, 0, r.err); return r.out.trim(); };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync("tests/browser/fixtures/manifest.json", "utf8")) as { fixtures: { id: number; file: string; sizeBytes: number; mime: string }[] };
const fixtures = [manifest.fixtures.find((f) => f.mime === "video/mp4")!, manifest.fixtures.find((f) => f.mime === "video/x-matroska")!];

try {
  up({ rest: false });
  sql(`alter role velora_media_gateway login password 'synthetic-cp8-local-only';
    insert into auth.users(id,is_anonymous) values('${subject}',false);
    insert into private.telegram_channels(bot_type,chat_id) values('movie',-1007776665555);
    insert into public.vjs(slug,name,is_active) values('cp8-local-vj','Synthetic VJ',true);`);
  const versions = new Map<number, { file: string; bytes: Buffer }>();
  for (const fixture of fixtures) {
    sql(`insert into private.telegram_media(bot_type,chat_id,message_id,file_id,file_unique_id,media_kind,mime_type,file_size_bytes,file_name,telegram_date)
      values('movie',-1007776665555,${fixture.id},'synthetic-id-${fixture.id}','synthetic-unique-${fixture.id}','document','${fixture.mime}',${fixture.sizeBytes},'${fixture.file}',now());
      insert into public.movies(slug,title,publication_status,published_at) values('cp8-fixture-${fixture.id}','Synthetic local fixture','published',now());
      insert into public.movie_versions(movie_id,vj_id,availability_status,rights_status,available_at,telegram_media_id)
      select m.id,v.id,'ready','cleared',now(),t.id from public.movies m,public.vjs v,private.telegram_media t
      where m.slug='cp8-fixture-${fixture.id}' and v.slug='cp8-local-vj' and t.file_unique_id='synthetic-unique-${fixture.id}';`);
    const version = Number(sql(`select mv.id from public.movie_versions mv join public.movies m on m.id=mv.movie_id where m.slug='cp8-fixture-${fixture.id}'`));
    versions.set(version, { file: fixture.file, bytes: readFileSync(`tests/browser/fixtures/${fixture.file}`) });
  }
  const [mp4Version] = versions.keys();

  const real = createPgResolver(`postgres://velora_media_gateway:synthetic-cp8-local-only@127.0.0.1:${ISOLATED.dbPort}/postgres`);
  assert.equal(await real.check(), "reachable");
  let resolverCalls = 0;
  const resolver: CatalogueMediaResolver = {
    resolveMovieVersion: (id, signal) => real.resolveMovieVersion(id, signal),
    resolveDownload: (id, sub, signal) => { resolverCalls++; return real.resolveDownload!(id, sub, signal); },
  };
  // One slow, abortable read per fixture: the transfer stays admitted while the test acts on it.
  let reads = 0, aborted = 0, delayMs = 0;
  let readStarted: () => void = () => {};
  const reader: MediaReader = {
    readiness: () => ({ ready: true, state: "synthetic_only" }),
    readPart: (locator, offset, limit, signal) => new Promise((resolve, reject) => {
      reads++; readStarted();
      const bytes = versions.get(locator.movieVersionId)!.bytes;
      const timer = setTimeout(() => resolve({ bytes: bytes.subarray(offset, offset + limit), rpcCount: 1 }), delayMs);
      signal.addEventListener("abort", () => { clearTimeout(timer); aborted++; reject(signal.reason); }, { once: true });
    }),
  };
  let clockOffsetMs = 0;
  const now = () => Date.now() + clockOffsetMs;
  const gateway = createMediaGateway({ tokenSecret: secret, limits: DEFAULT_LIMITS, resolver, reader, now, downloadLimits: { recheckMs: RECHECK_MS },
    logger: { info() {}, warn() {}, error() {} } });
  const server = createServer(gateway.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = (version: number) => `${origin}/v1/movie-versions/${version}/download?token=${signMediaToken(secret, { op: "download", movieVersionId: version, subject, ttlSeconds: 600, nowSeconds: Math.floor(now() / 1000) })}`;
  /**
   * Starts a transfer and resolves once its read is in flight, that is, once it has been authorized
   * and admitted. The response is returned inside an object: an async function that returned the
   * promise itself would wait for the whole response, and the test would act too late.
   */
  const admitted = async (url: string) => {
    const inFlight = new Promise<void>((resolve) => { readStarted = resolve; });
    const response = fetch(url);
    await inFlight;
    return { response, readStartedAt: Date.now() };
  };
  const idle = async () => { for (let n = 0; n < 100 && gateway.activeStreams; n++) await new Promise((r) => setTimeout(r, 10)); assert.equal(gateway.activeStreams, 0); };

  try {
    // 1. A capability serves several requests in its lifetime; each one is authorized by the real resolver.
    delayMs = 0;
    for (const [version, { file, bytes }] of versions) {
      const url = link(version), before = resolverCalls;
      const full = await fetch(url); assert.equal(full.status, 200);
      const body = Buffer.from(await full.arrayBuffer()); assert.equal(sha256(body), sha256(bytes));
      await idle();
      const part = await fetch(url, { headers: { Range: "bytes=1000-", "If-Range": full.headers.get("etag")! } }); assert.equal(part.status, 206);
      assert.equal(sha256(Buffer.concat([body.subarray(0, 1000), Buffer.from(await part.arrayBuffer())])), sha256(bytes));
      assert.equal(resolverCalls, before + 2); await idle();
      console.log(`${file}: one capability, full download then Range resume with If-Range, byte-identical, each request resolved in the database`);
    }

    // 2. A transfer authorized before expiry completes after it; the expired capability then starts nothing.
    delayMs = READ_DELAY_MS;
    for (const [version, { file, bytes }] of versions) {
      const url = link(version);
      const transfer = await admitted(url);
      clockOffsetMs += 3_600_000; // an hour past the capability's expiry, with the read still in flight
      const movedAfter = Date.now() - transfer.readStartedAt;
      const response = await transfer.response; assert.equal(response.status, 200);
      // The clock really moved while the transfer was running, and several rechecks ran after that.
      assert.ok(movedAfter < 200 && Date.now() - transfer.readStartedAt >= READ_DELAY_MS - 50, "the clock was not moved mid-transfer");
      assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(bytes)); await idle();
      const readsBefore = reads, callsBefore = resolverCalls;
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { Range: "bytes=1000-", "If-Range": response.headers.get("etag")! } })).status, 401);
      assert.equal(reads, readsBefore); assert.equal(resolverCalls, callsBefore);
      console.log(`${file}: transfer continued an hour past expiry, byte-identical; the expired link then got 401 twice with no database call and no media read`);
    }

    // 3. Each real revocation ends a transfer that has already outlived its capability, inside the recheck bound.
    const slug = `cp8-fixture-${fixtures[0].id}`;
    const revocations: [name: string, revoke: string, restore: string][] = [
      ["account banned", `update auth.users set banned_until=now()+interval '1 day' where id='${subject}'`, `update auth.users set banned_until=null where id='${subject}'`],
      ["account deleted", `update auth.users set deleted_at=now() where id='${subject}'`, `update auth.users set deleted_at=null where id='${subject}'`],
      ["account anonymous", `update auth.users set is_anonymous=true where id='${subject}'`, `update auth.users set is_anonymous=false where id='${subject}'`],
      ["movie unpublished", `update public.movies set publication_status='draft' where slug='${slug}'`, `update public.movies set publication_status='published' where slug='${slug}'`],
      ["rights withdrawn", `update public.movie_versions set rights_status='blocked' where id=${mp4Version}`, `update public.movie_versions set rights_status='cleared' where id=${mp4Version}`],
      ["version made unavailable", `update public.movie_versions set availability_status='unavailable' where id=${mp4Version}`, `update public.movie_versions set availability_status='ready' where id=${mp4Version}`],
      ["VJ deactivated", `update public.vjs set is_active=false where slug='cp8-local-vj'`, `update public.vjs set is_active=true where slug='cp8-local-vj'`],
    ];
    for (const [name, revoke, restore] of revocations) {
      const abortedBefore = aborted;
      const transfer = await admitted(link(mp4Version));
      clockOffsetMs += 3_600_000;
      sql(revoke);
      const revokedAt = Date.now();
      assert.ok(revokedAt - transfer.readStartedAt < READ_DELAY_MS / 2, `${name}: the row was not changed mid-transfer`);
      try {
        const response = await transfer.response;
        const elapsed = Date.now() - revokedAt;
        // Nothing had been sent yet, so the refusal is a clean status, and no byte of the file follows it.
        assert.equal(response.status, 404, name);
        assert.ok(elapsed < READ_DELAY_MS - 100, `${name}: ended after ${elapsed} ms, not before the read could finish`);
        assert.equal(aborted, abortedBefore + 1, `${name}: the media read was not cancelled`);
        await idle();
        // A new request with a new, valid capability is refused too, with no media read.
        const readsBefore = reads;
        assert.equal((await fetch(link(mp4Version))).status, 404, name); assert.equal(reads, readsBefore);
        console.log(`${name}: running transfer (already past expiry) ended ${elapsed} ms after the row changed, read cancelled, slot freed; a new capability is refused with no read`);
      } finally { sql(restore); }
      // Access is back once the row is restored: the denial came from the row, not from a stuck gateway.
      delayMs = 0; const again = await fetch(link(mp4Version)); assert.equal(again.status, 200); await again.arrayBuffer(); await idle(); delayMs = READ_DELAY_MS;
    }
    console.log(`real restricted adapter: ${versions.size} fixtures continued past expiry; ${revocations.length} revocations each ended a running transfer within the ${RECHECK_MS} ms recheck interval used here (30 s in production)`);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await real.close(); }
} finally { down(); }
