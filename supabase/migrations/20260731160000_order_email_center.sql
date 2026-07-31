-- Corrected 2026-07-31: every email template row supplies all six INSERT columns.
begin;

alter table public.site_settings
  add column if not exists email_config jsonb not null default '{"enabled":true,"fromName":"KeyMoura","fromEmail":"orders@keymoura.com","replyTo":"support@keymoura.com","staffNotificationEmail":"","sendCustomerMessages":true,"sendStatusUpdates":true,"sendPaymentUpdates":true}'::jsonb;

create table if not exists public.email_templates (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  name text not null,
  subject text not null check (char_length(subject) between 1 and 200),
  heading text not null check (char_length(heading) between 1 and 200),
  body text not null check (char_length(body) between 1 and 5000),
  button_label text not null default 'View order' check (char_length(button_label) between 1 and 80),
  is_enabled boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  template_key text references public.email_templates(key) on delete set null,
  recipient text not null,
  subject text not null,
  status text not null check (status in ('sent','failed','skipped')),
  provider_id text,
  error_message text,
  event_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists email_deliveries_order_idx on public.email_deliveries(order_id, created_at desc);

insert into public.email_templates(key,name,subject,heading,body,button_label) values
  ('request_received','Request received','We received your {{product_name}} request','Request received','Thanks, {{customer_name}}. We received your request for {{product_name}} and will review the details shortly.','View request'),
  ('staff_new_request','Staff: new request','New request: {{product_name}}','New order request','{{customer_name}} submitted a new request for {{product_name}}.','Review request'),
  ('needs_information','More information needed','We need more information for {{order_label}}','A few more details are needed','We sent a message about {{product_name}}. Reply on the order page so we can continue your request.','Reply to KeyMoura'),
  ('quote_ready','Quote ready','Your {{order_label}} quote is ready','Your quote is ready','The final price for {{product_name}} is {{price}}. Review the order and pay securely when you are ready.','Review and pay'),
  ('status_update','Order update: {{status}}','{{order_label}} is now {{status}}','Order status updated','Your {{product_name}} order is now {{status}}. Open the order page for the latest details.','View order'),
  ('customer_message','Customer message','New message about {{order_label}}','You have a new message','KeyMoura sent you a new message about {{product_name}}.','Read message'),
  ('staff_message','Staff: customer message','Customer message: {{order_label}}','New customer message','{{customer_name}} sent a new message about {{product_name}}.','Read message'),
  ('payment_received','Payment received','Payment received for {{order_label}}','Payment received','We received your payment of {{price}} for {{product_name}}. Your order is now in progress.','View order')
on conflict (key) do nothing;

alter table public.email_templates enable row level security;
alter table public.email_deliveries enable row level security;
revoke all on public.email_templates, public.email_deliveries from anon, authenticated;
grant select, insert, update, delete on public.email_templates, public.email_deliveries to service_role;
grant select, update on public.email_templates to authenticated;
grant select on public.email_deliveries to authenticated;

drop policy if exists "staff read email templates" on public.email_templates;
create policy "staff read email templates" on public.email_templates for select to authenticated
  using ((select public.is_staff_user()));
drop policy if exists "staff update email templates" on public.email_templates;
create policy "staff update email templates" on public.email_templates for update to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));
drop policy if exists "staff read email deliveries" on public.email_deliveries;
create policy "staff read email deliveries" on public.email_deliveries for select to authenticated
  using ((select public.is_staff_user()));

insert into public.permissions(key,name,description) values
 ('emails.manage','Manage email','Configure transactional email and edit order templates')
on conflict(key) do update set name=excluded.name,description=excluded.description;
insert into public.role_permissions(role_key,permission_key) values ('admin','emails.manage') on conflict do nothing;

notify pgrst, 'reload schema';
commit;
