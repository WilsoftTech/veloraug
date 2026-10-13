/** The admin media dashboard's data path against real SQL, disposable tmpfs database only.
 * node --experimental-transform-types --import ./scripts/ingest/register.mjs scripts/checkpoint9-validation.mts
 * (needs VELORA_FFPROBE_PATH and VELORA_FFMPEG_PATH: the committed fixtures are inspected for real).
 *
 * Two schemas, each built from scratch: the recorded hosted set of 17 migrations,
 * where the Policy 3 columns and functions do not exist, and the repository's 26.
 * In both, synthetic channel posts go through the real worker and reviewer RPCs
 * over PostgREST, and the page's own modules turn the reviewer's view into what
 * the dashboard shows. Nothing is rendered here: the markup is covered by
 * components/discovery-review.test.tsx. No operational configuration is read.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { up, down, psql, isolatedJwt, ISOLATED } from "./isolated-db.mjs";
import { channelIdentity } from "@/lib/discovery/events";
import { createReviewClient, databaseCataloguePorts, databasePersistence, DiscoveryStoreError, type DiscoveryRpc } from "@/lib/discovery/database";
import { guidance, verificationPending } from "@/lib/discovery/guidance";
import { candidateMedia, mediaReport, publicationRequirements } from "@/lib/discovery/media-report";
import { verifyChannelMedia, type ChannelMediaEvidence } from "@/lib/discovery/media-verification";
import type { InspectionPorts } from "@/lib/discovery/pipeline";
import { replayProvider, runReplay } from "@/lib/discovery/worker";
import { headProbe, resolveMediaTools } from "@/lib/uploader/media-tools";

const CHANNEL = -1007776665556;
const REVIEW = "00000000-0000-4000-8000-0000000009a1", RIGHTS = "00000000-0000-4000-8000-0000000009a2", PUBLISH = "00000000-0000-4000-8000-0000000009a3", NOBODY = "00000000-0000-4000-8000-0000000009a4";
const POLICY3 = ["20261011192618_original_media_evidence.sql", "20261011192619_admin_original_media_evidence.sql"];
const NOT_ON_HOSTED = ["20261011083200_admin_upload_sessions.sql", "20261011084309_admin_upload_disk_chunks.sql", "20261011085220_admin_upload_inspection.sql", "20261011093300_admin_upload_r2_staging.sql",
  "20261011094004_admin_upload_r2_worker.sql", "20261011095632_admin_upload_r2_visibility.sql", ...POLICY3, "20261011200813_original_media_download_resolver.sql"];
const REST = `http://127.0.0.1:${ISOLATED.restPort}`;

const sql = (statement: string) => { const result = psql(statement); assert.equal(result.code, 0, result.err); return result.out.trim(); };
// supabase-js addresses PostgREST as <url>/rest/v1/...; the disposable one serves at its root. Any other destination is refused.
const isolatedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== REST || !url.pathname.startsWith("/rest/v1/")) throw new Error("non_isolated_request_forbidden");
  return fetch(`${REST}/${url.pathname.slice("/rest/v1/".length)}${url.search}`, init);
}) as typeof fetch;
const rpcAs = (claims: Record<string, unknown>): DiscoveryRpc => {
  const client = createClient(REST, isolatedJwt(claims), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: isolatedFetch } });
  return (fn, args) => client.rpc(fn, args) as unknown as ReturnType<DiscoveryRpc>;
};
/** The second database reuses the first one's address: wait until a new connection answers, past any kept from the container before. */
async function reachable() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const answered = await fetch(`${REST}/`).then((response) => response.ok, () => false);
    if (answered) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("isolated PostgREST did not answer");
}
const reviewer = (sub: string) => createReviewClient(rpcAs({ role: "authenticated", sub, aud: "authenticated", is_anonymous: false }));
const refusal = async (run: () => Promise<unknown>) => { try { await run(); return "accepted"; } catch (error) { return error instanceof DiscoveryStoreError ? error.code : "other"; } };
const film = (tmdb: number, title: string) => ({ tmdb_id: tmdb, title, original_title: title, overview: "A synthetic film.", release_date: "2025-03-01", runtime_minutes: 101, poster_path: null, backdrop_path: null, vote_average: 7, vote_count: 10, genres: [] });
const key = (message: number) => sql(`select private.discovery_message_key(${CHANNEL}, ${message})`);
const status = (report: ReturnType<typeof mediaReport>, label: string) => report.statuses.find((item) => item.label === label)!.value;
const detail = (report: ReturnType<typeof mediaReport>, label: string) => report.details.find((item) => item.label === label)!.value;

