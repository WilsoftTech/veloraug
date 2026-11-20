-- Original-file downloads for published episodes: the episode counterpart of
-- media_gateway.resolve_movie_download (20261011200813).
--
-- It depends only on media_gateway.resolve_episode_version (20261119194500), so
-- it is independent of the movie download resolver. The publication rule is the
-- episode resolver's own, re-evaluated on every call; this function only adds
-- the original filename, the original MP4/MKV containers, the 2000 MiB ceiling
-- and the same capability-subject check as the movie download resolver.
--
-- No table, column, policy or client grant changes. Privileges are set
-- explicitly below (AGENTS.md migration privilege invariant).
begin;

create function media_gateway.resolve_episode_download(p_episode_version_id bigint, p_subject uuid)
returns table (
  chat_id bigint,
  message_id bigint,
  file_unique_id text,
  file_size_bytes bigint,
  mime_type text,
  file_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.chat_id, r.message_id, r.file_unique_id, r.file_size_bytes, r.mime_type, t.file_name
    from media_gateway.resolve_episode_version(p_episode_version_id) r
    join public.episode_versions ev on ev.id = p_episode_version_id
    join private.telegram_media t
      on t.id = ev.telegram_media_id
     and t.chat_id = r.chat_id
     and t.message_id = r.message_id
     and t.file_unique_id = r.file_unique_id
   where r.mime_type in ('video/mp4', 'video/x-matroska')
     and r.file_size_bytes between 1 and 2097152000
     -- The current entitlement policy admits all authenticated, non-anonymous users.
     -- Future subscription policy must update this check together with the issuer.
     and exists (
       select 1 from auth.users u
        where u.id = p_subject
          and not coalesce(u.is_anonymous, false)
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= now())
     )
$$;

revoke all on function media_gateway.resolve_episode_download(bigint, uuid)
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
grant execute on function media_gateway.resolve_episode_download(bigint, uuid) to velora_media_gateway;
comment on function media_gateway.resolve_episode_download(bigint, uuid) is
  'Original MP4/MKV location and filename of a publicly playable episode version for an eligible signed capability subject; gateway role only, no write authority.';

-- The upload worker role exists only where the admin-upload chain is deployed.
do $$ begin
  if to_regrole('velora_upload_worker') is not null then
    execute 'revoke all on function media_gateway.resolve_episode_download(bigint, uuid) from velora_upload_worker';
  end if;
end $$;

commit;
