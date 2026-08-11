/**
 * The operational notification catalogue — one definition, read by everything.
 *
 * Pure and dependency-free, so the event key a producer writes and the event
 * key a test asserts come from the same function rather than from two string
 * templates that agree today.
 *
 * ## Why an event key at all
 *
 * `createNotification` inserted unconditionally. Stripe replays were caught
 * upstream by `stripe_webhook_events`, so no duplicate had actually been
 * observed — but every non-Stripe lifecycle path (a retried fetch, a staff
 * member pressing a button whose response was slow, a route called twice by
 * two tabs) could produce two identical rows in a staff member's bell. A
 * durable key plus a partial unique index makes that unrepresentable rather
 * than unlikely.
 *
 * ## What a key must and must not contain
 *
 * A key identifies the *logical event*, not the call. `order-paid:{orderId}` is
 * right; `order-paid:{orderId}:{timestamp}` is a fresh key every time and
 * deduplicates nothing. Where a condition can legitimately recur — a product
 * going low, being restocked, and going low again — the key carries the thing
 * that makes the second occurrence genuinely new (the alert row id), not the
 * clock.
 *
 * Keys never carry a customer name, an email address, a message body or a note.
 * They are stored in a column that is read by every staff member who holds the
 * notification, and they appear in logs.
 */

/**
 * How loudly a notification asks to be dealt with.
 *
 * `blocker` is reserved for something that is stopping the shop working —
 * checkout refusing, a webhook not arriving. It is deliberately rare: a badge
 * that is always red is a badge nobody reads.
 */
export type NotificationPriority = "blocker" | "high" | "normal" | "low";

export type NotificationAlertKind =
  // Orders and payments
  | "order.new_direct"
  | "order.new_request"
  | "order.payment_received"
  | "order.payment_failed"
  | "order.needs_review"
  | "order.customer_information_received"
  | "order.ready_for_production"
  | "order.ready_to_fulfill"
  | "order.ready_for_pickup"
  // Support
  | "support.new_conversation"
  | "support.customer_replied"
  | "support.assigned"
  | "support.waiting_on_staff"
  // Production
  | "production.overdue"
  | "production.due_soon"
  | "production.blocked"
  // Fulfillment staleness
  | "fulfillment.pickup_uncollected"
  // Customer decisions
  | "cancellation.requested"
  | "return.requested"
  | "refund.failed"
  // Stock
  | "inventory.low_stock"
  | "inventory.out_of_stock"
  | "inventory.reservation_inconsistency"
  // Platform
  | "ops.email_failure"
  | "ops.webhook_failure"
  | "ops.integration_blocker"
  | "ops.automation_failure";

export type NotificationAlertSpec = {
  kind: NotificationAlertKind;
  /** Who is told. Resolved through `resolveStaffRecipients`, so role grants and direct grants both count. */
  permissionKey: string;
  priority: NotificationPriority;
  /** One line, shown as the notification title. Never interpolated with free text. */
  title: string;
  /**
   * True when the underlying condition can clear on its own — stock coming
   * back, a webhook succeeding. Those get a resolution notification when they
   * do, because an alert nobody ever sees close teaches staff to ignore alerts.
   */
  resolvable: boolean;
};

