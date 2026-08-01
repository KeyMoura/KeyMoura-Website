begin;

alter table public.orders
  add column if not exists quote_expires_at timestamptz,
  add column if not exists amount_refunded_cents integer not null default 0
    check (amount_refunded_cents >= 0),
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text
    check (cancellation_reason is null or char_length(cancellation_reason) <= 1000);

create table if not exists public.order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  stripe_payment_intent_id text not null unique,
  amount_cents integer not null check (amount_cents >= 50),
  amount_refunded_cents integer not null default 0
    check (amount_refunded_cents between 0 and amount_cents),
  received_at timestamptz not null default now()
);

create table if not exists public.order_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  order_payment_id uuid not null references public.order_payments(id),
  stripe_refund_id text not null unique,
  amount_cents integer not null check (amount_cents >= 1),
  reason text not null check (char_length(btrim(reason)) between 3 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists order_payments_order_idx
  on public.order_payments(order_id, received_at desc);
create index if not exists order_refunds_order_idx
  on public.order_refunds(order_id, created_at desc);

alter table public.order_payments enable row level security;
alter table public.order_refunds enable row level security;

drop policy if exists "participants read order payments" on public.order_payments;
create policy "participants read order payments" on public.order_payments
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_id and
      (o.customer_id = (select auth.uid()) or (select public.is_staff_user())))
  );

drop policy if exists "participants read order refunds" on public.order_refunds;
create policy "participants read order refunds" on public.order_refunds
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_id and
      (o.customer_id = (select auth.uid()) or (select public.is_staff_user())))
  );

grant select on public.order_payments, public.order_refunds to authenticated;
grant select, insert, update, delete on public.order_payments, public.order_refunds to service_role;

notify pgrst, 'reload schema';
commit;
