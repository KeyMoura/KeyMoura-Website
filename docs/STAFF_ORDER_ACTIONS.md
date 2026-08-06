# Staff order actions — the safety matrix

Every consequential action reachable from `/staff/orders/[id]`, with the guard
that actually stops it going wrong. Written during pass 11 by reading each
route rather than each button, because the button is a convenience and the
route is the control.

A cell says what is **true in the code**, not what would be nice. Where a guard
is missing it says so and the row is marked ⚠, and pass 11 either closed it or
recorded why not.

## How to read the columns

- **Expected-state guard** — does the client send the state it rendered from,
  and does the server put that state in the `WHERE` clause of the write? Both
  halves are needed. A read-then-write with no re-assertion is not a guard.
- **Idempotency** — what happens on the *second* identical request: a second
  effect, a no-op, or a refusal.
- **Customer effect** — does the customer see or receive something.

---

## 1. Order status and quote — `PATCH /api/staff/orders/[id]`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Accept request | `orders.manage` | status `requested`/`needs_information` | **`expected_status`, guarded UPDATE, 409** | dialog | email + notification | — | — | `order_status_history` | status re-asserted; second click is a 409, not a second email |
| Cancel request | `orders.manage` | status not already `cancelled` | **`expected_status`, guarded UPDATE, 409** | dialog, reason required | email + notification | — | — | history + reason column | ditto |
| Advanced status override | `orders.manage` | any listed status | **`expected_status`, guarded UPDATE, 409** | dialog | email + notification | — | — | history | ditto |
| Send quote revision | `orders.manage` | quote not settled (`quoteLocked`) | **`expected_quote_revision` + `expected_status`** | dialog showing the amount | `quote_ready` email | sets price payable | — | `order_quotes` row | revision guard makes a repeat a 409 |
| Save internal details | `orders.manage` | — | `expected_status` | none (not customer-visible) | none | — | — | — | last write wins by design; nothing customer-facing moves |
| Send finished-product review | `orders.manage` | status `in_progress`, balance clear | **`expected_status`** | dialog with photo/note preview | `status_update` email | — | — | history | pending state + guard |

Before pass 11 this route had **no expected-state guard of any kind** — a blind
`update().eq("id", id)`. Two staff members with the page open both wrote, the
second silently won, and because each request computed its own
`order_status_history` id, the `eventKey` differed and **both** sent the customer
an email. That was the single largest hole in the workspace and is closed.

## 2. Fulfillment — `POST /api/staff/orders/[id]/fulfillment`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Mark processing | `fulfillment.manage` | legal transition for method | `expectedStatus` → 409 | dialog | `fulfillment_processing` | — | — | `staff.order.fulfillment_changed` | `transition_order_fulfillment` returns `already` |
| Ready to fulfill | `fulfillment.manage` | as above | ✔ | dialog | none | — | — | ✔ | ✔ |
| Ready for pickup | `fulfillment.manage` | pickup method, balance clear | ✔ | dialog | `order_ready_for_pickup` | — | — | ✔ | ✔ |
| Confirm pickup | `fulfillment.manage` | pickup method, balance clear | ✔ | dialog | `order_picked_up` | — | — | ✔ | ✔ + `pickup_confirmed_at` set only `.is(null)` |
| Ship | `fulfillment.manage` | shipping method, balance clear, carrier + tracking | ✔ | dialog naming the tracking | `order_shipped` | — | — | ✔ | ✔ |
| Mark delivered | `fulfillment.manage` | shipped first | ✔ | dialog | `order_delivered` | — | — | ✔ | ✔ |
| Correct tracking | `fulfillment.manage` | shipping method only | ✔ | dialog | `tracking_corrected` only when it really changed | — | — | `staff.order.tracking_corrected` | event key includes the number |

Method narrowing is enforced by `canTransitionFulfillmentForMethod`: a pickup
order cannot be shipped and a shipping order cannot be picked up, refused
server-side with 409 rather than merely hidden. Previous carrier and number are
written into `order_fulfillment_events.metadata` before being replaced.

The balance guard (`RELEASES_GOODS`) is the reason `processing` is deliberately
*not* gated — packing early is normal; only the handover is consequential.

## 3. Cancellation review — `POST /api/staff/orders/[id]/cancellation`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Approve cancellation | `cancellations.review` (+ `refunds.issue` if refunding) | request `pending` | `.eq("status","pending")` on the UPDATE → 409 | dialog listing refund, stock, discount | `cancellation_approved` | refund recomputed server-side | `restore_order_inventory` | `staff.order.cancellation_approved` | request-keyed refund `cancellation-{id}-{cents}`; `applyOrderCancellation` is `.neq("status","cancelled")` |
| Deny cancellation | `cancellations.review` | request `pending` | ✔ | dialog, reason required | `cancellation_denied` carrying the reason | — | — | `staff.order.cancellation_denied` | ✔ |

Inventory restoration cannot double-apply: `restore_order_inventory` sums the
`inventory_adjustments` ledger and only returns a *net negative*, and each leg
carries the idempotency key `order-…-item-…-restore`. Running it twice restores
nothing the second time. Verified by reading the function, not by trusting the
caller.