export const NOTIFICATION_ALERTS: readonly NotificationAlertSpec[] = [
  {
    kind: "order.new_direct",
    permissionKey: "orders.view",
    priority: "high",
    title: "New order",
    resolvable: false,
  },
  {
    kind: "order.new_request",
    permissionKey: "orders.view",
    priority: "high",
    title: "New custom request",
    resolvable: false,
  },
  {
    kind: "order.payment_received",
    permissionKey: "orders.view",
    priority: "normal",
    title: "Payment received",
    resolvable: false,
  },
  {
    kind: "order.payment_failed",
    permissionKey: "orders.view",
    priority: "high",
    title: "Payment failed",
    resolvable: false,
  },
  {
    kind: "order.needs_review",
    permissionKey: "orders.view",
    priority: "high",
    title: "Order needs review",
    resolvable: false,
  },
  {
    kind: "order.customer_information_received",
    permissionKey: "orders.view",
    priority: "normal",
    title: "Customer information received",
    resolvable: false,
  },
  {
    kind: "order.ready_for_production",
    permissionKey: "production.view",
    priority: "normal",
    title: "Order ready for production",
    resolvable: false,
  },
  {
    kind: "order.ready_to_fulfill",
    permissionKey: "fulfillment.view",
    priority: "normal",
    title: "Order ready to fulfill",
    resolvable: false,
  },
  {
    kind: "order.ready_for_pickup",
    permissionKey: "fulfillment.view",
    priority: "normal",
    title: "Order ready for pickup",
    resolvable: false,
  },
  /*
   * Support alerts go to `support.view`, not `orders.view`.
   *
   * A conversation about a return is not an order event, and telling the whole
   * orders desk that somebody asked a question is how a bell becomes a thing
   * people scroll past. The one exception in shape is `support.assigned`, which
   * is directed at a single person and so is raised through `notifyStaffUser`
   * rather than fanned out by permission at all.
   */
  {
    kind: "support.new_conversation",
    permissionKey: "support.view",
    priority: "high",
    title: "New support request",
    resolvable: false,
  },
  {
    kind: "support.customer_replied",
    permissionKey: "support.view",
    priority: "normal",
    title: "Customer replied",
    resolvable: false,
  },
  {
    kind: "support.assigned",
    permissionKey: "support.view",
    priority: "high",
    title: "Support conversation assigned to you",
    resolvable: false,
  },
  /*
   * The staleness alerts the scheduler raises.
   *
   * All four are `resolvable`, because all four describe a condition that
   * genuinely clears: a job gets finished, a customer is finally replied to, a
   * parcel is collected. An alert nobody ever sees close teaches staff that the
   * bell is a list of things that were once true, which is how a real blocker
   * gets scrolled past — the same reasoning the inventory alerts already follow.
   *
   * `support.waiting_on_staff` goes to `support.view` rather than to the
   * assignee alone. An unanswered customer is the desk's problem even when the
   * person it was assigned to is away, which is usually exactly why it is stale.
   */
  {
    kind: "support.waiting_on_staff",
    permissionKey: "support.view",
    priority: "high",
    title: "Customer waiting on a reply",
    resolvable: true,
  },
  {
    kind: "production.overdue",
    permissionKey: "production.view",
    priority: "high",
    title: "Production overdue",
    resolvable: true,
  },
  {
    kind: "production.due_soon",
    permissionKey: "production.view",
    // Normal, not high: a job due tomorrow is information, not a problem. Only
    // the one that has already slipped earns the louder badge.
    priority: "normal",
    title: "Production due soon",
    resolvable: true,
  },
  {
    kind: "production.blocked",
    permissionKey: "production.view",
    priority: "high",
    title: "Production blocked too long",
    resolvable: true,
  },
  {
    kind: "fulfillment.pickup_uncollected",
    permissionKey: "fulfillment.view",
    priority: "normal",
    title: "Order still uncollected",
    resolvable: true,
  },
  {
    kind: "cancellation.requested",
    permissionKey: "cancellations.review",
    priority: "high",
    title: "Cancellation requested",
    resolvable: false,
  },
  {
    kind: "return.requested",
    permissionKey: "returns.review",
    priority: "high",
    title: "Return requested",
    resolvable: false,
  },
  {
    kind: "refund.failed",
    permissionKey: "refunds.issue",
    priority: "blocker",
    title: "Refund failed",
    resolvable: false,
  },
  {
    kind: "inventory.low_stock",
    permissionKey: "inventory.view",
    priority: "normal",
    title: "Low stock",
    resolvable: true,
  },
  {
    kind: "inventory.out_of_stock",
    permissionKey: "inventory.view",
    priority: "high",
    title: "Out of stock",
    resolvable: true,
  },
  {
    kind: "inventory.reservation_inconsistency",
    permissionKey: "inventory.view",
    priority: "high",
    title: "Stock hold inconsistency",
    resolvable: true,
  },
  {
    kind: "ops.email_failure",
    permissionKey: "emails.view",
    priority: "high",
    title: "Email delivery failed",
    resolvable: false,
  },
  {
    kind: "ops.webhook_failure",
    permissionKey: "orders.view",
    priority: "blocker",
    title: "Stripe webhook failed",
    resolvable: false,
  },
  {
    kind: "ops.integration_blocker",
    permissionKey: "commerce.settings.view",
    priority: "blocker",
    title: "Integration blocker",
    resolvable: true,
  },
  /*
   * The scheduler telling on itself.
   *
   * Raised when a job exhausts its retries or when the worker finds it cannot
   * do its job at all — no API key, no configured staff address. Gated on
   * `automation.view`, so the people told are the people who can open the page
   * that explains it.
   *
   * Not resolvable: a job that failed did fail, and the record of that should
   * not quietly close itself because the next one worked. Retrying it is an
   * explicit act with its own audit row.
   */
  {
    kind: "ops.automation_failure",
    permissionKey: "automation.view",
    priority: "high",
    title: "Scheduled job failed",
    resolvable: false,
  },
];

