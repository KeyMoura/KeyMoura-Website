-- Product purchase modes.
--
-- Additive. Every existing product backfills to 'request_only', which is
-- exactly today's behavior: nothing becomes directly purchasable until staff
-- decide it should be.

begin;

alter table public.products
  add column if not exists purchase_mode text not null default 'request_only';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_purchase_mode_check'
  ) then
    alter table public.products
      add constraint products_purchase_mode_check
      check (purchase_mode in ('direct_purchase', 'request_only', 'direct_or_request'));
  end if;
end;
$$;

create index if not exists products_purchase_mode_idx on public.products (purchase_mode);

-- Some option values make price or feasibility uncertain. Selecting one forces
-- the request path even on an otherwise directly purchasable product; this is
-- enforced server-side at cart validation and again at checkout.
alter table public.product_option_values
  add column if not exists requires_request boolean not null default false;

-- Options were only readable for products flagged is_custom, which hides the
-- options of a directly purchasable product from the browser client. Publish
-- status is the correct gate now that non-custom products can carry options.
drop policy if exists "published product options readable" on public.product_option_groups;
create policy "published product options readable" on public.product_option_groups
  for select to anon, authenticated
  using (exists (
    select 1 from public.products p
    where p.id = product_option_groups.product_id
      and p.is_published
      and p.archived_at is null
  ));

drop policy if exists "published product option values readable" on public.product_option_values;
create policy "published product option values readable" on public.product_option_values
  for select to anon, authenticated
  using (exists (
    select 1
    from public.product_option_groups g
    join public.products p on p.id = g.product_id
    where g.id = product_option_values.option_group_id
      and p.is_published
      and p.archived_at is null
      and product_option_values.is_active
  ));

notify pgrst, 'reload schema';

commit;
