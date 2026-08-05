-- Order lifecycle: state normalization, cancellations, Stripe-settled refunds,
-- returns, and the inventory ledger those three need to be correct.
--
-- Additive throughout. No table, column, index or policy is dropped. The two
-- CHECK constraints that are replaced (`orders_payment_status_check` and the
-- new-state columns' own checks) are only ever *widened*, so no existing row
-- can fail them — verified by the dry run, which asserts every live row still
-- validates after the swap.
--
-- Every new table, sequence and function carries explicit grants. This
-- database's default privileges for a new `public` table are `Dxtm` — TRUNCATE,
-- REFERENCES, TRIGGER, MAINTAIN — with **no SELECT, INSERT, UPDATE or DELETE**
-- for any PostgREST role, and table privileges are checked *before* RLS, so a
-- table shipped without grants is unreadable even by `service_role`, whose
-- BYPASSRLS bypasses policies but not grants. That is the pass-5a outage; see
-- `20260804020000_production_job_grants.sql`.

begin;

-- ============================================================================
-- 1. Order state model
-- ============================================================================
--
-- Four independent state fields rather than one enum. An order that is paid,
-- in production, has an open cancellation request and a partly shipped
-- fulfillment is an ordinary Tuesday; a single `status` column cannot hold
-- that without inventing a value per combination.
--
-- `orders.status` is left exactly as it is. It keeps its eleven values and
-- every existing reader keeps working; the new columns answer the questions it
-- was being asked to answer as a side effect.

alter table public.orders
  add column if not exists fulfillment_status text not null default 'unfulfilled',
  add column if not exists cancellation_status text not null default 'none',
  add column if not exists return_status text not null default 'none',
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null,
  add column if not exists inventory_committed_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists picked_up_at timestamptz;

-- Backfill from the columns that already carry the answer, before the checks
-- are added. Order matters: delivered wins over shipped.
update public.orders set fulfillment_status =
  case
    when status in ('cancelled', 'declined') then 'not_required'
    when delivered_at is not null and fulfillment_method = 'pickup' then 'picked_up'
    when delivered_at is not null then 'delivered'
    when shipped_at is not null and fulfillment_method = 'pickup' then 'ready_for_pickup'
    when shipped_at is not null then 'shipped'
    when status = 'ready' then 'processing'
    else 'unfulfilled'
  end
where fulfillment_status = 'unfulfilled';

update public.orders set
  cancellation_status = 'completed',
  cancellation_requested_at = coalesce(cancellation_requested_at, cancelled_at)
where (status = 'cancelled' or cancelled_at is not null) and cancellation_status = 'none';

-- Orders whose money already moved and settled keep an honest inventory
-- marker, so the ledger's idempotency keys do not later re-commit stock for
-- work that predates this migration.
update public.orders set inventory_committed_at = coalesce(inventory_committed_at, paid_at)
where paid_at is not null and inventory_committed_at is null;

alter table public.orders drop constraint if exists orders_fulfillment_status_check;
alter table public.orders add constraint orders_fulfillment_status_check check (
  fulfillment_status in (
    'not_required', 'unfulfilled', 'processing', 'ready_for_pickup',
    'picked_up', 'shipped', 'delivered', 'returned', 'partially_returned'
  )
);

alter table public.orders drop constraint if exists orders_cancellation_status_check;
alter table public.orders add constraint orders_cancellation_status_check check (
  cancellation_status in (
    'none', 'requested', 'under_review', 'approved', 'denied',
    'withdrawn', 'refund_pending', 'refund_failed', 'completed'
  )
);

alter table public.orders drop constraint if exists orders_return_status_check;
alter table public.orders add constraint orders_return_status_check check (
  return_status in (
    'none', 'requested', 'under_review', 'approved', 'denied',
    'awaiting_shipment', 'in_transit', 'received', 'inspected',
    'refund_pending', 'completed', 'closed'
  )
);

-- Widen `payment_status`. Every previously legal value stays legal, so this
-- cannot reject a stored row. `partially_refunded` and `payment_failed` are
-- the two states the column was previously forced to lie about: a partly
-- refunded order read as plain `paid`, and a failed async payment left it
-- `unpaid` with no way to tell "never tried" from "tried and was declined".
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check (
  payment_status in (
    'not_required', 'unpaid', 'payment_pending', 'partial', 'paid',
    'partially_refunded', 'refunded', 'payment_failed', 'payment_canceled'
  )
);

create index if not exists orders_cancellation_status_idx
  on public.orders(cancellation_status) where cancellation_status <> 'none';
create index if not exists orders_return_status_idx
  on public.orders(return_status) where return_status <> 'none';
create index if not exists orders_fulfillment_status_idx
  on public.orders(fulfillment_status);

-- ============================================================================
-- 2. Cancellation requests
-- ============================================================================

create table if not exists public.order_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  requested_by_kind text not null default 'customer'
    check (requested_by_kind in ('customer', 'staff')),
  reason_code text not null check (reason_code in (
    'changed_mind', 'ordered_by_mistake', 'found_another_option',
    'taking_too_long', 'no_longer_needed', 'duplicate_order',
    'incorrect_details', 'other'
  )),
  customer_note text check (customer_note is null or char_length(customer_note) <= 2000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'withdrawn', 'completed', 'failed')),
  -- Shown to the customer. A denial without one is a dead end, so the route
  -- requires it and this column records what they were told.
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  -- Never leaves staff surfaces.
  internal_note text check (internal_note is null or char_length(internal_note) <= 2000),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  withdrawn_at timestamptz,
  completed_at timestamptz,
  refund_mode text not null default 'none'
    check (refund_mode in ('none', 'full', 'partial')),
  refund_amount_cents integer check (refund_amount_cents is null or refund_amount_cents >= 0),
  restock_inventory boolean not null default true,
  restore_discount boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open request per order, enforced by the database rather than by a
