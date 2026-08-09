/**
 * The transactional email catalogue — one definition, read by everything.
 *
 * Pure and dependency-free on purpose. `sendCommerceEmail` is the only sender
 * and `email_templates` is the only template store; this module is neither. It
 * is the *inventory*: for every email this application can send, what triggers
 * it, who receives it, which record it belongs to, and how its idempotency key
 * is built.
 *
 * Why it exists as code rather than only as prose. Before this pass the answer
 * to "which emails does this system send, and can it send one twice?" could
 * only be assembled by reading twenty-odd route files, and the ledger's own
 * count of the catalogue had been wrong in three consecutive passes. A matrix
 * in a document drifts silently. This one is asserted against the routes by
 * `tests/transactional-emails.test.ts`, so a new `sendCommerceEmail` call that
 * is not listed here fails the suite, and a listed event whose template is not
 * seeded fails it too.
 *
 * `docs/TRANSACTIONAL_EMAIL_MATRIX.md` is written from this table.
 */

/** Every template key `email_templates` holds a row for. */
export const EMAIL_TEMPLATE_KEYS = [
  // Requests and quotes
  "request_received",
  "staff_new_request",
  "needs_information",
  "quote_ready",
  "quote_updated",
  "status_update",
  "customer_message",
  "staff_message",
  // Orders and payments
  "order_received",
  "staff_new_order",
  "payment_received",
  "payment_failed",
  "staff_payment_failed",
  // Production
  "production_started",
  "production_waiting_on_customer",
  "production_completed",
  // Fulfillment
  "fulfillment_processing",
  "order_ready_to_fulfill",
  "order_ready_for_pickup",
  "order_picked_up",
  "order_shipped",
  "order_delivered",
  "tracking_corrected",
  // Cancellations
  "cancellation_requested",
  "staff_cancellation_request",
  "cancellation_withdrawn",
  "cancellation_approved",
  "cancellation_denied",
  "order_cancelled",
  // Returns and refunds
  "return_requested",
  "staff_return_request",
  "return_approved",
  "return_denied",
  "return_received",
  "return_inspected",
  "refund_initiated",
  "refund_partial_completed",
  "refund_completed",
  "refund_failed",
  // Inventory and operations
  "low_stock_alert",
  "out_of_stock_alert",
  "staff_fulfillment_due",
  "staff_integration_failure",
  "guest_order_access",
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Who the message is addressed to. Decides which surfaces may show the body. */
export type EmailAudience = "customer" | "staff";

/** The record an email hangs off, used for filtering and for the resend link. */
export type EmailRelatedKind =
  | "order"
  | "request"
  | "return"
  | "cancellation"
  | "refund"
  | "product"
  | "system";

/**
 * What happens on a second identical trigger.
 *
 * - `suppressed` — the event key is stable for the logical event, so the second
 *   attempt hits the `email_deliveries` unique key and nothing is sent.
 * - `per_message` — the key includes a row id that is genuinely new each time,
 *   because each message *is* a new event (a second staff reply is not a
 *   duplicate of the first).
 */
export type EmailIdempotency = "suppressed" | "per_message";

export type EmailEvent = {
  /** Stable identifier for this event in the matrix. Not the runtime key. */
  id: string;
  templateKey: EmailTemplateKey;
  audience: EmailAudience;
  related: EmailRelatedKind;
  /** What causes it to be sent, in one sentence. */
  trigger: string;
  /** How the runtime `eventKey` is constructed, as a literal shape. */
  eventKeyShape: string;
  idempotency: EmailIdempotency;
  /** The audit or activity record written alongside, or null when there is none. */
  activity: string | null;
  /**
   * True when a staff member may re-send this to the original recipient from
   * the delivery centre. A staff alert is never resendable to a customer, and
   * an alert whose recipient is a configured address rather than a person is
   * not resendable at all.
   */
  resendable: boolean;
  /** Whether this event is wired to a trigger today. */
  wired: boolean;
  /** Set when `wired` is false: why, and what it would need. */
  notes?: string;
};

/**
 * Free-text variables that reach a customer.
 *
 * Every one is written *for* the customer by the route that sends it. Internal
 * notes, production notes, scrap reasons, staff notes and Postgres error
 * details are never routed into these — `tests/transactional-emails.test.ts`
 * asserts the internal-note column names never appear in a send call.
 */
export const CUSTOMER_SAFE_VARIABLES = [
  "customer_name",
  "product_name",
  "order_label",
  "status",
  "price",
  "detail",
  "quantity",
  "threshold",
  // Delivery facts. Safe because each is either chosen by staff for the
  // customer (carrier, tracking number) or already shown to them once the
  // order is ready (pickup location and instructions). `pickup_location` is
  // the *name and address the customer is told to come to*, which is a
  // different value from the shipping origin — the origin is deliberately
  // never sent anywhere.
  "carrier",
  "tracking_number",
  "fulfillment_method",
  "pickup_location",
  "pickup_instructions",
  "date",
] as const;

/**
 * The only variable names a caller may add beyond the standard set.
 *
 * `sendLifecycleNotification` filters extras through this, so a route cannot
 * smuggle an internal note into a template by inventing a variable name for it.
 * A name outside the list is dropped rather than passed through.
 */
export const EXTRA_CUSTOMER_VARIABLES = [
  "carrier",
  "tracking_number",
  "fulfillment_method",
  "pickup_location",
  "pickup_instructions",
  "date",
] as const;

/**
 * Placeholders in a template that will not be substituted.
 *
 * The sender replaces exactly `/\{\{([a-z_]+)\}\}/g`. Anything else is left in
 * the message **verbatim** and mailed to the customer as typed — so
 * `{{ customer_name }}`, `{Customer_Name}` and `{{first-name}}` are not
 * "ignored", they are delivered. A staff member has no way to discover that
 * short of sending themselves a test.
 *
 * Two distinct problems are reported, because they fail differently:
 *
 * - **malformed** — never matched, so the literal braces reach the customer.
 * - **unknown** — correctly formed but not a variable anything supplies, so it
 *   is replaced with an empty string and the sentence quietly loses a word.
 *
 * Returned as text to show rather than thrown: this is a warning beside the
 * field, not a refusal. Some of these are legitimately intentional — a template
 * about JSON, or a brace in prose — and refusing to save would be wrong.
 */
export function findPlaceholderProblems(text: string): { malformed: string[]; unknown: string[] } {
  const source = typeof text === "string" ? text : "";
  const allowed = new Set<string>(CUSTOMER_SAFE_VARIABLES);

  const unknown: string[] = [];
  for (const match of source.matchAll(/\{\{([a-z_]+)\}\}/g)) {
    if (!allowed.has(match[1]) && !unknown.includes(match[0])) unknown.push(match[0]);
  }

  const malformed: string[] = [];
  // Anything brace-wrapped that the sender's pattern would not match: single
  // braces, spaces inside, capitals, hyphens, digits.
  for (const match of source.matchAll(/\{\{?[^{}]*\}?\}/g)) {
    const token = match[0];
    if (/^\{\{[a-z_]+\}\}$/.test(token)) continue; // well-formed; handled above
    if (!/[A-Za-z]/.test(token)) continue; // `{}` or `{ }` is not a placeholder attempt
    if (!malformed.includes(token)) malformed.push(token);
  }

  return { malformed, unknown };
}

/** Drop anything that is not an allow-listed customer-safe variable. */
export function filterCustomerVariables(input: Record<string, string>): Record<string, string> {
  const allowed = new Set<string>(EXTRA_CUSTOMER_VARIABLES);
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([key, value]) => allowed.has(key) && typeof value === "string")
  );
}

