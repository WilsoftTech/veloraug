import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESOLVE_MOVIE_VERSION_SQL, locatorFromRow } from "@/lib/media-gateway/resolver-sql";

/**
 * E1.2: the media gateway's catalogue query against the LOCAL database (never
 * hosted). Fixtures are created and the query is run inside one transaction
 * that is always rolled back, so the database is left exactly as it was. The
 * statement under test is the exact constant the gateway adapter executes,
 * wrapped in a pg_temp function so each case can be selected by label.
 */

const PROJECT_ID = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(__dirname, "../../supabase/config.toml"), "utf8"))![1];
const MOVIES = -1007777777777;
const OTHER_CHAT = -1008888888888;

function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", `supabase_db_${PROJECT_ID}`, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-F", "|"], { input: sql, encoding: "utf8" }).trim();
}

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

insert into e12_case values ('unknown_id', 999999999), ('fuze_style_media_only', null);

create function pg_temp.e12_resolve(bigint) returns table (
  media_id bigint, chat_id text, message_id bigint, file_unique_id text, file_size_bytes bigint, mime_type text
) language sql as $e12$ ${RESOLVE_MOVIE_VERSION_SQL} $e12$;

select c.label, r.media_id, r.chat_id, r.message_id, r.file_unique_id, r.file_size_bytes, r.mime_type
  from e12_case c left join lateral pg_temp.e12_resolve(c.version_id) r on true
 order by c.label;
rollback;
`;

describe("media gateway catalogue resolver (local database)", () => {
  const rows = new Map(
    psql(CASES)
      .split(/\r?\n/)
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [label, mediaId, chatId, messageId, fileUniqueId, fileSize, mimeType] = line.split("|");
        return [label, mediaId ? { media_id: mediaId, chat_id: chatId, message_id: messageId, file_unique_id: fileUniqueId, file_size_bytes: fileSize, mime_type: mimeType || null } : null];
      }),
  );

  it("covers every fixture case", () => {
    expect([...rows.keys()].sort()).toEqual(
      ["fuze_style_media_only", "inactive_vj", "movie_archived", "movie_draft", "no_recorded_size", "published", "rights_blocked", "rights_unknown", "unknown_id", "unregistered_channel", "version_archived", "version_not_ready", "version_unavailable"].sort(),
    );
  });

  it("resolves a published, ready, cleared version with an active VJ in the registered channel", () => {
    const locator = locatorFromRow(rows.get("published") ?? undefined);
    expect(locator).toMatchObject({ chatId: String(MOVIES), messageId: 9001, fileUniqueId: "e12-unique-1", fileSize: 1_004_462_878, mimeType: "video/x-matroska" });
  });

  it.each([
    "movie_draft",
    "movie_archived",
    "version_not_ready",
    "version_unavailable",
    "version_archived",
    "inactive_vj",
    "rights_blocked",
    "rights_unknown",
    "unregistered_channel",
    "no_recorded_size",
    "unknown_id",
    "fuze_style_media_only",
  ])("returns nothing for %s", (label) => {
    expect(rows.get(label)).toBeNull();
  });

  it("left the database unchanged (the transaction rolled back)", () => {
    expect(psql("select count(*) from public.movies where slug like 'e12-%'")).toBe("0");
    expect(psql("select count(*) from private.telegram_media where file_unique_id like 'e12-%'")).toBe("0");
  });
});
