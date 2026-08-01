begin;

alter table public.orders
  add column if not exists deposit_amount_cents integer check (deposit_amount_cents is null or deposit_amount_cents >= 50),
  add column if not exists quote_revision integer not null default 0,
  add column if not exists quote_accepted_at timestamptz;

create table if not exists public.order_request_drafts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled custom request' check (char_length(title) between 1 and 120),
  request_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_quotes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  revision integer not null,
  total_cents integer not null check (total_cents >= 50),
  deposit_cents integer check (deposit_cents is null or deposit_cents between 50 and total_cents),
  note text check (note is null or char_length(note) <= 2000),
  created_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(order_id, revision)
);

create index if not exists order_request_drafts_customer_idx on public.order_request_drafts(customer_id, updated_at desc);
create index if not exists order_quotes_order_idx on public.order_quotes(order_id, revision desc);

alter table public.order_request_drafts enable row level security;
alter table public.order_quotes enable row level security;

drop policy if exists "customers manage own request drafts" on public.order_request_drafts;
create policy "customers manage own request drafts" on public.order_request_drafts for all to authenticated
  using ((select auth.uid()) = customer_id)
  with check ((select auth.uid()) = customer_id);

drop policy if exists "participants read order quotes" on public.order_quotes;
create policy "participants read order quotes" on public.order_quotes for select to authenticated using (
  exists(select 1 from public.orders o where o.id=order_id and (o.customer_id=(select auth.uid()) or (select public.is_staff_user())))
);
drop policy if exists "staff manage order quotes" on public.order_quotes;
create policy "staff manage order quotes" on public.order_quotes for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

grant select, insert, update, delete on public.order_request_drafts, public.order_quotes to authenticated, service_role;
notify pgrst, 'reload schema';
commit;
