-- Structured product categories with exactly one subcategory level.
--
-- Additive. Creates the category tables, adds products.category_id, and
-- backfills categories from the existing free-text products.category column.
-- The legacy text column is deliberately kept so nothing that still reads it
-- breaks during the transition.

begin;

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  parent_id uuid references public.product_categories(id) on delete restrict,
  image_url text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_categories_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint product_categories_slug_shape check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint product_categories_not_own_parent check (parent_id is null or parent_id <> id)
);

create unique index if not exists product_categories_slug_key
  on public.product_categories (slug);
create index if not exists product_categories_parent_idx
  on public.product_categories (parent_id, display_order);

-- A category may be a parent or a child, never both. Rejecting a parent that
-- already has a parent caps the tree at two levels and makes a cycle
-- unrepresentable, so no separate cycle check is needed.
create or replace function public.product_categories_enforce_depth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  grandparent uuid;
  child_count integer;
begin
  if new.parent_id is not null then
    select parent_id into grandparent from public.product_categories where id = new.parent_id;
    if not found then
      raise exception 'Parent category does not exist';
    end if;
    if grandparent is not null then
      raise exception 'Categories support one level of subcategory only';
    end if;
  end if;

  -- A category that already has children cannot itself become a subcategory.
  if new.parent_id is not null then
    select count(*) into child_count from public.product_categories where parent_id = new.id;
    if child_count > 0 then
      raise exception 'A category with subcategories cannot become a subcategory';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists product_categories_depth on public.product_categories;
create trigger product_categories_depth
  before insert or update of parent_id on public.product_categories
  for each row execute function public.product_categories_enforce_depth();

alter table public.products
  add column if not exists category_id uuid references public.product_categories(id) on delete set null;

create index if not exists products_category_id_idx on public.products (category_id);

-- Backfill: one category per distinct case-insensitive, whitespace-normalized
-- value of the legacy text column. Idempotent, so a re-run adds nothing.
do $$
declare
  row_data record;
  base_slug text;
  candidate text;
  suffix integer;
  new_id uuid;
  position integer := 0;
begin
  for row_data in
    select
      initcap(btrim(regexp_replace(category, '\s+', ' ', 'g'))) as display_name,
      lower(btrim(regexp_replace(category, '\s+', ' ', 'g'))) as match_key,
      count(*) as product_count
    from public.products
    where category is not null and btrim(category) <> ''
    group by 1, 2
    order by count(*) desc, 1
  loop
    select id into new_id
    from public.product_categories
    where lower(btrim(name)) = row_data.match_key
    limit 1;

    if new_id is null then
      base_slug := regexp_replace(lower(row_data.display_name), '[^a-z0-9]+', '-', 'g');
      base_slug := btrim(base_slug, '-');
      if base_slug = '' then base_slug := 'category'; end if;

      candidate := base_slug;
      suffix := 1;
      while exists (select 1 from public.product_categories where slug = candidate) loop
        suffix := suffix + 1;
        candidate := base_slug || '-' || suffix;
      end loop;

      insert into public.product_categories (name, slug, display_order)
      values (row_data.display_name, candidate, position)
      returning id into new_id;
    end if;

    update public.products
    set category_id = new_id
    where category_id is null
      and category is not null
      and lower(btrim(regexp_replace(category, '\s+', ' ', 'g'))) = row_data.match_key;

    position := position + 1;
  end loop;
end;
$$;

alter table public.product_categories enable row level security;

drop policy if exists "active categories readable" on public.product_categories;
create policy "active categories readable" on public.product_categories
  for select to anon, authenticated
  using (is_active and archived_at is null);

drop policy if exists "staff manage categories" on public.product_categories;
create policy "staff manage categories" on public.product_categories
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

grant select on public.product_categories to anon, authenticated;
grant select, insert, update, delete on public.product_categories to service_role;

insert into public.permissions(key, name, description) values
  ('catalog.categories.manage', 'Manage product categories', 'Create, edit, reorder, and archive catalog categories')
on conflict(key) do update set name = excluded.name, description = excluded.description;

insert into public.role_permissions(role_key, permission_key)
values ('admin', 'catalog.categories.manage')
on conflict do nothing;

notify pgrst, 'reload schema';

commit;
