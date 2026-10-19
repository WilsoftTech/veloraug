-- Velora UG: automatic whole-file media verification (2026-10-18, owner request).
--
-- The keyed verification of migration 20261014090000 checks one named
-- candidate. This adds the one thing an automatic verifier needs and the
-- worker cannot see for itself: which candidates are due. The verifier then
-- claims each of them through the unchanged discovery_claim_verification and
-- finishes through discovery_complete or discovery_fail, under the same
-- fenced lease. Nothing here records evidence, rights, approval or publication.
--
-- Due: a channel candidate awaiting review whose film and VJ a reviewer has
-- confirmed (the same rule as the keyed claim), not a duplicate, in the
-- registered Movies channel, within the verification contract's size limit,
-- and with no whole-file evidence for its current document since the last
-- reviewer request for a new check. A failed attempt waits p_retry_seconds,
-- and five failed attempts at one revision wait for a reviewer. A finished
-- verification, passing or not, is not repeated by itself: decoding the same
-- bytes again gives the same answer.
--
-- Depends only on migrations present on the hosted channel chain.

begin;

create function public.discovery_verification_due(p_limit integer, p_retry_seconds integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 or p_retry_seconds is null or p_retry_seconds not between 60 and 604800 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(x.discovery_key order by x.received_at, x.id)
    from (
      select r.discovery_key, e.received_at, e.id
      from private.channel_reviews r
      join private.ingestion_events e on e.id = r.ingestion_event_id
      join private.telegram_media m on m.id = e.telegram_media_id
      cross join lateral (select private.channel_media_identity(m.chat_id, m.message_id, m.file_unique_id, m.file_size_bytes) as identity) i
      where e.origin = 'channel' and e.status = 'needs_review'
        and r.identity_state = 'confirmed' and r.tmdb_id is not null and r.vj_id is not null
        and r.duplicate_of_media_id is null and i.identity is not null
        and m.file_size_bytes between 1 and 2097152000
        and exists (select 1 from private.telegram_channels c where c.bot_type = 'movie' and c.chat_id = m.chat_id)
        and not exists (
          select 1 from private.media_evidence ev
          where ev.telegram_media_id = m.id and ev.media_identity = i.identity and ev.scope = 'whole_file'
            and ev.checked_at > coalesce((select max(a.created_at) from private.channel_review_audit a
                                          where a.ingestion_event_id = e.id and a.action = 'reinspection_requested'), '-infinity'::timestamptz))
        and not exists (
          select 1 from private.channel_review_audit a
          where a.ingestion_event_id = e.id and a.actor_kind = 'worker' and a.action = 'inspection_failed'
            and a.created_at > now() - make_interval(secs => p_retry_seconds))
        and (select count(*) from private.channel_review_audit a
             where a.ingestion_event_id = e.id and a.actor_kind = 'worker' and a.action = 'inspection_failed'
               and a.review_revision = r.review_revision) < 5
      order by e.received_at, e.id
      limit p_limit) x), '[]'::jsonb);
end;
$$;

-- The evidence producers only: the worker's own role and the service role.
revoke all on function public.discovery_verification_due(integer, integer)
  from public, anon, authenticated, service_role, velora_discovery_worker, velora_review_service, velora_media_gateway;
grant execute on function public.discovery_verification_due(integer, integer) to service_role, velora_discovery_worker;

commit;
