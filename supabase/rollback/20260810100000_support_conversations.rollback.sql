-- Rollback for 20260810100000_support_conversations.
--
-- The migration is purely additive, so the rollback is a clean drop. Nothing it
-- created is depended on by an object that existed before it, and no existing
-- row was written — so this restores the schema exactly, not approximately.
--
-- ORDER MATTERS. `support_messages` carries a BEFORE DELETE trigger that refuses
-- every delete, so `drop table` is used rather than `delete from`: DDL drops the
-- table and its triggers together and is never intercepted by them. The view is
-- dropped first because it depends on both tables.

begin;

drop view if exists public.staff_support_queue;

drop trigger if exists support_messages_no_rewrite on public.support_messages;
drop trigger if exists support_conversations_identity_guard on public.support_conversations;
drop trigger if exists support_conversations_assign_reference on public.support_conversations;

drop table if exists public.support_messages;
drop table if exists public.support_conversations;

drop function if exists public.support_messages_append_only();
drop function if exists public.support_conversations_guard();
drop function if exists public.assign_support_reference();

drop sequence if exists public.keymoura_support_number_seq;

-- Role grants before the permission rows they reference.
delete from public.role_permissions
where permission_key in ('support.view','support.reply','support.manage','support.assign');

delete from public.user_permissions
where permission_key in ('support.view','support.reply','support.manage','support.assign');

delete from public.permissions
where key in ('support.view','support.reply','support.manage','support.assign');

delete from public.email_templates
where key in ('support_received','support_staff_reply','support_resolved','support_staff_new');

notify pgrst, 'reload schema';

commit;
