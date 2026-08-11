-- SECURITY REVIEW: write-only migration. Do not apply without approval.
-- Profiles currently have an anonymous/authenticated USING (true) policy and
-- roles/permissions have browser SELECT grants. Object ids therefore bypass the
-- intended account/staff boundary.

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles own or staff read"
on public.profiles for select to authenticated
using (id = (select auth.uid()) or public.is_staff_user());

revoke select on table public.profiles from anon;
revoke select on table public.roles, public.permissions from anon, authenticated;

-- service_role bypasses RLS, but it does not need the ability to erase whole
-- security/customer tables in one statement. Row-level maintenance remains.
revoke truncate on table
  public.profiles,
  public.user_roles,
  public.user_permissions,
  public.role_permissions,
  public.orders,
  public.order_items,
  public.order_messages,
  public.order_status_history,
  public.stripe_webhook_events,
  public.guest_order_access_codes,
  public.production_jobs,
  public.production_job_tasks,
  public.production_job_files,
  public.support_conversations,
  public.support_messages,
  public.audit_logs,
  public.email_deliveries,
  public.scheduled_jobs
from service_role;