/**
 * Column names that must never be interpolated into a customer email.
 *
 * Named here rather than in the test so the prohibition is discoverable from
 * the module it constrains.
 */
export const INTERNAL_ONLY_FIELDS = [
  "staff_note",
  "internal_note",
  "fulfillment_notes",
  "internal_notes",
  "scrap_reason",
  "materials_cost_cents",
  "labour_cost_cents",
  "stripe_payment_intent_id",
  "stripe_charge_id",
  "stripe_session_id",
] as const;

export const EMAIL_EVENTS: readonly EmailEvent[] = [
  // ---------------------------------------------------------------- requests
  {
    id: "request_received",
    templateKey: "request_received",
    audience: "customer",
    related: "request",
    trigger: "A custom request is submitted through /api/orders or /api/orders/custom.",
    eventKeyShape: "request-customer-{orderId} | custom-request-customer-{orderId}",
    idempotency: "suppressed",
    activity: "orders row insert",
    resendable: true,
    wired: true,
  },
  {
    id: "staff_new_request",
    templateKey: "staff_new_request",
    audience: "staff",
    related: "request",
    trigger: "The same submission, to the configured staff alert address.",
    eventKeyShape: "request-staff-{orderId} | custom-request-staff-{orderId}",
    idempotency: "suppressed",
    activity: "orders row insert",
    resendable: false,
    wired: true,
  },
  {
    id: "needs_information",
    templateKey: "needs_information",
    audience: "customer",
    related: "order",
    trigger: "Staff move an order to needs_information on PATCH /api/staff/orders/[id].",
    eventKeyShape: "order-update-{orderId}-{historyId}-needs_information",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: true,
  },
  {
    id: "customer_reply",
    templateKey: "staff_message",
    audience: "staff",
    related: "order",
    trigger: "A customer posts a message on their order.",
    eventKeyShape: "order-message-{messageId}",
    idempotency: "per_message",
    activity: "order_messages",
    resendable: false,
    wired: true,
  },
  {
    id: "staff_reply",
    templateKey: "customer_message",
    audience: "customer",
    related: "order",
    trigger: "Staff post a customer-visible message on an order.",
    eventKeyShape: "order-message-{messageId}",
    idempotency: "per_message",
    activity: "order_messages",
    resendable: true,
    wired: true,
  },
  {
    id: "quote_ready",
    templateKey: "quote_ready",
    audience: "customer",
    related: "order",
    trigger: "A first priced quote becomes payable on PATCH /api/staff/orders/[id].",
    eventKeyShape: "order-update-{orderId}-{historyId}-quote_ready",
    idempotency: "suppressed",
    activity: "order_quotes + order_status_history",
    resendable: true,
    wired: true,
  },
  {
    id: "quote_updated",
    templateKey: "quote_updated",
    audience: "customer",
    related: "order",
    trigger: "A revised quote is sent on an order that already had one.",
    eventKeyShape: "order-quote-{orderId}-rev{quoteRevision}",
    idempotency: "suppressed",
    activity: "order_quotes + order_status_history",
    resendable: true,
    wired: true,
  },
  {
    id: "payment_required",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "An order moves to awaiting_payment.",
    eventKeyShape: "order-update-{orderId}-{historyId}-status_update",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: true,
  },
  {
    id: "order_status_changed",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "Any other staff status change on PATCH /api/staff/orders/[id].",
    eventKeyShape: "order-update-{orderId}-{historyId}-status_update",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: true,
  },
  {
    id: "quote_expired",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "A quote passes quote_expires_at.",
    eventKeyShape: "order-quote-expired-{orderId}-rev{quoteRevision}",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: false,
    notes:
      "The column exists from 20260801050000 but nothing sweeps it. Expiry needs a scheduled job, which this project does not have; a request-time sweep would fire on whoever happens to load the page. Recorded rather than half-wired.",
  },
  {
    id: "payment_reminder",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "An accepted quote stays unpaid past a configured window.",
    eventKeyShape: "order-payment-reminder-{orderId}-{windowDays}",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: false,
    notes:
      "Needs the same scheduling this project lacks. Sending it from a page load would mean a customer's own visit triggers their reminder.",
  },

  // ------------------------------------------------------ orders and payment
  {
    id: "order_received",
    templateKey: "order_received",
    audience: "customer",
    related: "order",
    trigger: "A direct purchase order is created at /api/cart/checkout, before payment.",
    eventKeyShape: "order-received-{orderId}",
    idempotency: "suppressed",
    activity: "orders row insert",
    resendable: true,
    wired: true,
  },
  {
    id: "staff_new_order",
    templateKey: "staff_new_order",
    audience: "staff",
    related: "order",
    trigger: "The same direct purchase, to the configured staff alert address.",
    eventKeyShape: "order-received-staff-{orderId}",
    idempotency: "suppressed",
    activity: "orders row insert",
    resendable: false,
    wired: true,
  },
  {
    id: "payment_received",
    templateKey: "payment_received",
    audience: "customer",
    related: "order",
    trigger: "checkout.session.completed or async_payment_succeeded settles a payment.",
    eventKeyShape: "stripe-paid-{stripeEventId}",
    idempotency: "suppressed",
    activity: "order_payments + stripe_webhook_events",
    resendable: true,
    wired: true,
  },
  {
    id: "payment_failed",
    templateKey: "payment_failed",
    audience: "customer",
    related: "order",
    trigger: "checkout.session.async_payment_failed.",
    eventKeyShape: "stripe-payment-failed-{stripeEventId}",
    idempotency: "suppressed",
    activity: "stripe_webhook_events",
    resendable: true,
    wired: true,
  },
  {
    id: "staff_payment_failed",
    templateKey: "staff_payment_failed",
    audience: "staff",
    related: "order",
    trigger: "The same failure, to the configured staff alert address.",
    eventKeyShape: "stripe-payment-failed-staff-{stripeEventId}",
    idempotency: "suppressed",
    activity: "stripe_webhook_events",
    resendable: false,
    wired: true,
  },

  // ------------------------------------------------------------- production
  {
    id: "production_started",
    templateKey: "production_started",
    audience: "customer",
    related: "order",
    trigger: "A production job linked to an order moves to in_progress.",
    eventKeyShape: "production-{jobId}-in_progress",
    idempotency: "suppressed",
    activity: "production_job_events + staff.production.job.status",
    resendable: true,
    wired: true,
  },
  {
    id: "production_waiting_on_customer",
    templateKey: "production_waiting_on_customer",
    audience: "customer",
    related: "order",
    trigger: "A linked production job moves to waiting_on_customer.",
    eventKeyShape: "production-{jobId}-waiting_on_customer",
    idempotency: "suppressed",
    activity: "production_job_events + staff.production.job.status",
    resendable: true,
    wired: true,
  },
  {
    id: "production_completed",
    templateKey: "production_completed",
    audience: "customer",
    related: "order",
    trigger: "A linked production job moves to completed.",
    eventKeyShape: "production-{jobId}-completed",
    idempotency: "suppressed",
    activity: "production_job_events + staff.production.job.status",
    resendable: true,
    wired: true,
  },
  {
    id: "customer_information_received",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "A customer replies to a waiting-on-customer job; the reply itself is the message.",
    eventKeyShape: "order-message-{messageId}",
    idempotency: "per_message",
    activity: "order_messages",
    resendable: false,
    wired: true,
    notes:
      "Deliberately not a separate email. The customer already knows they replied; the staff-side alert is what matters and it is `customer_reply` above.",
  },
  {
    id: "ready_for_customer_review",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "Staff send a finished-product review package.",
    eventKeyShape: "order-update-{orderId}-{historyId}-status_update",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: true,
  },
  {
    id: "revisions_requested",
    templateKey: "status_update",
    audience: "customer",
    related: "order",
    trigger: "A customer requests revisions on a review package.",
    eventKeyShape: "order-update-{orderId}-{historyId}-status_update",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: true,
  },

  // ------------------------------------------------------------ fulfillment
  {
    id: "fulfillment_processing",
    templateKey: "fulfillment_processing",
    audience: "customer",
    related: "order",
    trigger: "Fulfillment moves to processing.",
    eventKeyShape: "fulfillment-{orderId}-processing",
    idempotency: "suppressed",
    activity: "order_fulfillment_events + staff.order.fulfillment_changed",
    resendable: true,
    wired: true,
  },
  {
    id: "order_ready_for_pickup",
    templateKey: "order_ready_for_pickup",
    audience: "customer",
    related: "order",
    trigger: "Fulfillment moves to ready_for_pickup.",
    eventKeyShape: "fulfillment-{orderId}-ready_for_pickup",
    idempotency: "suppressed",
    activity: "order_fulfillment_events + staff.order.fulfillment_changed",
    resendable: true,
    wired: true,
  },
  {
    id: "order_picked_up",
    templateKey: "order_picked_up",
    audience: "customer",
    related: "order",
    trigger: "Fulfillment moves to picked_up.",
    eventKeyShape: "fulfillment-{orderId}-picked_up",
    idempotency: "suppressed",
    activity: "order_fulfillment_events + staff.order.fulfillment_changed",
    resendable: true,
    wired: true,
  },
  {
    id: "order_shipped",
    templateKey: "order_shipped",
    audience: "customer",
    related: "order",
    trigger: "Fulfillment moves to shipped.",
    eventKeyShape: "fulfillment-{orderId}-shipped",
    idempotency: "suppressed",
    activity: "order_fulfillment_events + staff.order.fulfillment_changed",
    resendable: true,
    wired: true,
  },
  {
    id: "order_delivered",
    templateKey: "order_delivered",
    audience: "customer",
    related: "order",
    trigger: "Fulfillment moves to delivered.",
    eventKeyShape: "fulfillment-{orderId}-delivered",
    idempotency: "suppressed",
    activity: "order_fulfillment_events + staff.order.fulfillment_changed",
    resendable: true,
    wired: true,
  },
  {
    id: "tracking_corrected",
    templateKey: "tracking_corrected",
    audience: "customer",
    related: "order",
    trigger: "A tracking number is corrected and actually changed.",
    eventKeyShape: "tracking-corrected-{orderId}-{trackingNumber}",
    idempotency: "suppressed",
    activity: "order_fulfillment_events + staff.order.tracking_corrected",
    resendable: true,
    wired: true,
  },
  {
    id: "order_ready_to_fulfill",
    templateKey: "order_ready_to_fulfill",
    audience: "customer",
    related: "order",
    trigger: "Fulfillment moves to ready_to_fulfill.",
    eventKeyShape: "fulfillment-{orderId}-ready_to_fulfill",
    idempotency: "suppressed",
    activity: "order_fulfillment_events",
    resendable: true,
    wired: true,
    notes: "Seeded and reachable, but FULFILLMENT_CUSTOMER_EMAIL maps this state to no send — packing is not news.",
  },

  // ----------------------------------------------------------- cancellations
  {
    id: "cancellation_requested",
    templateKey: "cancellation_requested",
    audience: "customer",
    related: "cancellation",
    trigger: "A customer opens a cancellation request on a paid order.",
    eventKeyShape: "cancel-request-{requestId}",
    idempotency: "suppressed",
    activity: "order_cancellation_requests",
    resendable: true,
    wired: true,
  },
  {
    id: "staff_cancellation_request",
    templateKey: "staff_cancellation_request",
    audience: "staff",
    related: "cancellation",
    trigger: "The same request, to the configured staff alert address.",
    eventKeyShape: "cancel-request-staff-{requestId}",
    idempotency: "suppressed",
    activity: "order_cancellation_requests",
    resendable: false,
    wired: true,
  },
  {
    id: "cancellation_withdrawn",
    templateKey: "cancellation_withdrawn",
    audience: "customer",
    related: "cancellation",
    trigger: "A customer withdraws their own pending cancellation request.",
    eventKeyShape: "cancel-withdraw-{requestId}",
    idempotency: "suppressed",
    activity: "order_cancellation_requests",
    resendable: true,
    wired: true,
  },
  {
    id: "cancellation_approved",
    templateKey: "cancellation_approved",
    audience: "customer",
    related: "cancellation",
    trigger: "Staff approve a pending cancellation request.",
    eventKeyShape: "cancel-approved-{requestId}",
    idempotency: "suppressed",
    activity: "staff.order.cancellation_approved",
    resendable: true,
    wired: true,
  },
  {
    id: "cancellation_denied",
    templateKey: "cancellation_denied",
    audience: "customer",
    related: "cancellation",
    trigger: "Staff deny a pending cancellation request, with a customer-visible reason.",
    eventKeyShape: "cancel-denied-{requestId}",
    idempotency: "suppressed",
    activity: "staff.order.cancellation_denied",
    resendable: true,
    wired: true,
  },
  {
    id: "cancellation_completed",
    templateKey: "order_cancelled",
    audience: "customer",
    related: "order",
    trigger: "An unpaid eligible order is cancelled outright, with no staff decision.",
    eventKeyShape: "cancel-{orderId}-{requestId|immediate}",
    idempotency: "suppressed",
    activity: "order_status_history",
    resendable: true,
    wired: true,
  },

  // ------------------------------------------------------ returns and refunds
  {
    id: "return_requested",
    templateKey: "return_requested",
    audience: "customer",
    related: "return",
    trigger: "A customer opens a return.",
    eventKeyShape: "return-request-{returnId}",
    idempotency: "suppressed",
    activity: "order_returns",
    resendable: true,
    wired: true,
  },
  {
    id: "staff_return_request",
    templateKey: "staff_return_request",
    audience: "staff",
    related: "return",
    trigger: "The same return, to the configured staff alert address.",
    eventKeyShape: "return-request-staff-{returnId}",
    idempotency: "suppressed",
    activity: "order_returns",
    resendable: false,
    wired: true,
  },
  {
    id: "return_approved",
    templateKey: "return_approved",
    audience: "customer",
    related: "return",
    trigger: "Staff approve a return. Carries the snapshotted return address and instructions.",
    eventKeyShape: "return-approved-{returnId}",
    idempotency: "suppressed",
    activity: "staff.order.return_approved",
    resendable: true,
    wired: true,
  },
  {
    id: "return_denied",
    templateKey: "return_denied",
    audience: "customer",
    related: "return",
    trigger: "Staff deny a return, with a customer-visible reason.",
    eventKeyShape: "return-denied-{returnId}",
    idempotency: "suppressed",
    activity: "staff.order.return_denied",
    resendable: true,
    wired: true,
  },
  {
    id: "return_received",
    templateKey: "return_received",
    audience: "customer",
    related: "return",
    trigger: "Staff record that the parcel arrived.",
    eventKeyShape: "return-received-{returnId}",
    idempotency: "suppressed",
    activity: "staff.order.return_received",
    resendable: true,
    wired: true,
  },
  {
    id: "return_inspected",
    templateKey: "return_inspected",
    audience: "customer",
    related: "return",
    trigger: "Staff record the inspection outcome.",
    eventKeyShape: "return-inspected-{returnId}",
    idempotency: "suppressed",
    activity: "staff.order.return_inspected",
    resendable: true,
    wired: true,
  },
  {
    id: "refund_initiated",
    templateKey: "refund_initiated",
    audience: "customer",
    related: "refund",
    trigger: "A refund is accepted by Stripe but not yet settled.",
    eventKeyShape: "refund-sent-{refundLegIds}",
    idempotency: "suppressed",
    activity: "staff.order.refund_sent",
    resendable: true,
    wired: true,
  },
  {
    id: "refund_partial_completed",
    templateKey: "refund_partial_completed",
    audience: "customer",
    related: "refund",
    trigger: "A settled refund leaves part of the order still paid.",
    eventKeyShape: "refund-done-{refundLegIds} | refund-webhook-{stripeRefundId}-succeeded",
    idempotency: "suppressed",
    activity: "staff.order.refund_sent | stripe_webhook_events",
    resendable: true,
    wired: true,
  },
  {
    id: "refund_completed",
    templateKey: "refund_completed",
    audience: "customer",
    related: "refund",
    trigger: "A settled refund returns the whole remaining balance.",
    eventKeyShape: "refund-done-{refundLegIds} | refund-webhook-{stripeRefundId}-succeeded",
    idempotency: "suppressed",
    activity: "staff.order.refund_sent | stripe_webhook_events",
    resendable: true,
    wired: true,
  },
  {
    id: "refund_failed",
    templateKey: "refund_failed",
    audience: "customer",
    related: "refund",
    trigger: "Stripe refuses or fails a refund leg, from the route or from a webhook.",
    eventKeyShape: "refund-failed-{refundLegIds} | refund-webhook-{stripeRefundId}-failed",
    idempotency: "suppressed",
    activity: "staff.order.refund_failed | stripe_webhook_events",
    resendable: true,
    wired: true,
  },

  // ------------------------------------------------ inventory and operations
  {
    id: "low_stock",
    templateKey: "low_stock_alert",
    audience: "staff",
    related: "product",
    trigger: "A tracked product falls to or below its low-stock threshold.",
    eventKeyShape: "inventory-alert-{alertId}-low-{recipient}",
    idempotency: "suppressed",
    activity: "inventory_alerts",
    resendable: false,
    wired: true,
  },
  {
    id: "out_of_stock",
    templateKey: "out_of_stock_alert",
    audience: "staff",
    related: "product",
    trigger: "A tracked product reaches zero, or an open low alert escalates.",
    eventKeyShape: "inventory-alert-{alertId}-out-{recipient}",
    idempotency: "suppressed",
    activity: "inventory_alerts",
    resendable: false,
    wired: true,
  },
  {
    id: "guest_order_access_requested",
    templateKey: "guest_order_access",
    audience: "customer",
    related: "order",
    trigger: "A guest requests a verification code on the guest order page.",
    eventKeyShape: "guest-access-{challengeId}",
    idempotency: "suppressed",
    activity: "guest_order_access_codes",
    resendable: false,
    wired: true,
  },
  {
    id: "fulfillment_overdue",
    templateKey: "staff_fulfillment_due",
    audience: "staff",
    related: "order",
    trigger: "An order sits unfulfilled past the configured window.",
    eventKeyShape: "fulfillment-overdue-{orderId}-{windowDays}",
    idempotency: "suppressed",
    activity: null,
    resendable: false,
    wired: false,
    notes:
      "Surfaced as an in-app operational notification and on the dashboard instead. An email needs the scheduling this project does not have; sending it on a page load would mean whoever opens the dashboard triggers it.",
  },
  {
    id: "reservation_inconsistency",
    templateKey: "staff_integration_failure",
    audience: "staff",
    related: "product",
    trigger: "Reconciliation finds a hold that lapsed or outlived its order's payment.",
    eventKeyShape: "ops-{alertKind}-{subjectId}",
    idempotency: "suppressed",
    activity: null,
    resendable: false,
    wired: false,
    notes:
      "In-app operational notification only. Reconciliation is read-only and runs when a staff member opens it, so emailing from it would email whoever looked.",
  },
  {
    id: "webhook_failure",
    templateKey: "staff_integration_failure",
    audience: "staff",
    related: "system",
    trigger: "A Stripe webhook is received but cannot be processed.",
    eventKeyShape: "ops-webhook_failure-{stripeEventId}",
    idempotency: "suppressed",
    activity: "stripe_webhook_events",
    resendable: false,
    wired: true,
  },
  {
    id: "email_delivery_failure",
    templateKey: "staff_integration_failure",
    audience: "staff",
    related: "system",
    trigger: "A customer email is refused by Resend.",
    eventKeyShape: "ops-email_failure-{deliveryEventKey}",
    idempotency: "suppressed",
    activity: "email_deliveries",
    resendable: false,
    wired: true,
    notes:
      "Deliberately an in-app notification and never itself an email: emailing about a broken mailer is how a failure loop starts.",
  },
];

