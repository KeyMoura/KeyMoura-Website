-- Grant the production tables to the service role.
--
-- Repairs a defect in `20260804010000_production_jobs.sql`, which created four
-- tables and a sequence and enabled row level security on all of them, but
-- issued no `grant` statements at all.
--
-- Why that broke every read: this project's default privileges for new tables
-- in `public` are
--
--     postgres=arwdDxtm/postgres
--     anon=Dxtm/postgres
--     authenticated=Dxtm/postgres
--     service_role=Dxtm/postgres
--
-- `Dxtm` is TRUNCATE, REFERENCES, TRIGGER and MAINTAIN — there is no SELECT,
-- INSERT, UPDATE or DELETE in it. A new table in this database therefore starts
-- with *no* usable privilege for any of the three PostgREST roles, which is why
-- every other table-creating migration in this repository carries explicit
-- grants. This one was the only one that did not.
--
-- The failure surfaced as `42501: permission denied for table production_jobs`
-- on every request, because table privileges are checked *before* row level
-- security, and `service_role`'s BYPASSRLS attribute bypasses policies but not
-- grants. The policies were never reached and were never the problem.
--
-- Access model, unchanged from the original migration: these tables are
-- staff-only and every read and write goes through `/api/staff/production/*`,
-- which authenticates the caller and checks `production.view` or
-- `production.manage` before using the service role. Nothing is granted to
-- `anon` or to `authenticated`, and the four RLS policies from
-- `20260804010000` are left exactly as they are — this migration only adds the
-- privileges the API needs, and takes away the ones nothing needs.
--
-- The `revoke` lines are not redundant. Both roles inherited TRUNCATE from the
-- default ACL above, and TRUNCATE is not filtered by row level security.

begin;

-- ---------------------------------------------------------------------------
-- Nothing for anon or authenticated
-- ---------------------------------------------------------------------------

revoke all on public.production_jobs from anon, authenticated;
revoke all on public.production_job_tasks from anon, authenticated;
revoke all on public.production_job_files from anon, authenticated;
revoke all on public.production_job_events from anon, authenticated;
revoke all on sequence public.production_job_number_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The service role, which is what the staff API actually uses
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on public.production_jobs to service_role;
grant select, insert, update, delete on public.production_job_tasks to service_role;
grant select, insert, update, delete on public.production_job_files to service_role;

-- The timeline is append-only. `20260804010000` states that intent by giving it
-- select and insert policies and no update or delete policy; stating it here as
-- well makes it true at the privilege layer too, so a job's history cannot be
-- rewritten even by the service role. Cascade deletes still work: a referential
-- action runs as the table owner and does not consult the caller's privileges.
grant select, insert on public.production_job_events to service_role;

-- `production_jobs.job_number` defaults to `next_production_job_number()`, which
-- calls `nextval` on this sequence. The function is deliberately not SECURITY
-- DEFINER, so the sequence is touched as the *inserting* role — without this
-- grant, creating a job fails with `permission denied for sequence
-- production_job_number_seq` even once the table grants above are in place.
grant usage, select on sequence public.production_job_number_seq to service_role;

-- Explicit rather than relying on the PUBLIC execute default, so a later change
-- to default privileges cannot quietly break job creation.
grant execute on function public.next_production_job_number() to service_role;

notify pgrst, 'reload schema';

commit;
