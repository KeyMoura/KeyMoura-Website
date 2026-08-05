-- Pass 8, part 1: commerce settings, product shipping/inventory configuration,
-- order shipping snapshots, and the fulfillment state machine.
--
-- Additive throughout. No column is dropped, no existing constraint is
-- tightened, and the two CHECKs that change are only ever *widened*, so no
-- stored row can begin to fail one. Every new column is nullable or defaulted,
-- so existing products and orders keep their current behaviour untouched.

begin;

-- ---------------------------------------------------------------------------
-- Commerce settings
-- ---------------------------------------------------------------------------
-- One jsonb column on the existing singleton, beside `commerce_policy`, rather
-- than a new table. These are read on nearly every commerce request and always
-- read whole; a separate table would add a join to the hot path and — per the
-- pass-5a outage — would need its own explicit grants to be readable at all. A
-- column addition inherits `site_settings`' ACL, so that failure mode cannot
-- happen here.
--
-- The CHECK is the floor, not the specification: `parseCommerceSettings` is
-- total and is the only reader, so a hand-edited row degrades to safe defaults
-- instead of taking checkout offline.

alter table public.site_settings
  add column if not exists commerce_settings jsonb not null default '{}'::jsonb;

alter table public.site_settings drop constraint if exists site_settings_commerce_settings_object_check;
alter table public.site_settings add constraint site_settings_commerce_settings_object_check
  check (jsonb_typeof(commerce_settings) = 'object');

-- ---------------------------------------------------------------------------
-- Product shipping and inventory configuration
-- ---------------------------------------------------------------------------
-- `requires_shipping` and `fulfillment_required` default true and
-- `pickup_eligible` defaults true, which reproduces exactly how every existing
-- product behaves today: physical, postable, collectable. Nothing becomes
-- unavailable because this migration ran.

alter table public.products
  add column if not exists requires_shipping boolean not null default true,
  add column if not exists pickup_eligible boolean not null default true,
  add column if not exists fulfillment_required boolean not null default true,
  add column if not exists is_returnable boolean not null default true,
  add column if not exists package_weight_grams integer,
  add column if not exists package_length_mm integer,
  add column if not exists package_width_mm integer,
  add column if not exists package_height_mm integer,
  add column if not exists length_mm integer,
  add column if not exists width_mm integer,
  add column if not exists height_mm integer,
  -- Carried now so enabling Stripe Tax later is a value change rather than a
  -- schema change against live orders. Nothing reads it in this pass.
  add column if not exists tax_code text;

alter table public.products drop constraint if exists products_package_dimensions_positive_check;
alter table public.products add constraint products_package_dimensions_positive_check check (
  coalesce(package_weight_grams, 0) >= 0
  and coalesce(package_length_mm, 0) >= 0
  and coalesce(package_width_mm, 0) >= 0
  and coalesce(package_height_mm, 0) >= 0
  and coalesce(length_mm, 0) >= 0
  and coalesce(width_mm, 0) >= 0
  and coalesce(height_mm, 0) >= 0
);

-- ---------------------------------------------------------------------------
-- Order shipping snapshots
-- ---------------------------------------------------------------------------
-- Snapshots, not references. An order's shipping method, price, origin,
-- package and pickup location are copied at purchase time, because a settings
-- change six months later must not rewrite what a customer was charged or
-- redirect a parcel already in the post. `shipping_address` already exists and
-- is reused; from this pass on, direct purchases write it too.

alter table public.orders
  add column if not exists shipping_cents integer not null default 0 check (shipping_cents >= 0),
  -- Always 0 in this pass. Threaded now for the same reason as products.tax_code.
  add column if not exists tax_cents integer not null default 0 check (tax_cents >= 0),
  add column if not exists shipping_method_snapshot jsonb,
  add column if not exists shipping_origin_snapshot jsonb,
  add column if not exists pickup_location_snapshot jsonb,
  add column if not exists package_snapshot jsonb,
  add column if not exists ready_to_fulfill_at timestamptz,
  add column if not exists fulfillment_notes text,
  -- Two note columns on purpose: one is shown to the customer, one is not.
  -- A single column would be one careless select away from leaking.
  add column if not exists customer_shipment_note text,
  add column if not exists fulfillment_updated_at timestamptz,
  add column if not exists pickup_confirmed_at timestamptz;

-- Widened, never narrowed: every previously legal value stays legal.
alter table public.orders drop constraint if exists orders_fulfillment_status_check;
alter table public.orders add constraint orders_fulfillment_status_check check (
  fulfillment_status = any (array[
    'not_required','unfulfilled','processing','ready_to_fulfill','ready_for_pickup',
    'picked_up','shipped','delivered','returned','partially_returned','canceled'
  ])
);

alter table public.orders drop constraint if exists orders_fulfillment_method_check;
alter table public.orders add constraint orders_fulfillment_method_check check (
  fulfillment_method = any (array['shipping','pickup','none'])
);

-- Relaxed for the new 'none' method. A non-shipping order has no carrier to
-- name, and previously only 'pickup' was excused.
alter table public.orders drop constraint if exists orders_tracking_details_check;
alter table public.orders add constraint orders_tracking_details_check check (
  fulfillment_method <> 'shipping'
  or tracking_number is null
  or nullif(btrim(coalesce(shipping_carrier, '')), '') is not null
);

create index if not exists orders_fulfillment_status_idx
  on public.orders(fulfillment_status) where fulfillment_status <> 'not_required';

-- ---------------------------------------------------------------------------
-- Fulfillment history
-- ---------------------------------------------------------------------------
-- Append-only, and separate from `audit_logs` for the same reason pass 5 kept
-- the production timeline separate: the audit log is a security record with its
-- own retention, and this is an operational artifact staff read on every visit
-- to an order. Consequential actions write both.

