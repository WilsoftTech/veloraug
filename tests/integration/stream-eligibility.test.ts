import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMovieVersionPlayable } from "@/lib/catalogue";
import { DEFAULT_LIMITS } from "@/lib/media-gateway/limits";
import { RESOLVE_MOVIE_VERSION_SQL } from "@/lib/media-gateway/resolver-sql";
import { verifyMediaToken } from "@/lib/media-gateway/token";
import { canStreamMovieVersion } from "@/lib/playback/entitlement";
import { issueStreamCapability, streamCapabilityConfigFromEnv } from "@/lib/playback/stream-capability";

/**
 * E2 stream eligibility against the LOCAL database (never hosted).
 *
 * The application decides eligibility through the public catalogue read
 * (lib/catalogue.ts, as anon over PostgREST, under the B-2 policies). The media
 * gateway decides it again through its restricted resolver. This compares the
 * two on the E1.2A fixture matrix: they agree on every catalogue rule, and the
 * gateway alone enforces its two transport rules (registered channel, recorded
 * size), where it refuses a capability the application issued. That refusal is
 * the intended defence in depth: no bytes, and nothing learned by the caller.
 *
 * Fixtures are committed (PostgREST reads them over its own connection) and
 * removed afterwards. The gateway comparison runs in a rolled-back transaction.
 */

const ROOT = join(__dirname, "../..");
const PROJECT_ID = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"))![1];
const MOVIES = -1007777777777;
const OTHER_CHAT = -1008888888888;
const USER = { id: "0b8a3f0e-7d51-4c1f-9d1e-2f5a6b7c8d9e", email: null };

function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${PROJECT_ID}`, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-F", "|"], { input: sql, encoding: "utf8" }).trim();
}

const CLEANUP = `
delete from public.movie_versions where movie_id in (select id from public.movies where slug like 'e2-%')
   or vj_id in (select id from public.vjs where slug like 'e2-%');
delete from public.movies where slug like 'e2-%';
delete from public.vjs where slug like 'e2-%';
delete from private.telegram_media where file_unique_id like 'e2-unique-%';
`;

// label, movie, vj, availability, rights, media number (null: none)
const CASES = [
  ["published", "e2-published", "e2-active", "ready", "cleared", 1],
  ["movie_draft", "e2-draft", "e2-active", "ready", "cleared", 2],
  ["movie_archived", "e2-archived", "e2-active", "ready", "cleared", 3],
  ["inactive_vj", "e2-published", "e2-inactive", "ready", "cleared", 4],
  ["rights_blocked", "e2-published", "e2-rights", "ready", "blocked", 5],
  ["rights_unknown", "e2-published", "e2-unknown", "ready", "unknown", 8],
  ["unregistered_channel", "e2-published", "e2-other-chat", "ready", "cleared", 6],
  ["no_recorded_size", "e2-published", "e2-no-size", "ready", "cleared", 7],
  ["version_not_ready", "e2-published", "e2-unready", "draft", "cleared", null],
  ["version_unavailable", "e2-published", "e2-unavailable", "unavailable", "cleared", 9],
  ["version_archived", "e2-published", "e2-archived-v", "archived", "cleared", 10],
] as const;

/** Only the gateway checks these; the application's catalogue read cannot see them. */
const TRANSPORT_ONLY = new Set(["unregistered_channel", "no_recorded_size"]);

const SETUP = `
begin;
${CLEANUP}
insert into public.vjs (slug, name, is_active)
select distinct vj, initcap(replace(vj, '-', ' ')), vj <> 'e2-inactive'
  from (values ${CASES.map((c) => `('${c[2]}')`).join(", ")}) v(vj);
insert into public.movies (slug, title, publication_status, published_at) values
  ('e2-published', 'E2 Published', 'published', now()),
  ('e2-draft', 'E2 Draft', 'draft', now()),
  ('e2-archived', 'E2 Archived', 'archived', now());
-- Media 11 is Fuze-style: uploaded, no version, so there is nothing a client could name.
insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, mime_type, file_size_bytes, telegram_date)
select 'movie', case when n = 6 then ${OTHER_CHAT} else ${MOVIES} end, 8000 + n, 'e2-file-' || n, 'e2-unique-' || n, 'document',
       'video/x-matroska', case when n = 7 then null else 1004462878 end, now()
  from generate_series(1, 11) n;
insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
select m.id, v.id, f.availability, f.rights, case when f.availability = 'ready' then now() end,
       (select t.id from private.telegram_media t where t.file_unique_id = 'e2-unique-' || f.media)
  from (values ${CASES.map((c) => `('${c[0]}', '${c[1]}', '${c[2]}', '${c[3]}', '${c[4]}', ${c[5] ?? "null"}::int)`).join(", ")})
       f(label, movie, vj, availability, rights, media)
  join public.movies m on m.slug = f.movie
  join public.vjs v on v.slug = f.vj;
