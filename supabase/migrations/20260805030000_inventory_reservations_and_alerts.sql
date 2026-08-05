-- Pass 8, part 2: atomic inventory reservations, expiry, and low-stock alerts.
--
-- Additive: two new tables and eight functions. Nothing existing is altered.
--
-- The hole this closes: pass 7 commits stock at *confirmed payment*, which is
-- correct but leaves a window open between a customer starting checkout and
-- paying. Two customers could both check out the last unit and both payments
-- would succeed. A reservation holds the unit for the length of the Stripe
-- Checkout Session and nothing longer.
--
-- What is deliberately NOT changed: `create_checkout_order` (the custom-request
-- path) still decrements `products.inventory_quantity` eagerly at order
-- creation, and `commit_order_inventory` (the direct-purchase path) still
-- decrements at payment through `inventory_adjustments`. Those two cannot
-- double-count because they cover disjoint order kinds — `order_items` rows
-- exist only for direct purchases. Reservations sit in front of the
-- direct-purchase path only, and availability subtracts them from a quantity
-- the custom path has *already* reduced, so neither is counted twice.

begin;

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  cart_id uuid references public.carts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  checkout_session_id text,
  quantity integer not null check (quantity > 0),
  status text not null default 'active'
    check (status in ('active','committed','released','expired')),
  idempotency_key text not null,
  -- A reservation must never live forever: an unexpiring hold on the last unit
  -- is an outage that looks like an out-of-stock product.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  -- Every terminal state carries its timestamp, and no non-terminal state may
  -- claim one. Without this a row can read "released" with no release time,
  -- and the reconciliation report cannot tell a stuck hold from a closed one.
  constraint inventory_reservations_terminal_check check (
    (status = 'active' and committed_at is null and released_at is null)
    or (status = 'committed' and committed_at is not null)
    or (status in ('released','expired') and released_at is not null)
  )
);

-- Structural duplicate prevention. Two concurrent requests for the same cart
-- line collapse to one row: the loser gets 23505 rather than a second hold.
create unique index if not exists inventory_reservations_active_cart_product_idx
  on public.inventory_reservations(cart_id, product_id) where status = 'active';

create unique index if not exists inventory_reservations_active_idempotency_idx
  on public.inventory_reservations(idempotency_key) where status = 'active';

create index if not exists inventory_reservations_product_active_idx
  on public.inventory_reservations(product_id) where status = 'active';

create index if not exists inventory_reservations_expiry_idx
  on public.inventory_reservations(expires_at) where status = 'active';

create index if not exists inventory_reservations_order_idx
  on public.inventory_reservations(order_id) where order_id is not null;

create index if not exists inventory_reservations_session_idx
  on public.inventory_reservations(checkout_session_id) where checkout_session_id is not null;

alter table public.inventory_reservations enable row level security;

-- Staff-only read. A reservation names another customer's cart and is not
-- customer information; the customer learns about a shortage from the checkout
-- refusal, not by reading the holds.
drop policy if exists "Staff read inventory reservations" on public.inventory_reservations;
create policy "Staff read inventory reservations" on public.inventory_reservations
  for select using (public.is_staff_user());

-- ---------------------------------------------------------------------------
-- Low-stock alerts
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_alerts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  level text not null check (level in ('low','out')),
  status text not null default 'open' check (status in ('open','resolved')),
  threshold integer not null default 0,
  quantity_at_alert integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Null means "raised but not yet announced". Setting it is what makes an
  -- alert stop producing email, so re-announcing is an explicit reset rather
  -- than an accident of re-running the evaluation.
  notified_at timestamptz
);

-- One open alert per product, enforced by the database rather than by
-- remembering to check. This is what stops an alert per page load.
create unique index if not exists inventory_alerts_open_product_idx
  on public.inventory_alerts(product_id) where status = 'open';

create index if not exists inventory_alerts_status_idx
  on public.inventory_alerts(status, created_at desc);

alter table public.inventory_alerts enable row level security;

drop policy if exists "Staff read inventory alerts" on public.inventory_alerts;
create policy "Staff read inventory alerts" on public.inventory_alerts
  for select using (public.is_staff_user());

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
-- Available = on hand - what is actively held. Expired holds are excluded by
-- the `expires_at` test as well as by status, so availability is correct even
-- between sweeps and does not depend on the sweep having run.