create table if not exists public.order_fulfillment_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text,
  note text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists order_fulfillment_events_order_idx
  on public.order_fulfillment_events(order_id, created_at desc);

alter table public.order_fulfillment_events enable row level security;

drop policy if exists "Staff read fulfillment events" on public.order_fulfillment_events;
create policy "Staff read fulfillment events" on public.order_fulfillment_events
  for select using (public.is_staff_user());

-- ---------------------------------------------------------------------------
-- The transition
-- ---------------------------------------------------------------------------
-- In one statement under a row lock, because the check and the write must not
-- be separable. The from-status is re-asserted in the UPDATE's WHERE clause, so
-- a change that landed between a staff member's page load and their click
-- matches zero rows and is refused, rather than overwriting somebody else's
-- work. Repeating the same transition is reported as `already` rather than
-- erroring, which is what makes a double-click harmless.

create or replace function public.transition_order_fulfillment(
  p_order_id uuid,
  p_from text,
  p_to text,
  p_actor uuid,
  p_actor_role text default null,
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_row public.orders%rowtype;
  updated_count integer;
  stamp timestamptz := now();
begin
  select * into current_row from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found');
  end if;

  if current_row.fulfillment_status = p_to then
    return jsonb_build_object('ok', true, 'already', true, 'status', p_to);
  end if;

  if p_from is not null and current_row.fulfillment_status <> p_from then
    return jsonb_build_object(
      'ok', false, 'error', 'stale',
      'status', current_row.fulfillment_status
    );
  end if;

  update public.orders set
    fulfillment_status = p_to,
    fulfillment_updated_at = stamp,
    ready_to_fulfill_at = case when p_to in ('ready_to_fulfill','ready_for_pickup')
      then coalesce(ready_to_fulfill_at, stamp) else ready_to_fulfill_at end,
    ready_at = case when p_to in ('ready_to_fulfill','ready_for_pickup')
      then coalesce(ready_at, stamp) else ready_at end,
    picked_up_at = case when p_to = 'picked_up' then coalesce(picked_up_at, stamp) else picked_up_at end,
    shipped_at = case when p_to = 'shipped' then coalesce(shipped_at, stamp) else shipped_at end,
    delivered_at = case when p_to = 'delivered' then coalesce(delivered_at, stamp) else delivered_at end,
    updated_at = stamp
  where id = p_order_id and fulfillment_status = current_row.fulfillment_status;

  get diagnostics updated_count = row_count;
  if updated_count = 0 then
    return jsonb_build_object('ok', false, 'error', 'stale', 'status', current_row.fulfillment_status);
  end if;

  insert into public.order_fulfillment_events(order_id, from_status, to_status, actor_user_id, actor_role, note, metadata)
  values (p_order_id, current_row.fulfillment_status, p_to, p_actor, p_actor_role,
          nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_metadata, '{}'::jsonb));

  return jsonb_build_object('ok', true, 'already', false, 'from', current_row.fulfillment_status, 'status', p_to);
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- This database's default privileges for a new public table are
-- `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) for anon, authenticated and
-- service_role — no SELECT, INSERT, UPDATE or DELETE. A table shipped without
-- explicit grants is unreadable by every PostgREST role, which is exactly the
-- pass-5a outage. Table privileges are also checked *before* RLS, and
-- service_role's BYPASSRLS skips policies but not grants.
--
-- TRUNCATE is not filtered by RLS, so the inherited privilege is revoked rather
-- than left to a policy that cannot see it.

revoke all on table public.order_fulfillment_events from anon, authenticated, public;
grant select, insert on table public.order_fulfillment_events to service_role;

revoke all on function public.transition_order_fulfillment(uuid, text, text, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.transition_order_fulfillment(uuid, text, text, uuid, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Email templates
-- ---------------------------------------------------------------------------
-- `on conflict do nothing`: an owner who has already edited one of these keeps
-- their wording.

insert into public.email_templates(key, name, subject, heading, body, button_label) values
  ('fulfillment_processing','Order being prepared','{{order_label}} is being prepared','We are getting your order ready','Your {{product_name}} order is being prepared for {{fulfillment_method}}. We will let you know as soon as it is on its way.','View order'),
  ('order_ready_to_fulfill','Order packed','{{order_label}} is packed','Your order is packed','Your {{product_name}} order is packed and waiting to go out.','View order'),
  ('order_ready_for_pickup','Ready for pickup','{{order_label}} is ready to collect','Your order is ready for pickup','Your {{product_name}} order is ready to collect.\n\n{{pickup_location}}\n\n{{pickup_instructions}}','View order'),
  ('order_picked_up','Order collected','{{order_label}} was collected','Thanks for collecting your order','Your {{product_name}} order was marked collected on {{date}}. Thank you for choosing KeyMoura.','View order'),
  ('tracking_corrected','Tracking updated','Updated tracking for {{order_label}}','Your tracking details changed','The tracking details for your {{product_name}} order have been corrected. The new tracking number is {{tracking_number}} with {{carrier}}.','Track shipment'),
  ('low_stock_alert','Low stock (staff)','Low stock: {{product_name}}','Stock is running low','{{product_name}} is down to {{quantity}} in stock, at or below its threshold of {{threshold}}.','Open inventory'),
  ('out_of_stock_alert','Out of stock (staff)','Out of stock: {{product_name}}','A product is out of stock','{{product_name}} is out of stock. Direct purchase of it will be refused until it is restocked or backorders are enabled.','Open inventory'),
  ('staff_fulfillment_due','Order awaiting fulfillment (staff)','{{order_label}} is awaiting fulfillment','An order is waiting to go out','{{order_label}} is paid and waiting to be fulfilled.','Open order')
on conflict (key) do nothing;

notify pgrst, 'reload schema';

commit;