/** Every event, indexed by its matrix id. */
/**
 * Every event that sends a given template.
 *
 * `/staff/emails` uses this to answer the question the page could not answer
 * before: *what actually causes this email to go out?* The editor previously
 * carried a hand-written sentence per template, maintained beside this
 * catalogue rather than from it — a second source of truth for the one fact a
 * staff member is relying on when they change the wording.
 */
export function eventsForTemplate(templateKey: string): EmailEvent[] {
  return EMAIL_EVENTS.filter((event) => event.templateKey === templateKey);
}

/**
 * Whether editing this template can currently change any email that is sent.
 *
 * A template whose every event is `wired: false` is editable, saved, and reaches
 * nobody — which is exactly the "dead template setting pretending to control
 * production email" this audit was asked to rule out. Rather than hide the row
 * (it is a real template with a real, specified trigger that is simply not built
 * yet) the page says so, and says what it is waiting on.
 */
export function templateWiring(templateKey: string): {
  events: EmailEvent[];
  wired: boolean;
  /** Set when nothing is wired: why not, taken from the event's own note. */
  pendingReason: string | null;
} {
  const events = eventsForTemplate(templateKey);
  const wired = events.some((event) => event.wired);
  const pendingReason = wired ? null : events.find((event) => event.notes)?.notes ?? null;
  return { events, wired, pendingReason };
}