## 4. Return review — `POST /api/staff/orders/[id]/returns/[returnId]`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Approve return | `returns.review` | graph allows | `expected_status` + `.eq("status", from)` → 409 | dialog | `return_approved` + instructions | — | — | `staff.order.return_approved` | second click matches zero rows |
| Deny return | `returns.review` | graph allows | ✔ | dialog, reason required | `return_denied` carrying the reason | — | — | `staff.order.return_denied` | ✔ |
| Await shipment | `returns.review` | graph allows | ✔ | dialog | none | — | — | ✔ | ✔ |
| Mark received | `returns.review` | graph allows | ✔ | dialog | `return_received` | — | — | `staff.order.return_received` | ✔ |
| Record inspection | `returns.review` (+ `refunds.issue` if refunding) | status `received` | ✔ | dialog listing refund + stock | `return_inspected` | refund recomputed from received lines, capped by refundable | `restock_return_items` on explicit choice | `staff.order.return_inspected`, `staff.inventory.restored` | `advance("inspected")` makes a repeat a 409, so stock cannot be restocked twice |

Restocking happens **only** at inspection and only on an explicit tick — never
at approval, when the parcel is still in the post.

## 5. Refunds — `POST /api/staff/orders/[id]/refund`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Issue refund (full or partial) | `refunds.issue` | `amount ≤ refundableCents` | amount recomputed server-side; page state is advisory | dialog showing remaining-after | `refund_initiated` / `refund_completed` | **yes** | — | `staff.order.refund_requested` → `_sent`/`_failed` | claim written in Postgres under a row lock *before* Stripe is called |

The client amount is never trusted. `loadOrderLifecycleContext` recomputes
`refundableCents` from live rows with pending refunds already subtracted, so an
over-refund is a 409 regardless of what the form showed. The idempotency key is
namespaced by order and amount and can only ever *collapse* a duplicate, never
authorize a larger one.

A refund is complete only when Stripe confirms it. Until then it is `pending`,
the amount is held back from refundable, and the UI says "in progress".

## 6. Production — `POST /api/staff/production/jobs/[id]/status`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Any job transition | `production.manage` | `transitionProblem` allows | `expectedStatus` → 409 **and** `.eq("status", from)` → 409 | dialog; completion warnings returned unacknowledged once | none — production is internal | — | — | `staff.production.job.status` | guarded UPDATE matches zero rows on a repeat |
| Hold / rework | `production.manage` | reason required | ✔ | dialog | none | — | — | ✔ | ✔ |

The order page's **Shop work** panel is deliberately read-only. Duplicating a
status control there would be a second write path to guard, and production
notes must not leak to the customer — they never enter a notification payload.

## 7. Internal workspace — `PATCH /api/staff/orders/[id]/workspace`

Priority, assignee, checklist and cost rows. **Not consequential**: nothing here
is customer-visible, moves money, or changes stock. The checklist tick writes on
change, which is correct for an internal to-do and is the one place a
change-handler write is defensible. Recorded here so the exception is explicit
rather than an oversight.

## 8. Messages — `POST /api/orders/[id]/messages`

| Action | Permission | Requires | Expected-state guard | Confirm | Customer | Money | Stock | Audit | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| Message the customer | `orders.manage` | non-empty, ≤4000 | n/a — append-only | **dialog with the exact text previewed** | `customer_message` email + notification | — | — | `order_messages` row | **`client_token` unique per order**: a resend of the same token returns the first message |
| Add internal note | `orders.manage` | as above | n/a | none — nothing leaves the building | **none** | — | — | `order_messages.is_internal` | ✔ |

Before pass 11 the send button had no pending state and the dedup key was the
row id of the message just inserted — which is a *different* id on the second
click. Two clicks meant two customer messages and two emails. The token closes
it at the database.

The internal flag is enforced server-side (`isStaff && body.internal === true`)
and internal rows never reach `sendCommerceEmail`.

## 9. Email resend — **does not exist**

Audited and reported rather than built. `/staff/emails` edits templates and
sends a *test* to the signed-in staff address; there is no route that re-sends a
transactional email to a customer, and `email_deliveries` is display-only on the
order page.

Pass 11 did not add one. A "resend to customer" control is a new outbound-email
capability rather than a safety fix, and it is the one action in the brief whose
absence is safer than a hurried implementation. Recorded as deferred work with
the design constraints it would have to meet: fixed recipient taken from the
order, event key derived from the original delivery, an explicit audit event,
and no free-form recipient field anywhere.

---

## What pass 11 changed

1. **`PATCH /api/staff/orders/[id]` gained expected-state guards.** Status and
   quote revision are both asserted in the `WHERE` clause; a mismatch is a 409
   naming the current state, never an overwrite.
2. **Every consequential control gained a pending state.** No button on the
   order workspace can be pressed twice.
3. **`window.confirm` was replaced** by `ConsequentialActionDialog`, which shows
   the current state, the proposed state, and the customer / money / stock /
   email effects as four separate lines, restores focus, and traps a stale
   conflict in place instead of losing it to a page reload.
4. **Customer-visible and internal notes are separate fields** in every dialog
   that offers both, and the dialog labels which one the customer reads.
5. **Order messages are deduplicated at the database** by a per-order client
   token.

## Known residual risks

- The quote/status route still writes several concerns in one PATCH. It is
  guarded now, but a future pass should split "send a quote" from "save a note",
  because they have different consequences and share one button label history.
- `restore_order_inventory` is idempotent by ledger arithmetic rather than by a
  unique constraint. That is correct today and was verified by reading it; it
  is worth a regression test if the reason codes ever change.
- Email delivery is single-attempt. A failed customer email is recorded in
  `email_deliveries` and visible on the order, but there is no retry, which is
  the other half of the resend gap above.
