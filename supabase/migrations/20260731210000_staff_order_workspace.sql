begin;

create table if not exists public.order_workspaces (
  order_id uuid primary key references public.orders(id) on delete cascade,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assigned_to uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.order_checklist_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 240),
  is_complete boolean not null default false,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_cost_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  description text not null check (char_length(btrim(description)) between 1 and 240),
  category text not null default 'material' check (category in ('material','labor','shipping','service','other')),
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_cost_cents integer not null default 0 check (unit_cost_cents >= 0),
  billable boolean not null default false,
  notes text check (notes is null or char_length(notes) <= 1000),
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_workspaces_priority_idx on public.order_workspaces(priority, updated_at desc);
create index if not exists order_checklist_order_idx on public.order_checklist_items(order_id, sort_order, created_at);
create index if not exists order_costs_order_idx on public.order_cost_items(order_id, sort_order, created_at);

alter table public.order_workspaces enable row level security;
alter table public.order_checklist_items enable row level security;
alter table public.order_cost_items enable row level security;

drop policy if exists "staff manage order workspaces" on public.order_workspaces;
create policy "staff manage order workspaces" on public.order_workspaces for all to authenticated
using ((select public.is_staff_user())) with check ((select public.is_staff_user()));
drop policy if exists "staff manage order checklists" on public.order_checklist_items;
create policy "staff manage order checklists" on public.order_checklist_items for all to authenticated
using ((select public.is_staff_user())) with check ((select public.is_staff_user()));
drop policy if exists "staff manage order costs" on public.order_cost_items;
create policy "staff manage order costs" on public.order_cost_items for all to authenticated
using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

grant select, insert, update, delete on public.order_workspaces, public.order_checklist_items, public.order_cost_items to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
