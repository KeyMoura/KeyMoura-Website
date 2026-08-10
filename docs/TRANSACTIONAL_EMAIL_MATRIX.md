# Transactional email matrix

Every email this application can send, what triggers it, who receives it, and
whether it can be sent twice.

**This file is generated from `src/lib/comms/emailEvents.ts`.** That module is
the definition; this document is a rendering of it. The arrangement is
deliberate: the ledger's own count of the email catalogue was wrong in three
consecutive passes, because a matrix kept only as prose drifts the moment
somebody adds a `sendCommerceEmail` call. `tests/transactional-emails.test.ts`
asserts the module against the routes, so an uncatalogued send fails the suite
and a catalogued template with no seeded row fails it too.

## How to read the columns

- **Event key** — the shape of the runtime idempotency key. It is written into
  `email_deliveries.event_key`, which is `unique`, and it is passed to Resend as
  its own idempotency key.
- **Repeat** — what happens on a second identical trigger. *suppressed* means
  the key is stable for the logical event, so the second attempt is refused by
  the unique index and nothing is sent. *new each message* means the key
  contains a row id that is genuinely new every time, because each message **is**
  a new event: a second staff reply is not a duplicate of the first.
- **Wired** — whether a trigger exists today. A `no` is a recorded gap with the
  reason stated in the module, never a silent omission.

## The delivery guarantee

`sendCommerceEmail` **claims the event before it sends it**. The claim is an
insert against the unique `event_key`; exactly one caller wins, and the loser
reads what the winner recorded:

- `sent` or `delivered` — the customer already has it. Never sent again.
- `queued` — somebody is sending it right now. Suppressed rather than raced.
- `failed` or `skipped` — nothing reached the customer, so a retry is correct.
  The row is re-claimed with a guarded update and `attempt_count` goes up.

The previous implementation sent first and recorded afterwards, so two
concurrent calls with the same key **both sent**; the only thing between a
customer and two identical emails was Resend's own 24-hour idempotency window.

## What never reaches a customer

Enforced by `INTERNAL_ONLY_FIELDS` in the module and asserted by the suite:
`staff_note`, `internal_note`, `fulfillment_notes`, `internal_notes`,
`scrap_reason`, `materials_cost_cents`, `labour_cost_cents`, and every Stripe
identifier. Only the variables in `CUSTOMER_SAFE_VARIABLES` are interpolated,
every one of them is escaped into the HTML, and values reaching the *subject*
are additionally stripped of line breaks — `customer_name` comes from user
metadata, which the customer controls.

Every message carries a plain-text alternative built from the same interpolated
strings as the HTML, so the two cannot drift.

---

### Requests and quotes

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `request_received` | `request_received` | customer | request | A custom request is submitted through /api/orders or /api/orders/custom. | `request-customer-{orderId} | custom-request-customer-{orderId}` | suppressed | orders row insert | yes |
| `staff_new_request` | `staff_new_request` | staff | request | The same submission, to the configured staff alert address. | `request-staff-{orderId} | custom-request-staff-{orderId}` | suppressed | orders row insert | yes |
| `needs_information` | `needs_information` | customer | order | Staff move an order to needs_information on PATCH /api/staff/orders/[id]. | `order-update-{orderId}-{historyId}-needs_information` | suppressed | order_status_history | yes |
| `customer_reply` | `staff_message` | staff | order | A customer posts a message on their order. | `order-message-{messageId}` | new each message | order_messages | yes |
| `staff_reply` | `customer_message` | customer | order | Staff post a customer-visible message on an order. | `order-message-{messageId}` | new each message | order_messages | yes |
| `quote_ready` | `quote_ready` | customer | order | A first priced quote becomes payable on PATCH /api/staff/orders/[id]. | `order-update-{orderId}-{historyId}-quote_ready` | suppressed | order_quotes + order_status_history | yes |
| `quote_updated` | `quote_updated` | customer | order | A revised quote is sent on an order that already had one. | `order-quote-{orderId}-rev{quoteRevision}` | suppressed | order_quotes + order_status_history | yes |
| `payment_required` | `status_update` | customer | order | An order moves to awaiting_payment. | `order-update-{orderId}-{historyId}-status_update` | suppressed | order_status_history | yes |
| `order_status_changed` | `status_update` | customer | order | Any other staff status change on PATCH /api/staff/orders/[id]. | `order-update-{orderId}-{historyId}-status_update` | suppressed | order_status_history | yes |
| `quote_expired` | `status_update` | customer | order | A quote passes quote_expires_at. | `order-quote-expired-{orderId}-rev{quoteRevision}` | suppressed | order_status_history | **no** |
| `payment_reminder` | `status_update` | customer | order | An accepted quote stays unpaid past a configured window. | `order-payment-reminder-{orderId}-{windowDays}` | suppressed | order_status_history | **no** |