-- read-then-write in a route. Two tabs, a double click and a retried fetch all
-- collapse to one row.
create unique index if not exists order_cancellation_requests_open_idx
  on public.order_cancellation_requests(order_id) where status = 'pending';
create index if not exists order_cancellation_requests_order_idx
  on public.order_cancellation_requests(order_id, created_at desc);
create index if not exists order_cancellation_requests_status_idx
  on public.order_cancellation_requests(status, created_at desc) where status = 'pending';

-- ============================================================================
-- 3. Returns
-- ============================================================================

create sequence if not exists public.order_return_number_seq;

create table if not exists public.order_returns (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  -- From a sequence, not max()+1: two customers starting a return in the same
  -- moment must not race for the same authorization number.
  return_number text not null unique
    default ('RMA-' || lpad(nextval('public.order_return_number_seq')::text, 4, '0')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_by_kind text not null default 'customer'
    check (requested_by_kind in ('customer', 'staff')),
  status text not null default 'requested' check (status in (
    'requested', 'under_review', 'approved', 'denied', 'awaiting_shipment',
    'in_transit', 'received', 'inspected', 'refund_pending', 'completed', 'closed'
  )),
  reason_code text not null check (reason_code in (
    'wrong_item', 'damaged_in_transit', 'defective', 'does_not_fit',
    'not_as_described', 'changed_mind', 'other'
  )),
  customer_note text check (customer_note is null or char_length(customer_note) <= 2000),
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  internal_note text check (internal_note is null or char_length(internal_note) <= 2000),
  return_instructions text check (return_instructions is null or char_length(return_instructions) <= 4000),
  -- Snapshotted at approval. A later change to the shop's address must not
  -- redirect a return that is already in the post.
  return_address jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  carrier text check (carrier is null or char_length(carrier) <= 80),
  tracking_number text check (tracking_number is null or char_length(tracking_number) <= 160),
  tracking_url text check (tracking_url is null or char_length(tracking_url) <= 1000),
  shipped_at timestamptz,
  received_at timestamptz,
  received_by uuid references auth.users(id) on delete set null,
  inspected_at timestamptz,
  inspected_by uuid references auth.users(id) on delete set null,
  inspection_outcome text check (inspection_outcome is null or inspection_outcome in (
    'as_described', 'minor_damage', 'major_damage',
    'not_as_described', 'missing_parts', 'wrong_item_returned'
  )),
  inspection_note text check (inspection_note is null or char_length(inspection_note) <= 2000),
  restock_decision text not null default 'pending'
    check (restock_decision in ('pending', 'restock', 'do_not_restock', 'partial')),
  refund_decision text not null default 'pending'
    check (refund_decision in ('pending', 'full', 'partial', 'none')),
  refund_amount_cents integer check (refund_amount_cents is null or refund_amount_cents >= 0),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_returns_order_idx
  on public.order_returns(order_id, created_at desc);
create index if not exists order_returns_open_idx
  on public.order_returns(status, created_at desc)
  where status not in ('denied', 'completed', 'closed');

create table if not exists public.order_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.order_returns(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  -- Snapshots. What was returned has to stay describable after the product is
  -- renamed, repriced or deleted.
  product_name text not null check (char_length(product_name) between 1 and 300),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  requested_quantity integer not null check (requested_quantity >= 1),
  approved_quantity integer check (approved_quantity is null or approved_quantity >= 0),
  received_quantity integer check (received_quantity is null or received_quantity >= 0),
  restocked_quantity integer not null default 0 check (restocked_quantity >= 0),
  item_condition text check (item_condition is null or item_condition in (
    'unopened', 'opened_unused', 'used', 'damaged', 'incomplete'
  )),
  created_at timestamptz not null default now()
);

create unique index if not exists order_return_items_unique_idx
  on public.order_return_items(return_id, order_item_id) where order_item_id is not null;
create index if not exists order_return_items_return_idx
  on public.order_return_items(return_id);

-- ============================================================================
-- 4. Refund lifecycle
-- ============================================================================
--
-- Before this migration an `order_refunds` row *was* a completed refund: the
-- route called Stripe, and on a resolved promise wrote the row and incremented
-- `orders.amount_refunded_cents`. Stripe refunds are not always synchronous
-- and can fail after acceptance, so "we asked" was being recorded as "it
-- happened". A refund now has a status, and only `succeeded` moves money in
-- the local accounting.

alter table public.order_refunds
  add column if not exists status text not null default 'succeeded',
  add column if not exists requested_amount_cents integer,
  add column if not exists confirmed_amount_cents integer,
  add column if not exists currency text not null default 'usd',
  add column if not exists idempotency_key text,
  add column if not exists kind text not null default 'manual',
  add column if not exists source text not null default 'app',
  add column if not exists cancellation_request_id uuid
    references public.order_cancellation_requests(id) on delete set null,
  add column if not exists return_id uuid
    references public.order_returns(id) on delete set null,
  add column if not exists customer_note text,
  add column if not exists internal_note text,
  add column if not exists failure_code text,
  add column if not exists failure_message text,
  add column if not exists initiated_by uuid references auth.users(id) on delete set null,
  add column if not exists confirmed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Every pre-existing row is a historical success: it exists only because
-- Stripe returned a refund object and the accounting was applied.
update public.order_refunds set
  requested_amount_cents = coalesce(requested_amount_cents, amount_cents),
  confirmed_amount_cents = coalesce(confirmed_amount_cents, amount_cents),
  confirmed_at = coalesce(confirmed_at, created_at)
where requested_amount_cents is null or confirmed_amount_cents is null or confirmed_at is null;

-- A refund is claimed locally *before* Stripe is called, so a concurrent
-- second request sees the first one's amount as already spoken for. That claim
-- has no Stripe id yet.
alter table public.order_refunds alter column stripe_refund_id drop not null;

alter table public.order_refunds drop constraint if exists order_refunds_status_check;
alter table public.order_refunds add constraint order_refunds_status_check
  check (status in ('pending', 'succeeded', 'failed', 'canceled'));

alter table public.order_refunds drop constraint if exists order_refunds_kind_check;
alter table public.order_refunds add constraint order_refunds_kind_check
  check (kind in ('manual', 'cancellation', 'return'));

alter table public.order_refunds drop constraint if exists order_refunds_source_check;
alter table public.order_refunds add constraint order_refunds_source_check
  check (source in ('app', 'stripe_dashboard', 'reconciliation'));

-- The concurrency guard. Two clicks compute the same key and the second insert
-- loses to the unique index instead of reaching Stripe.
create unique index if not exists order_refunds_idempotency_key_idx
  on public.order_refunds(idempotency_key) where idempotency_key is not null;
create index if not exists order_refunds_pending_idx
  on public.order_refunds(order_id) where status = 'pending';
create index if not exists order_refunds_return_idx
  on public.order_refunds(return_id) where return_id is not null;

-- ============================================================================
-- 5. Inventory ledger
-- ============================================================================
--
-- `products.inventory_quantity` is a running total with no history: nothing
-- recorded why it moved, and the direct-purchase path never moved it at all.
-- Every change now writes a row here, and the idempotency key is what makes a
-- replayed Stripe webhook unable to decrement twice.

create table if not exists public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  delta integer not null check (delta <> 0),
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after integer not null check (quantity_after >= 0),
  reason text not null check (reason in (
    'order_committed', 'order_cancelled', 'return_restocked',
    'manual_set', 'manual_adjust', 'correction'
  )),
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  return_id uuid references public.order_returns(id) on delete set null,
  cancellation_request_id uuid
    references public.order_cancellation_requests(id) on delete set null,
  idempotency_key text,
  note text check (note is null or char_length(note) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists inventory_adjustments_idempotency_idx
  on public.inventory_adjustments(idempotency_key) where idempotency_key is not null;
create index if not exists inventory_adjustments_product_idx
  on public.inventory_adjustments(product_id, created_at desc);
create index if not exists inventory_adjustments_order_idx
  on public.inventory_adjustments(order_id) where order_id is not null;

-- ============================================================================
-- 6. Commerce policy settings
-- ============================================================================
--
-- Windows and eligibility rules live in one place instead of being spelled out
-- in each route handler. Defaults are deliberately conservative: custom and
-- personalized work is not returnable unless the owner says otherwise, because
-- guessing generously here is guessing with the shop's money.

alter table public.site_settings
  add column if not exists commerce_policy jsonb not null default '{
    "cancellation": {
      "unpaidWindowHours": 0,
      "allowPaidRequests": true,
      "blockAfterProductionStart": false,
      "blockForCustomOrders": false,
      "blockAfterMaterialsOrdered": true,
      "nonRefundableDepositCents": 0,
      "policyText": ""
    },
    "returns": {
      "enabled": true,
      "windowDays": 30,
      "allowCustomProducts": false,
      "allowLocalPickupReturns": true,
      "customerPaysReturnShipping": true,
      "restockingFeePercent": 0,
      "requireInspection": true,
      "returnAddress": null,
      "instructions": "",
      "policyText": ""
    },
    "inventory": {
      "commitOnPayment": true,
      "restoreOnCancellation": true,
      "restoreOnReturn": true,
      "lowStockThresholdDefault": 2
    }
  }'::jsonb;

-- ============================================================================
-- 7. Atomic operations
-- ============================================================================

-- ---------------------------------------------------------------------------
-- begin_order_refund: claim a refund before Stripe is called.
--
-- Returns one "leg" per payment the refund has to draw from, each already
-- inserted as a pending `order_refunds` row with its own idempotency key. The
-- order row is locked for the whole computation, so two concurrent callers
-- cannot both see the same amount as available.
--
-- Refundable deliberately subtracts *pending* refunds as well as settled ones.
-- A refund that has been sent to Stripe but not yet confirmed is money already
-- committed; treating it as available is how an order gets refunded twice.
-- ---------------------------------------------------------------------------
create or replace function public.begin_order_refund(
  p_order_id uuid,
  p_amount_cents integer,
  p_kind text,
  p_reason text,
  p_base_idempotency_key text,
  p_initiated_by uuid default null,
  p_customer_note text default null,
  p_internal_note text default null,
  p_cancellation_request_id uuid default null,
  p_return_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_order public.orders%rowtype;
  payment_row record;
  settled integer;
  pending integer;
  refundable integer;
  remaining integer;
  leg_amount integer;
  leg_key text;
  existing public.order_refunds%rowtype;
  legs jsonb := '[]'::jsonb;
  new_refund public.order_refunds%rowtype;
begin
  if p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'invalid_refund_amount';
  end if;
  if nullif(btrim(coalesce(p_base_idempotency_key, '')), '') is null then
    raise exception 'missing_idempotency_key';
  end if;
  if coalesce(p_kind, '') not in ('manual', 'cancellation', 'return') then
    raise exception 'invalid_refund_kind';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'missing_refund_reason';
  end if;

  select * into selected_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found';
  end if;

  select
    coalesce(sum(case when status = 'succeeded' then coalesce(confirmed_amount_cents, amount_cents) else 0 end), 0),
    coalesce(sum(case when status = 'pending' then coalesce(requested_amount_cents, amount_cents) else 0 end), 0)
  into settled, pending
  from public.order_refunds where order_id = p_order_id;

  refundable := coalesce(selected_order.amount_paid_cents, 0) - settled - pending;
  if refundable <= 0 or p_amount_cents > refundable then
    return jsonb_build_object(
      'ok', false,
      'error', 'refund_exceeds_refundable',
      'refundable_cents', greatest(refundable, 0)
    );
  end if;

  remaining := p_amount_cents;

  for payment_row in
    select p.id, p.stripe_payment_intent_id, p.amount_cents,
      p.amount_refunded_cents + coalesce((
        select sum(coalesce(r.requested_amount_cents, r.amount_cents))
        from public.order_refunds r
        where r.order_payment_id = p.id and r.status = 'pending'
      ), 0) as spoken_for
    from public.order_payments p
    where p.order_id = p_order_id
    order by p.received_at desc
    for update
  loop
    exit when remaining <= 0;
    leg_amount := least(remaining, payment_row.amount_cents - payment_row.spoken_for);
    continue when leg_amount <= 0;

    leg_key := p_base_idempotency_key || '-p-' || payment_row.id::text;

    select * into existing from public.order_refunds where idempotency_key = leg_key;
    if found then
      -- A retry of the same logical action. Hand back the row that already
      -- exists rather than creating a second one.
      legs := legs || jsonb_build_object(
        'refund_id', existing.id,
        'order_payment_id', existing.order_payment_id,
        'payment_intent_id', payment_row.stripe_payment_intent_id,
        'amount_cents', coalesce(existing.requested_amount_cents, existing.amount_cents),
        'idempotency_key', leg_key,
        'status', existing.status,
        'stripe_refund_id', existing.stripe_refund_id,
        'replayed', true
      );
      remaining := remaining - coalesce(existing.requested_amount_cents, existing.amount_cents);
      continue;
    end if;

    insert into public.order_refunds (
      order_id, order_payment_id, stripe_refund_id, amount_cents, reason, created_by,
      status, requested_amount_cents, confirmed_amount_cents, idempotency_key,
      kind, source, cancellation_request_id, return_id,
      customer_note, internal_note, initiated_by
    ) values (
      p_order_id, payment_row.id, null, leg_amount, left(btrim(p_reason), 1000), p_initiated_by,
      'pending', leg_amount, null, leg_key,
      p_kind, 'app', p_cancellation_request_id, p_return_id,
      left(nullif(btrim(coalesce(p_customer_note, '')), ''), 2000),
      left(nullif(btrim(coalesce(p_internal_note, '')), ''), 2000),
      p_initiated_by
    )
    returning * into new_refund;

    legs := legs || jsonb_build_object(
      'refund_id', new_refund.id,
      'order_payment_id', payment_row.id,
      'payment_intent_id', payment_row.stripe_payment_intent_id,
      'amount_cents', leg_amount,
      'idempotency_key', leg_key,
      'status', 'pending',
      'stripe_refund_id', null,
      'replayed', false
    );
    remaining := remaining - leg_amount;
  end loop;

  if remaining > 0 then
    -- Rolling back keeps the claimed legs from stranding as pending holds that
    -- nothing will ever settle.
    raise exception 'refund_exceeds_recorded_payments';
  end if;

  return jsonb_build_object('ok', true, 'legs', legs);
end $$;

-- ---------------------------------------------------------------------------
-- settle_order_refund: apply Stripe's answer to the local accounting.
--
-- This is the only place `orders.amount_refunded_cents` grows. A refund that
-- Stripe has not confirmed does not count, however many times the button was
-- pressed.
-- ---------------------------------------------------------------------------
create or replace function public.settle_order_refund(
  p_refund_id uuid,
  p_stripe_refund_id text,
  p_stripe_status text,
  p_amount_cents integer default null,
  p_failure_code text default null,
  p_failure_message text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  refund_row public.order_refunds%rowtype;
  selected_order public.orders%rowtype;
  payment_row public.order_payments%rowtype;
  settled_amount integer;
  new_order_refunded integer;
  new_payment_refunded integer;
  next_payment_status text;
begin
  select * into refund_row from public.order_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund_not_found';
  end if;

  if refund_row.status <> 'pending' then
    -- Already settled. Repeated webhooks and a browser response racing a
    -- webhook both land here, and both are no-ops.
    return jsonb_build_object(
      'applied', false, 'duplicate', true, 'status', refund_row.status
    );
  end if;

  select * into selected_order from public.orders where id = refund_row.order_id for update;
  select * into payment_row from public.order_payments where id = refund_row.order_payment_id for update;

  if p_stripe_status in ('failed', 'canceled') then
    update public.order_refunds set
      status = case when p_stripe_status = 'canceled' then 'canceled' else 'failed' end,
      stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
      failure_code = left(p_failure_code, 200),
      failure_message = left(p_failure_message, 1000),
      failed_at = now(),
      updated_at = now()
    where id = p_refund_id;
    return jsonb_build_object('applied', true, 'duplicate', false, 'status', p_stripe_status);
  end if;

  if p_stripe_status = 'pending' then
    -- Recorded, not settled. The webhook will come back.
    update public.order_refunds set
      stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
      updated_at = now()
    where id = p_refund_id;
    return jsonb_build_object('applied', false, 'duplicate', false, 'status', 'pending');
  end if;

  if p_stripe_status <> 'succeeded' then
    raise exception 'unknown_refund_status';
  end if;

  settled_amount := coalesce(p_amount_cents, refund_row.requested_amount_cents, refund_row.amount_cents);
  if settled_amount < 1 then
    raise exception 'invalid_settled_amount';
  end if;

  new_payment_refunded := payment_row.amount_refunded_cents + settled_amount;
  new_order_refunded := coalesce(selected_order.amount_refunded_cents, 0) + settled_amount;

  if new_payment_refunded > payment_row.amount_cents
     or new_order_refunded > coalesce(selected_order.amount_paid_cents, 0) then
    raise exception 'refund_exceeds_payment';
  end if;

  next_payment_status := case
    when new_order_refunded >= coalesce(selected_order.amount_paid_cents, 0) then 'refunded'
    when new_order_refunded > 0 then 'partially_refunded'
    else selected_order.payment_status
  end;

  update public.order_refunds set
    status = 'succeeded',
    stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
    amount_cents = settled_amount,
    confirmed_amount_cents = settled_amount,
    confirmed_at = now(),
    updated_at = now()
  where id = p_refund_id;

  update public.order_payments set amount_refunded_cents = new_payment_refunded
  where id = payment_row.id;

  update public.orders set
    amount_refunded_cents = new_order_refunded,
    payment_status = next_payment_status
  where id = selected_order.id;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'status', 'succeeded',
    'amount_refunded_cents', new_order_refunded,
    'fully_refunded', new_order_refunded >= coalesce(selected_order.amount_paid_cents, 0),
    'payment_status', next_payment_status
  );
end $$;

-- ---------------------------------------------------------------------------
-- reconcile_stripe_refund: adopt a refund Stripe knows about and we do not.
--
-- A refund issued from the Stripe Dashboard never touched this application.
-- Without this the local `amount_refunded_cents` stays behind and the refund
-- form would happily issue the same money a second time.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_stripe_refund(
  p_stripe_refund_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_status text,
  p_reason text default 'Recorded from Stripe',
  p_failure_message text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  refund_row public.order_refunds%rowtype;
  payment_row public.order_payments%rowtype;
  created_id uuid;
begin
  if nullif(btrim(coalesce(p_stripe_refund_id, '')), '') is null then
    raise exception 'missing_stripe_refund_id';
  end if;

  select * into refund_row from public.order_refunds
    where stripe_refund_id = p_stripe_refund_id for update;

  if found then
    if refund_row.status <> 'pending' then
      return jsonb_build_object('applied', false, 'duplicate', true, 'status', refund_row.status);
    end if;
    return public.settle_order_refund(
      refund_row.id, p_stripe_refund_id, p_status, p_amount_cents, null, p_failure_message
    );
  end if;

  select * into payment_row from public.order_payments
    where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'unmatched', true, 'reason', 'no_local_payment');
  end if;

  insert into public.order_refunds (
    order_id, order_payment_id, stripe_refund_id, amount_cents, reason,
    status, requested_amount_cents, confirmed_amount_cents, kind, source,
    idempotency_key
  ) values (
    payment_row.order_id, payment_row.id, p_stripe_refund_id, greatest(p_amount_cents, 1),
    left(coalesce(nullif(btrim(p_reason), ''), 'Recorded from Stripe'), 1000),
    'pending', greatest(p_amount_cents, 1), null, 'manual', 'stripe_dashboard',
    'stripe-reconcile-' || p_stripe_refund_id
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into created_id;

  if created_id is null then
    select id into created_id from public.order_refunds
      where idempotency_key = 'stripe-reconcile-' || p_stripe_refund_id;
  end if;

  return public.settle_order_refund(
    created_id, p_stripe_refund_id, p_status, p_amount_cents, null, p_failure_message
  );
end $$;

-- ---------------------------------------------------------------------------
-- adjust_product_inventory: the only writer of `products.inventory_quantity`.
--
-- One statement reads, changes and records. The idempotency key is what makes
-- a replayed webhook, a double-clicked Restock button and a retried fetch all
-- produce exactly one movement.
-- ---------------------------------------------------------------------------
create or replace function public.adjust_product_inventory(
  p_product_id uuid,
  p_delta integer,
  p_reason text,
  p_idempotency_key text default null,
  p_order_id uuid default null,
  p_order_item_id uuid default null,
  p_return_id uuid default null,
  p_cancellation_request_id uuid default null,
  p_note text default null,
  p_created_by uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_row public.products%rowtype;
  existing_id uuid;
  new_quantity integer;
begin
  if p_delta = 0 or p_delta is null then
    raise exception 'invalid_delta';
  end if;

  if p_idempotency_key is not null then
    select id into existing_id from public.inventory_adjustments
      where idempotency_key = p_idempotency_key;
    if existing_id is not null then
      return jsonb_build_object('applied', false, 'duplicate', true, 'adjustment_id', existing_id);
    end if;
  end if;

  select * into product_row from public.products where id = p_product_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'skipped', true, 'reason', 'product_missing');
  end if;
  if product_row.inventory_policy <> 'track' then
    -- Made-to-order and unlimited products have no finite stock to move. This
    -- is a normal outcome, not an error.
    return jsonb_build_object('applied', false, 'skipped', true, 'reason', 'not_tracked');
  end if;

  new_quantity := greatest(0, product_row.inventory_quantity + p_delta);

  update public.products set inventory_quantity = new_quantity, updated_at = now()
  where id = p_product_id;

  insert into public.inventory_adjustments (
    product_id, delta, quantity_before, quantity_after, reason,
    order_id, order_item_id, return_id, cancellation_request_id,
    idempotency_key, note, created_by
  ) values (
    p_product_id, new_quantity - product_row.inventory_quantity,
    product_row.inventory_quantity, new_quantity, p_reason,
    p_order_id, p_order_item_id, p_return_id, p_cancellation_request_id,
    p_idempotency_key, left(nullif(btrim(coalesce(p_note, '')), ''), 1000), p_created_by
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing;

  return jsonb_build_object(
    'applied', true, 'duplicate', false,
    'quantity_before', product_row.inventory_quantity,
    'quantity_after', new_quantity
  );
end $$;

-- ---------------------------------------------------------------------------
-- commit_order_inventory / restore_order_inventory
--
-- Commit runs once per order item from the paid webhook. The key is derived
-- from the item id, so a webhook delivered five times decrements once.
-- Restore reverses only what the ledger says was actually committed.
-- ---------------------------------------------------------------------------
create or replace function public.commit_order_inventory(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item record;
  applied integer := 0;
  skipped integer := 0;
  result jsonb;
begin
  for item in
    select id, product_id, quantity from public.order_items
    where order_id = p_order_id and product_id is not null
  loop
    result := public.adjust_product_inventory(
      item.product_id, -item.quantity, 'order_committed',
      'order-' || p_order_id::text || '-item-' || item.id::text || '-commit',
      p_order_id, item.id, null, null, null, null
    );
    if (result->>'applied')::boolean then applied := applied + 1; else skipped := skipped + 1; end if;
  end loop;

  update public.orders set inventory_committed_at = coalesce(inventory_committed_at, now())
  where id = p_order_id;

  return jsonb_build_object('applied', applied, 'skipped', skipped);
end $$;

create or replace function public.restore_order_inventory(
  p_order_id uuid,
  p_reason text,
  p_cancellation_request_id uuid default null,
  p_created_by uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  committed record;
  applied integer := 0;
  result jsonb;
begin
  -- Only what was committed comes back. Summing the ledger rather than reading
  -- `order_items` means an order that never decremented stock cannot invent it.
  for committed in
    select order_item_id, product_id, sum(delta) as net
    from public.inventory_adjustments
    where order_id = p_order_id and reason in ('order_committed', 'order_cancelled')
    group by order_item_id, product_id
    having sum(delta) < 0
  loop
    result := public.adjust_product_inventory(
      committed.product_id, -committed.net::integer, 'order_cancelled',
      'order-' || p_order_id::text || '-item-' || coalesce(committed.order_item_id::text, 'null') || '-restore',
      p_order_id, committed.order_item_id, null, p_cancellation_request_id,
      left(p_reason, 1000), p_created_by
    );
    if (result->>'applied')::boolean then applied := applied + 1; end if;
  end loop;

  return jsonb_build_object('restored_items', applied);
end $$;

-- ---------------------------------------------------------------------------
-- create_order_return: quantity validation that concurrency cannot slip past.
--
-- The order is locked, already-returned quantities are summed from the
-- database, and the whole request is refused if any line asks for more than
-- remains. Doing this check in a route would leave a window between the read
-- and the insert wide enough to return the same item twice.
-- ---------------------------------------------------------------------------
create or replace function public.create_order_return(
  p_order_id uuid,
  p_requested_by uuid,
  p_requested_by_kind text,
  p_reason_code text,
  p_customer_note text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_order public.orders%rowtype;
  entry jsonb;
  item_row public.order_items%rowtype;
  already integer;
  wanted integer;
  created_return public.order_returns%rowtype;
  line_count integer := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'no_return_items';
  end if;

  select * into selected_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order_not_found';
  end if;

  if exists (
    select 1 from public.order_returns
    where order_id = p_order_id
      and status not in ('denied', 'closed', 'completed')
  ) then
    raise exception 'return_already_open';
  end if;

  insert into public.order_returns (
    order_id, requested_by, requested_by_kind, reason_code, customer_note
  ) values (
    p_order_id, p_requested_by, coalesce(p_requested_by_kind, 'customer'),
    p_reason_code, left(nullif(btrim(coalesce(p_customer_note, '')), ''), 2000)
  )
  returning * into created_return;

  for entry in select * from jsonb_array_elements(p_items)
  loop
    wanted := coalesce((entry->>'quantity')::integer, 0);
    if wanted < 1 then
      raise exception 'invalid_return_quantity';
    end if;

    select * into item_row from public.order_items
      where id = (entry->>'order_item_id')::uuid and order_id = p_order_id;
    if not found then
      raise exception 'order_item_not_found';
    end if;

    -- Quantities on returns that were denied or closed without receipt are
    -- released; everything else is still spoken for.
    select coalesce(sum(ri.requested_quantity), 0) into already
    from public.order_return_items ri
    join public.order_returns r on r.id = ri.return_id
    where ri.order_item_id = item_row.id and r.status not in ('denied', 'closed');

    if already + wanted > item_row.quantity then
      raise exception 'return_quantity_exceeds_purchased';
    end if;

    insert into public.order_return_items (
      return_id, order_item_id, product_id, product_name,
      unit_price_cents, requested_quantity
    ) values (
      created_return.id, item_row.id, item_row.product_id, item_row.product_name,
      item_row.unit_price_cents, wanted
    );
    line_count := line_count + 1;
  end loop;

  update public.orders set return_status = 'requested', updated_at = now()
  where id = p_order_id;

  return jsonb_build_object(
    'return_id', created_return.id,
    'return_number', created_return.return_number,
    'item_count', line_count
  );
end $$;

-- ---------------------------------------------------------------------------
-- restock_return_items: stock comes back only when staff say it should, and
-- only once per line.
-- ---------------------------------------------------------------------------
create or replace function public.restock_return_items(
  p_return_id uuid,
  p_created_by uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  line record;
  restocked integer := 0;
  result jsonb;
  quantity integer;
begin
  for line in
    select id, product_id, order_item_id, received_quantity, approved_quantity, restocked_quantity
    from public.order_return_items where return_id = p_return_id
  loop
    quantity := coalesce(line.received_quantity, line.approved_quantity, 0) - line.restocked_quantity;
    continue when quantity <= 0 or line.product_id is null;

    result := public.adjust_product_inventory(
      line.product_id, quantity, 'return_restocked',
      'return-' || p_return_id::text || '-line-' || line.id::text || '-restock',
      null, line.order_item_id, p_return_id, null, null, p_created_by
    );

    if (result->>'applied')::boolean or (result->>'duplicate')::boolean then
      update public.order_return_items
        set restocked_quantity = restocked_quantity + quantity
      where id = line.id;
      restocked := restocked + quantity;
    end if;
  end loop;

  return jsonb_build_object('restocked_units', restocked);
end $$;

-- ---------------------------------------------------------------------------
-- release_order_discount: give a redemption back when policy says so.
--
-- Deleting the redemption row rather than only decrementing `total_uses` keeps
-- per-customer limits honest — a code capped at one use per customer has to
-- stop counting the cancelled order, not merely free a global slot. The delete
-- is guarded on the row still existing, so calling twice restores once.
-- ---------------------------------------------------------------------------
create or replace function public.release_order_discount(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  redemption public.discount_redemptions%rowtype;
begin
  select * into redemption from public.discount_redemptions
    where order_id = p_order_id for update;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'no_redemption');
  end if;

  update public.discount_codes
    set total_uses = greatest(0, total_uses - 1), updated_at = now()
  where id = redemption.discount_code_id;

  delete from public.discount_redemptions where id = redemption.id;

  return jsonb_build_object('released', true, 'discount_code_id', redemption.discount_code_id);
end $$;

-- ============================================================================
-- 8. Row level security
-- ============================================================================

alter table public.order_cancellation_requests enable row level security;
alter table public.order_returns enable row level security;
alter table public.order_return_items enable row level security;
alter table public.inventory_adjustments enable row level security;

-- Read-only for authenticated callers. Every write goes through a route
-- handler that has already checked ownership or a staff permission, so there
-- is no insert/update policy to abuse from PostgREST.
drop policy if exists "participants read cancellation requests" on public.order_cancellation_requests;
create policy "participants read cancellation requests" on public.order_cancellation_requests
  for select to authenticated using (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and (o.customer_id = (select auth.uid()) or (select public.is_staff_user()))
    )
  );

drop policy if exists "participants read returns" on public.order_returns;
create policy "participants read returns" on public.order_returns
  for select to authenticated using (
    exists (
      select 1 from public.orders o
      where o.id = order_id
        and (o.customer_id = (select auth.uid()) or (select public.is_staff_user()))
    )
  );

drop policy if exists "participants read return items" on public.order_return_items;
create policy "participants read return items" on public.order_return_items
  for select to authenticated using (
    exists (
      select 1 from public.order_returns r
      join public.orders o on o.id = r.order_id
      where r.id = return_id
        and (o.customer_id = (select auth.uid()) or (select public.is_staff_user()))
    )
  );

-- Stock movements are an internal record: they expose purchase volumes and
-- operational detail, and no customer surface reads them.
drop policy if exists "staff read inventory adjustments" on public.inventory_adjustments;
create policy "staff read inventory adjustments" on public.inventory_adjustments
  for select to authenticated using ((select public.is_staff_user()));

-- ============================================================================
-- 9. Grants
-- ============================================================================
--
-- Explicit on every new object. The revokes matter as much as the grants: the
-- default ACL hands `anon` and `authenticated` TRUNCATE, which RLS does not
-- filter.

revoke all on public.order_cancellation_requests from anon;
revoke all on public.order_returns from anon;
revoke all on public.order_return_items from anon;
revoke all on public.inventory_adjustments from anon, authenticated;

grant select on public.order_cancellation_requests to authenticated;
grant select on public.order_returns to authenticated;
grant select on public.order_return_items to authenticated;

grant select, insert, update, delete on public.order_cancellation_requests to service_role;
grant select, insert, update, delete on public.order_returns to service_role;
grant select, insert, update, delete on public.order_return_items to service_role;
grant select, insert, update, delete on public.inventory_adjustments to service_role;

revoke all on sequence public.order_return_number_seq from anon, authenticated;
grant usage, select on sequence public.order_return_number_seq to service_role;

revoke all on function public.begin_order_refund(uuid, integer, text, text, text, uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.settle_order_refund(uuid, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.reconcile_stripe_refund(text, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.adjust_product_inventory(uuid, integer, text, text, uuid, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.commit_order_inventory(uuid) from public, anon, authenticated;
revoke all on function public.restore_order_inventory(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_order_return(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.restock_return_items(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_order_discount(uuid) from public, anon, authenticated;

grant execute on function public.begin_order_refund(uuid, integer, text, text, text, uuid, text, text, uuid, uuid) to service_role;
grant execute on function public.settle_order_refund(uuid, text, text, integer, text, text) to service_role;
grant execute on function public.reconcile_stripe_refund(text, text, integer, text, text, text) to service_role;
grant execute on function public.adjust_product_inventory(uuid, integer, text, text, uuid, uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.commit_order_inventory(uuid) to service_role;
grant execute on function public.restore_order_inventory(uuid, text, uuid, uuid) to service_role;
grant execute on function public.create_order_return(uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.restock_return_items(uuid, uuid) to service_role;
grant execute on function public.release_order_discount(uuid) to service_role;

-- ============================================================================
-- 10. Email templates
-- ============================================================================
--
-- Inserted with `on conflict do nothing`, so an owner who has already edited a
-- template keeps their wording.

insert into public.email_templates(key, name, subject, heading, body, button_label) values
  ('order_cancelled', 'Order cancelled', '{{order_label}} was cancelled', 'Your order was cancelled',
   'Your {{product_name}} order was cancelled. {{detail}}', 'View order'),
  ('cancellation_requested', 'Cancellation requested', 'We received your cancellation request for {{order_label}}', 'Cancellation request received',
   'We received your request to cancel {{product_name}}. A member of the team will review it and let you know. {{detail}}', 'View order'),
  ('cancellation_approved', 'Cancellation approved', '{{order_label}} cancellation approved', 'Your cancellation was approved',
   'Your request to cancel {{product_name}} was approved. {{detail}}', 'View order'),
  ('cancellation_denied', 'Cancellation denied', 'Update on your cancellation request for {{order_label}}', 'We could not cancel this order',
   'We reviewed your request to cancel {{product_name}} and were not able to approve it. {{detail}}', 'View order'),
  ('refund_initiated', 'Refund initiated', 'A refund is on the way for {{order_label}}', 'Your refund is being processed',
   'A {{price}} refund for {{product_name}} has been sent to your bank. {{detail}}', 'View order'),
  ('refund_completed', 'Refund completed', 'Your {{price}} refund for {{order_label}} is complete', 'Your refund is complete',
   'A {{price}} refund for {{product_name}} has completed. Your bank may take a few more days to show it. {{detail}}', 'View order'),
  ('refund_failed', 'Refund failed', 'We hit a problem refunding {{order_label}}', 'We could not complete your refund',
   'A refund for {{product_name}} did not go through. We are looking into it and will be in touch. {{detail}}', 'Contact support'),
  ('return_requested', 'Return requested', 'We received your return request for {{order_label}}', 'Return request received',
   'We received your return request for {{product_name}}. We will review it and send instructions if it is approved. {{detail}}', 'View return'),
  ('return_approved', 'Return approved', 'Your return for {{order_label}} is approved', 'Your return is approved',
   'Your return for {{product_name}} is approved. {{detail}}', 'View return'),
  ('return_denied', 'Return denied', 'Update on your return request for {{order_label}}', 'We could not approve this return',
   'We reviewed your return request for {{product_name}} and were not able to approve it. {{detail}}', 'View return'),
  ('return_received', 'Return received', 'We received your return for {{order_label}}', 'Your return arrived',
   'Your returned {{product_name}} arrived and is being inspected. {{detail}}', 'View return'),
  ('return_inspected', 'Return inspected', 'Inspection complete for {{order_label}}', 'Inspection complete',
   'We finished inspecting your returned {{product_name}}. {{detail}}', 'View return')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
commit;
