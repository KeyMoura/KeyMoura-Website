-- Rollback for 20260810110000_support_truncate_lockdown.
--
-- Restores the privilege the migration removed. Worth stating plainly: running
-- this re-opens the hole — it makes `support_messages` truncatable again by
-- anything holding the service key, which defeats the append-only guarantee that
-- table exists to provide. It is here for completeness, not because there is a
-- reason to run it.

begin;

grant truncate on public.support_messages to service_role;
grant truncate on public.support_conversations to service_role;
grant truncate on public.staff_support_queue to service_role;

notify pgrst, 'reload schema';

commit;