### Support

Note what is **absent**: there is no event for an internal note. That is not an
omission — the internal-note route makes no call to the sender at all, so there
is no send to suppress and no flag that could be set wrongly. An internal note
reaches a customer only if somebody writes a new code path, and an uncatalogued
send fails the suite.

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `support_received` | `support_received` | customer | support | A support conversation is opened at POST /api/support, by an account holder or a guest. | `support-received-{conversationId}` | suppressed | support_conversations + support.created | yes |
| `support_staff_new` | `support_staff_new` | staff | support | The same submission, to the configured staff alert address. | `support-received-staff-{conversationId}` | suppressed | support_conversations + support.created | yes |
| `support_staff_reply` | `support_staff_reply` | customer | support | Staff post a customer-visible reply on a support conversation. | `support-reply-{messageId}` | new each message | support_messages + support.staff_replied | yes |
| `support_resolved` | `support_resolved` | customer | support | Staff move a support conversation to resolved. | `support-resolved-{conversationId}-{resolvedAt}` | suppressed | support.resolved | yes |

### Orders and payments

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `order_received` | `order_received` | customer | order | A direct purchase order is created at /api/cart/checkout, before payment. | `order-received-{orderId}` | suppressed | orders row insert | yes |
| `staff_new_order` | `staff_new_order` | staff | order | The same direct purchase, to the configured staff alert address. | `order-received-staff-{orderId}` | suppressed | orders row insert | yes |
| `payment_received` | `payment_received` | customer | order | checkout.session.completed or async_payment_succeeded settles a payment. | `stripe-paid-{stripeEventId}` | suppressed | order_payments + stripe_webhook_events | yes |
| `payment_failed` | `payment_failed` | customer | order | checkout.session.async_payment_failed. | `stripe-payment-failed-{stripeEventId}` | suppressed | stripe_webhook_events | yes |
| `staff_payment_failed` | `staff_payment_failed` | staff | order | The same failure, to the configured staff alert address. | `stripe-payment-failed-staff-{stripeEventId}` | suppressed | stripe_webhook_events | yes |

### Production

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `production_started` | `production_started` | customer | order | A production job linked to an order moves to in_progress. | `production-{jobId}-in_progress` | suppressed | production_job_events + staff.production.job.status | yes |
| `production_waiting_on_customer` | `production_waiting_on_customer` | customer | order | A linked production job moves to waiting_on_customer. | `production-{jobId}-waiting_on_customer` | suppressed | production_job_events + staff.production.job.status | yes |
| `production_completed` | `production_completed` | customer | order | A linked production job moves to completed. | `production-{jobId}-completed` | suppressed | production_job_events + staff.production.job.status | yes |
| `customer_information_received` | `status_update` | customer | order | A customer replies to a waiting-on-customer job; the reply itself is the message. | `order-message-{messageId}` | new each message | order_messages | yes |
| `ready_for_customer_review` | `status_update` | customer | order | Staff send a finished-product review package. | `order-update-{orderId}-{historyId}-status_update` | suppressed | order_status_history | yes |
| `revisions_requested` | `status_update` | customer | order | A customer requests revisions on a review package. | `order-update-{orderId}-{historyId}-status_update` | suppressed | order_status_history | yes |

