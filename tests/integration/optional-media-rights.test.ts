import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewClient, databaseCataloguePorts, databasePersistence, type DiscoveryRpc } from "@/lib/discovery/database";
import { catalogueStage } from "@/lib/discovery/guidance";
import { indicators } from "@/lib/discovery/media-report";
import { replayProvider, runReplay } from "@/lib/discovery/worker";
import { runAutoVerification } from "@/lib/discovery/auto-verify";
import { channelVerificationPort } from "@/lib/discovery/media-verification";
import { decodeStreams, headProbe, probeMedia, resolveMediaTools, spoolDocument } from "@/lib/uploader/media-tools";
import type { InspectionPorts } from "@/lib/discovery/pipeline";
import { getMovie, isMovieVersionPlayable } from "@/lib/catalogue";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import { RESOLVE_MOVIE_VERSION_SQL } from "@/lib/media-gateway/resolver-sql";
import type { MovieSnapshot } from "@/lib/tmdb/ingestion-search";
import { ISOLATED_REST, isolatedJwt, isolatedSql } from "./isolated-env";

/**
 * Optional media verification and the rights review (migration 20261018090000),
 * isolated end to end: a trusted Movies-channel document detected by a worker
 * with no media reader (the listener's metadata mode) is prepared for the
 * catalogue without any inspection or rights document, stays unpublishable and
 * unplayable until a rights reviewer verifies a rights reference, and then goes
 * through the same approval, publication and playback boundaries as before.
 * Synthetic updates and metadata only; no Telegram, TMDB or hosted request.
 */
const CHANNEL = -1004343434343;
const REVIEW = "00000000-0000-4000-8000-00000000f0a1";
const RIGHTS = "00000000-0000-4000-8000-00000000f0a2";
const PUBLISH = "00000000-0000-4000-8000-00000000f0a3";
const TMDB = 9820001;
const SIZE = 734_003_200;
const FILM: MovieSnapshot = { tmdb_id: TMDB, title: "Optional Check Film", original_title: "Optional Check Film", overview: "A synthetic film published without a media check.",
  release_date: "2025-06-01", runtime_minutes: 95, poster_path: null, backdrop_path: null, vote_average: 6.8, vote_count: 12, genres: [{ tmdb_id: 18, name: "Drama" }] };

