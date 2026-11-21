/**
 * Series review queue end to end in a disposable database (migration 20261120191536): every command
 * goes through the isolated PostgREST as a signed-in reviewer, and every answer is parsed by the same
 * client and schemas the admin page uses. Synthetic documents only; nothing hosted is touched.
 * Usage: node --experimental-transform-types --import ./scripts/ingest/register.mjs scripts/series-review-validation.mts
 */
import assert from "node:assert/strict";
import { createReviewClient, type DiscoveryRpc } from "../lib/discovery/database.ts";
import { seriesItemStage } from "../lib/series-review.ts";
import { up, down, psql, isolatedJwt, ISOLATED } from "./isolated-db.mjs";

const REVIEWER = "00000000-0000-4000-8000-0000000000c1";
function sql(text: string) {
  const result = psql(text, { user: "supabase_admin", quiet: true });
  if (result.code) throw new Error(result.err);
  return String(result.out).trim();
}
const rpc: DiscoveryRpc = async (fn, args) => {
  const response = await fetch(`http://127.0.0.1:${ISOLATED.restPort}/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${isolatedJwt({ sub: REVIEWER, role: "authenticated", is_anonymous: false })}` },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  return response.ok ? { data: body, error: null } : { data: null, error: { message: body.message, code: body.code, details: body.details } };
};

up({ rest: true });
try {
  sql(`insert into private.telegram_channels (bot_type, chat_id) values ('series', -1002222222222);
    insert into public.vjs (slug, name, is_active) values ('vj-series', 'VJ Series', true);
    insert into auth.users (id, aud, role, email) values ('${REVIEWER}', 'authenticated', 'authenticated', 'reviewer@series.invalid');
    insert into private.catalogue_reviewers (user_id, can_review, can_clear_rights, can_publish) values ('${REVIEWER}', true, true, true);
    insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, file_name, mime_type, file_size_bytes, telegram_date)
    values ('series', -1002222222222, 60, 'synthetic-60', 'AgADseries60', 'document', 'Heros Eo1 Ice P.mp4', 'video/mp4', 1000, now());`);
  const client = createReviewClient(rpc);

  const empty = await client.seriesQueue();
  assert.ok(empty, "the queue command exists");
  assert.equal(empty.items.length, 1);
  assert.equal(seriesItemStage(empty.items[0]), "unassigned");
  assert.deepEqual(empty.vjs.map((vj) => vj.name), ["VJ Series"]);

  const series = await client.saveSeries(null, null, { title: "Synthetic Heroes", original_title: null, overview: "Manual.", first_air_date: "2024-03-01",
    genres: ["Drama"], poster_path: "/posters/0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e.webp", backdrop_path: null });
  assert.equal(series.slug, "synthetic-heroes-2024");
  assert.equal(series.manual, true);

  const media = empty.items[0].media_id;
  const vj = empty.vjs[0].id;
  const assigned = await client.assignEpisode(media, 0, { seriesId: series.id, season: 1, episode: 1, title: "Pilot", overview: null, vjId: vj });
  assert.equal(seriesItemStage(assigned), "awaiting_rights");
  const cleared = await client.episodeRights(media, assigned.revision, true);
  assert.equal(seriesItemStage(cleared), "awaiting_check");
  await assert.rejects(client.publishEpisode(media, cleared.revision), (error: { code?: string }) => error.code === "catalogue_media_not_verified");

  // A passing whole-file result through the worker's own commands, as in database test 033.
  sql(`set role velora_discovery_worker;
    select public.media_verification_finish((c->>'media_id')::bigint, (c->>'lease')::uuid, c->>'identity',
      jsonb_build_object('identity', c->>'identity', 'method', 'full_original_v1', 'inspection_scope', 'whole_file', 'policy_version', 3, 'media_class', 'original', 'reasons', '[]'::jsonb,
        'container', 'mp4', 'video_codec', 'h264', 'audio_codec', 'aac', 'accessible', true, 'gateway_compatible', true, 'playback_ready', false, 'bytes_read', 1100,
        'assessment', jsonb_build_object('accepted', true, 'container', 'mp4', 'integrity', 'verified', 'streaming', 'verified', 'download', 'original_servable',
          'reasons', '[]'::jsonb, 'warnings', '[]'::jsonb,
          'compatibility', jsonb_build_object('basis', 'tested_fixture_combinations', 'perFile', 'prediction',
            'evidence', 'docs/MP4_MKV_NATIVE_PLAYBACK.md#checkpoint-1-browser-test-infrastructure-and-baseline-2026-10-11',
            'chromium', 'tested_combination', 'firefox', 'tested_combination', 'safari', 'real_device_not_tested', 'ios', 'real_device_not_tested', 'android', 'real_device_not_tested'),
          'tracks', '[{"index":0,"type":"video","codec":"h264","width":1920,"height":1080,"attachedPicture":false},{"index":1,"type":"audio","codec":"aac","channels":2,"sampleRate":48000,"attachedPicture":false}]'::jsonb,
          'verification', jsonb_build_object('contract', 1, 'digest', jsonb_build_object('algorithm', 'sha256', 'value', repeat('b', 64), 'bytes', 1000),
            'integrity', jsonb_build_object('status', 'verified', 'method', 'whole_file_decode_v1', 'duration_seconds', 3000, 'decoded_seconds', 3000, 'reasons', '[]'::jsonb),
            'streaming', jsonb_build_object('status', 'verified', 'method', 'sampled_seek_decode_v1', 'layout', 'mp4_head_index', 'reasons', '[]'::jsonb,
              'samples', '[{"position":"start","seconds":0,"decoded":true},{"position":"middle","seconds":1500,"decoded":true},{"position":"end","seconds":2700,"decoded":true}]'::jsonb),
            'download', jsonb_build_object('status', 'original_servable', 'reasons', '[]'::jsonb),
            'tools', jsonb_build_object('ffmpeg', '9.0.2', 'ffprobe', '9.0.2'),
            'started_at', '2026-11-19T07:00:00.000Z', 'finished_at', '2026-11-19T07:10:00.000Z'))), null)
    from (select public.media_verification_claim_v2(gen_random_uuid(), 600, 60, array['series']) c) x;`);
  const ready = (await client.seriesQueue())!.items[0];
  assert.equal(seriesItemStage(ready), "ready");
  assert.equal(ready.verification?.publishable, true);

  const published = await client.publishEpisode(media, ready.revision);
  assert.equal(published.series_slug, "synthetic-heroes-2024");
  assert.equal(seriesItemStage(published), "published");
  assert.equal(sql("select publication_status from public.series where slug = 'synthetic-heroes-2024'"), "published");
  // The public read sees the manual series, its episode and the VJ version.
  const response = await fetch(`http://127.0.0.1:${ISOLATED.restPort}/episode_versions?select=id`, { headers: { authorization: `Bearer ${isolatedJwt({ role: "anon" })}` } });
  assert.equal((await response.json()).length, 1);
  console.log(JSON.stringify({ event: "series_review_validation_passed" }));
} finally {
  down();
}
