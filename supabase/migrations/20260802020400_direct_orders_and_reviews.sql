-- Direct-purchase orders and verified-purchase reviews.
--
-- Additive. A direct purchase becomes a real row in `orders` with
-- order_kind = 'direct_purchase' and a canonical agreed_price_cents set before
-- the Stripe session is created, so it settles through the same webhook, the
-- same idempotency table, and the same accounting RPC as a quoted order rather
-- than growing a second, weaker payment path.

begin;

alter table public.orders
  add column if not exists order_kind text not null default 'custom_request',
  add column if not exists subtotal_cents integer,
  add column if not exists discount_cents integer not null default 0,
  add column if not exists discount_code text,
  add column if not exists discount_code_id uuid references public.discount_codes(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_order_kind_check') then
    alter table public.orders
      add constraint orders_order_kind_check
      check (order_kind in ('custom_request', 'direct_purchase'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_discount_cents_check') then
    alter table public.orders
      add constraint orders_discount_cents_check check (discount_cents >= 0);
  end if;
end;
$$;

create index if not exists orders_order_kind_idx on public.orders (order_kind, created_at desc);

-- Line items for a multi-product direct order. Names and prices are copied at
-- purchase time so a later product edit never rewrites what a customer bought.
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  product_slug text,
  selected_options jsonb not null default '{}'::jsonb,
  quantity integer not null,
  unit_price_cents integer not null,
  line_subtotal_cents integer not null,
  created_at timestamptz not null default now(),
  constraint order_items_quantity_check check (quantity > 0),
  constraint order_items_price_check check (unit_price_cents >= 0 and line_subtotal_cents >= 0)
);

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

alter table public.order_items enable row level security;

-- Line items follow the visibility of their order exactly.
drop policy if exists "participants read order items" on public.order_items;
create policy "participants read order items" on public.order_items
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and (o.customer_id = (select auth.uid()) or (select public.is_staff_user()))
  ));

drop policy if exists "staff manage order items" on public.order_items;
create policy "staff manage order items" on public.order_items
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

grant select on public.order_items to authenticated;
grant select, insert, update, delete on public.order_items to service_role;

-- Verified-purchase reviews. Eligibility is one review per purchased line item,
-- which naturally prevents duplicates and ties the verified badge to a real
-- order row rather than to a self-reported claim.
create table if not exists public.product_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  customer_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  rating integer not null,
  title text,
  body text,
  is_verified_purchase boolean not null default false,
  status text not null default 'published',
  moderation_reason text,
  moderated_by uuid references auth.users(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_reviews_rating_check check (rating between 1 and 5),
  constraint product_reviews_status_check check (status in ('published', 'hidden', 'removed')),
  constraint product_reviews_title_length check (title is null or char_length(title) <= 120),
  constraint product_reviews_body_length check (body is null or char_length(body) <= 4000)
);

-- One review per purchased line. Partial so pre-existing rows without a line
-- item reference are still possible for staff-side corrections.
create unique index if not exists product_reviews_order_item_key
  on public.product_reviews (order_item_id) where order_item_id is not null;
create index if not exists product_reviews_product_idx
  on public.product_reviews (product_id, status, created_at desc);
create index if not exists product_reviews_customer_idx
  on public.product_reviews (customer_id, created_at desc);

create table if not exists public.product_review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.product_reviews(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  reason text not null,
  status text not null default 'open',
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint product_review_reports_status_check check (status in ('open', 'resolved', 'dismissed')),
  constraint product_review_reports_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create unique index if not exists product_review_reports_unique
  on public.product_review_reports (review_id, reporter_id) where reporter_id is not null;

alter table public.product_reviews enable row level security;
alter table public.product_review_reports enable row level security;

-- Only published reviews of a visible product are public. Authors keep sight of
-- their own review after moderation hides it, so they are not left confused
-- about where it went.
drop policy if exists "published reviews readable" on public.product_reviews;
create policy "published reviews readable" on public.product_reviews
  for select to anon, authenticated
  using (
    (status = 'published' and exists (
      select 1 from public.products p
      where p.id = product_reviews.product_id and p.is_published and p.archived_at is null
    ))
    or customer_id = (select auth.uid())
    or (select public.is_staff_user())
  );

drop policy if exists "staff manage reviews" on public.product_reviews;
create policy "staff manage reviews" on public.product_reviews
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

drop policy if exists "reporters read own reports" on public.product_review_reports;
create policy "reporters read own reports" on public.product_review_reports
  for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.is_staff_user()));

drop policy if exists "staff manage review reports" on public.product_review_reports;
create policy "staff manage review reports" on public.product_review_reports
  for all to authenticated
  using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

grant select on public.product_reviews to anon, authenticated;
grant select on public.product_review_reports to authenticated;
grant select, insert, update, delete on public.product_reviews to service_role;
grant select, insert, update, delete on public.product_review_reports to service_role;

insert into public.permissions(key, name, description) values
  ('catalog.reviews.moderate', 'Moderate product reviews', 'Hide, restore, or remove product reviews and resolve reports')
on conflict(key) do update set name = excluded.name, description = excluded.description;

insert into public.role_permissions(role_key, permission_key)
values ('admin', 'catalog.reviews.moderate')
on conflict do nothing;

notify pgrst, 'reload schema';

commit;
