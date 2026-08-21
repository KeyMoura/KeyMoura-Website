-- Lightweight business-management foundations. Additive and safe for existing commerce rows.
begin;

-- Human-facing references are assigned in Postgres. Sequences are concurrency-safe and
-- deliberately tolerate gaps caused by rolled-back transactions.
create sequence if not exists public.keymoura_order_number_v2_seq;
create or replace function public.assign_keymoura_order_number()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.order_number is null or btrim(new.order_number) = '' then
    new.order_number := 'KM-' || to_char(coalesce(new.created_at, now()), 'YYYY') || '-' ||
      lpad(nextval('public.keymoura_order_number_v2_seq')::text, 6, '0');
  end if;
  if new.status not in ('requested','needs_information','declined') then
    new.accepted_at := coalesce(new.accepted_at, now());
  end if;
  if new.status = 'completed' then new.completed_at := coalesce(new.completed_at, now()); end if;
  return new;
end $$;

-- Existing identifiers remain unchanged. Only previously unnumbered rows are backfilled.
update public.orders set order_number = null where order_number is not null and btrim(order_number) = '';
update public.orders set order_number = 'KM-' || to_char(created_at, 'YYYY') || '-' ||
  lpad(nextval('public.keymoura_order_number_v2_seq')::text, 6, '0') where order_number is null;
alter table public.orders alter column order_number set not null;
create unique index if not exists orders_order_number_ci_uidx on public.orders(lower(order_number));
revoke all on sequence public.keymoura_order_number_v2_seq from public, anon, authenticated;
grant usage, select on sequence public.keymoura_order_number_v2_seq to service_role;

-- Shipping fields not already represented by the existing snapshot foundation.
alter table public.products
  add column if not exists weight_grams integer check (weight_grams is null or weight_grams >= 0),
  add column if not exists preferred_package_preset text;
alter table public.orders
  add column if not exists shipping_service text,
  add column if not exists shipping_cost_cents integer check (shipping_cost_cents is null or shipping_cost_cents >= 0),
  add column if not exists delivered_at timestamptz;

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(), name text not null check (char_length(btrim(name)) between 2 and 160),
  website text, contact_name text, email text, phone text, notes text,
  typical_lead_time_days integer check (typical_lead_time_days is null or typical_lead_time_days >= 0),
  minimum_order_quantity numeric(14,4) check (minimum_order_quantity is null or minimum_order_quantity >= 0),
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists suppliers_name_active_uidx on public.suppliers(lower(name)) where archived_at is null;

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(), name text not null check (char_length(btrim(name)) between 2 and 160),
  sku text not null check (char_length(btrim(sku)) between 2 and 80), description text, specification text,
  unit text not null check (unit in ('board_feet','square_inches','linear_inches','pounds','pieces','sheets','ounces','feet','inches')),
  current_quantity numeric(14,4) not null default 0 check (current_quantity >= 0),
  average_unit_cost_cents numeric(14,4) not null default 0 check (average_unit_cost_cents >= 0),
  reorder_threshold numeric(14,4) check (reorder_threshold is null or reorder_threshold >= 0),
  preferred_supplier_id uuid references public.suppliers(id) on delete set null,
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists materials_sku_uidx on public.materials(lower(sku));
create index if not exists materials_supplier_idx on public.materials(preferred_supplier_id) where archived_at is null;

