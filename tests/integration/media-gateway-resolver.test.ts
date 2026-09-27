import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESOLVER_COLUMNS, RESOLVE_MOVIE_VERSION_SQL, locatorFromRow } from "@/lib/media-gateway/resolver-sql";

/**
 * E1.2A: the media gateway's catalogue boundary against the LOCAL database
 * (never hosted), exercised as the restricted role velora_media_gateway.
 *
 * 1. The eligibility matrix runs as that role (SET ROLE inside one transaction
 *    that is always rolled back), with the exact statement the adapter sends.
 * 2. The real Postgres adapter (services/media-gateway/pg-resolver.mts) logs in
 *    as that role over TCP with a random local-only password. Its fixtures are
 *    committed and removed afterwards, and the role returns to NOLOGIN.
 */

const ROOT = join(__dirname, "../..");
const PROJECT_ID = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"))![1];
const MOVIES = -1007777777777;
const OTHER_CHAT = -1008888888888;

function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${PROJECT_ID}`, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-F", "|"], { input: sql, encoding: "utf8" }).trim();
}

const statementFor = (versionExpression: string) => RESOLVE_MOVIE_VERSION_SQL.replace("$1", versionExpression);

const CASES = `
begin;
-- The local registration may already exist (fixtures elsewhere); this transaction owns its own.
delete from private.telegram_channels where bot_type = 'movie';
insert into private.telegram_channels (bot_type, chat_id) values ('movie', ${MOVIES});

insert into public.vjs (slug, name, is_active) values ('e12-active', 'E12 Active', true), ('e12-inactive', 'E12 Inactive', false);
insert into public.movies (slug, title, publication_status, published_at) values
  ('e12-published', 'E12 Published', 'published', now()),
  -- published_at set on the hidden movies too, so only publication_status excludes them
  ('e12-draft', 'E12 Draft', 'draft', now()),
  ('e12-archived', 'E12 Archived', 'archived', now());

insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, mime_type, file_size_bytes, telegram_date)
select 'movie', case when n = 6 then ${OTHER_CHAT} else ${MOVIES} end, 9000 + n, 'e12-file-' || n, 'e12-unique-' || n, 'document',
       'video/x-matroska', case when n = 7 then null else 1004462878 end, now()
from generate_series(1, 10) n;

create temporary table e12_case (label text primary key, version_id bigint) on commit drop;

-- label, movie, vj, availability, rights, media number
with fixtures(label, movie, vj, availability, rights, media) as (values
  ('published',          'e12-published', 'e12-active',   'ready', 'cleared', 1),
  ('movie_draft',        'e12-draft',     'e12-active',   'ready', 'cleared', 2),
  ('movie_archived',     'e12-archived',  'e12-active',   'ready', 'cleared', 3),
  ('inactive_vj',        'e12-published', 'e12-inactive', 'ready', 'cleared', 4)
), inserted as (
  insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select m.id, v.id, f.availability, f.rights, case when f.availability = 'ready' then now() end,
         (select t.id from private.telegram_media t where t.file_unique_id = 'e12-unique-' || f.media)
    from fixtures f join public.movies m on m.slug = f.movie join public.vjs v on v.slug = f.vj
  returning id, movie_id, vj_id
)
insert into e12_case select f.label, i.id from fixtures f
  join public.movies m on m.slug = f.movie join public.vjs v on v.slug = f.vj
  join inserted i on i.movie_id = m.id and i.vj_id = v.id;

-- Cases needing their own (movie, vj) pairs.
insert into public.vjs (slug, name, is_active) values ('e12-rights', 'E12 Rights', true), ('e12-unknown', 'E12 Unknown', true),
  ('e12-other-chat', 'E12 Other Chat', true), ('e12-no-size', 'E12 No Size', true),
  ('e12-unready', 'E12 Unready', true), ('e12-unavailable', 'E12 Unavailable', true), ('e12-archived-v', 'E12 Archived Version', true);