commit;
select f.label, mv.id
  from (values ${CASES.map((c) => `('${c[0]}', '${c[1]}', '${c[2]}')`).join(", ")}) f(label, movie, vj)
  join public.movies m on m.slug = f.movie
  join public.vjs v on v.slug = f.vj
  join public.movie_versions mv on mv.movie_id = m.id and mv.vj_id = v.id;
select 'fuze_versions', count(*) from public.movie_versions mv
  join private.telegram_media t on t.id = mv.telegram_media_id where t.file_unique_id = 'e2-unique-11';
`;

const ids = new Map<string, number>();
let fuzeVersions = -1;
const UNKNOWN_ID = 999_999_999;

function gatewayResolves(versionIds: number[]): Set<number> {
  const output = psql(`
begin;
delete from private.telegram_channels where bot_type = 'movie';
insert into private.telegram_channels (bot_type, chat_id) values ('movie', ${MOVIES});
grant velora_media_gateway to postgres;
set local role velora_media_gateway;
select v.id from unnest(array[${versionIds.join(", ")}]::bigint[]) as v(id)
 where exists (${RESOLVE_MOVIE_VERSION_SQL.replace("$1", "v.id")});
rollback;
`);
  return new Set(output.split(/\r?\n/).filter((line) => /^\d+$/.test(line)).map(Number));
}

beforeAll(() => {
  for (const line of psql(SETUP).split(/\r?\n/)) {
    const [label, value] = line.split("|");
    if (label === "fuze_versions") fuzeVersions = Number(value);
    else if (value && /^\d+$/.test(value)) ids.set(label, Number(value));
  }
});

afterAll(() => {
  psql(CLEANUP);
});

describe("stream eligibility: application catalogue read vs gateway resolver (local database)", () => {
  it("has every fixture", () => {
    expect([...ids.keys()].sort()).toEqual(CASES.map((c) => c[0]).sort());
    expect(fuzeVersions).toBe(0);
  });

  it("agrees with the gateway on every catalogue rule, and leaves only the transport rules to the gateway", async () => {
    const resolved = gatewayResolves([...ids.values(), UNKNOWN_ID]);
    const table: Record<string, { app: boolean; gateway: boolean }> = {};
    for (const [label, id] of ids) table[label] = { app: await isMovieVersionPlayable(id), gateway: resolved.has(id) };
    table.unknown_id = { app: await isMovieVersionPlayable(UNKNOWN_ID), gateway: resolved.has(UNKNOWN_ID) };

    for (const [label, row] of Object.entries(table)) {
      if (TRANSPORT_ONLY.has(label)) expect(row, label).toEqual({ app: true, gateway: false });
      else expect(row.app, label).toBe(row.gateway);
    }
    expect(Object.entries(table).filter(([, row]) => row.gateway).map(([label]) => label)).toEqual(["published"]);
  });

  it("issues a stream capability only for the published version, through the real entitlement and catalogue", async () => {
    const config = streamCapabilityConfigFromEnv({ NODE_ENV: "test", MEDIA_GATEWAY_TOKEN_SECRET: randomBytes(32).toString("base64url"), MEDIA_GATEWAY_PUBLIC_ORIGIN: "http://127.0.0.1:8787" });
    const decisions: Record<string, string> = {};
    for (const [label, id] of [...ids, ["unknown_id", UNKNOWN_ID] as const]) {
      const decision = await canStreamMovieVersion(USER, id);
      decisions[label] = decision.allowed ? "allowed" : decision.reason;
      if (!decision.allowed) continue;
      const { streamUrl } = issueStreamCapability(config, decision, Date.now());
      const verified = verifyMediaToken(config.secret, new URL(streamUrl).searchParams.get("token") ?? undefined, {
        op: "stream",
        movieVersionId: id,
        nowSeconds: Math.floor(Date.now() / 1000),
        maxLifetimeSeconds: DEFAULT_LIMITS.maxTokenLifetimeSeconds,
      });
      expect(verified.ok, label).toBe(true);
    }
    const allowed = Object.entries(decisions).filter(([, value]) => value === "allowed").map(([label]) => label).sort();
    expect(allowed).toEqual(["no_recorded_size", "published", "unregistered_channel"]);
    for (const [label, value] of Object.entries(decisions)) if (value !== "allowed") expect(value, label).toBe("unavailable");
  });

  it("never asks the catalogue for a signed-out caller", async () => {
    expect(await canStreamMovieVersion(null, ids.get("published"))).toEqual({ allowed: false, reason: "authentication_required" });
  });
});