export const EMAIL_EVENTS_BY_ID: Readonly<Record<string, EmailEvent>> = Object.freeze(
  Object.fromEntries(EMAIL_EVENTS.map((event) => [event.id, event]))
);

/** Template keys a staff member may re-send from the delivery centre. */
export const RESENDABLE_TEMPLATE_KEYS: readonly EmailTemplateKey[] = [
  ...new Set(EMAIL_EVENTS.filter((event) => event.resendable).map((event) => event.templateKey)),
];

/**
 * True when this template may be re-sent to its original recipient.
 *
 * The delivery centre asks this, not the caller. A staff alert addressed to a
 * configured mailbox is not resendable, because "resend" on it means "email the
 * shop again", which is a notification rather than a customer communication and
 * has no failure the customer is waiting on.
 */
export function isResendableTemplate(key: string): key is EmailTemplateKey {
  return (RESENDABLE_TEMPLATE_KEYS as readonly string[]).includes(key);
}

/** The audience a template addresses, or null for a key not in the catalogue. */
export function audienceForTemplate(key: string): EmailAudience | null {
  return EMAIL_EVENTS.find((event) => event.templateKey === key)?.audience ?? null;
}

/**
 * Mask an email address for display in a staff list.
 *
 * The delivery centre shows who a message went to without putting a complete
 * customer address on a screen that is filtered, paginated and screenshotted.
 * The local part keeps its first character and its last when there is room, the
 * domain is kept whole — a staff member needs to tell `gmail.com` from a
 * typo'd `gmial.com`, which is exactly the failure this list exists to spot.
 */