interface Post { message: number; tmdb: number; title: string; file: string; fixture?: string; size: number; evidence(identity: string): Promise<ChannelMediaEvidence> }
function setup() {
  sql(`insert into private.telegram_channels (bot_type, chat_id, checkpoint_message_id) values ('movie', ${CHANNEL}, 1);
    insert into private.discovery_cursors (bot_type) values ('movie') on conflict do nothing;
    insert into public.vjs (slug, name, is_active) values ('vj-cp9', 'VJ Checkpoint', true);
    insert into auth.users (id, aud, role, email) values ('${REVIEW}', 'authenticated', 'authenticated', 'r@cp9.invalid'), ('${RIGHTS}', 'authenticated', 'authenticated', 'g@cp9.invalid'),
      ('${PUBLISH}', 'authenticated', 'authenticated', 'p@cp9.invalid'), ('${NOBODY}', 'authenticated', 'authenticated', 'n@cp9.invalid');
    insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values ('${REVIEW}', true, false, false), ('${RIGHTS}', false, true, false), ('${PUBLISH}', false, false, true);`);
}
/** Posts each file to the synthetic channel and inspects it with the real worker, then confirms film and VJ as a reviewer. */
async function ingest(posts: readonly Post[]) {
  const service = rpcAs({ role: "service_role" });
  const byName = new Map(posts.map((post) => [post.file, post]));
  const ports: InspectionPorts = {
    ...databaseCataloguePorts(service),
    async search(query) { const post = posts.find((item) => item.title === query.title)!; return [{ tmdbId: post.tmdb, mediaType: "movie", title: post.title, originalTitle: post.title, year: 2025 }]; },
    async snapshot(id) { const post = posts.find((item) => item.tmdb === id); return post ? film(post.tmdb, post.title) : null; },
    async media(event) { return { duplicateOf: null, source: null, evidence: null, verification: await byName.get(event.media.name!)!.evidence(channelIdentity(event)!) }; },
  };
  const updates = posts.map((post, index) => ({ update_id: 900 + index, channel_post: { message_id: post.message, date: 1760100000, chat: { id: CHANNEL, type: "channel" },
    document: { file_id: `synthetic-bot-file-${post.message}`, file_unique_id: `AgADcp9x${post.message}`, file_size: post.size, file_name: post.file, mime_type: post.file.endsWith(".mkv") ? "video/x-matroska" : "video/mp4" },
    caption: `${post.title} (2025)\nVJ Checkpoint` } }));
  const metrics = await runReplay(databasePersistence(service, { channelId: CHANNEL }), replayProvider(updates), ports, { now: () => new Date(), signal: new AbortController().signal, paceMs: 0 });
  assert.equal(metrics.failures, 0); assert.equal(metrics.candidates, posts.length);
  const vjId = Number(sql("select id from public.vjs where slug = 'vj-cp9'"));
  for (const post of posts) {
    const found = (await reviewer(REVIEW).get(key(post.message)))!;
    await reviewer(REVIEW).correct(found.candidate.id, found.candidate.revision, { tmdbId: post.tmdb, year: 2025, vjId });
  }
}
const read = async (message: number) => (await reviewer(REVIEW).get(key(message)))!.candidate;
/** Nothing of the bot's file handle belongs in what the page is given. */
const leaks = (candidate: unknown) => JSON.stringify(candidate).includes("synthetic-bot-file");

