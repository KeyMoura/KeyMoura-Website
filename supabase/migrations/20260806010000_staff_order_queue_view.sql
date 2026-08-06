-- Staff order queue — a derived, server-authoritative view over `orders`.
--
-- WHY THIS EXISTS
--
-- `/staff/orders` selected every order into the browser and filtered them in
-- JavaScript. That is three problems in one: it does not scale, it ships every
-- customer's order row to every staff client regardless of what the list shows,
-- and — the defect this pass opens with — a refused query became an empty array
-- and every count on the page rendered a confident `0`.
--
-- Fixing the counts needs the filtering to move to the server. Moving it to the
-- server needs the *derived* predicates to be expressible in SQL: "requires
-- action", "overdue", and the fulfillment bucket all depend on the outstanding
-- balance, which is `agreed_price - (paid - refunded)` — a comparison between
-- columns that PostgREST cannot express as a filter.
--
-- So the derivation lives here, once, and the API filters and counts against it.
-- The alternative — approximating the rule in PostgREST and computing the true
-- one in TypeScript — reproduces exactly the failure pass 9 warned about: a
-- dashboard card reading 3 that opens a list of 5.
--
-- THIS VIEW MIRRORS `src/lib/staff/operationsQueues.ts`. The ordering of the
-- CASE arms below is the ordering of the `if`s in `fulfillmentBucket()`, and a
-- test asserts the two agree on a shared fixture set. If you change one, change
-- both.
--
-- ADDITIVE ONLY: creates one view. No table is altered, no data is written, and
-- nothing existing reads differently.

create or replace view public.staff_order_queue
with (security_invoker = true) as
select
  o.id,
  o.order_number,
  o.customer_id,
  o.product_id,
  o.product_name,
  o.status,
  o.order_kind,
  o.quantity,
  o.agreed_price_cents,
  o.amount_paid_cents,
  o.amount_refunded_cents,
  o.payment_status,
  o.fulfillment_status,
  o.fulfillment_method,
  o.cancellation_status,
  o.return_status,
  o.shipping_carrier,
  o.tracking_number,
  o.target_date,
  o.created_at,
  o.updated_at,
  o.paid_at,
  o.ready_at,
  o.shipped_at,
  o.delivered_at,
  w.priority,
  w.assigned_to,

  -- Priority as a sortable rank, because Postgres sorts the *words* — which
  -- orders them "high, low, normal, urgent", an ordering that is alphabetical
  -- and meaningless. An order with no workspace row ranks as `normal`, matching
  -- `workspaces[order.id]?.priority ?? "normal"` on the client.
  case coalesce(w.priority, 'normal')
    when 'urgent' then 0
    when 'high' then 1
    when 'normal' then 2
    when 'low' then 3
    else 2
  end as priority_rank,

  -- Money still owed. Mirrors outstandingBalanceCents(): the net of payments and
  -- refunds is floored at zero before subtracting, so an over-refund cannot make
  -- an order look like it owes more than its price.
  greatest(
    0,
    coalesce(o.agreed_price_cents, 0)
      - greatest(0, o.amount_paid_cents - coalesce(o.amount_refunded_cents, 0))
  )::int as outstanding_cents,

  -- Fulfillment bucket. Arm order mirrors fulfillmentBucket() exactly: the
  -- departed and terminal states are decided *before* the balance is consulted,
  -- so an order that shipped and was later partly refunded does not reappear on
  -- the packing bench.
  case
    when o.fulfillment_status in ('canceled', 'not_required') then 'not_applicable'
    when o.status in ('completed', 'declined', 'cancelled')
         and o.fulfillment_status not in ('shipped', 'delivered', 'picked_up') then 'not_applicable'
    when o.fulfillment_status in ('delivered', 'picked_up', 'returned', 'partially_returned') then 'settled'
    when o.fulfillment_status = 'shipped' then 'in_transit'
    when o.fulfillment_status in ('ready_to_fulfill', 'ready_for_pickup') then 'ready'
    when greatest(
           0,
           coalesce(o.agreed_price_cents, 0)
             - greatest(0, o.amount_paid_cents - coalesce(o.amount_refunded_cents, 0))
         ) > 0 then 'awaiting_payment'
    when o.fulfillment_status = 'processing' then 'in_progress'
    else 'to_prepare'
  end as fulfillment_bucket,

  -- Shipped with nothing for the customer to follow. Mirrors missingTracking().
  (
    coalesce(o.fulfillment_method, 'shipping') = 'shipping'
    and o.fulfillment_status = 'shipped'
    and nullif(btrim(coalesce(o.tracking_number, '')), '') is null
  ) as missing_tracking,

  -- Past its target date and still open. `target_date` is a DATE, so this is a
  -- calendar comparison and does not drift with the server's clock time.
  (
    o.target_date is not null
    and o.target_date < current_date
    and o.status not in ('completed', 'declined', 'cancelled')
  ) as is_overdue,

  -- A refund leg that Stripe refused. The money has not moved and a customer is
  -- waiting, which is why it is a queue of its own rather than a detail on the
  -- order. `exists` rather than a join: an order with three failed legs is one
  -- row in this list, not three.
  exists (
    select 1 from public.order_refunds r
    where r.order_id = o.id and r.status = 'failed'
  ) as has_failed_refund,

  -- A stock hold that outlived what it was holding stock for: still active but
  -- expired, or still active on an order that is already settled or dead.
  exists (
    select 1 from public.inventory_reservations res
    where res.order_id = o.id
      and res.status = 'active'
      and (
        res.expires_at < now()
        or o.status in ('completed', 'declined', 'cancelled')
        or o.payment_status in ('refunded', 'payment_canceled')
      )
  ) as has_inventory_issue,

  -- Open lifecycle work, as booleans so the API can filter on them directly.
  (o.cancellation_status in ('requested', 'under_review', 'refund_pending', 'refund_failed')) as cancellation_open,
  (o.return_status in ('requested', 'under_review', 'approved', 'awaiting_shipment',
                       'in_transit', 'received', 'inspected', 'refund_pending')) as return_open,

  -- The linked production job's state, if there is one. `order_id` is not unique
  -- on production_jobs, so this takes the most recently created job rather than
  -- erroring on multiple rows — one order can be re-run after a failed batch.
  (
    select j.status from public.production_jobs j
    where j.order_id = o.id
    order by j.created_at desc
    limit 1
  ) as production_status

from public.orders o
left join public.order_workspaces w on w.order_id = o.id;

comment on view public.staff_order_queue is
  'Derived staff order queue. Mirrors src/lib/staff/operationsQueues.ts so counts and lists cannot disagree. Read by /api/staff/orders after an application-level permission check.';

-- GRANTS
--
-- Explicit, and least-privilege. A view inherits nothing useful by default and
-- `security_invoker = true` means the caller's own rights on `orders` still
-- apply — so this cannot become a way around the RLS on the base table.
--
-- Only `service_role` may read it, because the only caller is a server route
-- that has already checked `orders.view`/`orders.manage`. `anon` and
-- `authenticated` get nothing: a staff order row carries customer identifiers,
-- money and internal state, and navigation visibility is not authorization.
revoke all on public.staff_order_queue from public;
revoke all on public.staff_order_queue from anon;
revoke all on public.staff_order_queue from authenticated;
grant select on public.staff_order_queue to service_role;