export function maskRecipient(recipient: string): string {
  const value = (recipient ?? "").trim();
  if (!value) return "";
  const at = value.lastIndexOf("@");
  if (at <= 0) return value.length <= 2 ? "••" : `${value[0]}${"•".repeat(Math.min(value.length - 1, 6))}`;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 2) return `${local[0]}${"•".repeat(3)}${domain}`;
  return `${local[0]}${"•".repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}${domain}`;
}

export type EmailFailureCategory =
  | "not_configured"
  | "disabled"
  | "invalid_recipient"
  | "provider_rejected"
  | "provider_unavailable"
  | "rate_limited"
  | "unknown";

/**
 * Turn a provider error into a category a staff member may safely be shown.
 *
 * Lives here rather than beside the sender because the sender is `server-only`
 * and this is a pure string function — putting it there made the one piece of
 * logic most worth unit-testing the one piece that could not be imported by a
 * test.
 *
 * The raw provider string is still stored in `email_deliveries.error_message`
 * for diagnosis; the delivery centre renders the *category*. A provider message
 * can quote the address it refused, and that page is filtered, paginated and
 * screenshotted.
 */
export function classifyEmailFailure(message: string): EmailFailureCategory {
  const value = (message || "").toLowerCase();
  if (!value) return "unknown";
  if (value.includes("rate limit") || value.includes("too many requests") || value.includes("429")) return "rate_limited";
  if (value.includes("invalid") && value.includes("email")) return "invalid_recipient";
  if (value.includes("not a valid") || value.includes("invalid_recipient") || value.includes("no recipients")) return "invalid_recipient";
  if (value.includes("timeout") || value.includes("econnrefused") || value.includes("enotfound") || value.includes("fetch failed") || value.includes("503") || value.includes("502")) return "provider_unavailable";
  if (value.includes("unauthorized") || value.includes("forbidden") || value.includes("api key") || value.includes("domain") || value.includes("validation")) return "provider_rejected";
  return "unknown";
}
