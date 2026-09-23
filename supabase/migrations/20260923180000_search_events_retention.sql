-- Velora UG: retention for anonymous raw search analytics.
--
-- Policy (explicit Velora UG product/engineering decision, 2026-09-23; see
-- docs/HOSTED_BOOTSTRAP_AUDIT.md, "Pre-B hardening"):
--   private.search_events   raw anonymous events are kept for 30 days.
--   public.search_history   unchanged: newest 20 per user, removed with the
--                           account. This policy does not apply to it.
--   trending_searches       unchanged: reads the last 7 days.
--
-- Enforcement reuses private.purge_search_events from
-- 20260920181819_search_analytics_and_history.sql unchanged: it deletes only
-- from private.search_events, oldest first, at most one bounded batch per call,
-- and never anything newer than 7 days. The interval is passed explicitly and
-- is never NULL (Phase 3 audit, debt item 7).
--
-- Capacity: one daily run of 5000 deletes at most 5000 events per day. If
-- sustained volume exceeds that, the backlog grows; raise the cadence or batch
-- in a new migration rather than adding a second purge path.

-- Supabase installs pg_cron into pg_catalog; its objects live in the cron schema.
create extension if not exists pg_cron with schema pg_catalog;

-- cron.schedule with a job name upserts that job for the current role, so
-- re-running this migration on a fresh database yields exactly one job.
-- 00:17 UTC is 03:17 in Kampala (EAT, UTC+3): low traffic, off the hour mark.
-- The job runs as the migration role (postgres), which owns the purge function;
-- no client role gains EXECUTE on it.
select cron.schedule(
  'velora-purge-search-events',
  '17 0 * * *',
  $$select private.purge_search_events(interval '30 days', 5000)$$
);

-- Privilege audit. Neither the cron schema nor the purge function is
-- client-facing. pg_cron's own install (owned by supabase_admin) grants PUBLIC
-- EXECUTE on schedule/unschedule and SELECT on cron.job/job_run_details, which
-- postgres cannot revoke. Those grants are unreachable: PUBLIC, anon and
-- authenticated have no USAGE on schema cron, cron is not an exposed API schema,
-- and the job tables apply RLS by username. The revokes below state the intended
-- client posture explicitly instead of relying on defaults. cron's sequences are
-- omitted: postgres holds no grant option on them, so a revoke there is a no-op
-- that only emits warnings, and no client role holds a direct grant on them.
revoke all on schema cron from anon, authenticated;
revoke all on all tables in schema cron from anon, authenticated;
revoke all on all functions in schema cron from anon, authenticated;
revoke all on function private.purge_search_events(interval, integer) from public, anon, authenticated;
