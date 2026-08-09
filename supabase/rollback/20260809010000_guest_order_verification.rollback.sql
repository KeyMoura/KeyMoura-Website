begin;
drop function if exists public.consume_guest_order_access_code(uuid,uuid,text,timestamptz);
drop function if exists public.record_guest_order_code_failure(uuid,integer);
drop function if exists public.replace_guest_order_access_code(uuid,text,timestamptz,integer);
drop table if exists public.guest_order_access_codes;
delete from public.email_templates where key = 'guest_order_access';
commit;
