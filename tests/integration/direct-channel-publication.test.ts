import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelIdentity, detectDocument } from "@/lib/discovery/events";
import { createReviewClient, databaseCataloguePorts, databasePersistence, type DiscoveryRpc } from "@/lib/discovery/database";
import { verifyChannelMedia } from "@/lib/discovery/media-verification";
import { approvalCommand, publicationCommand, publicationState } from "@/lib/discovery/owner-commands";
import { probeOf, virtualMp4 } from "@/lib/discovery/synthetic-media";
import { reconcile, replayProvider, runReplay } from "@/lib/discovery/worker";
import type { InspectionPorts } from "@/lib/discovery/pipeline";
import { getMovie, getVj, isMovieVersionPlayable, listMovies, listVjs, searchCatalogue } from "@/lib/catalogue";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import { issueStreamCapability, streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { RESOLVE_MOVIE_VERSION_SQL } from "@/lib/media-gateway/resolver-sql";
import type { MovieSnapshot } from "@/lib/tmdb/ingestion-search";
import { ISOLATED_REST, isolatedJwt, isolatedSql } from "./isolated-env";

/**
 * E3.8A end to end, isolated: a document posted directly to the Movies channel
 * becomes a published, playable catalogue title only through detection,
 * bounded verification, review, explicit rights, approval and publication.
 *
 * Real modules throughout (worker, persistence, verifier, reviewer client,
 * owner commands, lib/catalogue, entitlement and capability issuing) over the
 * real migrations, PostgREST and psql of the disposable database. Synthetic
 * Telegram updates, TMDB metadata and media bytes only: no Telegram, TMDB or
 * hosted request can leave this process (tests/integration/discovery-isolated-fetch.ts).
 */

const CHANNEL = -1004242424242;
const REVIEW = "00000000-0000-4000-8000-00000000e3a1";
const RIGHTS = "00000000-0000-4000-8000-00000000e3a2";
const PUBLISH = "00000000-0000-4000-8000-00000000e3a3";
const NOBODY = "00000000-0000-4000-8000-00000000e3a4";
const TMDB = 9810001;
const SIZE = 1_004_462_878;
const FILM: MovieSnapshot = { tmdb_id: TMDB, title: "Direct Channel Film", original_title: "Direct Channel Film", overview: "A synthetic film posted directly to the channel.",
  release_date: "2025-03-01", runtime_minutes: 101, poster_path: null, backdrop_path: null, vote_average: 7.2, vote_count: 42, genres: [{ tmdb_id: 18, name: "Drama" }] };

const rpcAs = (claims: Record<string, unknown>): DiscoveryRpc => {
  const client = createClient(ISOLATED_REST, isolatedJwt(claims), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return (fn, args) => client.rpc(fn, args) as unknown as ReturnType<DiscoveryRpc>;
};
const service = rpcAs({ role: "service_role" });
const reviewer = (sub: string) => createReviewClient(rpcAs({ role: "authenticated", sub, aud: "authenticated", is_anonymous: false }));
const post = (update: number, message: number, unique: string, options: { edited?: boolean; size?: number } = {}) => ({
  update_id: update, [options.edited ? "edited_channel_post" : "channel_post"]: {
    message_id: message, date: 1760100000, ...(options.edited ? { edit_date: 1760100000 + update } : {}), chat: { id: CHANNEL, type: "channel" },
    document: { file_id: `synthetic-bot-file-${message}`, file_unique_id: unique, file_size: options.size ?? SIZE, file_name: "Direct.Channel.Film.2025.VJ.Direct.mp4", mime_type: "video/mp4" },
    caption: "Direct Channel Film (2025)\nVJ Direct" } });

let tmdbSearches = 0;
let verifications = 0;
const ports: InspectionPorts = {
  ...databaseCataloguePorts(service),
  async search() { tmdbSearches++; return [{ tmdbId: TMDB, mediaType: "movie", title: FILM.title, originalTitle: FILM.original_title, year: 2025 }]; },
  async snapshot(id) { return id === TMDB ? FILM : null; },
  // Bounded verification of the exact document over a byte reader (the gateway's MediaReader in production).
  async media(event) {
    verifications++;
    const identity = channelIdentity(event)!;
    const file = virtualMp4({ size: event.media.size! });
    const verification = await verifyChannelMedia({ identity, sizeBytes: event.media.size! }, { read: file.read, probe: async (head) => probeOf(undefined, head.length), gatewayCompatible: true });
    return { duplicateOf: null, source: null, evidence: null, verification };
  },
};
const options = () => ({ now: () => new Date(), signal: new AbortController().signal, paceMs: 0 });
const key = (message: number) => isolatedSql(`select private.discovery_message_key(${CHANNEL}, ${message})`);
const owner = (statement: string) => isolatedSql(statement, "velora_review_service");
const refused = (run: () => unknown) => { try { run(); return "accepted"; } catch (error) { return String((error as Error).message); } };
let before = "";

describe.skipIf(process.env.VELORA_E38_ISOLATED_TESTS !== "true" || process.env.NEXT_PUBLIC_SUPABASE_URL !== ISOLATED_REST)("E3.8A direct channel publication (isolated)", () => {
  beforeAll(() => {
    isolatedSql(`
      delete from private.discovery_cursors where bot_type = 'movie';
      delete from private.telegram_channels where bot_type = 'movie';
      insert into private.telegram_channels (bot_type, chat_id, checkpoint_message_id) values ('movie', ${CHANNEL}, 1);
      insert into private.discovery_cursors (bot_type) values ('movie');
      insert into public.vjs (slug, name, is_active) values ('vj-direct', 'VJ Direct', true);
      insert into auth.users (id, aud, role, email) values ('${REVIEW}', 'authenticated', 'authenticated', 'r@e38a.invalid'),
        ('${RIGHTS}', 'authenticated', 'authenticated', 'g@e38a.invalid'), ('${PUBLISH}', 'authenticated', 'authenticated', 'p@e38a.invalid'),
        ('${NOBODY}', 'authenticated', 'authenticated', 'n@e38a.invalid');
      insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
        ('${REVIEW}', true, false, false), ('${RIGHTS}', false, true, false), ('${PUBLISH}', false, false, true);
      -- The restricted review identity logs in only in this disposable database.
      alter role velora_review_service login password 'postgres';`);
    before = isolatedSql(`select coalesce(jsonb_agg(jsonb_build_object('m', to_jsonb(m), 'v', (select jsonb_agg(to_jsonb(v) order by v.id) from public.movie_versions v where v.movie_id = m.id)) order by m.id), '[]') from public.movies m`);
  });
  afterAll(() => {
    // Leave the channel slot free for other suites in this disposable run.
    isolatedSql(`delete from private.discovery_cursors where bot_type = 'movie'; delete from private.telegram_channels where chat_id = ${CHANNEL};`);
  });

  it("detects, persists and dedupes a channel document; one consumer at a time; restart-safe", async () => {
    const first = databasePersistence(service, { channelId: CHANNEL });
    const metrics = await runReplay(first, replayProvider([post(501, 900, "AgADdirect900"), post(501, 900, "AgADdirect900")]), ports, options());
    expect(metrics).toMatchObject({ updates: 2, duplicates: 1, processed: 1, failures: 0, candidates: 1, awaitingReview: 1 });
    expect(isolatedSql(`select count(*) from private.channel_reviews`)).toBe("1");
    expect(isolatedSql(`select e.origin || ':' || coalesce(e.source_fingerprint, '-') from private.ingestion_events e join private.channel_reviews r on r.ingestion_event_id = e.id`)).toBe("channel:-");
    expect(isolatedSql(`select update_offset from private.discovery_cursors`)).toBe("501");
    // A second consumer cannot take the update stream while the lease is held.
    await expect(databasePersistence(service, { channelId: CHANNEL }).checkpoint()).rejects.toMatchObject({ code: "discovery_consumer_busy" });
    // Restart: the lease expires, a new process replays the same updates: nothing new, nothing re-inspected.
    isolatedSql(`update private.discovery_cursors set consumer_until = now() - interval '1 second'`);
    const searches = tmdbSearches;
    const again = await runReplay(databasePersistence(service, { channelId: CHANNEL }), replayProvider([post(501, 900, "AgADdirect900")]), ports, options());
    expect(again).toMatchObject({ duplicates: 1, processed: 0, candidates: 1 });
    expect(tmdbSearches).toBe(searches);
  });

  it("proposes identity and VJ, verifies the exact document, and starts with rights missing", async () => {
    const detail = (await reviewer(REVIEW).get(key(900)))!;
    const event = detectDocument(post(501, 900, "AgADdirect900"), CHANNEL).event!;
    expect(detail.candidate).toMatchObject({ status: "awaiting_identity", identity: "proposed", tmdbId: TMDB, title: "Direct Channel Film", year: 2025, vjText: "Direct", relation: "new_movie" });
    expect(detail.candidate.vjId).toBe(Number(isolatedSql(`select id from public.vjs where slug = 'vj-direct'`)));
    expect(detail.candidate.evidence).toMatchObject({ identity: channelIdentity(event), mediaClass: "canonical", video: "h264", audio: "aac", browser: true, gateway: true, accessible: true });
    expect(detail.candidate.evidence!.bytesRead).toBeLessThan(16 * 1024);
    expect(detail.candidate.gates).toEqual(["identity_unconfirmed", "rights_clearance_required"]);
    expect(JSON.stringify(detail)).not.toContain("synthetic-bot-file");
  });

  it("refuses review to everyone without the capability", async () => {
    await expect(reviewer(NOBODY).list()).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(createReviewClient(rpcAs({ role: "anon" })).list()).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(createReviewClient(service).correct(key(900), 1, { tmdbId: TMDB, year: 2025, vjId: 1 })).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(reviewer(RIGHTS).correct(key(900), 1, { tmdbId: TMDB, year: 2025, vjId: 1 })).rejects.toMatchObject({ code: "review_not_authorized" });
  });

  it("requires confirmation, explicit rights and an authorized approval; stale and unauthorized approvals fail", async () => {
    const vj = Number(isolatedSql(`select id from public.vjs where slug = 'vj-direct'`));
    const confirmed = await reviewer(REVIEW).correct(key(900), 1, { tmdbId: TMDB, year: 2025, vjId: vj });
    expect(confirmed).toMatchObject({ revision: 2, identity: "confirmed", status: "awaiting_rights", gates: ["rights_clearance_required"] });
    expect(refused(() => owner(approvalCommand(key(900), 2, REVIEW)))).toMatch(/review_gates_not_met/);
    const cleared = await reviewer(RIGHTS).clearRights(key(900), 2, "licence E38A-direct-001");
    expect(cleared).toMatchObject({ revision: 3, status: "awaiting_review", gates: [], rights: { reference: "licence E38A-direct-001", actor: RIGHTS } });
    expect(refused(() => owner(approvalCommand(key(900), 3, NOBODY)))).toMatch(/review_not_authorized/);
    expect(refused(() => owner(approvalCommand(key(900), 3, RIGHTS)))).toMatch(/review_not_authorized/);
    expect(refused(() => owner(approvalCommand(key(900), 2, REVIEW)))).toMatch(/review_stale_revision/);
    // The worker's identity cannot run owner commands at all.
    expect(refused(() => isolatedSql(`set role service_role; ${approvalCommand(key(900), 3, REVIEW)}`))).toMatch(/permission denied/);
    owner(approvalCommand(key(900), 3, REVIEW));
    expect((await reviewer(REVIEW).get(key(900)))!.candidate).toMatchObject({ status: "approved", approval: { revision: 3, actor: REVIEW } });
  });

  it("publishes atomically and idempotently through the shared owner boundary, reconciling an uncertain result", async () => {
    expect(await getMovie("direct-channel-film-2025")).toBeNull();
    expect(refused(() => owner(publicationCommand(key(900), 3, REVIEW)))).toMatch(/review_not_authorized/);
    // The result of the publishing call is "lost": reconcile from database state, never by guessing.
    try { owner(publicationCommand(key(900), 3, PUBLISH)); } catch { /* treated as uncertain below */ }
    const after = (await reviewer(REVIEW).get(key(900)))!.candidate;
    expect(publicationState(after, 3)).toBe("published");
    expect(after.publication).toMatchObject({ movieSlug: "direct-channel-film-2025" });
    // Re-running the same command is safe: the database returns the same publication.
    expect(owner(publicationCommand(key(900), 3, PUBLISH))).toContain('"result": "already_published"');
    expect(isolatedSql(`select count(*) from public.movies where tmdb_id = ${TMDB}`)).toBe("1");
    expect(isolatedSql(`select count(*) || ':' || min(mv.availability_status) || ':' || min(mv.rights_status) from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.tmdb_id = ${TMDB}`)).toBe("1:ready:cleared");
    expect(isolatedSql(`select string_agg(a.action, ',' order by a.id) from private.channel_review_audit a join private.channel_reviews r on r.ingestion_event_id = a.ingestion_event_id where r.discovery_key = '${key(900)}'`))
      .toBe("detected,inspected,identity_confirmed,rights_cleared,approved,published");
  });

  it("is visible through the existing catalogue queries", async () => {
    const slug = "direct-channel-film-2025";
    expect((await listMovies()).items.map((item) => item.slug)).toContain(slug);
    expect((await searchCatalogue("Direct Channel Film", "movie")).titles.map((item) => item.slug)).toContain(slug);
    const movie = (await getMovie(slug))!;
    expect(movie.versions).toHaveLength(1);
    expect((await listVjs()).map((vj) => vj.slug)).toContain("vj-direct");
    expect((await getVj("vj-direct"))?.slug).toBe("vj-direct");
    expect((await listMovies({ vjSlug: "vj-direct" })).items.map((item) => item.slug)).toEqual([slug]);
  });

  it("stays behind the existing playback authorization and gateway resolver", async () => {
    const versionId = Number(isolatedSql(`select mv.id from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.tmdb_id = ${TMDB}`));
    expect(await isMovieVersionPlayable(versionId)).toBe(true);
    expect(await canStreamMovieVersion(null, versionId)).toEqual({ allowed: false, reason: "authentication_required" });
    const decision = await canStreamMovieVersion({ id: REVIEW, email: null }, versionId);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const config = streamCapabilityConfigFromEnv({ NODE_ENV: "test", MEDIA_GATEWAY_TOKEN_SECRET: randomBytes(32).toString("base64url"), MEDIA_GATEWAY_PUBLIC_ORIGIN: "http://127.0.0.1:8787" });
    const token = new URL(issueStreamCapability(config, decision, Date.now()).streamUrl).searchParams.get("token")!;
    const expectation = { op: "stream" as const, movieVersionId: versionId, nowSeconds: Math.floor(Date.now() / 1000), maxLifetimeSeconds: DEFAULT_LIMITS.maxTokenLifetimeSeconds };
    expect(verifyMediaToken(config.secret, token, expectation).ok).toBe(true);
    expect(verifyMediaToken(config.secret, `${token.slice(0, -2)}xx`, expectation).ok).toBe(false);
    expect(verifyMediaToken(config.secret, token, { ...expectation, op: "download" }).ok).toBe(false);
    expect(verifyMediaToken(config.secret, token, { ...expectation, movieVersionId: versionId + 1 }).ok).toBe(false);
    const resolved = isolatedSql(`begin; grant velora_media_gateway to postgres; set local role velora_media_gateway;
      select message_id || ':' || file_unique_id || ':' || file_size_bytes from (${RESOLVE_MOVIE_VERSION_SQL.replace("$1", String(versionId))}) r; rollback;`);
    expect(resolved).toBe(`900:AgADdirect900:${SIZE}`);
  });

  it("restarts, edits and reconciliation never duplicate or alter the publication", async () => {
    const versions = isolatedSql(`select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') from public.movie_versions v`);
    isolatedSql(`update private.discovery_cursors set consumer_until = now() - interval '1 second'`);
    const worker = databasePersistence(service, { channelId: CHANNEL });
    // A replacement document edited into the published message, plus a repost of the published document.
    await runReplay(worker, replayProvider([post(502, 900, "AgADswapped900", { edited: true }), post(503, 901, "AgADdirect900")]), ports, options());
    await reconcile(worker, { page: async () => ({ updates: [{ channel_post: post(0, 900, "AgADdirect900").channel_post }], next: null, complete: true, inaccessible: 0 }) }, () => new Date(), new AbortController().signal);
    expect(isolatedSql(`select m.file_unique_id || ':' || e.status || ':' || e.error_code from private.telegram_media m join private.ingestion_events e on e.telegram_media_id = m.id where m.chat_id = ${CHANNEL} and m.message_id = 900`))
      .toBe("AgADdirect900:published:published_message_changed");
    expect(isolatedSql(`select e.status || ':' || e.error_code from private.ingestion_events e join private.telegram_media m on m.id = e.telegram_media_id where m.chat_id = ${CHANNEL} and m.message_id = 901`))
      .toBe("ignored:duplicate_media");
    expect(isolatedSql(`select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') from public.movie_versions v`)).toBe(versions);
    expect(isolatedSql(`select reconciliation_incomplete from private.discovery_cursors`)).toBe("f");
  });

  it("leaves every title that existed before unchanged", () => {
    const after = isolatedSql(`select coalesce(jsonb_agg(jsonb_build_object('m', to_jsonb(m), 'v', (select jsonb_agg(to_jsonb(v) order by v.id) from public.movie_versions v where v.movie_id = m.id)) order by m.id), '[]')
      from public.movies m where m.tmdb_id is distinct from ${TMDB}`);
    expect(after).toBe(before);
    expect(verifications).toBeGreaterThan(0);
  });
});
