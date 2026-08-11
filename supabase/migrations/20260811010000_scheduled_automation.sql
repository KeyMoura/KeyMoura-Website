-- Scheduled operational automation: the durable job model and the run log.
--
-- WHY A TABLE AT ALL
--
-- Cron must not be the source of truth. A schedule that lives only in a cron
-- expression cannot answer "was this reminder already sent?", and that is the
-- one question the whole feature turns on. Vercel can invoke a route twice, a
-- deployment can restart mid-send, two regions can wake at the same instant, and
-- a network timeout can land after the provider already accepted the message.
-- Every one of those is a duplicate email to a customer unless something durable
-- says otherwise.
--
-- So cron wakes a worker, and *this* table decides what needs doing. The unique
-- `dedupe_key` is what makes a second attempt at the same logical reminder
-- unrepresentable rather than merely unlikely, exactly as `email_deliveries`
-- does for the send itself. The two guards are deliberately layered: this one
-- stops the work being scheduled twice, that one stops the message leaving twice.
--
-- ADDITIVE. Two new tables, one new function. No existing table, column, policy,
-- trigger or row is altered. Nothing that exists today changes behaviour.

begin;

-- ---------------------------------------------------------------------------
-- The job model
-- ---------------------------------------------------------------------------

create table if not exists public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Validated against `lib/automation/catalogue.ts` by the test suite rather
  -- than by a CHECK constraint. A new reminder type should not need a migration,
  -- and a constraint listing job types would be a second catalogue to keep in
  -- step with the first.
  job_type text not null,

  -- What the job is about. `entity_id` is nullable so a maintenance job that
  -- belongs to no single row can still be represented.
  entity_type text not null,
  entity_id uuid,

  -- When it becomes due. Always UTC: every threshold in this system is computed
  -- from stored instants, and no part of the worker consults a local timezone.
  run_at timestamptz not null,

  state text not null default 'pending',

  -- The durable identity of one logical reminder. Unique, and that uniqueness is
  -- the point of the column: `pickup_reminder:<order>:day3` can exist once, so
  -- a discovery pass that runs every fifteen minutes writes it once.
  dedupe_key text not null,

  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,

  -- Why a job was abandoned, in the worker's own words. Never a provider payload
  -- and never a row value.
  cancel_reason text,
  failure_category text,
  -- A sanitized one-line summary. The handler decides what goes here; secrets,
  -- provider bodies and Postgres `details` fields never do.
  last_error text,

  metadata jsonb not null default '{}'::jsonb,

  -- Claim bookkeeping. A worker that dies mid-job leaves the row in `running`
  -- with a lease that has passed, and the next invocation reclaims it. Without
  -- the lease, one crash would strand a reminder in `running` forever.
  locked_at timestamptz,
  lease_expires_at timestamptz,
  worker_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint scheduled_jobs_state_check
    check (state in ('pending', 'running', 'completed', 'cancelled', 'failed')),
  constraint scheduled_jobs_dedupe_key_unique unique (dedupe_key),
  constraint scheduled_jobs_attempts_sane check (attempt_count >= 0 and attempt_count <= 100)
);

-- The hot path: "what is due right now". Partial, because the table is mostly
-- finished work and a full index over completed rows would be read never.
create index if not exists scheduled_jobs_due_idx
  on public.scheduled_jobs (run_at)
  where state = 'pending';

-- Reclaiming a job whose worker died.
create index if not exists scheduled_jobs_lease_idx
  on public.scheduled_jobs (lease_expires_at)
  where state = 'running';

-- "Has this entity already been reminded?" — asked by every discovery pass
-- before it schedules anything.
create index if not exists scheduled_jobs_entity_idx
  on public.scheduled_jobs (entity_type, entity_id);

-- The staff list, which filters by type and state.
create index if not exists scheduled_jobs_type_state_idx
  on public.scheduled_jobs (job_type, state);

-- The failures panel, newest first.
create index if not exists scheduled_jobs_failed_idx
  on public.scheduled_jobs (updated_at desc)
  where state = 'failed';

-- ---------------------------------------------------------------------------
-- The run log
-- ---------------------------------------------------------------------------
--
-- One row per worker invocation. This is what makes "is automation healthy?"
-- answerable without inferring it from the absence of complaints: a scheduler
-- that stopped being invoked looks exactly like a scheduler with nothing to do,
-- unless something records the heartbeat.
--
-- Deliberately *not* written to the audit log. A heartbeat every fifteen minutes
-- is 2,880 rows a month of "nothing happened", which would bury the log that
-- exists to show what people did.

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null default 'running',
  -- `cron` or `manual`. A staff member running the worker by hand is a real
  -- event and should not be mistaken for the schedule working.
  trigger text not null default 'cron',
  discovered integer not null default 0,
  claimed integer not null default 0,
  completed integer not null default 0,
  cancelled integer not null default 0,
  failed integer not null default 0,
  reservations_expired integer not null default 0,
  guest_codes_purged integer not null default 0,
  duration_ms integer,
  error text,
  constraint automation_runs_outcome_check
    check (outcome in ('running', 'success', 'partial', 'failed')),
  constraint automation_runs_trigger_check
    check (trigger in ('cron', 'manual'))
);

create index if not exists automation_runs_started_idx
  on public.automation_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------
--
-- The one guarantee that matters: two workers running at the same instant must
-- not both send the same reminder.
--
-- `for update skip locked` inside the subquery is what provides it. Each worker
-- locks a disjoint set of rows and moves them to `running` in the *same*
-- statement, so there is no window where a row is selected but not yet claimed.
-- The second worker does not block and does not wait; it simply gets different
-- rows, or none.
--
-- The same statement also picks up `running` rows whose lease has passed, which
-- is how a job survives its worker being killed mid-flight. `attempt_count` goes
-- up on every claim, so a job that repeatedly kills its worker still exhausts
-- its attempts rather than looping forever.