const rpcAs = (claims: Record<string, unknown>): DiscoveryRpc => {
  const client = createClient(ISOLATED_REST, isolatedJwt(claims), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return (fn, args) => client.rpc(fn, args) as unknown as ReturnType<DiscoveryRpc>;
};
const service = rpcAs({ role: "service_role" });
const reviewer = (sub: string) => createReviewClient(rpcAs({ role: "authenticated", sub, aud: "authenticated", is_anonymous: false }));
const post = (update: number, message: number, unique: string) => ({
  update_id: update, channel_post: { message_id: message, date: 1760200000, chat: { id: CHANNEL, type: "channel" },
    document: { file_id: `synthetic-bot-file-${message}`, file_unique_id: unique, file_size: SIZE, file_name: "Optional.Check.Film.2025.VJ.Optional.mkv", mime_type: "video/x-matroska" },
    caption: "Optional Check Film (2025)\nVJ Optional" } });
// The listener's metadata mode: identity matching, no media reader, no evidence.
const metadataOnly: InspectionPorts = {
  ...databaseCataloguePorts(service),
  async search() { return [{ tmdbId: TMDB, mediaType: "movie", title: FILM.title, originalTitle: FILM.original_title, year: 2025 }]; },
  async snapshot(id) { return id === TMDB ? FILM : null; },
  async media() { return { duplicateOf: null, source: null, evidence: null }; },
};
const options = () => ({ now: () => new Date(), signal: new AbortController().signal, paceMs: 0 });
const key = (message: number) => isolatedSql(`select private.discovery_message_key(${CHANNEL}, ${message})`);
const versionId = () => Number(isolatedSql(`select coalesce(max(mv.id), 0) from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.tmdb_id = ${TMDB}`));

describe.skipIf(process.env.VELORA_E38_ISOLATED_TESTS !== "true" || process.env.NEXT_PUBLIC_SUPABASE_URL !== ISOLATED_REST)("optional media verification and the rights review (isolated)", () => {
  beforeAll(() => {
    isolatedSql(`
      delete from private.discovery_cursors where bot_type = 'movie';
      delete from private.telegram_channels where bot_type = 'movie';
      insert into private.telegram_channels (bot_type, chat_id, checkpoint_message_id) values ('movie', ${CHANNEL}, 1);
      insert into private.discovery_cursors (bot_type) values ('movie');
      insert into public.vjs (slug, name, is_active) values ('vj-optional', 'VJ Optional', true);
      insert into auth.users (id, aud, role, email) values ('${REVIEW}', 'authenticated', 'authenticated', 'r@opt.invalid'),
        ('${RIGHTS}', 'authenticated', 'authenticated', 'g@opt.invalid'), ('${PUBLISH}', 'authenticated', 'authenticated', 'p@opt.invalid');
      insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values
        ('${REVIEW}', true, false, false), ('${RIGHTS}', false, true, false), ('${PUBLISH}', false, false, true);
      -- The owner's setting, changed only by the owner in SQL.
      update private.catalogue_policy set media_inspection_mode = 'optional';`);
  });
  afterAll(() => {
    isolatedSql(`update private.catalogue_policy set media_inspection_mode = 'required';
      delete from private.discovery_cursors where bot_type = 'movie'; delete from private.telegram_channels where chat_id = ${CHANNEL};`);
  });

  it("ingests a trusted document without any media inspection, once, and records no evidence and no rights", async () => {
    const metrics = await runReplay(databasePersistence(service, { channelId: CHANNEL }), replayProvider([post(601, 950, "AgADoptional950"), post(601, 950, "AgADoptional950")]), metadataOnly, options());
    expect(metrics).toMatchObject({ updates: 2, duplicates: 1, processed: 1, failures: 0 });
    expect(isolatedSql(`select count(*) from private.channel_reviews r join private.ingestion_events e on e.id = r.ingestion_event_id join private.telegram_media m on m.id = e.telegram_media_id where m.chat_id = ${CHANNEL}`)).toBe("1");
    expect(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id = ev.telegram_media_id where m.chat_id = ${CHANNEL}`)).toBe("0");
    expect(isolatedSql(`select count(*) from private.rights_clearances rc join private.channel_reviews r on r.ingestion_event_id = rc.ingestion_event_id where r.discovery_key = '${key(950)}'`)).toBe("0");
  });

  it("is catalogue-prepared from the film and VJ alone: unchecked media stays not inspected, and rights stay missing", async () => {
    const vj = Number(isolatedSql(`select id from public.vjs where slug = 'vj-optional'`));
    const confirmed = await reviewer(REVIEW).correct(key(950), 1, { tmdbId: TMDB, year: 2025, vjId: vj });
    expect(confirmed).toMatchObject({ revision: 2, status: "awaiting_rights", identity: "confirmed", evidence: null, mediaInspection: "optional",
      rightsReview: { status: "not_provided", submissions: [] }, gates: ["rights_clearance_required"] });
    expect(catalogueStage(confirmed)).toBe("awaiting_authorization");
    expect(indicators(confirmed).find((item) => item.label === "Media verification")).toMatchObject({ value: "Not inspected" });
    // Without a rights decision nothing can be approved, published or played.
    await expect(reviewer(REVIEW).approve(key(950), 2)).rejects.toMatchObject({ code: "review_gates_not_met" });
    await expect(reviewer(PUBLISH).publish(key(950), 2)).rejects.toMatchObject({ code: "catalogue_not_approved" });
    expect(versionId()).toBe(0);
    expect(await getMovie("optional-check-film-2025")).toBeNull();
  });

  it("a submitted rights reference grants nothing until a rights reviewer verifies it", async () => {
    const submitted = await reviewer(REVIEW).submitRights(key(950), 2, "licence OPT-950", null);
    expect(submitted).toMatchObject({ revision: 2, rightsReview: { status: "pending_review" }, gates: ["rights_clearance_required"] });
    const first = (await reviewer(REVIEW).get(key(950)))!.candidate.rightsReview!.submissions[0];
    await expect(reviewer(REVIEW).decideRights(key(950), 2, first.id, "verified")).rejects.toMatchObject({ code: "review_not_authorized" });
    await expect(createReviewClient(service).submitRights(key(950), 2, "licence OPT-950", null)).rejects.toMatchObject({ code: "review_not_authorized" });
    expect(await reviewer(RIGHTS).decideRights(key(950), 2, first.id, "rejected")).toMatchObject({ revision: 2, rightsReview: { status: "rejected" }, gates: ["rights_clearance_required"] });
    await reviewer(REVIEW).submitRights(key(950), 2, "licence OPT-950b", "f".repeat(64));
    const second = (await reviewer(REVIEW).get(key(950)))!.candidate.rightsReview!.submissions[0];
    expect(second).toMatchObject({ reference: "licence OPT-950b", documentSha256: "f".repeat(64), decision: "pending", current: true });
    const verified = await reviewer(RIGHTS).decideRights(key(950), 2, second.id, "verified");
    expect(verified).toMatchObject({ revision: 3, status: "awaiting_review", gates: [], rights: { reference: "licence OPT-950b", actor: RIGHTS }, rightsReview: { status: "verified" } });
  });

  it("publishes through the unchanged approval and publication capabilities, and plays only behind the existing authorization", async () => {
    await expect(reviewer(PUBLISH).approve(key(950), 3)).rejects.toMatchObject({ code: "review_not_authorized" });
    expect(await reviewer(REVIEW).approve(key(950), 3)).toMatchObject({ status: "approved" });
    await expect(reviewer(REVIEW).publish(key(950), 3)).rejects.toMatchObject({ code: "review_not_authorized" });
    expect(await reviewer(PUBLISH).publish(key(950), 3)).toMatchObject({ result: "published", movie_slug: "optional-check-film-2025" });
    expect(isolatedSql(`select mv.availability_status || ':' || mv.rights_status from public.movie_versions mv where mv.id = ${versionId()}`)).toBe("ready:cleared");
    expect(isolatedSql(`select string_agg(a.action, ',' order by a.id) from private.channel_review_audit a join private.channel_reviews r on r.ingestion_event_id = a.ingestion_event_id where r.discovery_key = '${key(950)}'`))
      .toBe("detected,inspected,identity_confirmed,rights_submitted,rights_rejected,rights_submitted,rights_cleared,approved,published");
    expect(await isMovieVersionPlayable(versionId())).toBe(true);
    expect(await canStreamMovieVersion(null, versionId())).toEqual({ allowed: false, reason: "authentication_required" });
    expect((await canStreamMovieVersion({ id: REVIEW, email: null }, versionId())).allowed).toBe(true);
    expect(isolatedSql(`begin; grant velora_media_gateway to postgres; set local role velora_media_gateway;
      select message_id || ':' || file_unique_id from (${RESOLVE_MOVIE_VERSION_SQL.replace("$1", String(versionId()))}) r; rollback;`)).toBe("950:AgADoptional950");
    // The evidence was never invented: the published file is still uninspected.
    expect(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id = ev.telegram_media_id where m.chat_id = ${CHANNEL}`)).toBe("0");
  });

  // Automatic whole-file verification (migration 20261018100000): the real loop, the real "due" query, the keyed claim
  // and the real verifier (ffprobe/ffmpeg) over a committed synthetic MP4 served as the Telegram document.
  it("checks every confirmed movie automatically, once, and never records rights or publishes", async () => {
    const found = await resolveMediaTools();
    if (!found.ok) throw new Error("VELORA_FFPROBE_PATH and VELORA_FFMPEG_PATH are required: the fixture is verified with the real tools");
    const tools = found.tools;
    const work = mkdtempSync(join(tmpdir(), "velora-autoverify-"));
    try {
      const bytes = new Uint8Array(readFileSync("tests/browser/fixtures/mp4-h264-aac-faststart.mp4"));
      const films: Record<number, MovieSnapshot> = {
        960: { ...FILM, tmdb_id: TMDB + 1, title: "Checked Film", original_title: "Checked Film" },
        961: { ...FILM, tmdb_id: TMDB + 2, title: "Unreachable Film", original_title: "Unreachable Film" } };
      const ports: InspectionPorts = { ...metadataOnly,
        async search(query) { const item = Object.values(films).find((film) => film.title === query.title)!; return [{ tmdbId: item.tmdb_id, mediaType: "movie", title: item.title, originalTitle: item.title, year: 2025 }]; },
        async snapshot(id) { return Object.values(films).find((film) => film.tmdb_id === id) ?? null; } };
      const updates = [960, 961].map((message) => ({ update_id: 700 + message, channel_post: { message_id: message, date: 1760200000, chat: { id: CHANNEL, type: "channel" },
        document: { file_id: `synthetic-bot-file-${message}`, file_unique_id: `AgADauto${message}`, file_size: bytes.length, file_name: `${films[message].title.replaceAll(" ", ".")}.2025.VJ.Optional.mp4`, mime_type: "video/mp4" },
        caption: `${films[message].title} (2025)\nVJ Optional` } }));
      isolatedSql(`update private.discovery_cursors set consumer_until = now() - interval '1 second'`);
      await runReplay(databasePersistence(service, { channelId: CHANNEL }), replayProvider(updates), ports, options());
      const vj = Number(isolatedSql(`select id from public.vjs where slug = 'vj-optional'`));
      for (const message of [960, 961]) await reviewer(REVIEW).correct(key(message), 1, { tmdbId: films[message].tmdb_id, year: 2025, vjId: vj });

      const persistence = databasePersistence(service, { channelId: CHANNEL });
      const reads: number[] = [];
      const port = channelVerificationPort((document) => async (offset, length) => {
        reads.push(document.messageId);
        if (document.messageId === 961) throw Object.assign(new Error("flood_wait"), { name: "GatewayError", code: "flood_wait" });
        return bytes.subarray(offset, offset + length);
      }, {
        probe: headProbe(tools.ffprobe), gatewayCompatible: true,
        spool: (read, sizeBytes, handle) => spoolDocument(join(work, "spool"), read, sizeBytes, handle),
        inspect: async (path) => { const probe = await probeMedia(tools.ffprobe, path); return probe.ok ? probe.inspection : null; },
        decoder: (path) => ({ decode: (streams, window) => decodeStreams(tools.ffmpeg, path, streams, window) }),
        tools: { ffmpeg: tools.ffmpeg.version, ffprobe: tools.ffprobe.version }, now: () => new Date(),
      });
      const due = async () => (await persistence.verificationDue(100, 3600)).map((item) => item);
      expect((await due()).sort()).toEqual([key(960), key(961)].sort());
      const logs: Record<string, unknown>[] = [];
      const run = () => runAutoVerification({ due: (limit) => persistence.verificationDue(limit, 3600), verify: (item) => persistence.verifyOne(item, port, () => new Date(), 600),
        sleep: async () => {}, log: (entry) => logs.push(entry) }, { signal: new AbortController().signal, intervalMs: 1000, once: true });

      expect(await run()).toEqual({ passes: 1, verified: 1, notVerified: 0, failed: 1, errors: 0 });
      // The good file is verified whole: integrity and streaming, under the database's own predicate.
      const checked = (await reviewer(REVIEW).get(key(960)))!.candidate;
      expect(checked.evidence).toMatchObject({ policyVersion: 3, facts: { integrity: "verified", streaming: "verified", publishable: true }, inspection: { scope: "whole_file" } });
      // The reader outage is a failed attempt, never evidence; it waits before being tried again.
      expect(isolatedSql(`select count(*) from private.media_evidence ev join private.telegram_media m on m.id = ev.telegram_media_id where m.chat_id = ${CHANNEL} and m.message_id = 961`)).toBe("0");
      expect((await reviewer(REVIEW).get(key(961)))!.candidate).toMatchObject({ status: "failed", error: "media_read_flood_wait" });
      // A second run repeats nothing.
      const before = reads.length;
      expect(await run()).toEqual({ passes: 1, verified: 0, notVerified: 0, failed: 0, errors: 0 });
      expect(reads.length).toBe(before);
      // Verification recorded no rights, no approval and no publication.
      for (const message of [960, 961]) {
        const item = (await reviewer(REVIEW).get(key(message)))!.candidate;
        expect(item).toMatchObject({ rights: null, approval: null, publication: null, rightsReview: { status: "not_provided" } });
        expect(item.gates).toContain("rights_clearance_required");
      }
      expect(JSON.stringify(logs)).not.toContain(key(960));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("withdrawing rights from a published version still stops the existing resolver", () => {
    isolatedSql(`update public.movie_versions set rights_status = 'blocked' where id = ${versionId()}`);
    expect(isolatedSql(`begin; grant velora_media_gateway to postgres; set local role velora_media_gateway;
      select count(*) from (${RESOLVE_MOVIE_VERSION_SQL.replace("$1", String(versionId()))}) r; rollback;`)).toBe("0");
  });
});
