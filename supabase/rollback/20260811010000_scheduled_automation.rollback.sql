-- Rollback for 20260811010000_scheduled_automation.
--
-- The migration was purely additive — two new tables and one new function — so
-- the rollback is a clean removal and nothing that existed beforehand is touched.
--
-- Order matters: the function's return type is `setof public.scheduled_jobs`, so
-- it depends on the table and must go first. Dropping the table while the
-- function still references it would fail, or would silently leave a function
-- whose return type no longer exists.
--
-- What is deliberately NOT here: no `commerce_settings` edit. The automation
-- timing block lives inside that column's JSON, and removing it would rewrite a
-- row this migration never wrote. `parseAutomationSettings` treats an absent
-- block as the defaults, so leaving it costs nothing and touching it would mean
-- editing settings the operator chose.

begin;

-- The four seeded templates. Removed by key, and only these four: the seed used
-- `on conflict do nothing`, so any row here is one this migration created.
delete from public.email_templates
where key in ('quote_expiring', 'pickup_reminder', 'customer_action_required_reminder', 'support_waiting_customer');

drop function if exists public.claim_scheduled_jobs(integer, text, integer);

drop index if exists public.scheduled_jobs_failed_idx;
drop index if exists public.scheduled_jobs_type_state_idx;
drop index if exists public.scheduled_jobs_entity_idx;
drop index if exists public.scheduled_jobs_lease_idx;
drop index if exists public.scheduled_jobs_due_idx;
drop index if exists public.automation_runs_started_idx;

drop table if exists public.scheduled_jobs;
drop table if exists public.automation_runs;

commit;
