-- Emergency rollback for 20260811030000_security_boundary_hardening.
drop policy if exists "profiles own or staff read" on public.profiles;
create policy "profiles readable" on public.profiles for select to anon, authenticated using (true);
grant select on table public.profiles, public.roles, public.permissions to anon, authenticated;
grant truncate on table
  public.profiles, public.user_roles, public.user_permissions, public.role_permissions,
  public.orders, public.order_items, public.order_messages, public.order_status_history,
  public.stripe_webhook_events, public.guest_order_access_codes,
  public.production_jobs, public.production_job_tasks, public.production_job_files,
  public.support_conversations, public.support_messages, public.audit_logs,
  public.email_deliveries, public.scheduled_jobs
to service_role;
