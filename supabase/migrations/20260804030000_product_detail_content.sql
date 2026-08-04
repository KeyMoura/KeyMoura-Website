-- Structured product content for the redesigned product-detail page.
--
-- Additive only: new columns on `products`, no table dropped, no column
-- dropped, no existing constraint altered. Every column is nullable or carries
-- a default, so the two live products remain valid without being touched and
-- `description`/`short_description` are left exactly as they are.
--
-- Columns rather than five new tables (benefits, specifications, compatibility,
-- included items, FAQ). The deciding facts:
--
--   * These are ordered display blocks. They are always read as a whole, with
--     the product, and never filtered, joined, or queried independently.
--   * Five tables means five sets of RLS policies, five grants, five sort_order
--     columns and five staff editors — and, per the pass-5a outage, a table
--     that ships without explicit grants is unreadable by every PostgREST role
--     because this database's default privileges carry no SELECT. Adding a
--     column to `products` inherits the grants `products` already has, so that
--     failure mode is unreachable here.
--   * The scalar facts (material, finish, dimensions, made-to-order) are
--     separate columns rather than JSON keys, because those are the ones a
--     future catalog filter would want to index.
--
-- `detail_content` is validated in the application by
-- `src/lib/commerce/productContent.ts`, which every reader goes through. The
-- CHECK below is the floor, not the specification: it guarantees the column is
-- an object so a reader never has to defend against an array or a bare string.

alter table public.products
  add column if not exists material text,
  add column if not exists finish text,
  add column if not exists made_to_order boolean not null default false,
  add column if not exists installation_difficulty text,
  add column if not exists installation_notes text,
  add column if not exists care_instructions text,
  add column if not exists warranty_text text,
  add column if not exists shipping_notes text,
  add column if not exists return_notes text,
  add column if not exists cancellation_notes text,
  add column if not exists dimensions_text text,
  add column if not exists package_dimensions_text text,
  add column if not exists weight_grams integer,
  add column if not exists detail_content jsonb not null default '{}'::jsonb;

do $$
begin
  -- A fixed vocabulary, because the product page renders it as a labelled
  -- difficulty rather than echoing free text.
  if not exists (select 1 from pg_constraint where conname = 'products_installation_difficulty_check') then
    alter table public.products
      add constraint products_installation_difficulty_check
      check (installation_difficulty is null or installation_difficulty in ('easy','moderate','advanced','professional'));
  end if;

  -- A negative weight is a data-entry slip, and it would render as "-2 kg".
  if not exists (select 1 from pg_constraint where conname = 'products_weight_grams_check') then
    alter table public.products
      add constraint products_weight_grams_check
      check (weight_grams is null or weight_grams >= 0);
  end if;

  -- Guarantees readers get an object. Without it a staff bug could store `[]`
  -- or `"none"` and every `->>` in the application would silently return null
  -- rather than failing where the mistake was made.
  if not exists (select 1 from pg_constraint where conname = 'products_detail_content_check') then
    alter table public.products
      add constraint products_detail_content_check
      check (jsonb_typeof(detail_content) = 'object');
  end if;
end $$;

comment on column public.products.detail_content is
  'Ordered display blocks: benefits, specifications, compatibility, included, faq. Shape enforced by src/lib/commerce/productContent.ts.';
comment on column public.products.made_to_order is
  'True when the product is manufactured per order rather than shipped from stock. Distinct from availability_status, which is whether it can be bought at all.';

-- No grants are issued here on purpose. `products` already carries them, and
-- column additions inherit the table's ACL; issuing table grants in this file
-- would silently widen or narrow whatever is already in place.