create table if not exists public.supplier_materials (
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  supplier_sku text, last_purchase_price_cents numeric(14,4) check (last_purchase_price_cents is null or last_purchase_price_cents >= 0),
  last_purchased_at date, minimum_order_quantity numeric(14,4) check (minimum_order_quantity is null or minimum_order_quantity >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key(supplier_id, material_id)
);

create table if not exists public.product_cost_profiles (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id) on delete cascade,
  variant_key text, selling_price_cents integer not null default 0 check (selling_price_cents >= 0),
  cnc_minutes numeric(10,2) not null default 0 check (cnc_minutes >= 0), manual_labor_minutes numeric(10,2) not null default 0 check (manual_labor_minutes >= 0),
  finishing_minutes numeric(10,2) not null default 0 check (finishing_minutes >= 0), machine_hourly_rate_cents integer not null default 0 check (machine_hourly_rate_cents >= 0),
  labor_hourly_rate_cents integer not null default 0 check (labor_hourly_rate_cents >= 0),
  tooling_cents integer not null default 0 check (tooling_cents >= 0), finishing_supplies_cents integer not null default 0 check (finishing_supplies_cents >= 0),
  hardware_cents integer not null default 0 check (hardware_cents >= 0), packaging_cents integer not null default 0 check (packaging_cents >= 0),
  payment_processing_cents integer not null default 0 check (payment_processing_cents >= 0), advertising_cents integer not null default 0 check (advertising_cents >= 0),
  shipping_subsidy_cents integer not null default 0 check (shipping_subsidy_cents >= 0), miscellaneous_cents integer not null default 0 check (miscellaneous_cents >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(product_id, variant_key)
);
create unique index if not exists product_cost_profiles_default_uidx on public.product_cost_profiles(product_id) where variant_key is null;

create table if not exists public.product_cost_materials (
  id uuid primary key default gen_random_uuid(), cost_profile_id uuid not null references public.product_cost_profiles(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete restrict, quantity numeric(14,4) not null check (quantity > 0),
  unit text not null, unit_cost_cents numeric(14,4) not null check (unit_cost_cents >= 0), waste_percent numeric(6,3) not null default 0 check (waste_percent between 0 and 1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(cost_profile_id, material_id)
);
create index if not exists product_cost_materials_material_idx on public.product_cost_materials(material_id);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(), expense_date date not null default current_date,
  category text not null check (category in ('materials','tooling','equipment','packaging','shipping','advertising','software','utilities','office','professional_services','other')),
  description text not null check (char_length(btrim(description)) between 2 and 240), vendor text,
  amount_cents integer not null check (amount_cents >= 0), tax_cents integer not null default 0 check (tax_cents >= 0), notes text,
  order_id uuid references public.orders(id) on delete set null, receipt_path text,
  created_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists expenses_date_category_idx on public.expenses(expense_date desc, category);
create index if not exists expenses_order_idx on public.expenses(order_id) where order_id is not null;

-- Approval snapshots never point at mutable quote fields for their meaning.
create table if not exists public.order_approvals (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
  customer_id uuid not null references auth.users(id) on delete restrict, quote_revision integer not null check (quote_revision > 0),
  revision_identifier text not null, specification_snapshot jsonb not null check (jsonb_typeof(specification_snapshot) = 'object'),
  quote_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(quote_snapshot) = 'object'), notes text,
  approved_at timestamptz not null default now(), created_at timestamptz not null default now(), unique(order_id, quote_revision)
);
create index if not exists order_approvals_customer_idx on public.order_approvals(customer_id, approved_at desc);
create or replace function public.prevent_approval_mutation() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'approval records are immutable'; end $$;
drop trigger if exists order_approvals_immutable on public.order_approvals;
create trigger order_approvals_immutable before update or delete on public.order_approvals for each row execute function public.prevent_approval_mutation();

-- Consistent timestamps for mutable business records.
do $$ declare t text; begin foreach t in array array['suppliers','materials','supplier_materials','product_cost_profiles','product_cost_materials','expenses'] loop
  execute format('drop trigger if exists %I_touch_updated_at on public.%I', t, t);
  execute format('create trigger %I_touch_updated_at before update on public.%I for each row execute function public.touch_commerce_updated_at()', t, t);
end loop; end $$;

alter table public.suppliers enable row level security; alter table public.materials enable row level security;
alter table public.supplier_materials enable row level security; alter table public.product_cost_profiles enable row level security;
alter table public.product_cost_materials enable row level security; alter table public.expenses enable row level security; alter table public.order_approvals enable row level security;
do $$ declare t text; begin foreach t in array array['suppliers','materials','supplier_materials','product_cost_profiles','product_cost_materials','expenses'] loop
  execute format('create policy "staff manage %s" on public.%I for all to authenticated using ((select public.is_staff_user())) with check ((select public.is_staff_user()))', t, t);
end loop; end $$;
create policy "customers read own approval snapshots" on public.order_approvals for select to authenticated using (customer_id = (select auth.uid()) or (select public.is_staff_user()));
create policy "staff create approval snapshots" on public.order_approvals for insert to authenticated with check ((select public.is_staff_user()));

revoke all on public.suppliers, public.materials, public.supplier_materials, public.product_cost_profiles, public.product_cost_materials, public.expenses, public.order_approvals from anon, authenticated;
grant select,insert,update,delete on public.suppliers, public.materials, public.supplier_materials, public.product_cost_profiles, public.product_cost_materials, public.expenses to authenticated, service_role;
grant select,insert on public.order_approvals to authenticated, service_role;

insert into public.permissions(key,name,description) values
 ('materials.view','View materials','View internal material inventory'),('materials.manage','Manage materials','Manage materials and stock levels'),
 ('suppliers.view','View suppliers','View supplier records'),('suppliers.manage','Manage suppliers','Manage supplier records'),
 ('finance.view','View finance','View internal costs, expenses, and financial metrics'),('finance.manage','Manage finance','Manage costs and expenses')
on conflict(key) do update set name=excluded.name,description=excluded.description;
insert into public.role_permissions(role_key,permission_key) select 'admin', key from (values ('materials.view'),('materials.manage'),('suppliers.view'),('suppliers.manage'),('finance.view'),('finance.manage')) p(key) on conflict do nothing;

notify pgrst, 'reload schema';
commit;
