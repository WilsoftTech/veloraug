import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ReviewDetail } from "@/components/discovery-review";
import { MediaVerification } from "@/components/media-verification";
import { createReviewClient, databaseCataloguePorts, databasePersistence, type DiscoveryRpc } from "@/lib/discovery/database";
import { guidance, verificationPending } from "@/lib/discovery/guidance";
import { candidateMedia, mediaReport, publicationRequirements } from "@/lib/discovery/media-report";
import { channelMediaPort, channelVerificationPort, type ChannelMediaEvidence } from "@/lib/discovery/media-verification";
import { channelIdentity } from "@/lib/discovery/events";
import type { InspectionPorts } from "@/lib/discovery/pipeline";
import { replayProvider, runReplay } from "@/lib/discovery/worker";
import { getMovie } from "@/lib/catalogue";
import { RESOLVE_MOVIE_VERSION_SQL } from "@/lib/media-gateway/resolver-sql";
import { inspectAdminUpload } from "@/lib/uploader/admin-inspection";
import { createUploadClient, uploadMedia } from "@/lib/uploader/admin-upload";
import { verifiedUploadPath } from "@/lib/uploader/disk-transfer";
import { decodeStreams, headProbe, probeMedia, resolveMediaTools, runProcess, spoolDocument, type MediaTools } from "@/lib/uploader/media-tools";
import { ISOLATED_REST, isolatedJwt, isolatedSql } from "./isolated-env";

/**
 * Checkpoint 10, end to end and isolated: the Policy 3 verification contract on
 * both ingestion paths, with real files, the real tools and the real database
 * functions.
 *
 * Channel path: a synthetic post is detected and inspected by the real worker,
 * a reviewer confirms film and VJ, and a keyed whole-file verification reads
 * every byte through a reader port, hashes and decodes it. Upload path: a staged
 * original goes through the real inspection of the upload worker. In both, the
 * database records what was found, and only a candidate that passes every gate
 * can be published.
 *
 * The files are the committed synthetic fixtures (tests/browser/fixtures) and
 * damaged copies of them made in a temporary folder. No Telegram, TMDB, R2 or
 * hosted request can leave this process (tests/integration/discovery-isolated-fetch.ts).
 * The upload path stops where the next step would be a transfer to Telegram.
 */

const UPLOAD_TMDB = 9940001;
const film = (tmdb: number, title: string) => ({ tmdb_id: tmdb, title, original_title: title, overview: "A synthetic film.", release_date: "2025-03-01", runtime_minutes: 101, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] });
vi.mock("@/lib/tmdb/ingestion-search", async (original) => ({
  ...(await original<typeof import("@/lib/tmdb/ingestion-search")>()),
  searchTmdbForIngestion: vi.fn(async (query: { title: string }) => [{ tmdbId: UPLOAD_TMDB, mediaType: "movie", title: query.title, originalTitle: query.title, year: 2025 }]),
  fetchMovieSnapshot: vi.fn(async (id: number) => film(id, "Uploaded Original")),
}));

