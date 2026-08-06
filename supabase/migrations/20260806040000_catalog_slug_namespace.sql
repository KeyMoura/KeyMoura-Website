-- Catalog slug namespace
--
-- One address space under /catalog.
--
-- `/catalog/[slug]` was the product-detail route and is now also the category
-- route, because Next.js cannot have two different dynamic segments in one
-- position and moving products to a new path would break links that are live,
-- indexed, and embedded in transactional email.
--
-- That only works if a slug can never name two things. Both columns are
-- already unique within their own table (`products_slug_key`,
-- `product_categories_slug_key`); what is missing is that they be disjoint
-- from each other. This adds that, in the database, as the documented
-- uniqueness rule:
--
--   **A slug identifies at most one thing under /catalog — a product or a
--   category, never both.**
--
-- Enforced with triggers rather than a constraint because a CHECK cannot see
-- another table and an exclusion constraint cannot span two. The cost is that
-- two concurrent inserts of the same slug into different tables could both
-- pass their check; that is acceptable here because both tables are written
-- only by staff routes running as `service_role`, the window is a single
-- statement wide, and the failure mode is a category that shadows a product
-- until somebody renames one — not lost data or a wrong price.
--
-- Archived and unpublished rows count. A slug freed by archiving a product and
-- then taken by a category would collide again the moment the product was
-- restored, and discovering that during a restore is worse than being told now.
--
-- Additive: no column, constraint, policy or row is altered. Nothing is
-- dropped. Existing data is verified to satisfy the new rule before either
-- trigger is created, so this migration cannot leave the tables in a state
-- their own guard would refuse.

begin;

-- ---------------------------------------------------------------------------
-- Guard: refuse to install a rule the current data already breaks
-- ---------------------------------------------------------------------------
do $$
declare
  clashes text;
begin
  select string_agg(c.slug, ', ')
    into clashes
    from public.product_categories c
    join public.products p on p.slug = c.slug;

  if clashes is not null then
    raise exception
      'Cannot install the catalog slug namespace: these slugs name both a category and a product: %',
      clashes;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The two halves of one rule
-- ---------------------------------------------------------------------------
create or replace function public.product_categories_slug_namespace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.products where slug = new.slug) then
    raise exception 'A product already uses the address /catalog/%. Choose a different category slug.', new.slug
      using errcode = '23505';
  end if;
  return new;
end;
$$;

create or replace function public.products_slug_namespace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.product_categories where slug = new.slug) then
    raise exception 'A category already uses the address /catalog/%. Choose a different product slug.', new.slug
      using errcode = '23505';
  end if;
  return new;
end;
$$;

-- Insert and update are separate triggers rather than one with a combined
-- condition, because `tg_op` is not available inside a trigger WHEN clause —
-- it exists only in the function body. Splitting them lets the update trigger
-- carry `when (new.slug is distinct from old.slug)`, so saving a product
-- without touching its slug pays for no lookup and cannot fail because of a
-- rule introduced after the row was written.
drop trigger if exists product_categories_slug_namespace_insert on public.product_categories;
create trigger product_categories_slug_namespace_insert
  before insert on public.product_categories
  for each row
  execute function public.product_categories_slug_namespace();

drop trigger if exists product_categories_slug_namespace_update on public.product_categories;
create trigger product_categories_slug_namespace_update
  before update of slug on public.product_categories
  for each row
  when (new.slug is distinct from old.slug)
  execute function public.product_categories_slug_namespace();

drop trigger if exists products_slug_namespace_insert on public.products;
create trigger products_slug_namespace_insert
  before insert on public.products
  for each row
  execute function public.products_slug_namespace();

drop trigger if exists products_slug_namespace_update on public.products;
create trigger products_slug_namespace_update
  before update of slug on public.products
  for each row
  when (new.slug is distinct from old.slug)
  execute function public.products_slug_namespace();

-- ---------------------------------------------------------------------------
-- Least privilege
-- ---------------------------------------------------------------------------
-- A trigger function is called by the trigger, never by a client, so nothing
-- needs EXECUTE on it. Revoking keeps a SECURITY DEFINER function out of
-- anon's and authenticated's reach, which is what the Supabase security
-- advisor checks for.
revoke all on function public.product_categories_slug_namespace() from public, anon, authenticated;
revoke all on function public.products_slug_namespace() from public, anon, authenticated;

commit;
