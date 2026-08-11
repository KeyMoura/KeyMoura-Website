-- The thing that wakes the worker.
--
-- WHY POSTGRES AND NOT VERCEL
--
-- The first attempt was a `vercel.json` cron at `*/15 * * * *`. The deploy was
-- refused: **Vercel Hobby caps cron at once per day**, and this system's useful
-- cadence is fifteen minutes. Once a day would mean a quote-expiry warning
-- configured for 24 hours ahead could arrive up to 24 hours late — that is, at
-- or after the quote had already lapsed, which is precisely the failure the
-- reminder exists to prevent.
--
-- So the schedule lives here instead. `pg_cron` is already installed and has
-- been running `purge-expired-moderation-recycle-bin` nightly since
-- `20260729000000`, and that migration's own comment anticipated this one:
-- "Projects without it can call the function daily from a protected Vercel cron
-- route in a later migration."
--
-- It also puts the schedule in the same database as the job table it drives,
-- which is where it belongs. `pg_cron` alone could never have done this job —
-- it runs SQL and the worker has to reach Resend — so the HTTP hop through
-- `pg_net` is doing the one thing SQL cannot.
--
-- ADDITIVE. One extension, one function, one schedule. No existing table,
-- column, policy, trigger, row or cron entry is altered. The recycle-bin job is
-- left exactly as it is.
--
-- CONFIGURATION REQUIRED BEFORE THIS DOES ANYTHING
--
-- Two secrets, neither of which is in this file and neither of which may be:
--
--   1. `CRON_SECRET` in the Vercel project's Production environment.
--   2. A Vault secret named `automation_cron_secret`, holding the same value.
--
-- Until both exist the trigger returns without making a request, and the
-- endpoint refuses every caller. That is deliberate on both sides: a scheduler
-- that fires at an unconfigured endpoint would log a 401 every fifteen minutes
-- forever, and an endpoint that ran without a secret would be public.

begin;

-- `pg_cron` can run SQL and nothing else. This is how the schedule reaches a
-- Node runtime that can render a template and talk to the mail provider.
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------
--
-- Deliberately dumb. It makes one authenticated GET and does not care what comes
-- back: the worker is idempotent, records its own run in `automation_runs`, and
-- is the only thing that knows what "success" means. A trigger that tried to
-- interpret the response would be a second, worse source of truth about whether
-- automation is healthy — and the staff page already reads the first one.
--
-- `security definer` because `vault.decrypted_secrets` is not readable by the
-- `postgres` role that `pg_cron` runs jobs as by default.

create or replace function public.trigger_automation_worker()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'automation_cron_secret'
   limit 1;

  -- Not configured yet. Return quietly rather than calling the endpoint
  -- unauthenticated: a 401 every fifteen minutes is noise that teaches whoever
  -- reads the logs to ignore them.
  if v_secret is null or length(v_secret) = 0 then
    return;
  end if;

  perform net.http_get(
    url := 'https://keymoura.com/api/cron/automation',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    -- Comfortably past the worker's own 45-second budget and its outer
    -- 120-second route limit, so a slow run is waited out rather than reported
    -- as a timeout the worker never saw.
    timeout_milliseconds := 150000
  );
end;
$$;

revoke all on function public.trigger_automation_worker() from public;
revoke all on function public.trigger_automation_worker() from anon;
revoke all on function public.trigger_automation_worker() from authenticated;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
--
-- One entry. Ten would be ten things to configure, ten to get wrong, and ten
-- places to look when a reminder does not arrive — the worker reads the job
-- table and does whatever is due, which is the reason the job table exists.
--
-- Guarded so re-running the migration does not create a second schedule, in the
-- same shape `20260729000000` used for the recycle-bin job.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'automation-worker') then
      perform cron.schedule(
        'automation-worker',
        '*/15 * * * *',
        'select public.trigger_automation_worker()'
      );
    end if;
  end if;
end;
$$;

commit;
