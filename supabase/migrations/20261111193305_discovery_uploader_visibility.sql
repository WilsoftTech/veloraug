-- Read-only Discovery visibility for uploader-owned movies. Keep the original
-- ingestion, fingerprint, Telegram binding, evidence and publication gates intact.
create function public.discovery_upload_list(p_query text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_reviewer('any');
  if char_length(coalesce(p_query, '')) > 300 or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'discovery_invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id::text, 'title', coalesce(x.parsed->>'title', x.file_name, 'Untitled movie'),
      'fileName', x.file_name, 'vj', v.name, 'status', x.status,
      'sizeBytes', x.file_size_bytes, 'receivedAt', x.received_at,
      'mediaReady', coalesce(ev.scope = 'whole_file' and ev.integrity_status = 'verified' and ev.streaming_status = 'verified', false),
      'integrity', ev.integrity_status, 'streaming', ev.streaming_status
    ) order by x.received_at desc, x.id desc)
    from (
      select e.id, e.parsed, e.status, e.received_at, e.telegram_media_id, m.file_name, m.file_size_bytes
      from private.ingestion_events e
      join private.telegram_media m on m.id = e.telegram_media_id and m.bot_type = 'movie'
      where e.origin = 'uploader' and e.bot_type = 'movie' and e.upload_state = 'uploaded'
        and e.status not in ('published', 'rejected', 'ignored')
        and (coalesce(p_query, '') = '' or pg_catalog.strpos(
          pg_catalog.lower(coalesce(e.parsed->>'title', '') || ' ' || coalesce(m.file_name, '')),
          pg_catalog.lower(p_query)) > 0)
      order by e.received_at desc, e.id desc limit p_limit
    ) x
    left join public.vjs v on v.id::text = x.parsed->>'vj_id'
    left join lateral private.channel_current_evidence(x.telegram_media_id) ev on true
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.discovery_upload_list(text, integer) from public, anon, authenticated, service_role;
grant execute on function public.discovery_upload_list(text, integer) to authenticated;
comment on function public.discovery_upload_list(text, integer) is
  'Reviewer-only read of pending uploader movies; no file handles, private paths, rights decisions or write capability.';