with extra(label, vj, availability, rights, media) as (values
  ('rights_blocked', 'e12-rights',     'ready', 'blocked', 5),
  ('rights_unknown', 'e12-unknown',    'ready', 'unknown', 8),
  ('unregistered_channel', 'e12-other-chat', 'ready', 'cleared', 6),
  ('no_recorded_size', 'e12-no-size',  'ready', 'cleared', 7),
  ('version_not_ready', 'e12-unready', 'draft', 'cleared', null),
  -- Versions that keep their media but are not ready: only availability excludes them.
  ('version_unavailable', 'e12-unavailable', 'unavailable', 'cleared', 9),
  ('version_archived', 'e12-archived-v', 'archived', 'cleared', 10)
), inserted as (
  insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
  select (select id from public.movies where slug = 'e12-published'), v.id, e.availability, e.rights,
         case when e.availability = 'ready' then now() end,
         (select t.id from private.telegram_media t where t.file_unique_id = 'e12-unique-' || e.media)
    from extra e join public.vjs v on v.slug = e.vj
  returning id, vj_id
)
insert into e12_case select e.label, i.id from extra e join public.vjs v on v.slug = e.vj join inserted i on i.vj_id = v.id;

insert into e12_case values ('unknown_id', 999999999), ('fuze_style_media_only', null), ('zero_id', 0), ('negative_id', -5);

-- From here on, everything runs as the restricted gateway role (test-only grant, rolled back).
grant velora_media_gateway to postgres;
grant select on e12_case to velora_media_gateway;
set local role velora_media_gateway;
select current_user;

select c.label, r.chat_id, r.message_id, r.file_unique_id, r.file_size_bytes, r.mime_type
  from e12_case c left join lateral (${statementFor("c.version_id")}) r on true
 order by c.label;