create or replace function public.claim_scheduled_jobs(
  p_limit integer default 50,
  p_worker text default 'worker',
  p_lease_seconds integer default 300
)
returns setof public.scheduled_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.scheduled_jobs j
     set state            = 'running',
         locked_at        = now(),
         lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 300), 900))),
         worker_id        = left(coalesce(p_worker, 'worker'), 80),
         attempt_count    = j.attempt_count + 1,
         last_attempt_at  = now(),
         updated_at       = now()
   where j.id in (
     select c.id
       from public.scheduled_jobs c
      where (c.state = 'pending' and c.run_at <= now())
         or (c.state = 'running' and c.lease_expires_at is not null and c.lease_expires_at < now())
      order by c.run_at asc
      -- Bounded here as well as in the caller. A batch limit that only exists in
      -- application code is a batch limit one bad request removes.
      limit greatest(1, least(coalesce(p_limit, 50), 200))
      for update skip locked
   )
  returning j.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Neither table is reachable from a browser session, by anyone, ever. A customer
-- has no business enumerating scheduled reminders, and staff read these rows
-- through `/api/staff/automation`, which authorises with `automation.view` and
-- queries with the service key. That is the same shape the support inbox uses.
--
-- RLS is enabled with no policies. `service_role` bypasses RLS, so the effect is
-- "service key only" stated twice — once by the grant and once by the policy set
-- — which is deliberate belt-and-braces on a table that decides what gets emailed
-- to customers.

alter table public.scheduled_jobs enable row level security;
alter table public.automation_runs enable row level security;

revoke all on public.scheduled_jobs from public;
revoke all on public.scheduled_jobs from anon;
revoke all on public.scheduled_jobs from authenticated;
-- DELETE is granted because retention pruning is a real operation the worker
-- performs: finished jobs older than the retention window are removed so the
-- table stays the size of the work in flight rather than the work ever done.
grant select, insert, update, delete on public.scheduled_jobs to service_role;

revoke all on public.automation_runs from public;
revoke all on public.automation_runs from anon;
revoke all on public.automation_runs from authenticated;
grant select, insert, update, delete on public.automation_runs to service_role;

-- The hole pass 22 had to come back for, closed in the same migration this time.
--
-- Supabase's default privileges hand `service_role` TRUNCATE on every new table
-- in `public`, and `revoke all ... from public/anon/authenticated` does not touch
-- it. "Empty the entire schedule in one statement" is not an operation this
-- application has, and a bounded DELETE is.
revoke truncate on public.scheduled_jobs from service_role;
revoke truncate on public.automation_runs from service_role;

revoke all on function public.claim_scheduled_jobs(integer, text, integer) from public;
revoke all on function public.claim_scheduled_jobs(integer, text, integer) from anon;
revoke all on function public.claim_scheduled_jobs(integer, text, integer) from authenticated;
grant execute on function public.claim_scheduled_jobs(integer, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------
--
-- Four new customer templates, one per reminder that reaches a person by email.
-- The staff reminders get no template because they do not send email: they raise
-- an operational alert into the bell those people already read.
--
-- Every placeholder below is drawn from `CUSTOMER_SAFE_VARIABLES` in
-- `lib/comms/emailEvents.ts`, and `tests/transactional-emails.test.ts` asserts
-- that a seeded template cannot reference a variable nothing supplies — an
-- unknown one is substituted with an empty string, so the failure mode is a
-- sentence that quietly loses a word rather than an error anybody sees.
-- (That test greps every migration for brace-wrapped names, so this comment
-- deliberately does not spell one out.)
--
-- `on conflict do nothing` so re-running the migration cannot overwrite wording a
-- staff member has since edited. The templates are seeds, not the source of truth.

insert into public.email_templates (key, name, subject, heading, body, button_label) values
  ('quote_expiring',
   'Quote expiring soon',
   'Your quote expires {{date}} — {{order_label}}',
   'Your quote is about to run out',
   E'Your quote for {{product_name}} is valid until {{date}}.'
   || E'\n\nThe total is {{price}}. If you would still like to go ahead, you can pay from the link below and we will get started.'
   || E'\n\nIf the date passes we can always re-quote — prices and lead times may have moved by then.',
   'Review and pay'),
  ('pickup_reminder',
   'Order waiting for collection',
   'Still waiting for you — {{order_label}}',
   'Your order is ready to collect',
   E'{{product_name}} has been ready since {{date}} and is waiting for you at {{pickup_location}}.'
   || E'\n\n{{pickup_instructions}}'
   || E'\n\nIf you would rather it was posted, or something has changed, just reply and we will sort it out.',
   'View your order'),
  ('customer_action_required_reminder',
   'Waiting on you',
   'We need something from you — {{order_label}}',
   'We are waiting on you',
   E'Your order for {{product_name}} is on hold because we need something from you before we can carry on.'
   || E'\n\n{{detail}}'
   || E'\n\nOpen the order to see what is outstanding. If this is no longer wanted, tell us and we will close it off.',
   'Open your order'),
  ('support_waiting_customer',
   'Support request waiting on you',
   'Still there? — {{support_reference}}',
   'We are waiting to hear back',
   E'We replied to {{support_reference}} — {{support_subject}} — and have not heard back.'
   || E'\n\nIf you still need a hand, reply and we will pick it straight back up. If it is sorted, you can ignore this and we will close it off in due course.',
   'Read and reply')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

commit;
