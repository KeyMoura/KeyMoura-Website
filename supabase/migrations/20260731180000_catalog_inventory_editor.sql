begin;

alter table public.products
  add column if not exists sku text,
  add column if not exists inventory_policy text not null default 'unlimited',
  add column if not exists inventory_quantity integer not null default 0,
  add column if not exists low_stock_threshold integer not null default 2,
  add column if not exists continue_selling_when_out_of_stock boolean not null default false,
  add column if not exists archived_at timestamptz;

create unique index if not exists products_sku_unique_idx on public.products (lower(sku)) where sku is not null;
create index if not exists products_catalog_state_idx on public.products (archived_at, is_published, sort_order, created_at desc);

do $$ begin
  alter table public.products add constraint products_inventory_policy_check check (inventory_policy in ('unlimited', 'track'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.products add constraint products_inventory_quantity_check check (inventory_quantity >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.products add constraint products_low_stock_threshold_check check (low_stock_threshold >= 0);
exception when duplicate_object then null; end $$;

drop policy if exists "published products readable" on public.products;
create policy "published products readable" on public.products for select to anon, authenticated
using (is_published and archived_at is null);

notify pgrst, 'reload schema';
commit;