rollback;
`;

describe("media gateway resolver as the restricted role (local database)", () => {
  const output = psql(CASES).split(/\r?\n/);
  const rows = new Map(
    output
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [label, chatId, messageId, fileUniqueId, fileSize, mimeType] = line.split("|");
        return [label, chatId ? { chat_id: chatId, message_id: messageId, file_unique_id: fileUniqueId, file_size_bytes: fileSize, mime_type: mimeType || null } : null];
      }),
  );

  it("runs as velora_media_gateway", () => {
    expect(output).toContain("velora_media_gateway");
  });

  it("covers every fixture case", () => {
    expect([...rows.keys()].sort()).toEqual(
      [
        "fuze_style_media_only", "inactive_vj", "movie_archived", "movie_draft", "negative_id", "no_recorded_size", "published", "rights_blocked",
        "rights_unknown", "unknown_id", "unregistered_channel", "version_archived", "version_not_ready", "version_unavailable", "zero_id",
      ].sort(),
    );
  });

  it("resolves a published, ready, cleared version with an active VJ in the registered channel", () => {
    expect(locatorFromRow(42, rows.get("published") ?? undefined)).toEqual({
      movieVersionId: 42, chatId: String(MOVIES), messageId: 9001, fileUniqueId: "e12-unique-1", fileSize: 1_004_462_878, mimeType: "video/x-matroska",
    });
  });

  it.each([
    "movie_draft", "movie_archived", "version_not_ready", "version_unavailable", "version_archived", "inactive_vj", "rights_blocked",
    "rights_unknown", "unregistered_channel", "no_recorded_size", "unknown_id", "fuze_style_media_only", "zero_id", "negative_id",
  ])("returns nothing for %s", (label) => {
    expect(rows.get(label)).toBeNull();
  });

  it("exposes exactly the five transport fields, and no file_id, caption, file name or internal id", () => {
    const columns = psql(`select string_agg(name, ',' order by ord) from pg_proc p, unnest(p.proargnames, p.proargmodes::text[]) with ordinality a(name, mode, ord)
      where p.oid = 'media_gateway.resolve_movie_version(bigint)'::regprocedure and mode = 't'`);
    expect(columns.split(",")).toEqual([...RESOLVER_COLUMNS]);
  });

  it("left the database unchanged (the transaction rolled back)", () => {
    expect(psql("select count(*) from public.movies where slug like 'e12-%'")).toBe("0");
    expect(psql("select count(*) from private.telegram_media where file_unique_id like 'e12-%'")).toBe("0");
    expect(psql("select rolcanlogin from pg_roles where rolname = 'velora_media_gateway'")).toBe("f");
  });
});

describe("gateway Postgres adapter logged in as the restricted role (local database)", () => {
  const password = randomBytes(24).toString("base64url");
  const restrictedUrl = `postgresql://velora_media_gateway:${password}@127.0.0.1:54322/postgres`;
  const ownerUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"; // local stack default
  let previousChannel = "";
  let versions: Record<string, number> = {};

  beforeAll(() => {
    previousChannel = psql("select chat_id from private.telegram_channels where bot_type = 'movie'");
    const ids = psql(`
      delete from private.telegram_channels where bot_type = 'movie';
      insert into private.telegram_channels (bot_type, chat_id) values ('movie', ${MOVIES});
      insert into public.vjs (slug, name, is_active) values ('e12a-live', 'E12A Live', true);
      insert into public.movies (slug, title, publication_status, published_at) values ('e12a-live', 'E12A Live', 'published', now()), ('e12a-hidden', 'E12A Hidden', 'draft', null);
      insert into private.telegram_media (bot_type, chat_id, message_id, file_id, file_unique_id, media_kind, mime_type, file_size_bytes, telegram_date)
        values ('movie', ${MOVIES}, 9501, 'e12a-file-1', 'e12a-unique-1', 'document', 'video/x-matroska', 1004462878, now()),
               ('movie', ${MOVIES}, 9502, 'e12a-file-2', 'e12a-unique-2', 'document', 'video/x-matroska', 1056312383, now());
      insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status, available_at, telegram_media_id)
        select m.id, v.id, 'ready', 'cleared', now(), t.id from public.movies m, public.vjs v, private.telegram_media t
         where m.slug = 'e12a-live' and v.slug = 'e12a-live' and t.file_unique_id = 'e12a-unique-1';
      insert into public.movie_versions (movie_id, vj_id, availability_status, rights_status)
        select m.id, v.id, 'draft', 'unknown' from public.movies m, public.vjs v where m.slug = 'e12a-hidden' and v.slug = 'e12a-live';
      alter role velora_media_gateway login password '${password}';
      select string_agg(m.slug || '=' || mv.id, ',') from public.movie_versions mv join public.movies m on m.id = mv.movie_id where m.slug like 'e12a-%';`);
    versions = Object.fromEntries(
      ids.split(/\r?\n/).pop()!.split(",").map((pair) => {
        const [slug, id] = pair.split("=");
        return [slug, Number(id)];
      }),
    );
  });

  afterAll(() => {
    psql(`
      alter role velora_media_gateway nologin password null;
      delete from public.movie_versions where movie_id in (select id from public.movies where slug like 'e12a-%');
      delete from public.movies where slug like 'e12a-%';
      delete from public.vjs where slug = 'e12a-live';
      delete from private.telegram_media where file_unique_id like 'e12a-unique-%';
      delete from private.telegram_channels where bot_type = 'movie';
      ${previousChannel ? `insert into private.telegram_channels (bot_type, chat_id) values ('movie', ${Number(previousChannel)});` : ""}`);
  });

  /** Runs the real adapter inside the gateway package (where its `postgres` dependency lives). */
  function adapter(url: string, versionIds: number[]) {
    const script = `
      const { createPgResolver } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "services/media-gateway/pg-resolver.mts")).href)});
      const resolver = createPgResolver(process.env.E12A_URL, { maxConnections: 1 });
      const state = await resolver.check();
      const resolved = {};
      for (const id of JSON.parse(process.env.E12A_IDS)) {
        try { resolved[id] = await resolver.resolveMovieVersion(id, new AbortController().signal); } catch (e) { resolved[id] = "error:" + e.code; }
      }
      await resolver.close();
      process.stdout.write(JSON.stringify({ state, resolved }));`;
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(join(ROOT, "scripts/ingest/register.mjs")).href, "--input-type=module", "-e", script], {
      cwd: join(ROOT, "services/media-gateway"),
      // A minimal environment: the child sees only the URL under test, never the operator's .env.local.
      env: { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, E12A_URL: url, E12A_IDS: JSON.stringify(versionIds) },
      encoding: "utf8",
    });
    return JSON.parse(out) as { state: string; resolved: Record<string, unknown> };
  }

  it("is ready as the restricted role and resolves only the published version", () => {
    const result = adapter(restrictedUrl, [versions["e12a-live"], versions["e12a-hidden"], 999_999_999]);
    expect(result.state).toBe("reachable");
    expect(result.resolved[versions["e12a-live"]]).toEqual({
      movieVersionId: versions["e12a-live"], chatId: String(MOVIES), messageId: 9501, fileUniqueId: "e12a-unique-1", fileSize: 1_004_462_878, mimeType: "video/x-matroska",
    });
    expect(result.resolved[versions["e12a-hidden"]]).toBeNull();
    expect(result.resolved[999_999_999]).toBeNull();
  });

  it("never becomes ready with the owner credential (no fallback)", () => {
    expect(adapter(ownerUrl, []).state).toBe("wrong_identity");
  });

  it("is unreachable with a wrong password", () => {
    expect(adapter(restrictedUrl.replace(password, "wrong-password"), []).state).toBe("unreachable");
  });
});