export const NOTIFICATION_ALERTS_BY_KIND: Readonly<Record<NotificationAlertKind, NotificationAlertSpec>> =
  Object.freeze(
    Object.fromEntries(NOTIFICATION_ALERTS.map((spec) => [spec.kind, spec])) as Record<
      NotificationAlertKind,
      NotificationAlertSpec
    >
  );

/** Characters a key may hold. Anything else is replaced, so a key stays greppable and index-safe. */
const KEY_SAFE = /[^a-zA-Z0-9._:-]/g;

/**
 * Build the durable event key for one logical alert.
 *
 * `subjectId` is the record the alert is *about* — an order id, a return id, an
 * inventory alert row id. `discriminator` is for the cases where the same
 * subject can legitimately raise the same kind more than once and each one is a
 * real new event; it is never a timestamp.
 *
 * Truncated to 200 characters because the column is indexed and a key longer
 * than the thing it identifies is a bug rather than a long name.
 */
export function notificationEventKey(
  kind: NotificationAlertKind,
  subjectId: string,
  discriminator?: string | null
): string {
  const subject = String(subjectId ?? "").replace(KEY_SAFE, "-").slice(0, 100);
  const extra = discriminator ? `:${String(discriminator).replace(KEY_SAFE, "-").slice(0, 60)}` : "";
  return `${kind}:${subject}${extra}`.slice(0, 200);
}

/** The key for the notification announcing that a resolvable condition cleared. */
export function resolutionEventKey(
  kind: NotificationAlertKind,
  subjectId: string,
  discriminator?: string | null
): string {
  return `${notificationEventKey(kind, subjectId, discriminator)}:resolved`.slice(0, 200);
}

/**
 * The deep link for an alert.
 *
 * Every alert lands on the page where the work is done, not on a list the
 * reader then has to search. A notification that opens `/staff/orders` when it
 * meant one order costs its reader the same three clicks every time.
 */
export function alertHref(kind: NotificationAlertKind, subjectId: string): string {
  switch (kind) {
    case "order.new_direct":
    case "order.new_request":
    case "order.payment_received":
    case "order.payment_failed":
    case "order.needs_review":
    case "order.customer_information_received":
    case "cancellation.requested":
    case "return.requested":
    case "refund.failed":
      return `/staff/orders/${subjectId}`;
    case "order.ready_for_production":
    case "production.overdue":
    case "production.due_soon":
    case "production.blocked":
      return `/staff/production/${subjectId}`;
    case "order.ready_to_fulfill":
    case "order.ready_for_pickup":
    case "fulfillment.pickup_uncollected":
      return `/staff/orders/${subjectId}`;
    case "support.new_conversation":
    case "support.customer_replied":
    case "support.assigned":
    case "support.waiting_on_staff":
      return `/staff/support/${subjectId}`;
    case "inventory.low_stock":
    case "inventory.out_of_stock":
    case "inventory.reservation_inconsistency":
      return `/staff/inventory/${subjectId}`;
    case "ops.email_failure":
      return "/staff/emails/deliveries";
    case "ops.webhook_failure":
      return "/staff/integrations";
    case "ops.integration_blocker":
      return "/staff/launch-readiness";
    case "ops.automation_failure":
      // The failures panel, not the settings form: somebody following this link
      // wants to see what broke, not to change a threshold.
      return "/staff/settings/automation";
  }
}

/**
 * Priorities in the order a staff member should work them.
 *
 * Exported so the notification list and any future badge sort by one rule.
 */
export const PRIORITY_RANK: Readonly<Record<NotificationPriority, number>> = {
  blocker: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Trim a message to what a preview may carry.
 *
 * Operational messages are written by this codebase, never by a customer, so
 * the cap is about layout rather than safety — but the cap is enforced here so
 * every producer gets it, and the *rule* that no customer free text enters a
 * notification payload is asserted in `tests/notification-dedup.test.ts`.
 */
export function previewMessage(message: string, max = 200): string {
  const value = (message ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
