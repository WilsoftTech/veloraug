-- Checkpoint 5, preparation only. Depends on the existing gateway resolver;
-- deliberately independent of both CP4 migrations and the pending admin chain.
-- The existing resolver dynamically enforces the installed publication/rights policy.
begin;
create function media_gateway.resolve_movie_download(p_movie_version_id bigint,p_subject uuid)
returns table(chat_id bigint,message_id bigint,file_unique_id text,file_size_bytes bigint,mime_type text,file_name text)
language sql stable security definer set search_path='' as $$
  select r.chat_id,r.message_id,r.file_unique_id,r.file_size_bytes,r.mime_type,t.file_name
  from media_gateway.resolve_movie_version(p_movie_version_id) r
  join public.movie_versions mv on mv.id=p_movie_version_id
  join private.telegram_media t on t.id=mv.telegram_media_id
    and t.chat_id=r.chat_id and t.message_id=r.message_id and t.file_unique_id=r.file_unique_id
  where r.mime_type in ('video/mp4','video/x-matroska')
    and r.file_size_bytes between 1 and 2097152000
    -- The current entitlement policy admits all authenticated, non-anonymous users.
    -- Future subscription policy must update this check together with the issuer.
    and exists(select 1 from auth.users u where u.id=p_subject
      and not coalesce(u.is_anonymous,false) and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()))
$$;
revoke all on function media_gateway.resolve_movie_download(bigint,uuid) from public,anon,authenticated,service_role,velora_discovery_worker,velora_review_service,velora_media_gateway;
grant execute on function media_gateway.resolve_movie_download(bigint,uuid) to velora_media_gateway;
comment on function media_gateway.resolve_movie_download(bigint,uuid) is
  'Original MP4/MKV location and filename for an eligible signed capability subject; gateway role only, no write authority.';
commit;