create or replace function public.reserved_product_quantity(p_product_id uuid, p_exclude_cart uuid default null)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(quantity), 0)::integer
  from public.inventory_reservations
  where product_id = p_product_id
    and status = 'active'
    and expires_at > now()
    and (p_exclude_cart is null or cart_id is distinct from p_exclude_cart);
$$;

create or replace function public.available_product_inventory(p_product_id uuid, p_exclude_cart uuid default null)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(0, p.inventory_quantity - public.reserved_product_quantity(p.id, p_exclude_cart))
  from public.products p where p.id = p_product_id;
$$;

-- ---------------------------------------------------------------------------
-- Expiry sweep
-- ---------------------------------------------------------------------------
-- Called opportunistically on the reservation path and available as a
-- scheduled job. It is idempotent and bounded, so running it twice at once is
-- harmless.

create or replace function public.expire_inventory_reservations(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  expired_count integer;
begin
  with stale as (
    select id from public.inventory_reservations
    where status = 'active' and expires_at <= now()
    order by expires_at
    limit greatest(1, least(5000, coalesce(p_limit, 500)))
    for update skip locked
  )
  update public.inventory_reservations r
     set status = 'expired', released_at = now(), release_reason = 'expired'
    from stale
   where r.id = stale.id;
  get diagnostics expired_count = row_count;
  return expired_count;
end $$;

-- ---------------------------------------------------------------------------
-- Reserving a whole cart, all or nothing
-- ---------------------------------------------------------------------------
-- All-or-nothing because a partly reserved cart is worse than an unreserved
-- one: the customer is held up on two lines and oversold on the third.
--
-- Shortages are computed *before* anything is written, so a refusal leaves the
-- cart's existing holds exactly as they were. Product rows are locked in id
-- order, which is what stops two carts holding overlapping products from
-- deadlocking each other.

create or replace function public.reserve_cart_inventory(
  p_cart_id uuid,
  p_user_id uuid,
  p_lines jsonb,
  p_minutes integer default 60,
  p_allow_oversell boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  line record;
  product_row public.products%rowtype;
  shortages jsonb := '[]'::jsonb;
  created jsonb := '[]'::jsonb;
  available_now integer;
  expires timestamptz := now() + (greatest(1, least(1440, coalesce(p_minutes, 60))) || ' minutes')::interval;
  new_id uuid;
begin
  if p_cart_id is null then
    return jsonb_build_object('ok', false, 'error', 'cart_required');
  end if;
  if jsonb_typeof(p_lines) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'invalid_lines');
  end if;

  -- Clear anything already past its time before measuring, so a customer is
  -- never refused because of a hold that should have lapsed an hour ago.
  perform public.expire_inventory_reservations(500);

  -- Deterministic lock order.
  perform 1 from public.products
   where id in (select (value->>'product_id')::uuid from jsonb_array_elements(p_lines))
   order by id
     for update;

  for line in
    select (value->>'product_id')::uuid as product_id,
           greatest(0, coalesce((value->>'quantity')::integer, 0)) as quantity
      from jsonb_array_elements(p_lines)
     order by 1
  loop
    if line.quantity = 0 then continue; end if;

    select * into product_row from public.products where id = line.product_id;
    if not found then
      shortages := shortages || jsonb_build_object(
        'product_id', line.product_id, 'product_name', 'Unknown item',
        'requested', line.quantity, 'available', 0, 'reason', 'missing');
      continue;
    end if;

    -- Untracked, made-to-order and backorder-enabled products are not finite
    -- stock, so holding a unit of them would be holding nothing. They are
    -- skipped rather than refused — reserving a made-to-order part would make
    -- it look sold out the moment two people opened checkout.
    if product_row.inventory_policy <> 'track'
       or product_row.made_to_order
       or product_row.continue_selling_when_out_of_stock
       or p_allow_oversell then
      continue;
    end if;

    available_now := greatest(0, product_row.inventory_quantity
      - public.reserved_product_quantity(product_row.id, p_cart_id));

    if available_now < line.quantity then
      shortages := shortages || jsonb_build_object(
        'product_id', product_row.id, 'product_name', product_row.name,
        'requested', line.quantity, 'available', available_now, 'reason', 'insufficient');
    end if;
  end loop;

  if jsonb_array_length(shortages) > 0 then
    return jsonb_build_object('ok', false, 'error', 'insufficient_inventory', 'shortages', shortages);
  end if;

  -- Past this point nothing can fail on availability, so replacing the cart's
  -- holds wholesale is safe. Replace rather than adjust: one rule covers a
  -- quantity increase, a decrease, and a line that has been removed entirely.
  update public.inventory_reservations
     set status = 'released', released_at = now(), release_reason = 'superseded'
   where cart_id = p_cart_id and status = 'active';

  for line in
    select (value->>'product_id')::uuid as product_id,
           greatest(0, coalesce((value->>'quantity')::integer, 0)) as quantity
      from jsonb_array_elements(p_lines)
     order by 1
  loop
    if line.quantity = 0 then continue; end if;
    select * into product_row from public.products where id = line.product_id;
    if not found then continue; end if;
    if product_row.inventory_policy <> 'track'
       or product_row.made_to_order
       or product_row.continue_selling_when_out_of_stock
       or p_allow_oversell then
      continue;
    end if;

    insert into public.inventory_reservations(
      product_id, cart_id, user_id, quantity, expires_at, idempotency_key
    ) values (
      product_row.id, p_cart_id, p_user_id, line.quantity, expires,
      'cart:' || p_cart_id::text || ':' || product_row.id::text
    ) returning id into new_id;

    created := created || jsonb_build_object('id', new_id, 'product_id', product_row.id, 'quantity', line.quantity);
  end loop;

  return jsonb_build_object('ok', true, 'reservations', created, 'expires_at', expires);
end $$;

-- ---------------------------------------------------------------------------
-- Linking, committing and releasing
-- ---------------------------------------------------------------------------

create or replace function public.link_cart_reservations_to_order(
  p_cart_id uuid,
  p_order_id uuid,
  p_checkout_session_id text default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare linked integer;
begin
  update public.inventory_reservations
     set order_id = p_order_id, checkout_session_id = coalesce(p_checkout_session_id, checkout_session_id)
   where cart_id = p_cart_id and status = 'active';
  get diagnostics linked = row_count;
  return linked;
end $$;

-- Commits exactly once. Only `active` rows move, so a webhook delivered five
-- times commits on the first and reports 0 on the rest. This does NOT decrement
-- stock: `commit_order_inventory` remains the only writer of
-- `products.inventory_quantity` for this path. Committing here simply stops the
-- hold counting against availability, at the same moment the on-hand figure
-- drops — so availability is unchanged across the commit, which is the point.
create or replace function public.commit_order_reservations(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare committed_count integer;
begin
  update public.inventory_reservations
     set status = 'committed', committed_at = now()
   where order_id = p_order_id and status = 'active';
  get diagnostics committed_count = row_count;
  return jsonb_build_object('ok', true, 'committed', committed_count);
end $$;

create or replace function public.release_inventory_reservations(
  p_reason text,
  p_cart_id uuid default null,
  p_order_id uuid default null,
  p_checkout_session_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare released_count integer;
begin
  if p_cart_id is null and p_order_id is null and p_checkout_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_selector');
  end if;
  update public.inventory_reservations
     set status = 'released', released_at = now(),
         release_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where status = 'active'
     and ((p_cart_id is not null and cart_id = p_cart_id)
       or (p_order_id is not null and order_id = p_order_id)
       or (p_checkout_session_id is not null and checkout_session_id = p_checkout_session_id));
  get diagnostics released_count = row_count;
  return jsonb_build_object('ok', true, 'released', released_count);
end $$;

-- ---------------------------------------------------------------------------
-- Low-stock evaluation
-- ---------------------------------------------------------------------------
-- Called after any inventory movement. Returns what changed so the caller can
-- decide whether to notify; it never sends anything itself.
--
-- Deduplication is structural: the partial unique index permits one open alert
-- per product, so re-running this on every adjustment cannot produce a second.
-- An open `low` alert that reaches zero is *escalated* in place and has its
-- `notified_at` cleared, which is the one case where a second message is
-- correct.

create or replace function public.evaluate_inventory_alert(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row public.products%rowtype;
  open_alert public.inventory_alerts%rowtype;
  wanted_level text;
  new_id uuid;
begin
  select * into product_row from public.products where id = p_product_id for update;
  if not found then return jsonb_build_object('action', 'none', 'reason', 'missing'); end if;

  -- An untracked, made-to-order or backorder-enabled product has no finite
  -- stock to run low on. Alerting on one is noise that trains staff to ignore
  -- the alert that matters.
  if product_row.inventory_policy <> 'track'
     or product_row.made_to_order
     or product_row.continue_selling_when_out_of_stock then
    update public.inventory_alerts set status = 'resolved', resolved_at = now(), updated_at = now()
     where product_id = p_product_id and status = 'open';
    return jsonb_build_object('action', 'none', 'reason', 'not_tracked');
  end if;

  wanted_level := case
    when product_row.inventory_quantity <= 0 then 'out'
    when product_row.inventory_quantity <= product_row.low_stock_threshold then 'low'
    else null end;

  select * into open_alert from public.inventory_alerts
   where product_id = p_product_id and status = 'open' limit 1;

  if wanted_level is null then
    if open_alert.id is not null then
      update public.inventory_alerts
         set status = 'resolved', resolved_at = now(), updated_at = now()
       where id = open_alert.id;
      return jsonb_build_object('action', 'resolved', 'product_id', p_product_id,
        'quantity', product_row.inventory_quantity, 'product_name', product_row.name);
    end if;
    return jsonb_build_object('action', 'none');
  end if;

  if open_alert.id is null then
    insert into public.inventory_alerts(product_id, level, threshold, quantity_at_alert)
    values (p_product_id, wanted_level, product_row.low_stock_threshold, product_row.inventory_quantity)
    returning id into new_id;
    return jsonb_build_object('action', 'opened', 'alert_id', new_id, 'level', wanted_level,
      'product_id', p_product_id, 'product_name', product_row.name,
      'quantity', product_row.inventory_quantity, 'threshold', product_row.low_stock_threshold);
  end if;

  if open_alert.level = 'low' and wanted_level = 'out' then
    update public.inventory_alerts
       set level = 'out', quantity_at_alert = product_row.inventory_quantity,
           notified_at = null, updated_at = now()
     where id = open_alert.id;
    return jsonb_build_object('action', 'escalated', 'alert_id', open_alert.id, 'level', 'out',
      'product_id', p_product_id, 'product_name', product_row.name,
      'quantity', product_row.inventory_quantity, 'threshold', product_row.low_stock_threshold);
  end if;

  update public.inventory_alerts
     set quantity_at_alert = product_row.inventory_quantity, updated_at = now()
   where id = open_alert.id;
  return jsonb_build_object('action', 'unchanged', 'alert_id', open_alert.id, 'level', open_alert.level);
end $$;

create or replace function public.mark_inventory_alert_notified(p_alert_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare updated_count integer;
begin
  update public.inventory_alerts set notified_at = now(), updated_at = now()
   where id = p_alert_id and notified_at is null;
  get diagnostics updated_count = row_count;
  return updated_count > 0;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Explicit, because this database's default privileges carry no SELECT for any
-- PostgREST role, and because the inherited TRUNCATE is not filtered by RLS.

revoke all on table public.inventory_reservations from anon, authenticated, public;
revoke all on table public.inventory_alerts from anon, authenticated, public;

grant select, insert, update on table public.inventory_reservations to service_role;
grant select, insert, update on table public.inventory_alerts to service_role;

-- No DELETE on either. A reservation's history is how the reconciliation report
-- tells an expired hold from one that was never taken, and an alert's history
-- is how "this keeps running out" becomes visible. Both are closed by status.

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.reserved_product_quantity(uuid, uuid)',
    'public.available_product_inventory(uuid, uuid)',
    'public.expire_inventory_reservations(integer)',
    'public.reserve_cart_inventory(uuid, uuid, jsonb, integer, boolean)',
    'public.link_cart_reservations_to_order(uuid, uuid, text)',
    'public.commit_order_reservations(uuid)',
    'public.release_inventory_reservations(text, uuid, uuid, text)',
    'public.evaluate_inventory_alert(uuid)',
    'public.mark_inventory_alert_notified(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