const CHANNEL = -1007776665557;
const REVIEW = "00000000-0000-4000-8000-000000001a01", RIGHTS = "00000000-0000-4000-8000-000000001a02", PUBLISH = "00000000-0000-4000-8000-000000001a03";
const OWNER = "00000000-0000-4000-8000-000000001a04";
const FIXTURES = "tests/browser/fixtures";
const rpcAs = (claims: Record<string, unknown>): DiscoveryRpc => {
  const client = createClient(ISOLATED_REST, isolatedJwt(claims), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return (fn, args) => client.rpc(fn, args) as unknown as ReturnType<DiscoveryRpc>;
};
const session = (sub: string) => ({ role: "authenticated", sub, aud: "authenticated", is_anonymous: false });
const service = rpcAs({ role: "service_role" });
const reviewer = (sub: string) => createReviewClient(rpcAs(session(sub)));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const key = (message: number) => isolatedSql(`select private.discovery_message_key(${CHANNEL}, ${message})`);
const refusal = async (run: () => Promise<unknown>) => { try { await run(); return "accepted"; } catch (error) { return String((error as { code?: string }).code ?? "other"); } };
const status = (report: ReturnType<typeof mediaReport>, label: string) => report.statuses.find((item) => item.label === label)!;
const row = (report: ReturnType<typeof mediaReport>, label: string) => [...report.details, ...report.provenance].find((item) => item.label === label)!.value;

interface Doc { message: number; tmdb: number; title: string; name: string; mime: string; bytes: Buffer }
const docs = new Map<number, Doc>();
/** What the reader returns for a message. Replaced per test to stand for a changed, shorter or unreadable document. */
const served = new Map<number, (offset: number, length: number) => Promise<Uint8Array>>();
let tools: MediaTools;
let work: string;
let vjId: number;
const skip = process.env.VELORA_E38_ISOLATED_TESTS !== "true" || process.env.NEXT_PUBLIC_SUPABASE_URL !== ISOLATED_REST;

const open = (document: { messageId: number }) => (offset: number, length: number) =>
  (served.get(document.messageId) ?? (async (at: number, size: number) => docs.get(document.messageId)!.bytes.subarray(at, at + size)))(offset, length);
const bounded = () => channelMediaPort(open, headProbe(tools.ffprobe));
const whole = () => channelVerificationPort(open, {
  probe: headProbe(tools.ffprobe), gatewayCompatible: true,
  spool: (read, sizeBytes, handle) => spoolDocument(join(work, "spool"), read, sizeBytes, handle),
  inspect: async (path) => { const probe = await probeMedia(tools.ffprobe, path); return probe.ok ? probe.inspection : null; },
  decoder: (path) => ({ decode: (streams, window) => decodeStreams(tools.ffmpeg, path, streams, window) }),
  tools: { ffmpeg: tools.ffmpeg.version, ffprobe: tools.ffprobe.version }, now: () => new Date(),
});
const persistence = () => databasePersistence(service, { channelId: CHANNEL });
const verify = (message: number) => persistence().verifyOne(key(message), whole(), () => new Date(), 600);
const read = async (message: number) => (await reviewer(REVIEW).get(key(message)))!.candidate;
const evidenceRows = (message: number) => Number(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id=ev.telegram_media_id where m.chat_id=${CHANNEL} and m.message_id=${message}`));
const page = (candidate: Awaited<ReturnType<typeof read>>, capabilities = { review: true, rights: true, publish: true }, downloads = false) =>
  renderToStaticMarkup(<ReviewDetail candidate={candidate} vjs={[]} action={async () => {}} mode="database" capabilities={capabilities} downloads={downloads} />);

/** Posts documents to the synthetic channel, inspects them with the real bounded worker and confirms film and VJ. */
async function post(items: Doc[]) {
  for (const item of items) docs.set(item.message, item);
  const ports: InspectionPorts = {
    ...databaseCataloguePorts(service),
    async search(query) { const item = items.find((doc) => doc.title === query.title)!; return [{ tmdbId: item.tmdb, mediaType: "movie", title: item.title, originalTitle: item.title, year: 2025 }]; },
    async snapshot(id) { const item = [...docs.values()].find((doc) => doc.tmdb === id); return item ? film(item.tmdb, item.title) : null; },
    media: bounded(),
  };
  const updates = items.map((item) => ({ update_id: 5000 + item.message, channel_post: { message_id: item.message, date: 1760100000, chat: { id: CHANNEL, type: "channel" },
    document: { file_id: `synthetic-bot-file-${item.message}`, file_unique_id: `AgADcp10x${item.message}`, file_size: item.bytes.length, file_name: item.name, mime_type: item.mime }, caption: `${item.title} (2025)\nVJ Verified` } }));
  isolatedSql("update private.discovery_cursors set consumer_token=null, consumer_until=null");
  const metrics = await runReplay(persistence(), replayProvider(updates), ports, { now: () => new Date(), signal: new AbortController().signal, paceMs: 0 });
  expect(metrics.failures).toBe(0);
  for (const item of items) {
    const found = (await reviewer(REVIEW).get(key(item.message)))!;
    await reviewer(REVIEW).correct(found.candidate.id, found.candidate.revision, { tmdbId: item.tmdb, year: 2025, vjId });
  }
}
const doc = (message: number, title: string, fixture: string | Buffer, extension: string, mime?: string): Doc => ({ message, tmdb: 9930000 + message, title,
  name: `${title.replaceAll(" ", ".")}.2025.VJ.Verified.${extension}`, mime: mime ?? (extension === "mkv" ? "video/x-matroska" : "video/mp4"),
  bytes: typeof fixture === "string" ? readFileSync(join(FIXTURES, fixture)) : fixture });

describe.skipIf(skip)("Policy 3 verification contract, end to end (isolated)", () => {
  beforeAll(async () => {
    const found = await resolveMediaTools();
    if (!found.ok) throw new Error("VELORA_FFPROBE_PATH and VELORA_FFMPEG_PATH are required: the fixtures are verified with the real tools");
    tools = found.tools;
    work = mkdtempSync(join(tmpdir(), "velora-cp10-"));
    isolatedSql(`
      delete from private.discovery_cursors where bot_type = 'movie';
      delete from private.telegram_channels where bot_type = 'movie';
      insert into private.telegram_channels (bot_type, chat_id, checkpoint_message_id) values ('movie', ${CHANNEL}, 1);
      insert into private.discovery_cursors (bot_type) values ('movie');
      insert into public.vjs (slug, name, is_active) values ('vj-verified', 'VJ Verified', true);
      insert into auth.users (id, aud, role, email, raw_app_meta_data, is_anonymous) values
        ('${REVIEW}', 'authenticated', 'authenticated', 'r@cp10.invalid', '{}', false), ('${RIGHTS}', 'authenticated', 'authenticated', 'g@cp10.invalid', '{}', false),
        ('${PUBLISH}', 'authenticated', 'authenticated', 'p@cp10.invalid', '{}', false), ('${OWNER}', 'authenticated', 'authenticated', 'o@cp10.invalid', '{"role":"admin"}', false);
      insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
        ('${REVIEW}', true, false, false), ('${RIGHTS}', false, true, false), ('${PUBLISH}', false, false, true), ('${OWNER}', true, true, true);
      alter role velora_upload_worker login password 'postgres';`);
    vjId = Number(isolatedSql("select id from public.vjs where slug = 'vj-verified'"));
  });
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    isolatedSql(`delete from private.discovery_cursors where bot_type = 'movie'; delete from private.telegram_channels where chat_id = ${CHANNEL}`);
  });

  describe("channel path", () => {
    it("a bounded inspection still records metadata only: pending, never verified, and the media gate stays closed", async () => {
      await post([doc(301, "Alpha Original", "mp4-h264-aac-faststart.mp4", "mp4"), doc(302, "Bravo Original", "mkv-h264-aac.mkv", "mkv"),
        doc(303, "Charlie Original", "mkv-h264-aac-two-audio.mkv", "mkv"), doc(304, "Delta Original", "mkv-h264-aac-subtitles.mkv", "mkv"), doc(305, "Echo Original", "mkv-hevc-aac.mkv", "mkv")]);
      const candidate = await read(301);
      expect(candidate).toMatchObject({ status: "awaiting_media", gates: ["media_verification_required", "rights_clearance_required"] });
      expect(candidate.evidence).toMatchObject({ policyVersion: 3, inspection: { scope: "bounded", download: "not_implemented_authorization_required", sha256: null }, facts: { integrity: "metadata_consistent", publishable: false } });
      expect(verificationPending(candidate)).toBe(true);
      const html = page(candidate);
      for (const text of ["Verification pending", "Metadata consistent, not verified", "Bounded sample", "Not recorded by a bounded inspection", "Not assessed by this inspection"]) expect(html, text).toContain(text);
      expect(html).not.toContain(">Verified<");
    });

    it("original MP4 with valid evidence: every byte read and hashed, the film decoded, the gate opens, and nothing else does", async () => {
      const result = await verify(301);
      expect(result.outcome).toBe("needs_review");
      const bytes = docs.get(301)!.bytes;
      expect(result.evidence).toMatchObject({ method: "full_original_v1", inspection_scope: "whole_file", media_class: "original", reasons: [], container: "mp4", video_codec: "h264", audio_codec: "aac", playback_ready: false,
        assessment: { accepted: true, integrity: "verified", streaming: "verified", download: "original_servable",
          verification: { contract: 1, digest: { algorithm: "sha256", value: sha256(bytes), bytes: bytes.length }, integrity: { status: "verified", method: "whole_file_decode_v1", reasons: [] },
            streaming: { status: "verified", layout: "mp4_head_index", samples: [{ position: "start", decoded: true }, { position: "middle", decoded: true }, { position: "end", decoded: true }] }, download: { status: "original_servable", reasons: [] } } } });
      expect(result.evidence!.bytes_read).toBeGreaterThanOrEqual(bytes.length);
      const stored = JSON.parse(isolatedSql(`select to_jsonb(x) from (select ev.scope, ev.method, ev.verified, ev.integrity_status, ev.streaming_status, ev.download_status, ev.content_sha256, ev.playback_ready,
        private.media_evidence_publishable(ev) as publishable from private.media_evidence ev join private.telegram_media m on m.id=ev.telegram_media_id where m.message_id=301 and m.chat_id=${CHANNEL} order by ev.id desc limit 1) x`));
      // The earlier policies' `verified` column is not what opens the gate, and stays false: Policy 3 has its own facts.
      expect(stored).toEqual({ scope: "whole_file", method: "full_original_v1", verified: false, integrity_status: "verified", streaming_status: "verified", download_status: "original_servable", content_sha256: sha256(bytes), playback_ready: false, publishable: true });
      expect(evidenceRows(301)).toBe(2); // the bounded inspection is kept beside it
      const candidate = await read(301);
      // Film and VJ are the reviewer's; rights and approval are still missing.
      expect(candidate).toMatchObject({ status: "awaiting_rights", identity: "confirmed", tmdbId: 9930301, vjId, gates: ["rights_clearance_required"] });
      expect(publicationRequirements(candidate).requirements.map((item) => item.done)).toEqual([true, true, true, true, false, false]);
      // The original file was only read.
      expect(sha256(readFileSync(join(FIXTURES, "mp4-h264-aac-faststart.mp4")))).toBe(sha256(bytes));
    });

    it("the dashboard shows the worker's record: verified, whole file, the digest, and still no publication control without rights and approval", async () => {
      const candidate = await read(301);
      const report = mediaReport(candidateMedia(candidate), { enabled: false, published: false });
      expect(report.statuses.map((item) => [item.label, item.value, item.tone])).toEqual([["Media integrity", "Verified", "verified"], ["Streaming readiness", "Verified", "verified"],
        ["Browser compatibility", "Tested combination on desktop", "pending"], ["Download availability", "Switched off", "missing"]]);
      expect([row(report, "Original container"), row(report, "Original filename"), row(report, "Video codec"), row(report, "Audio codec"), row(report, "Audio tracks"), row(report, "Subtitle tracks"), row(report, "Inspection policy"),
        row(report, "Inspection scope"), row(report, "Content SHA-256"), row(report, "Download evidence")])
        .toEqual(["MP4", "Alpha.Original.2025.VJ.Verified.mp4", "h264", "aac", "1", "0", "Version 3", "Whole file", sha256(docs.get(301)!.bytes), "The original can be served as it is"]);
      expect(report.basis).toContain("whole original file was read, hashed and decoded");
      const html = page(candidate);
      for (const text of ["Every byte was read and hashed", "decoded after seeking", "Whole file", sha256(docs.get(301)!.bytes), "whole file read and decoded", "Rights needed", "rights clearance required"]) expect(html, text).toContain(text);
      expect(html.match(/>Verified</g)).toHaveLength(2);
      for (const text of ['value="approve"', 'value="publish"', "Every mandatory gate passes", "synthetic-bot-file", "AgADcp10x", String(Math.abs(CHANNEL)), "tg1-"]) expect(html, text).not.toContain(text);
    });

    it("rights not cleared, then approval missing: each is its own gate, and a verified file passes neither for anyone", async () => {
      const candidate = await read(301);
      expect(await refusal(() => reviewer(REVIEW).approve(candidate.id, candidate.revision))).toBe("review_gates_not_met");
      expect(await refusal(() => reviewer(PUBLISH).publish(candidate.id, candidate.revision))).toBe("catalogue_not_approved");
      expect(await refusal(() => reviewer(REVIEW).clearRights(candidate.id, candidate.revision, "licence CP10-301"))).toBe("review_not_authorized");
      const cleared = await reviewer(RIGHTS).clearRights(candidate.id, candidate.revision, "licence CP10-301");
      expect(cleared).toMatchObject({ status: "awaiting_review", gates: [] });
      expect(page(cleared, { review: true, rights: false, publish: false })).toContain('value="approve"');
      // Rights and verified media, but no approval: nothing publishes.
      expect(await refusal(() => reviewer(PUBLISH).publish(cleared.id, cleared.revision))).toBe("catalogue_not_approved");
      expect(await refusal(() => reviewer(RIGHTS).approve(cleared.id, cleared.revision))).toBe("review_not_authorized");
      expect(await getMovie("alpha-original-2025")).toBeNull();
    });

    it("fully verified and approved: it publishes, plays through the gateway's resolver and reports its facts publicly", async () => {
      const cleared = await read(301);
      const approved = await reviewer(REVIEW).approve(cleared.id, cleared.revision);
      expect(publicationRequirements(approved).requirements.map((item) => item.done)).toEqual([true, true, true, true, true, true]);
      expect(await refusal(() => reviewer(REVIEW).publish(approved.id, approved.revision))).toBe("review_not_authorized");
      const published = await reviewer(PUBLISH).publish(approved.id, approved.revision);
      expect(published).toMatchObject({ result: "published", movie_slug: "alpha-original-2025" });
      expect((await getMovie("alpha-original-2025"))?.versions).toHaveLength(1);
      // The gateway's resolver names the same document and nothing was rewritten.
      isolatedSql("alter role velora_media_gateway login password 'postgres'");
      expect(isolatedSql(`begin read only; select message_id || ':' || file_size_bytes || ':' || mime_type from (${RESOLVE_MOVIE_VERSION_SQL.replace("$1", String(published.version_id))}) r; rollback;`, "velora_media_gateway"))
        .toBe(`301:${docs.get(301)!.bytes.length}:video/mp4`);
      // The public profile carries the facts and nothing private: no digest, no Telegram location.
      const profile = JSON.parse(isolatedSql(`select public.movie_media_profile(${published.version_id})`));
      expect(profile).toMatchObject({ container: "mp4", video_codec: "h264", audio_codec: "aac", integrity_status: "verified", streaming_status: "verified", download_status: "original_servable", policy_version: 3 });
      expect(JSON.stringify(profile)).not.toMatch(/sha256|digest|message|chat|file_unique/);
      const after = await read(301);
      expect(status(mediaReport(candidateMedia(after), { enabled: true, published: true }), "Download availability").value).toBe("Switched on");
      expect(page(after, undefined, false)).toContain("Switched off");
    });

    it("original MKV, multiple audio tracks, embedded subtitles and a browser warning: all verify, and a warning changes no gate", async () => {
      for (const [message, container, audio, subtitles, video, browsers, warnings] of [[302, "MKV", "1", "0", "h264", "Limited in some browsers", 1], [303, "MKV", "2", "0", "h264", "Limited in some browsers", 2],
        [304, "MKV", "1", "1", "h264", "Limited in some browsers", 2], [305, "MKV", "1", "0", "hevc", "Limited in some browsers", 2]] as const) {
        expect((await verify(message)).outcome, String(message)).toBe("needs_review");
        const candidate = await read(message);
        const report = mediaReport(candidateMedia(candidate));
        expect([row(report, "Original container"), row(report, "Audio tracks"), row(report, "Subtitle tracks"), row(report, "Video codec"), status(report, "Media integrity").value, status(report, "Streaming readiness").value,
          status(report, "Browser compatibility").value, report.warnings.length], String(message)).toEqual([container, audio, subtitles, video, "Verified", "Verified", browsers, warnings]);
        expect(candidate.evidence!.inspection).toMatchObject({ scope: "whole_file", download: "original_servable", sha256: sha256(docs.get(message)!.bytes) });
        // Compatibility is a warning beside two verified facts; the only gate left is rights.
        expect(candidate.gates, String(message)).toEqual(["rights_clearance_required"]);
        expect(page(candidate), String(message)).toContain("Playback warnings");
      }
      expect(JSON.stringify((await read(303)).evidence)).not.toMatch(/"title"/);
    });

    it("integrity mismatch: a second whole-file read of the same document that hashes differently closes the gate again", async () => {
      // The same post, the same size, one different byte in a text field: both reads decode, and they disagree.
      const changed = Buffer.from(docs.get(302)!.bytes);
      const at = changed.indexOf("Lavf");
      expect(at).toBeGreaterThan(0);
      changed[at + 3] = "g".charCodeAt(0);
      served.set(302, async (offset, length) => changed.subarray(offset, offset + length));
      expect((await verify(302)).outcome).toBe("needs_review");
      served.delete(302);
      const candidate = await read(302);
      expect(candidate.evidence!.inspection!.sha256).toBe(sha256(changed));
      expect(candidate.gates).toEqual(["media_content_conflict", "rights_clearance_required"]);
      expect(Number(isolatedSql(`select count(distinct ev.content_sha256) from private.media_evidence ev join private.telegram_media m on m.id=ev.telegram_media_id where m.message_id=302 and m.chat_id=${CHANNEL}`))).toBe(2);
      const cleared = await reviewer(RIGHTS).clearRights(candidate.id, candidate.revision, "licence CP10-302");
      expect(cleared.gates).toEqual(["media_content_conflict"]);
      expect(await refusal(() => reviewer(REVIEW).approve(cleared.id, cleared.revision))).toBe("review_gates_not_met");
      expect(page(cleared)).toContain("Also blocking: media content conflict");
    });

    it("corrupt media, a document shorter than recorded and an unreadable one are three different outcomes, none of them verified", async () => {
      const source = readFileSync(join(FIXTURES, "mkv-h264-aac.mkv"));
      const corrupt = Buffer.from(source); const middle = Math.floor(corrupt.length / 2); corrupt.fill(0, middle, middle + 20_000);
      await post([doc(311, "Foxtrot Original", corrupt, "mkv"), doc(312, "Golf Original", "mkv-h264-mp3.mkv", "mkv"), doc(313, "Hotel Original", "mp4-h264-mp3-faststart.mp4", "mp4")]);
      // 311: every byte arrives, and the film does not decode.
      const damaged = await verify(311);
      expect(damaged.evidence).toMatchObject({ media_class: "unverified", inspection_scope: "whole_file", assessment: { accepted: false, integrity: "incomplete", streaming: "unverified",
        verification: { integrity: { status: "failed" }, streaming: { status: "not_attempted", samples: [] }, digest: { value: sha256(corrupt) } } } });
      expect(damaged.evidence!.reasons).toEqual(["decode_failed"]);
      const failed = await read(311);
      expect(failed).toMatchObject({ status: "awaiting_media", gates: ["media_verification_required", "rights_clearance_required"] });
      const report = mediaReport(candidateMedia(failed));
      expect([status(report, "Media integrity").value, status(report, "Streaming readiness").value]).toEqual(["Failed", "Failed"]);
      expect(report.reasons[0]).toContain("the file is damaged");
      expect(guidance(failed).label).toBe("Media check failed");
      expect(page(failed).match(/>Failed</g)).toHaveLength(2);

      // 312: the reader stops short of the recorded size. That is recorded as a failed read of this document, with no digest.
      served.set(312, async (offset, length) => docs.get(312)!.bytes.subarray(offset, Math.min(offset + length, 100_000)));
      const short = await verify(312);
      expect(short.evidence).toMatchObject({ media_class: "unverified" });
      expect(short.evidence!.assessment).toBeUndefined();
      expect(["content_size_mismatch", "mkv_tracks_incomplete", "media_unreadable"]).toContain(short.evidence!.reasons[0]);
      expect((await read(312)).evidence!.inspection!.sha256).toBeNull();

      // 313: the reader is down. Nothing is recorded as evidence; the attempt is scheduled again.
      const before = evidenceRows(313);
      served.set(313, async () => { throw Object.assign(new Error("flood_wait"), { name: "GatewayError", code: "flood_wait" }); });
      expect(await verify(313)).toEqual({ outcome: "failed", evidence: null });
      served.delete(313);
      expect(evidenceRows(313)).toBe(before);
      expect(isolatedSql(`select e.status || ':' || e.error_code from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id=e.id where r.discovery_key='${key(313)}'`)).toBe("failed:media_read_flood_wait");
      for (const message of [311, 312, 313]) expect(Number(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id=ev.telegram_media_id where m.message_id=${message} and m.chat_id=${CHANNEL} and private.media_evidence_publishable(ev)`)), String(message)).toBe(0);
    });

    it("missing or invalid container metadata never reaches a whole-file read", async () => {
      const noise = Buffer.alloc(200_000, 7);
      await post([doc(321, "India Original", noise, "mkv")]);
      let reads = 0;
      served.set(321, async (offset, length) => { reads += length; return noise.subarray(offset, offset + length); });
      const result = await verify(321);
      served.delete(321);
      expect(result.evidence).toMatchObject({ method: "bounded_original_v2", inspection_scope: "bounded", media_class: "unverified", reasons: ["container_not_mp4_or_mkv"] });
      expect(reads).toBeLessThan(20_000);
      const report = mediaReport(candidateMedia(await read(321)));
      expect([status(report, "Media integrity").value, row(report, "Original container"), row(report, "Inspection scope")]).toEqual(["Failed", "Not reported", "Bounded sample"]);
    });

    it("streaming-readiness failure: integrity verified, the layout not one the player is tested with, and the gate stays closed", async () => {
      const fragmented = join(work, "fragmented.mp4");
      // A fragmented copy of a synthetic fixture, made here as test data. No product file is ever repackaged.
      const made = await runProcess(tools.ffmpeg.path, ["-hide_banner", "-v", "error", "-nostdin", "-i", join(FIXTURES, "mp4-h264-aac-faststart.mp4"), "-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof", fragmented], { timeoutMs: 60_000, maxStdoutBytes: 65_536 });
      expect(made.code).toBe(0);
      await post([doc(331, "Juliet Original", readFileSync(fragmented), "mp4")]);
      const result = await verify(331);
      expect(result.evidence).toMatchObject({ media_class: "unverified", reasons: ["mp4_fragmented_untested"], assessment: { accepted: false, integrity: "verified", streaming: "unverified",
        verification: { integrity: { status: "verified" }, streaming: { status: "failed", layout: null, samples: [], reasons: ["mp4_fragmented_untested"] } } } });
      const candidate = await read(331);
      const report = mediaReport(candidateMedia(candidate));
      expect([status(report, "Media integrity").value, status(report, "Streaming readiness").value]).toEqual(["Verified", "Failed"]);
      expect(publicationRequirements(candidate).requirements.slice(0, 2).map((item) => item.done)).toEqual([true, false]);
      expect(candidate.gates).toContain("media_verification_required");
      const cleared = await reviewer(RIGHTS).clearRights(candidate.id, candidate.revision, "licence CP10-331");
      expect(await refusal(() => reviewer(REVIEW).approve(cleared.id, cleared.revision))).toBe("review_gates_not_met");
    });

    it("download evidence is its own finding: a document Telegram records as a generic file verifies, publishes like any other and is shown as not downloadable", async () => {
      await post([doc(341, "Kilo Original", "mp4-h264-aac-two-audio.mp4", "mp4", "application/octet-stream")]);
      const result = await verify(341);
      expect(result.evidence).toMatchObject({ media_class: "original", assessment: { accepted: true, integrity: "verified", streaming: "verified", download: "not_servable", verification: { download: { status: "not_servable", reasons: ["download_media_type_mismatch"] } } } });
      const candidate = await read(341);
      expect(candidate.gates).toEqual(["rights_clearance_required"]);
      const report = mediaReport(candidateMedia(candidate), { enabled: true, published: true });
      expect(status(report, "Download availability")).toMatchObject({ value: "Not available", tone: "warning" });
      expect(row(report, "Download evidence")).toBe("The original cannot be served as a download");
      expect(row(report, "Audio tracks")).toBe("2");
    });

    it("the database refuses evidence that is incomplete, inconsistent or about another file, and records none of it", async () => {
      await post([doc(351, "Lima Original", "mp4-h264-aac-subtitles.mp4", "mp4")]);
      const honest = (await whole()({ id: "a".repeat(64), messageKey: key(351), updateId: null, channelId: CHANNEL, messageId: 351, kind: "channel_post", timestamp: 1760100000, digest: "b".repeat(64),
        media: { uniqueId: "AgADcp10x351", size: docs.get(351)!.bytes.length, name: docs.get(351)!.name, mime: "video/mp4", caption: null } })).verification!;
      expect(honest.assessment).toMatchObject({ integrity: "verified", streaming: "verified" });
      const before = evidenceRows(351);
      type Loose = Record<string, unknown> & { verification: Record<string, Record<string, unknown>> };
      const release = () => isolatedSql(`update private.ingestion_events e set status='needs_review' from private.channel_reviews r where r.ingestion_event_id=e.id and r.discovery_key='${key(351)}' and e.status='processing';
        update private.channel_reviews set lease_token=null, lease_until=null where discovery_key='${key(351)}'`);
      const submit = async (change: (assessment: Loose) => void, evidence: (value: ChannelMediaEvidence) => ChannelMediaEvidence = (value) => value) => {
        // A refused record leaves its claim open: give the lease back before the next attempt.
        release();
        const forged = structuredClone(honest) as ChannelMediaEvidence;
        change(forged.assessment as unknown as Loose);
        return refusal(() => persistence().verifyOne(key(351), async () => ({ duplicateOf: null, source: null, evidence: null, verification: evidence(forged) }), () => new Date(), 600));
      };
      // Missing download evidence: the whole record is refused; it is not stored with a default.
      expect(await submit((a) => { delete (a.verification as Record<string, unknown>).download; })).toBe("discovery_invalid_input");
      expect(await submit((a) => { delete (a as Record<string, unknown>).download; })).toBe("discovery_invalid_input");
      // Verified without its evidence, or against it.
      expect(await submit((a) => { delete (a as Record<string, unknown>).verification; })).toBe("discovery_invalid_input");
      expect(await submit((a) => { a.verification.integrity.status = "failed"; a.verification.integrity.reasons = ["decode_failed"]; })).toBe("discovery_invalid_input");
      expect(await submit((a) => { a.verification.integrity.decoded_seconds = 3; })).toBe("discovery_invalid_input");
      expect(await submit((a) => { (a.verification.streaming.samples as { decoded: boolean }[])[1].decoded = false; })).toBe("discovery_invalid_input");
      expect(await submit((a) => { (a.verification.streaming.samples as unknown[]).pop(); })).toBe("discovery_invalid_input");
      expect(await submit((a) => { a.verification.digest.value = "not-a-digest"; })).toBe("discovery_invalid_input");
      // A browser prediction is not streaming evidence: it cannot stand in for the samples.
      expect(await submit((a) => { a.verification.streaming = { ...a.verification.streaming, status: "verified", samples: [], method: "browser_profile" }; })).toBe("discovery_invalid_input");
      // A bounded inspection cannot carry a verification, and fewer bytes read than digested is not a whole-file read.
      expect(await submit(() => {}, (value) => ({ ...value, method: "bounded_original_v2", inspection_scope: "bounded" }))).toBe("discovery_invalid_input");
      expect(await submit(() => {}, (value) => ({ ...value, bytes_read: 1000 }))).toBe("discovery_invalid_input");
      expect(await submit(() => {}, (value) => ({ ...value, playback_ready: true }))).toBe("discovery_invalid_input");
      // Evidence about another size or another document.
      expect(await submit((a) => { a.verification.digest.bytes = docs.get(351)!.bytes.length - 1; })).toBe("discovery_evidence_size_mismatch");
      // Evidence naming another document never leaves the worker: the inspection completes with no evidence at all.
      expect(await submit(() => {}, (value) => ({ ...value, identity: `tg1-${"f".repeat(64)}` }))).toBe("accepted");
      release();
      expect(evidenceRows(351)).toBe(before);
      expect((await read(351)).gates).toContain("media_verification_required");
      expect((await verify(351)).outcome).toBe("needs_review");
      expect((await read(351)).gates).toEqual(["rights_clearance_required"]);
    });

    it("stale evidence: a verification that outlives its claim, or its document, is not recorded", async () => {
      await post([doc(361, "Mike Original", "mp4-h264-ac3-faststart.mp4", "mp4")]);
      const before = evidenceRows(361);
      // The lease is taken over while the file is being read.
      const slow: InspectionPorts["media"] = async (event) => {
        const result = await whole()(event);
        isolatedSql(`update private.channel_reviews set lease_token=gen_random_uuid() where discovery_key='${key(361)}'`);
        return result;
      };
      expect((await persistence().verifyOne(key(361), slow, () => new Date(), 600)).outcome).toBe("stale");
      expect(evidenceRows(361)).toBe(before);
      // The post is edited to another file while the old one is being verified: the evidence names a document that is no longer current.
      isolatedSql(`update private.ingestion_events e set status='needs_review' from private.channel_reviews r where r.ingestion_event_id=e.id and r.discovery_key='${key(361)}';
        update private.channel_reviews set lease_token=null, lease_until=null where discovery_key='${key(361)}'`);
      const replaced: InspectionPorts["media"] = async (event) => {
        const result = await whole()(event);
        return { ...result, verification: { ...result.verification!, identity: channelIdentity({ ...event, media: { ...event.media, uniqueId: "AgADanotherfile" } })! } };
      };
      expect((await persistence().verifyOne(key(361), replaced, () => new Date(), 600)).outcome).toBe("needs_review");
      expect(evidenceRows(361)).toBe(before);
      expect((await read(361)).gates).toContain("media_verification_required");
    });

    it("a verification is claimed by key, only for a confirmed candidate, and by the worker alone", async () => {
      await post([doc(371, "November Original", "mkv-h264-ac3.mkv", "mkv")]);
      const unconfirmed = doc(372, "Oscar Original", "mp4-hevc-aac-faststart.mp4", "mp4");
      docs.set(372, unconfirmed);
      isolatedSql("update private.discovery_cursors set consumer_token=null, consumer_until=null");
      await runReplay(persistence(), replayProvider([{ update_id: 5372, channel_post: { message_id: 372, date: 1760100000, chat: { id: CHANNEL, type: "channel" },
        document: { file_id: "synthetic-bot-file-372", file_unique_id: "AgADcp10x372", file_size: unconfirmed.bytes.length, file_name: unconfirmed.name, mime_type: "video/mp4" }, caption: "Oscar Original (2025)\nVJ Verified" } }]),
      { ...databaseCataloguePorts(service), search: async () => [{ tmdbId: 9930372, mediaType: "movie", title: "Oscar Original", originalTitle: "Oscar Original", year: 2025 }], snapshot: async () => film(9930372, "Oscar Original"), media: bounded() },
      { now: () => new Date(), signal: new AbortController().signal, paceMs: 0 });
      expect(await refusal(() => verify(372))).toBe("discovery_verification_not_claimable");
      expect(await refusal(() => persistence().verifyOne("0".repeat(64), whole(), () => new Date(), 600))).toBe("discovery_not_found");
      expect(await refusal(() => persistence().verifyOne(key(371), whole(), () => new Date(), 30))).toBe("discovery_invalid_input");
      for (const claims of [{ role: "anon" }, session(REVIEW), session(PUBLISH)]) {
        const reply = await rpcAs(claims)("discovery_claim_verification", { p_key: key(371), p_lease_seconds: 600 });
        expect(reply.error?.code, JSON.stringify(claims)).toBe("42501");
      }
      // The named candidate is the one verified; the published one cannot be claimed again.
      const attempts = isolatedSql(`select e.attempt_count from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id=e.id where r.discovery_key='${key(371)}'`);
      expect((await verify(371)).outcome).toBe("needs_review");
      expect(isolatedSql(`select e.attempt_count from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id=e.id where r.discovery_key='${key(371)}'`)).toBe(attempts);
      expect((await read(371)).evidence!.facts).toMatchObject({ integrity: "verified", streaming: "verified" });
      expect(await refusal(() => verify(301))).toBe("discovery_verification_not_claimable");
      // Nothing was left in the spool, and the reviewer's choice is unchanged.
      expect(isolatedSql(`select r.identity_state || ':' || r.tmdb_id from private.channel_reviews r where r.discovery_key='${key(371)}'`)).toBe("confirmed:9930371");
    });
  });

  describe("upload path (R2 staging), up to the Telegram boundary", () => {
    const upload = createUploadClient(rpcAs(session(OWNER)));
    const worker = (statement: string) => isolatedSql(statement, "velora_upload_worker");
    /** A session whose bytes were received and hashed (the transfer and verify steps, which need R2, are stated as done). */
    async function staged(name: string, bytes: Buffer) {
      const created = await upload.createR2({ fileName: name, sizeBytes: bytes.length }, randomUUID(), 7);
      const fileKey = randomUUID();
      await upload.edit(created.id, created.revision, { kind: "movie", title: "Uploaded Original", year: 2025, vjId, snapshot: null, season: null, episode: null, provenance: "Synthetic fixture, made for this test." });
      isolatedSql(`update private.admin_upload_sessions set stage='uploaded', bytes_received=${bytes.length}, verified_sha256='${sha256(bytes)}', verified_file_key='${fileKey}',
        source_fingerprint='sf1-${sha256(Buffer.from(name))}' where id='${created.id}'`);
      const path = verifiedUploadPath(join(work, "staging"), created.id, fileKey, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return created.id;
    }
    /** The real inspection of the upload worker, claimed and finished through the worker's own RPCs. */
    async function inspect(id: string) {
      const token = randomUUID();
      const claim = JSON.parse(worker(`select public.admin_upload_r2_worker_claim('${token}', array['inspect'])`));
      expect(claim).toMatchObject({ operation: "inspect", session: { id } });
      await inspectAdminUpload(join(work, "staging"), {
        claim: async () => ({ manifest: { session: claim.session, chunks: [] }, token, operation: "inspect", verified_file_key: claim.file_key, vjs: claim.vjs }),
        finish: async (sessionId, lease, result) => worker(`select public.admin_upload_r2_worker_finish('${sessionId}', '${lease}', 'inspect', $json$${JSON.stringify(result)}$json$::jsonb)`),
      });
      return upload.get(id);
    }
    const edit = async (id: string) => {
      const current = await upload.get(id);
      return upload.edit(id, current.revision, { ...current.metadata, snapshot: film(UPLOAD_TMDB, "Uploaded Original") });
    };

    beforeAll(() => { mkdirSync(join(work, "staging"), { recursive: true }); });

    it("a staged MKV original is verified whole by the real worker inspection, and only then can it be submitted", async () => {
      const bytes = readFileSync(join(FIXTURES, "mkv-h264-aac-two-audio.mkv"));
      const id = await staged("Uploaded.Original.2025.VJ.Verified.mkv", bytes);
      const inspected = await inspect(id);
      expect(inspected).toMatchObject({ stage: "metadata_review", pipeline: { media_verified: true, rights_cleared: false, approved: false, stored: false } });
      const evidence = JSON.parse(isolatedSql(`select to_jsonb(x) from (select policy_version, container, video_codec, audio_codec, integrity_status, streaming_status, download_status, content_sha256, verified_sha256, error_code
        from private.admin_upload_media_evidence where upload_id='${id}' order by id desc limit 1) x`));
      expect(evidence).toEqual({ policy_version: 3, container: "mkv", video_codec: "h264", audio_codec: "aac", integrity_status: "verified", streaming_status: "verified", download_status: "original_servable",
        content_sha256: sha256(bytes), verified_sha256: sha256(bytes), error_code: null });
      // The page's panel, from the session the owner reads back.
      const facts = uploadMedia(inspected);
      expect(facts).toMatchObject({ container: "mkv", video: "h264", audio: "aac", inspection: { scope: "whole_file", download: "original_servable", sha256: sha256(bytes) }, policy3: { integrity: "verified", streaming: "verified", audioTracks: 2, subtitleTracks: 0 } });
      const html = renderToStaticMarkup(<MediaVerification report={mediaReport(facts, { enabled: false, published: false })} />);
      for (const text of ["Whole file", sha256(bytes), "Limited in some browsers", "plays only the default one", "The original can be served as it is"]) expect(html, text).toContain(text);
      expect(html.match(/>Verified</g)).toHaveLength(2);
      // The staged file was only read.
      const stagedPath = isolatedSql(`select verified_file_key from private.admin_upload_sessions where id='${id}'`);
      expect(sha256(readFileSync(verifiedUploadPath(join(work, "staging"), id, stagedPath, "Uploaded.Original.2025.VJ.Verified.mkv")))).toBe(sha256(bytes));

      // Verified media alone is not publication: identity, rights and approval are still separate steps.
      expect(await refusal(async () => upload.review(id, inspected.revision, "approve"))).toBe("upload_illegal_transition");
      const chosen = await edit(id);
      const submitted = await upload.review(id, chosen.revision, "submit");
      expect(submitted.stage).toBe("awaiting_rights");
      expect(await refusal(async () => upload.review(id, submitted.revision, "approve"))).toBe("upload_illegal_transition");
      const cleared = await upload.review(id, submitted.revision, "clear_rights", "licence CP10-UP1", new Date(Date.now() + 86_400_000).toISOString());
      expect(cleared.stage).toBe("awaiting_approval");
      expect((await upload.get(id)).pipeline).toMatchObject({ media_verified: true, rights_cleared: true, approved: false });
      const approved = await upload.review(id, cleared.revision, "approve");
      expect(approved.stage).toBe("approved");
      expect((await upload.get(id)).pipeline).toMatchObject({ media_verified: true, rights_cleared: true, approved: true, stored: false, publication_slug: null });
      // The boundary. The next step is the worker's transfer to Telegram, which this test does not make: nothing is published.
      expect(isolatedSql(`select count(*) from public.movies where tmdb_id=${UPLOAD_TMDB}`)).toBe("0");
      expect(isolatedSql(`select count(*) from private.ingestion_events where origin='uploader' and source_fingerprint=(select source_fingerprint from private.admin_upload_sessions where id='${id}')`)).toBe("0");
    });

    it("a truncated upload is refused by the same inspection, and cannot be submitted, cleared or approved into publication", async () => {
      const source = readFileSync(join(FIXTURES, "mkv-h264-aac.mkv"));
      const truncated = source.subarray(0, 150_000);
      const id = await staged("Truncated.Original.2025.VJ.Verified.mkv", Buffer.from(truncated));
      const inspected = await inspect(id);
      expect(inspected).toMatchObject({ stage: "metadata_review", pipeline: { media_verified: false } });
      expect(inspected.inspection!.classification).toMatchObject({ class: "manual_review", policyVersion: 3 });
      expect(["decode_failed", "content_truncated"]).toContain(inspected.inspection!.classification.reasons[0]);
      const report = mediaReport(uploadMedia(inspected), { enabled: false, published: false });
      expect([status(report, "Media integrity").value, status(report, "Streaming readiness").value]).toEqual(["Failed", "Failed"]);
      const chosen = await edit(id);
      expect(await refusal(async () => upload.review(id, chosen.revision, "submit"))).toBe("upload_review_blocked");
      expect(isolatedSql(`select private.admin_upload_media_publishable('${id}') or private.admin_upload_r2_eligible('${id}')`)).toBe("f");
    });

    it("the database refuses a verification about another file: a digest or a size that is not this session's", async () => {
      const bytes = readFileSync(join(FIXTURES, "mp4-h264-aac-moov-at-end.mp4"));
      const id = await staged("Mismatch.Original.2025.VJ.Verified.mp4", bytes);
      const token = randomUUID();
      const claim = JSON.parse(worker(`select public.admin_upload_r2_worker_claim('${token}', array['inspect'])`));
      let honest: Record<string, unknown> | null = null;
      await inspectAdminUpload(join(work, "staging"), {
        claim: async () => ({ manifest: { session: claim.session, chunks: [] }, token, operation: "inspect", verified_file_key: claim.file_key, vjs: claim.vjs }),
        finish: async (_id, _lease, result) => { honest ??= result; return "metadata_review"; },
      });
      const inspection = (honest as unknown as { inspection: { assessment: { streaming: string; verification: { digest: { value: string; bytes: number }; streaming: { layout: string } } } } }).inspection;
      // A tail-index MP4 is streamable: verified, with its layout recorded.
      expect(inspection.assessment).toMatchObject({ streaming: "verified", verification: { streaming: { layout: "mp4_tail_index" } } });
      const finish = (changed: unknown) => { try { return worker(`select public.admin_upload_r2_worker_finish('${id}', '${token}', 'inspect', $json$${JSON.stringify({ outcome: "inspected", inspection: changed })}$json$::jsonb)`); } catch (error) { return String((error as Error).message).split("\n")[0]; } };
      const forged = structuredClone(inspection);
      forged.assessment.verification.digest.value = "c".repeat(64);
      expect(finish(forged)).toContain("upload_invalid_result");
      const shorter = structuredClone(inspection);
      shorter.assessment.verification.digest.bytes = bytes.length - 1;
      expect(finish(shorter)).toContain("upload_invalid_result");
      expect(isolatedSql(`select count(*) from private.admin_upload_media_evidence where upload_id='${id}'`)).toBe("0");
      expect(finish(inspection)).toBe("metadata_review");
      expect(isolatedSql(`select private.admin_upload_media_publishable('${id}')`)).toBe("t");
      // The file changes after it was verified (a new verified digest for the session): the old evidence no longer counts.
      isolatedSql(`update private.admin_upload_sessions set verified_sha256='${"d".repeat(64)}' where id='${id}'`);
      expect(isolatedSql(`select private.admin_upload_media_publishable('${id}')`)).toBe("f");
    });
  });
});
