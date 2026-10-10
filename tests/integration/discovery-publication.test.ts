import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openInbox } from "@/lib/discovery/store";
import { fixtureSchema, fixturePorts } from "@/lib/discovery/fixtures";
import { detectDocument, mediaKey, receive } from "@/lib/discovery/events";
import { inspectNext } from "@/lib/discovery/pipeline";
import { decideReview, publishReviewed } from "@/lib/discovery/review";
import { getMovie, getVj, listFeatured, listMovies, listVjs, searchCatalogue } from "@/lib/catalogue";
import { ISOLATED_REST, isolatedSql } from "./isolated-env";

// Disposable isolated database (scripts/isolated-db.mjs); never DATABASE_URL or service-role keys.
const sql = (statement: string): string => `${isolatedSql(statement)}\n`;
describe.skipIf(process.env.VELORA_E38_ISOLATED_TESTS !== "true" || process.env.NEXT_PUBLIC_SUPABASE_URL !== ISOLATED_REST)("discovery publication through existing owner SQL and catalogue queries", () => {
  it("approved uploader-linked fixture becomes visible; drafts and existing titles remain unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "velora-e38-db-"));
    // Repeatable after an interrupted TEST run. Fixed synthetic identities, isolated database only.
    sql(`delete from public.movie_versions where movie_id in (select id from public.movies where tmdb_id=980038);
      delete from public.movies where tmdb_id=980038;
      delete from private.metadata_match_candidates where ingestion_event_id in (select id from private.ingestion_events where source_fingerprint='sf1-${"e".repeat(64)}');
      delete from private.ingestion_events where source_fingerprint='sf1-${"e".repeat(64)}';
      delete from private.telegram_media where chat_id=-1009990001112;
      delete from private.discovery_cursors where bot_type='movie';
      delete from private.telegram_channels where bot_type='movie';
      delete from public.vjs where slug='vj-e38-fixture';`);
    const before = sql("select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]') from public.movies m;").trim();
    try {
      const fixture = fixtureSchema.parse(JSON.parse(await readFile("scripts/discovery/example.json", "utf8")));
      const fingerprint = `sf1-${"e".repeat(64)}`;
      const vjId = Number(sql("insert into public.vjs(slug,name,is_active) values ('vj-e38-fixture','Test',true) returning id;").split("\n")[0]);
      fixture.vjs[0].id = vjId; fixture.movies[0].tmdb_id = 980038;
      const event = detectDocument(fixture.updates[0], fixture.channelId).event!;
      fixture.media.push({ mediaKey: mediaKey(event), duplicateOf: null,
        source: { fingerprint, mediaKey: mediaKey(event), evaluatedTmdbId: 980038, evaluatedVjId: vjId },
        evidence: { mediaKey: mediaKey(event), accessible: true, container: true, gateway: true, browser: true, checkedAt: "2026-10-09T12:00:00.000Z", reference: "synthetic-isolated-proof" } });
      sql(`insert into private.telegram_channels(bot_type,chat_id,checkpoint_message_id) values ('movie',${fixture.channelId},1);
        set role service_role;
        select upload_state from public.ingest_upload_start('${fingerprint}','movie',${fixture.channelId},1024);
        select public.ingest_upload_record('${fingerprint}','movie',${fixture.channelId},10,'synthetic-unused','synthetic-document','document','Example.Movie.2024.VJ.Test.mp4','video/mp4','velora-src:${fingerprint}',1024,null,null,null,now());
        select public.ingest_record_evaluation('${fingerprint}','movie',
          '{"kind":"movie","kind_status":"confirmed","title":"Example Movie","year":2024,"vj_text":"Test","vj_status":"resolved","vj_id":${vjId},"season":null,"episode":null}',
          '[{"tmdb_id":980038,"media_type":"movie","score":1,"title_match":"exact","title_field":"title","year_match":"match","title":"Example Movie","year":2024}]');`);
      const store = await openInbox(directory, process.cwd(), fixture.channelId);
      const ports = fixturePorts(fixture); const now = () => new Date("2026-10-09T12:00:00.000Z");
      await store.transaction((inbox) => receive(inbox, fixture.updates, now().toISOString())); await inspectNext(store, ports, now);
      let candidate = Object.values((await store.read()).candidates)[0];
      expect(await getMovie("example-movie-2024")).toBeNull(); expect((await searchCatalogue("Example Movie", "movie")).titles).toHaveLength(0);
      const actor = { id: "synthetic-isolated-admin", admin: true };
      candidate = await decideReview(store, actor, candidate.id, candidate.revision, { kind: "correct", fields: { title: "Example Movie", year: 2024, tmdbId: 980038, vjId } }, fixture.vjs, now(), fixture.catalogue);
      candidate = await decideReview(store, actor, candidate.id, candidate.revision, { kind: "rights", reference: "synthetic-test-only" }, fixture.vjs, now());
      candidate = await decideReview(store, actor, candidate.id, candidate.revision, { kind: "approve" }, fixture.vjs, now());
      let calls = 0;
      const port = { async publish(script: string) {
        calls++; sql(script);
        const result = JSON.parse(sql("select jsonb_build_object('movieSlug',m.slug,'versionId',v.id) from public.movies m join public.movie_versions v on v.movie_id=m.id where m.tmdb_id=980038;"));
        return result as { movieSlug: string; versionId: number };
      } };
      const published = await publishReviewed(store, actor, candidate.id, candidate.revision, port, now);
      await publishReviewed(store, actor, candidate.id, candidate.revision, port, now); expect(calls).toBe(1);
      const slug = published.publication!.movieSlug;
      expect((await listMovies()).items.some((item) => item.slug === slug)).toBe(true);
      expect((await searchCatalogue("Example Movie", "movie")).titles.map((item) => item.slug)).toContain(slug);
      expect((await getMovie(slug))?.versions).toHaveLength(1);
      expect((await listVjs()).some((item) => item.slug === "vj-e38-fixture")).toBe(true);
      expect((await getVj("vj-e38-fixture"))?.id).toBe(vjId);
      expect((await listMovies({ vjSlug: "vj-e38-fixture" })).items.map((item) => item.slug)).toContain(slug);
      // The existing home query includes only featured titles when there are already featured picks.
      expect((await listFeatured()).every((item) => item.slug !== slug)).toBe(true);
      const after = sql("select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]') from public.movies m where m.tmdb_id is distinct from 980038;").trim(); expect(after).toBe(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 120000);
});
