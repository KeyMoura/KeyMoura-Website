-- Option values can point at a gallery image; option groups can be shown as swatches.
--
-- Additive and default-safe. Two nullable/defaulted columns, one index and one
-- integrity trigger. Nothing existing changes behaviour: every current option
-- value gets `media_id = null` (no associated image, which is exactly what they
-- have today) and every current option group gets `display_style = 'buttons'`,
-- which is the rendering they already receive.
--
-- Not added: a price column. `product_option_values.price_adjustment_cents`
-- has existed since `20260731060000_configurable_products_recovery` and is
-- already the single server-authoritative adjustment used by `pricing.ts`, the
-- cart, checkout and the order snapshot. A second one would be a competing
-- source of truth for the same number.
--
-- Grants: none issued, and none needed. Privileges on both tables are
-- table-level (`service_role` holds INSERT/SELECT/UPDATE/DELETE; `anon` and
-- `authenticated` hold SELECT, and `authenticated` also holds write) and a new
-- column inherits them. Verified against the live catalogue before writing.
--
-- RLS: unchanged. Both tables have RLS enabled and every policy is row-scoped —
-- `published product option values readable`, `staff manage product option
-- values`, and the group equivalents. None of them enumerate columns, so adding
-- one neither widens nor narrows what anybody can read or write.
--
-- Numbered 20260809020000, not 20260808030000, and the reason is worth stating.
-- Production has `20260809010000_guest_order_verification` applied, from a merge
-- that was reverted in the repository afterwards — so the database is one
-- migration ahead of `supabase/migrations`, and that row is not going away.
-- A file numbered below it would sort before an already-applied version, which
-- is the out-of-order case the migration runner is entitled to refuse. This
-- migration touches none of that work: `guest_order_access_codes` is a separate
-- table with its own functions and nothing here reads or writes it.

-- ---------------------------------------------------------------------------
-- 1. The image an option value switches the gallery to.
-- ---------------------------------------------------------------------------

alter table public.product_option_values
  add column if not exists media_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_option_values'::regclass
      and conname = 'product_option_values_media_id_fkey'
  ) then
    alter table public.product_option_values
      add constraint product_option_values_media_id_fkey
      foreign key (media_id) references public.product_media (id)
      -- SET NULL, not CASCADE. Deleting a photograph must not delete the colour
      -- customers can buy; the choice simply stops changing the gallery. CASCADE
      -- here would let a staff member remove a product's image and silently
      -- remove "Blue" from sale with it.
      on delete set null;
  end if;
end
$$;

-- Supports the FK's own delete-time lookup and the editor's "which values use
-- this image?" read. Partial because the overwhelming majority of values have
-- no image and there is no query that wants those rows by this column.
create index if not exists product_option_values_media_id_idx
  on public.product_option_values (media_id)
  where media_id is not null;

-- ---------------------------------------------------------------------------
-- 2. An option value may only point at its *own* product's media.
--
-- A foreign key cannot express this: the relationship runs value -> group ->
-- product and media -> product, and the constraint is that the two products
-- agree. Without it, a mis-sent id would attach one product's photograph to
-- another product's colour — and the failure would look like a broken gallery
-- rather than like bad data. The storefront additionally resolves the id
-- against the product's own media list, so a bad link is inert either way; this
-- is what stops it being written in the first place.
-- ---------------------------------------------------------------------------

create or replace function public.product_option_value_media_belongs_to_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.media_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.product_option_groups g
    join public.product_media m on m.id = new.media_id
    where g.id = new.option_group_id
      and m.product_id = g.product_id
  ) then
    raise exception 'option value media must belong to the same product as the option group'
      using errcode = '23514';
  end if;

  return new;
end
$$;

drop trigger if exists product_option_values_media_product_check on public.product_option_values;
create trigger product_option_values_media_product_check
  before insert or update of media_id, option_group_id
  on public.product_option_values
  for each row
  execute function public.product_option_value_media_belongs_to_product();

-- ---------------------------------------------------------------------------
-- 3. How a group's choices are drawn.
--
-- Deliberately a separate column rather than a new `input_type`. `input_type`
-- says what kind of *answer* the option takes — and the request wizard reads it
-- to decide between a text box, a number and a file upload. Presentation is a
-- different question asked only of the choice-shaped types, and folding it into
-- that CHECK would make "swatches" a data type.
--
-- Chosen explicitly by staff, never inferred from the option's name: a group
-- called "Colour" with no images should keep rendering as buttons, and one
-- called "Finish" with photographs of each finish should be able to show them.
-- ---------------------------------------------------------------------------

alter table public.product_option_groups
  add column if not exists display_style text not null default 'buttons';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_option_groups'::regclass
      and conname = 'product_option_groups_display_style_check'
  ) then
    alter table public.product_option_groups
      add constraint product_option_groups_display_style_check
      check (display_style in ('buttons', 'swatches'));
  end if;
end
$$;

comment on column public.product_option_values.media_id is
  'Optional product_media row this choice switches the storefront gallery to. Same product only, enforced by trigger.';
comment on column public.product_option_values.price_adjustment_cents is
  'Server-authoritative price delta in integer cents. The only option pricing mechanism; see src/lib/commerce/pricing.ts.';
comment on column public.product_option_groups.display_style is
  'buttons (use input_type) or swatches (thumbnails from each value''s media_id).';