### Fulfillment

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `fulfillment_processing` | `fulfillment_processing` | customer | order | Fulfillment moves to processing. | `fulfillment-{orderId}-processing` | suppressed | order_fulfillment_events + staff.order.fulfillment_changed | yes |
| `order_ready_to_fulfill` | `order_ready_to_fulfill` | customer | order | Fulfillment moves to ready_to_fulfill. | `fulfillment-{orderId}-ready_to_fulfill` | suppressed | order_fulfillment_events | yes |
| `order_ready_for_pickup` | `order_ready_for_pickup` | customer | order | Fulfillment moves to ready_for_pickup. | `fulfillment-{orderId}-ready_for_pickup` | suppressed | order_fulfillment_events + staff.order.fulfillment_changed | yes |
| `order_picked_up` | `order_picked_up` | customer | order | Fulfillment moves to picked_up. | `fulfillment-{orderId}-picked_up` | suppressed | order_fulfillment_events + staff.order.fulfillment_changed | yes |
| `order_shipped` | `order_shipped` | customer | order | Fulfillment moves to shipped. | `fulfillment-{orderId}-shipped` | suppressed | order_fulfillment_events + staff.order.fulfillment_changed | yes |
| `order_delivered` | `order_delivered` | customer | order | Fulfillment moves to delivered. | `fulfillment-{orderId}-delivered` | suppressed | order_fulfillment_events + staff.order.fulfillment_changed | yes |
| `tracking_corrected` | `tracking_corrected` | customer | order | A tracking number is corrected and actually changed. | `tracking-corrected-{orderId}-{trackingNumber}` | suppressed | order_fulfillment_events + staff.order.tracking_corrected | yes |

### Cancellations

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `cancellation_requested` | `cancellation_requested` | customer | cancellation | A customer opens a cancellation request on a paid order. | `cancel-request-{requestId}` | suppressed | order_cancellation_requests | yes |
| `staff_cancellation_request` | `staff_cancellation_request` | staff | cancellation | The same request, to the configured staff alert address. | `cancel-request-staff-{requestId}` | suppressed | order_cancellation_requests | yes |
| `cancellation_withdrawn` | `cancellation_withdrawn` | customer | cancellation | A customer withdraws their own pending cancellation request. | `cancel-withdraw-{requestId}` | suppressed | order_cancellation_requests | yes |
| `cancellation_approved` | `cancellation_approved` | customer | cancellation | Staff approve a pending cancellation request. | `cancel-approved-{requestId}` | suppressed | staff.order.cancellation_approved | yes |
| `cancellation_denied` | `cancellation_denied` | customer | cancellation | Staff deny a pending cancellation request, with a customer-visible reason. | `cancel-denied-{requestId}` | suppressed | staff.order.cancellation_denied | yes |
| `cancellation_completed` | `order_cancelled` | customer | order | An unpaid eligible order is cancelled outright, with no staff decision. | `cancel-{orderId}-{requestId|immediate}` | suppressed | order_status_history | yes |

