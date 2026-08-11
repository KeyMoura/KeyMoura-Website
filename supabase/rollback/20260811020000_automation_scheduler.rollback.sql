-- Rollback for 20260811020000_automation_scheduler.
--
-- Unschedules the job and drops the trigger function. After this, nothing wakes
-- the worker: the job table, the endpoint and the staff page all remain, and
-- `Run now` on /staff/settings/automation still works. Automation goes dormant
-- rather than broken.
--
-- Order matters: the schedule references the function by name in its command
-- string, so it is removed first.
--
-- What is deliberately NOT here:
--
--   * `drop extension pg_net` — other things may come to depend on it, and
--     dropping an extension to undo one function that used it is a wider change
--     than this migration made.
--   * `cron.unschedule('purge-expired-moderation-recycle-bin')` — that job
--     belongs to 20260729000000 and this migration never touched it.
--   * Any deletion of the Vault secret. It was created by hand outside a
--     migration and is not this file's to remove.

begin;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'automation-worker') then
      perform cron.unschedule('automation-worker');
    end if;
  end if;
end;
$$;

drop function if exists public.trigger_automation_worker();

commit;