try {
  assert.equal(readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).length, 26);
  const tools = await resolveMediaTools();
  assert.ok(tools.ok, "VELORA_FFPROBE_PATH and VELORA_FFMPEG_PATH are required: the fixtures are inspected for real");

  // 1. The recorded hosted schema (17 migrations): no Policy 3 column or function exists.
  up({ rest: true, excludeMigrations: NOT_ON_HOSTED });
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='private' and table_name='media_evidence' and column_name in ('assessment','integrity_status','streaming_status')"), "0");
  assert.equal(sql("select to_regprocedure('public.movie_media_profile(bigint)') is null and to_regprocedure('private.media_evidence_publishable(private.media_evidence)') is null"), "t");
  setup();
  const earlier = (extra: Partial<ChannelMediaEvidence>) => async (identity: string): Promise<ChannelMediaEvidence> => ({ identity, method: "bounded_mtproto_v1", policy_version: 2, media_class: "canonical", reasons: [],
    container: "mp4", video_codec: "h264", audio_codec: "aac", accessible: true, gateway_compatible: true, playback_ready: true, bytes_read: 4096, ...extra });
  await ingest([
    { message: 101, tmdb: 9910101, title: "Earlier Passed Film", file: "Earlier.Passed.Film.2025.VJ.Checkpoint.mp4", size: 1_000_000, evidence: earlier({}) },
    { message: 102, tmdb: 9910102, title: "Earlier Refused Film", file: "Earlier.Refused.Film.2025.VJ.Checkpoint.mp4", size: 1_000_001, evidence: earlier({ media_class: "unverified", reasons: ["mp4_not_fast_start"], playback_ready: false, bytes_read: 64 }) },
  ]);
  assert.deepEqual(await reviewer(REVIEW).capabilities(), { review: true, rights: false, publish: false });
  const passed = await read(101), refused = await read(102);
  for (const candidate of [passed, refused]) { assert.equal(candidate.evidence!.facts, undefined); assert.equal(candidate.evidence!.policyVersion, 2); assert.equal(leaks(candidate), false); }
  const passedReport = mediaReport(candidateMedia(passed), { enabled: false, published: false }), refusedReport = mediaReport(candidateMedia(refused), { enabled: false, published: false });
  assert.deepEqual(passedReport.statuses.map((item) => item.value), ["Not reported", "Verified by the earlier MP4 policy", "Not reported", "Switched off"]);
  assert.deepEqual(refusedReport.statuses.map((item) => item.value), ["Not reported", "Failed", "Not reported", "Switched off"]);
  assert.deepEqual([detail(passedReport, "Original container"), detail(passedReport, "Video codec"), detail(passedReport, "Audio codec"), detail(passedReport, "Audio tracks"), detail(passedReport, "Subtitle tracks"), detail(passedReport, "Inspection policy")],
    ["MP4", "h264", "aac", "Not reported", "Not reported", "Version 2"]);
  assert.match(refusedReport.reasons[0], /index at the end/);
  assert.deepEqual(passed.gates, ["rights_clearance_required"]); assert.deepEqual(refused.gates, ["media_verification_required", "rights_clearance_required"]);
  assert.deepEqual(publicationRequirements(passed).requirements.map((item) => item.done), [true, true, true, true, false, false]);
  assert.deepEqual(publicationRequirements(refused).requirements.map((item) => item.done), [false, false, true, true, false, false]);
  console.log("hosted-equivalent 17: reviewer view parsed with no Policy 3 field; earlier facts shown, the rest reported as missing; refused file shown as failed");

  // Authorization on that schema is unchanged: review, rights and publication stay separate accounts.
  assert.equal(await refusal(() => createReviewClient(rpcAs({ role: "anon" })).get(passed.id)), "review_not_authorized");
  assert.equal(await refusal(() => reviewer(NOBODY).get(passed.id)), "review_not_authorized");
  assert.equal(await refusal(() => reviewer(REVIEW).approve(passed.id, passed.revision)), "review_gates_not_met");
  assert.equal(await refusal(() => reviewer(REVIEW).clearRights(passed.id, passed.revision, "licence CP9-1")), "review_not_authorized");
  const cleared = await reviewer(RIGHTS).clearRights(passed.id, passed.revision, "licence CP9-1");
  assert.deepEqual(cleared.gates, []);
  assert.equal(await refusal(() => reviewer(PUBLISH).publish(cleared.id, cleared.revision)), "catalogue_not_approved");
  assert.equal(await refusal(() => reviewer(PUBLISH).approve(cleared.id, cleared.revision)), "review_not_authorized");
  const approved = await reviewer(REVIEW).approve(cleared.id, cleared.revision);
  assert.deepEqual(publicationRequirements(approved).requirements.map((item) => item.done), [true, true, true, true, true, true]);
  assert.equal(await refusal(() => reviewer(REVIEW).publish(approved.id, approved.revision)), "review_not_authorized");
  assert.equal((await reviewer(PUBLISH).publish(approved.id, approved.revision)).result, "published");
  const published = await read(101);
  assert.equal(published.status, "published");
  assert.equal(status(mediaReport(candidateMedia(published), { enabled: true, published: true }), "Download availability"), "Switched on");
  // The refused file cannot be approved or published by anyone, with rights or without.
  const refusedCleared = await reviewer(RIGHTS).clearRights(refused.id, refused.revision, "licence CP9-2");
  assert.deepEqual(refusedCleared.gates, ["media_verification_required"]);
  assert.equal(await refusal(() => reviewer(REVIEW).approve(refusedCleared.id, refusedCleared.revision)), "review_gates_not_met");
  assert.equal(await refusal(() => reviewer(PUBLISH).publish(refusedCleared.id, refusedCleared.revision)), "catalogue_not_approved");
  assert.equal(sql("select count(*) from public.movies where publication_status='published' and tmdb_id in (9910101,9910102)"), "1");
  console.log("hosted-equivalent 17: anonymous, non-reviewer, review-only, rights-only and publish-only accounts each refused outside their capability; the earlier publication path works; the refused file cannot be approved");

  // 2. The repository's 26 migrations: real Policy 3 inspections of the committed fixtures.
  up({ rest: true });
  await reachable();
  setup();
  const manifest = JSON.parse(readFileSync("tests/browser/fixtures/manifest.json", "utf8")) as { fixtures: { file: string; sizeBytes: number }[] };
  const fixtures = ["mp4-h264-aac-faststart.mp4", "mp4-h264-aac-moov-at-end.mp4", "mkv-h264-aac-two-audio.mkv", "mkv-h264-aac-subtitles.mkv", "mkv-h264-ac3.mkv", "mkv-hevc-aac.mkv"];
  // Each fixture is posted under an ordinary release name; its bytes and its extension are the fixture's own.
  const posts: Post[] = fixtures.map((fixture, index) => {
    const bytes = readFileSync(`tests/browser/fixtures/${fixture}`), letter = String.fromCharCode(65 + index);
    assert.equal(bytes.length, manifest.fixtures.find((item) => item.file === fixture)!.sizeBytes);
    return { message: 201 + index, tmdb: 9920201 + index, title: `Original Film ${letter}`, fixture, file: `Original.Film.${letter}.2025.VJ.Checkpoint.${fixture.split(".").pop()}`, size: bytes.length,
      evidence: (identity) => verifyChannelMedia({ identity, sizeBytes: bytes.length }, { read: async (offset, length) => bytes.subarray(offset, offset + length), probe: headProbe(tools.tools.ffprobe), gatewayCompatible: true }) };
  });
  await ingest(posts);
  const expected: Record<string, { container: string; video: string; audio: string; audioTracks: string; subtitles: string; streaming: string; browsers: string; warnings: RegExp[] }> = {
    "mp4-h264-aac-faststart.mp4": { container: "MP4", video: "h264", audio: "aac", audioTracks: "1", subtitles: "0", streaming: "Potentially playable, not verified", browsers: "Tested combination on desktop", warnings: [] },
    "mp4-h264-aac-moov-at-end.mp4": { container: "MP4", video: "h264", audio: "aac", audioTracks: "1", subtitles: "0", streaming: "Potentially playable, slow start, not verified", browsers: "Tested combination on desktop", warnings: [/index at the end/] },
    "mkv-h264-aac-two-audio.mkv": { container: "MKV", video: "h264", audio: "aac", audioTracks: "2", subtitles: "0", streaming: "Potentially playable, not verified", browsers: "Limited in some browsers", warnings: [/Firefox/, /default one/] },
    "mkv-h264-aac-subtitles.mkv": { container: "MKV", video: "h264", audio: "aac", audioTracks: "1", subtitles: "1", streaming: "Potentially playable, not verified", browsers: "Limited in some browsers", warnings: [/Firefox/, /subtitles/] },
    "mkv-h264-ac3.mkv": { container: "MKV", video: "h264", audio: "ac3", audioTracks: "1", subtitles: "0", streaming: "Potentially playable, not verified", browsers: "Limited in some browsers", warnings: [/Firefox/, /AC-3/] },
    "mkv-hevc-aac.mkv": { container: "MKV", video: "hevc", audio: "aac", audioTracks: "1", subtitles: "0", streaming: "Potentially playable, not verified", browsers: "Limited in some browsers", warnings: [/Firefox/, /HEVC/] },
  };
  for (const post of posts) {
    const candidate = await read(post.message), want = expected[post.fixture!];
    assert.equal(candidate.status, "awaiting_media", post.file); assert.equal(leaks(candidate), false, post.file);
    assert.ok(candidate.evidence?.facts, post.file); assert.equal(candidate.evidence!.policyVersion, 3); assert.equal(candidate.evidence!.facts!.publishable, false);
    const report = mediaReport(candidateMedia(candidate), { enabled: false, published: false });
    assert.deepEqual([detail(report, "Original container"), detail(report, "Original filename"), detail(report, "Video codec"), detail(report, "Audio codec"), detail(report, "Audio tracks"), detail(report, "Subtitle tracks"), detail(report, "Inspection policy")],
      [want.container, post.file, want.video, want.audio, want.audioTracks, want.subtitles, "Version 3"], post.file);
    assert.deepEqual(report.statuses.map((item) => item.value), ["Metadata consistent, not verified", want.streaming, want.browsers, "Switched off"], post.file);
    assert.equal(report.warnings.length, want.warnings.length, `${post.file}: ${report.warnings.join(" | ")}`);
    for (const pattern of want.warnings) assert.ok(report.warnings.some((warning) => pattern.test(warning)), `${post.file}: ${pattern}`);
    assert.deepEqual(report.reasons, []); assert.equal(report.browsers.length, 5);
    // Recorded, not verified: the media gate is closed, and the screen says pending rather than failed.
    assert.deepEqual(candidate.gates, ["media_verification_required", "rights_clearance_required"], post.file);
    assert.deepEqual(publicationRequirements(candidate).requirements.map((item) => item.done), [false, false, true, true, false, false], post.file);
    assert.equal(verificationPending(candidate), true); assert.equal(guidance(candidate).label, "Verification pending");
    console.log(`${post.fixture}: ${want.container}, ${want.video}/${want.audio}, ${want.audioTracks} audio, ${want.subtitles} subtitle; ${report.statuses.slice(0, 3).map((item) => item.value).join("; ")}; ${report.warnings.length} playback warning(s); media gate closed`);
  }
  // No browser warning opens or closes anything: with rights recorded, the only gate left is the media gate, for every file alike.
  for (const post of posts) {
    const candidate = await read(post.message);
    const cleared3 = await reviewer(RIGHTS).clearRights(candidate.id, candidate.revision, `licence CP9-${post.message}`);
    assert.deepEqual(cleared3.gates, ["media_verification_required"], post.file);
    assert.equal(await refusal(() => reviewer(REVIEW).approve(cleared3.id, cleared3.revision)), "review_gates_not_met", post.file);
    assert.equal(await refusal(() => reviewer(PUBLISH).publish(cleared3.id, cleared3.revision)), "catalogue_not_approved", post.file);
  }
  assert.equal(sql("select count(*) from public.movies where tmdb_id between 9920201 and 9920206"), "0");
  assert.equal(sql("select count(*) from private.media_evidence where policy_version=3 and (verified or integrity_status='verified' or streaming_status='verified')"), "0");
  assert.equal(await refusal(() => createReviewClient(rpcAs({ role: "anon" })).get(key(201))), "review_not_authorized");
  assert.equal(await refusal(() => reviewer(NOBODY).list()), "review_not_authorized");
  console.log(`repository 26: ${posts.length} originals inspected for real; Policy 3 facts reach the reviewer view; none is verified, none can be approved or published, and no dashboard value changed that`);
} finally { down(); }