### Returns and refunds

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `return_requested` | `return_requested` | customer | return | A customer opens a return. | `return-request-{returnId}` | suppressed | order_returns | yes |
| `staff_return_request` | `staff_return_request` | staff | return | The same return, to the configured staff alert address. | `return-request-staff-{returnId}` | suppressed | order_returns | yes |
| `return_approved` | `return_approved` | customer | return | Staff approve a return. Carries the snapshotted return address and instructions. | `return-approved-{returnId}` | suppressed | staff.order.return_approved | yes |
| `return_denied` | `return_denied` | customer | return | Staff deny a return, with a customer-visible reason. | `return-denied-{returnId}` | suppressed | staff.order.return_denied | yes |
| `return_received` | `return_received` | customer | return | Staff record that the parcel arrived. | `return-received-{returnId}` | suppressed | staff.order.return_received | yes |
| `return_inspected` | `return_inspected` | customer | return | Staff record the inspection outcome. | `return-inspected-{returnId}` | suppressed | staff.order.return_inspected | yes |
| `refund_initiated` | `refund_initiated` | customer | refund | A refund is accepted by Stripe but not yet settled. | `refund-sent-{refundLegIds}` | suppressed | staff.order.refund_sent | yes |
| `refund_partial_completed` | `refund_partial_completed` | customer | refund | A settled refund leaves part of the order still paid. | `refund-done-{refundLegIds} | refund-webhook-{stripeRefundId}-succeeded` | suppressed | staff.order.refund_sent | stripe_webhook_events | yes |
| `refund_completed` | `refund_completed` | customer | refund | A settled refund returns the whole remaining balance. | `refund-done-{refundLegIds} | refund-webhook-{stripeRefundId}-succeeded` | suppressed | staff.order.refund_sent | stripe_webhook_events | yes |
| `refund_failed` | `refund_failed` | customer | refund | Stripe refuses or fails a refund leg, from the route or from a webhook. | `refund-failed-{refundLegIds} | refund-webhook-{stripeRefundId}-failed` | suppressed | staff.order.refund_failed | stripe_webhook_events | yes |

### Inventory and operations

| Event | Template | To | Record | Trigger | Event key | Repeat | Activity / audit | Wired |
|---|---|---|---|---|---|---|---|---|
| `guest_order_access_requested` | `guest_order_access` | customer | order | A guest opens their order without a valid session, or asks for a new code. | `guest-access-{challengeId}` | suppressed | guest_order_access_codes | yes |
| `low_stock` | `low_stock_alert` | staff | product | A tracked product falls to or below its low-stock threshold. | `inventory-alert-{alertId}-low-{recipient}` | suppressed | inventory_alerts | yes |
| `out_of_stock` | `out_of_stock_alert` | staff | product | A tracked product reaches zero, or an open low alert escalates. | `inventory-alert-{alertId}-out-{recipient}` | suppressed | inventory_alerts | yes |
| `fulfillment_overdue` | `staff_fulfillment_due` | staff | order | An order sits unfulfilled past the configured window. | `fulfillment-overdue-{orderId}-{windowDays}` | suppressed | — | **no** |
| `reservation_inconsistency` | `staff_integration_failure` | staff | product | Reconciliation finds a hold that lapsed or outlived its order's payment. | `ops-{alertKind}-{subjectId}` | suppressed | — | **no** |
| `webhook_failure` | `staff_integration_failure` | staff | system | A Stripe webhook is received but cannot be processed. | `ops-webhook_failure-{stripeEventId}` | suppressed | stripe_webhook_events | yes |
| `email_delivery_failure` | `staff_integration_failure` | staff | system | A customer email is refused by Resend. | `ops-email_failure-{deliveryEventKey}` | suppressed | email_deliveries | yes |


Totals: 52 events across 44 templates; 48 wired, 4 recorded-not-built.

## Recorded, not built

Four events are catalogued with `wired: false`. Each needs the same missing
thing — **a scheduled job runner, which this project does not have**:

- `quote_expired` — `quote_expires_at` exists from `20260801050000` and nothing
  sweeps it.
- `payment_reminder` — an accepted quote left unpaid past a window.
- `fulfillment_overdue` — surfaced as an in-app alert and on the dashboard
  instead.
- `reservation_inconsistency` — surfaced by reconciliation, which is read-only
  and runs when a staff member opens it.

Sending any of these from a page load would mean whoever opened the page
triggered the customer's email. They are specified and unbuilt rather than
half-wired.

## Deliberately in-app only

`email_delivery_failure` raises a notification and is **never itself an email**.
Emailing about a broken mailer is how a failure loop starts, and the one case
where the mailer is definitely broken is the case that would trigger it.
